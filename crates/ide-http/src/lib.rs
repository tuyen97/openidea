//! HTTP Client: IntelliJ-style `.http` request files.
//!
//! [`parse`] splits a file into requests, [`env`] resolves `{{variables}}` from
//! `http-client(.private).env.json`, [`exec`] sends a request (cancellable,
//! timed) and [`history`] keeps the responses. [`client`] builds every HTTP client
//! of the backend, with the proxy of System Settings › HTTP Proxy.

pub mod client;
pub mod env;
pub mod exec;
pub mod globals;
pub mod history;
pub mod parse;
pub mod script;

pub use env::Environments;
pub use exec::{HttpResponse, PreparedRequest};
pub use globals::Globals;
pub use history::{History, HistoryEntry, HttpExchange};
pub use parse::{HttpRequestBlock, ScriptBlock, ScriptSource};

use ide_core::{CancellationToken, IdeError, IdeResult, IpcPath};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

/// Where a request comes from and how to resolve it.
pub struct RunInput<'a> {
    pub text: &'a str,
    pub index: u32,
    /// The request file (`None` for an unsaved buffer).
    pub file: Option<&'a Path>,
    pub root: Option<&'a Path>,
    pub env: Option<&'a str>,
    /// `client.global` values of the project session.
    pub globals: Option<Arc<Globals>>,
}

/// Prepares and sends request `index` of `text`. Preparation errors (bad
/// variables, missing includes) fail; transport errors are part of the exchange.
pub async fn run(input: RunInput<'_>, cancel: &CancellationToken) -> IdeResult<HttpExchange> {
    let parsed = parse::parse(input.text);
    let raw = parsed
        .requests
        .get(input.index as usize)
        .ok_or_else(|| IdeError::not_found(format!("no request #{}", input.index + 1)))?;
    let envs = Environments::load(input.file, input.root)?;
    let globals = input.globals.clone().unwrap_or_default();
    let mut file_vars: Vec<(String, String)> = globals.variables().into_iter().collect();
    file_vars.extend(parsed.variables.clone());

    let mut script_logs = Vec::new();
    let mut script_error = None;
    if let Some(pre) = &raw.pre_script {
        let source = script_source(pre, input.file)?;
        let mut initial: HashMap<String, String> = envs.variables(input.env);
        initial.extend(globals.variables());
        initial.extend(parsed.variables.iter().cloned());
        let pre_globals = globals.clone();
        let outcome = tokio::task::spawn_blocking(move || script::run_pre_request(&source, initial, &pre_globals))
            .await
            .map_err(|e| IdeError::internal(format!("pre-request script task failed: {e}")))?;
        if let Some(error) = outcome.error {
            return Err(IdeError::invalid(format!("pre-request script: {error}")));
        }
        script_logs.extend(outcome.logs);
        // The script may have set globals used by this request.
        file_vars = globals.variables().into_iter().collect();
        file_vars.extend(parsed.variables.clone());
        file_vars.extend(outcome.variables);
    }

    let request = exec::prepare(raw, &file_vars, &envs, input.env, input.file.and_then(Path::parent))?;
    let time_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or_default();
    let result = exec::execute(&request, cancel).await;
    if let Err(e) = &result
        && e.kind == ide_core::error::ErrorKind::Cancelled
    {
        return Err(e.clone());
    }
    let (response, error) = match result {
        Ok(r) => (Some(r), None),
        Err(e) => (None, Some(e.message)),
    };

    if let Some(handler) = &raw.response_script
        && let Some(response) = &response
    {
        match script_source(handler, input.file) {
            Ok(source) => {
                let request = request.clone();
                let response = response.clone();
                let handler_globals = globals.clone();
                match tokio::task::spawn_blocking(move || {
                    script::run_response(&source, &request, &response, &handler_globals)
                })
                .await
                {
                    Ok(outcome) => {
                        script_logs.extend(outcome.logs);
                        script_error = outcome.error;
                    }
                    Err(e) => script_error = Some(format!("script task failed: {e}")),
                }
            }
            Err(e) => script_error = Some(e.message),
        }
    }

    Ok(HttpExchange {
        entry: HistoryEntry {
            id: uuid::Uuid::new_v4().simple().to_string(),
            time_ms,
            name: request.name.clone(),
            method: request.method.clone(),
            url: request.url.clone(),
            status: response.as_ref().map(|r| r.status),
            total_ms: response.as_ref().map(|r| r.total_ms),
            file: input.file.map(IpcPath::from),
            error,
        },
        request,
        response,
        script_logs,
        script_error,
    })
}

/// Script code: inline text, or a `.js` file relative to the request file.
fn script_source(block: &ScriptBlock, file: Option<&Path>) -> IdeResult<String> {
    match &block.source {
        ScriptSource::Inline(source) => Ok(source.clone()),
        ScriptSource::File(path) => {
            let path = Path::new(path);
            let path = match file.and_then(Path::parent) {
                Some(dir) if path.is_relative() => dir.join(path),
                _ => path.to_path_buf(),
            };
            std::fs::read_to_string(&path)
                .map_err(|e| IdeError::not_found(format!("cannot read script {}: {e}", path.display())))
        }
    }
}

/// Environment names available to `file`.
pub fn environments(file: Option<&Path>, root: Option<&Path>) -> IdeResult<Vec<String>> {
    Ok(Environments::load(file, root)?.names())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn response(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    async fn request_head(socket: &mut tokio::net::TcpStream) -> String {
        let mut buf = vec![0u8; 4096];
        let n = socket.read(&mut buf).await.unwrap();
        String::from_utf8_lossy(&buf[..n]).to_string()
    }

    #[tokio::test]
    async fn scripts_run_before_and_after_the_request() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            let head = request_head(&mut first).await;
            assert!(head.starts_with("GET /first HTTP/1.1"), "{head}");
            first.write_all(response(r#"{"token":"abc"}"#).as_bytes()).await.unwrap();

            let (mut second, _) = listener.accept().await.unwrap();
            let head = request_head(&mut second).await;
            assert!(head.starts_with("GET /second?token=abc HTTP/1.1"), "{head}");
            second.write_all(response(r#"{"ok":true}"#).as_bytes()).await.unwrap();
        });

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("requests.http");
        std::fs::write(
            &file,
            format!(
                "GET http://{addr}/first\n\
                 > {{%\n\
                   client.global.set('token', response.body.token);\n\
                 %}}\n\
                 \n\
                 ###\n\
                 GET http://{addr}/second?token={{{{token}}}}\n\
                 > {{% client.log(response.status) %}}\n"
            ),
        )
        .unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        let globals = Arc::new(Globals::default());

        let first = run(
            RunInput {
                text: &text,
                index: 0,
                file: Some(&file),
                root: Some(dir.path()),
                env: None,
                globals: Some(globals.clone()),
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(first.script_error, None);
        assert_eq!(globals.get("token"), Some(serde_json::json!("abc")));

        let second = run(
            RunInput {
                text: &text,
                index: 1,
                file: Some(&file),
                root: Some(dir.path()),
                env: None,
                globals: Some(globals),
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(second.script_error, None);
        assert_eq!(second.script_logs, vec!["200"]);
        server.await.unwrap();
    }
}
