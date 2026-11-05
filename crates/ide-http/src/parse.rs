//! Parser for IntelliJ-style `.http` / `.rest` request files.
//!
//! ```text
//! @host = example.com          # file variable
//! ### Get user                 # separator; the rest of the line names the request
//! # @name getUser              # explicit name
//! GET https://{{host}}/users/1
//! Accept: application/json
//!
//! { "body": true }
//! < ./payload.json             # body include
//! ```
//!
//! Request scripts (`< {% … %}`, `< file.js`) and response handlers
//! (`> {% … %}`, `> file.js`) are parsed into [`ScriptBlock`]s; response
//! redirects (`>> file`) and references to previous responses (`<> file`) are
//! recognised and skipped.

use serde::{Deserialize, Serialize};
use specta::Type;

pub const METHODS: &[&str] = &["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE", "CONNECT"];

/// One request of a file, as shown by the gutter and the Run All list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestBlock {
    /// 0-based index among the file's requests.
    pub index: u32,
    pub name: Option<String>,
    pub method: String,
    /// URL as written (variables not substituted).
    pub url: String,
    /// 0-based line of the request line.
    pub line: u32,
    /// First and last line (0-based, inclusive) of the block, separator excluded.
    pub start_line: u32,
    pub end_line: u32,
}

/// A body line: literal text or `< path` (file contents).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BodyPart {
    Text(String),
    File(String),
}

/// Where a script's code comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScriptSource {
    /// Inline `{% … %}` text, delimiters removed.
    Inline(String),
    /// A `./handler.js` path, as written (relative to the request file).
    File(String),
}

/// A pre-request script (`<`) or response handler (`>`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptBlock {
    pub source: ScriptSource,
    /// 0-based line of the `<` / `>` marker.
    pub line: u32,
}

/// A request with every part still unsubstituted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawRequest {
    pub block: HttpRequestBlock,
    pub headers: Vec<(String, String)>,
    pub body: Vec<BodyPart>,
    pub pre_script: Option<ScriptBlock>,
    pub response_script: Option<ScriptBlock>,
}

/// Everything parsed from one file.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HttpFile {
    /// `@name = value` file variables, in order (later wins).
    pub variables: Vec<(String, String)>,
    pub requests: Vec<RawRequest>,
}

fn is_separator(line: &str) -> bool {
    line.trim_start().starts_with("###")
}

fn is_comment(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with('#') || t.starts_with("//")
}

/// `# @name foo` / `// @name foo` / `# @name=foo`.
fn name_tag(line: &str) -> Option<String> {
    let t = line.trim_start();
    let rest = t.strip_prefix('#').or_else(|| t.strip_prefix("//"))?.trim_start();
    let rest = rest.strip_prefix("@name")?;
    let name = rest.trim_start_matches([' ', '\t', '=']).trim();
    (!name.is_empty() && (rest.starts_with([' ', '\t', '=']))).then(|| name.to_owned())
}

/// `@name = value` (file variable).
fn file_variable(line: &str) -> Option<(String, String)> {
    let rest = line.trim_start().strip_prefix('@')?;
    let (name, value) = rest.split_once('=')?;
    let name = name.trim();
    if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '.') {
        return None;
    }
    Some((name.to_owned(), value.trim().to_owned()))
}

/// `METHOD url [HTTP/x]` or a bare URL (GET).
fn request_line(line: &str) -> Option<(String, String)> {
    let t = line.trim();
    if t.is_empty() {
        return None;
    }
    let (first, rest) = match t.split_once(char::is_whitespace) {
        Some((a, b)) => (a, b.trim()),
        None => (t, ""),
    };
    let (method, target) = if METHODS.contains(&first) {
        if rest.is_empty() {
            return None;
        }
        (first.to_owned(), rest)
    } else if looks_like_url(t) {
        ("GET".to_owned(), t)
    } else {
        return None;
    };
    // Drop a trailing protocol version.
    let url = match target.rsplit_once(char::is_whitespace) {
        Some((u, v)) if v.starts_with("HTTP/") => u.trim(),
        _ => target,
    };
    Some((method, url.to_owned()))
}

fn looks_like_url(t: &str) -> bool {
    t.starts_with("http://") || t.starts_with("https://") || t.starts_with("{{") || t.starts_with('/')
}

fn header(line: &str) -> Option<(String, String)> {
    let (name, value) = line.split_once(':')?;
    let name = name.trim();
    if name.is_empty() || name.contains(char::is_whitespace) {
        return None;
    }
    Some((name.to_owned(), value.trim().to_owned()))
}

/// Splits `text` into blocks separated by `###` lines: `(first line, lines)`.
fn blocks(text: &str) -> Vec<(u32, Option<String>, Vec<&str>)> {
    let mut out = Vec::new();
    let mut start = 0u32;
    let mut title: Option<String> = None;
    let mut cur: Vec<&str> = Vec::new();
    for (i, raw) in text.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if is_separator(line) {
            out.push((start, title.take(), std::mem::take(&mut cur)));
            start = i as u32 + 1;
            let t = line.trim_start().trim_start_matches('#').trim();
            title = (!t.is_empty()).then(|| t.to_owned());
        } else {
            cur.push(line);
        }
    }
    out.push((start, title, cur));
    out
}

pub fn parse(text: &str) -> HttpFile {
    let mut file = HttpFile::default();
    for (start, title, lines) in blocks(text) {
        let mut name = title;
        let mut i = 0;
        // Preamble: comments, names, variables, blank lines.
        let mut request = None;
        while i < lines.len() {
            let line = lines[i];
            if let Some(n) = name_tag(line) {
                name = Some(n);
            } else if let Some(v) = file_variable(line) {
                file.variables.push(v);
            } else if line.trim().is_empty() || is_comment(line) {
            } else if let Some(r) = request_line(line) {
                request = Some((i, r));
                i += 1;
                break;
            }
            i += 1;
        }
        let Some((req_idx, (method, mut url))) = request else { continue };
        // Multi-line query: indented continuation lines.
        while i < lines.len() {
            let l = lines[i];
            let t = l.trim();
            if l.starts_with([' ', '\t']) && (t.starts_with('?') || t.starts_with('&') || t.starts_with('/')) {
                url.push_str(t);
                i += 1;
            } else {
                break;
            }
        }
        let mut headers = Vec::new();
        while i < lines.len() {
            let l = lines[i];
            if l.trim().is_empty() {
                i += 1;
                break;
            }
            // A script or body include directly after the headers (no blank
            // line) still belongs to the body section, not to the headers.
            if l.trim_start().starts_with(['<', '>']) {
                break;
            }
            if !is_comment(l)
                && let Some(h) = header(l)
            {
                headers.push(h);
            }
            i += 1;
        }
        let body_start = i.min(lines.len());
        let (body, pre_script, response_script) = body_parts(&lines[body_start..], start + body_start as u32);
        // Trailing blank lines are not part of the block's visible extent.
        let mut last = lines.len();
        while last > req_idx + 1 && lines[last - 1].trim().is_empty() {
            last -= 1;
        }
        let index = file.requests.len() as u32;
        file.requests.push(RawRequest {
            block: HttpRequestBlock {
                index,
                name,
                method,
                url,
                line: start + req_idx as u32,
                start_line: start,
                end_line: start + last.saturating_sub(1) as u32,
            },
            headers,
            body,
            pre_script,
            response_script,
        });
    }
    file
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HandlerKind {
    PreRequest,
    Response,
}

impl HandlerKind {
    fn set(self, pre: &mut Option<ScriptBlock>, response: &mut Option<ScriptBlock>, block: ScriptBlock) {
        match self {
            HandlerKind::PreRequest => *pre = Some(block),
            HandlerKind::Response => *response = Some(block),
        }
    }
}

/// `{% … %}` on a `<` or `>` line: the kind and the text after `{%`.
fn inline_handler(t: &str) -> Option<(HandlerKind, &str)> {
    for (prefix, kind) in [
        ("< {%", HandlerKind::PreRequest),
        ("<{%", HandlerKind::PreRequest),
        ("> {%", HandlerKind::Response),
        (">{%", HandlerKind::Response),
    ] {
        if let Some(rest) = t.strip_prefix(prefix) {
            return Some((kind, rest));
        }
    }
    None
}

/// A script file line: `< ./pre.js` / `> ./handler.js`.
fn script_file(t: &str) -> Option<(HandlerKind, String)> {
    // `>> file` and `<> file` are not scripts.
    if t.starts_with("<>") || t.starts_with(">>") {
        return None;
    }
    let (kind, rest) = if let Some(rest) = t.strip_prefix("< ") {
        (HandlerKind::PreRequest, rest)
    } else if let Some(rest) = t.strip_prefix("> ") {
        (HandlerKind::Response, rest)
    } else {
        return None;
    };
    let path = rest.trim();
    let lower = path.to_ascii_lowercase();
    let is_js = [".js", ".mjs", ".cjs"].iter().any(|ext| lower.ends_with(ext));
    // `< ./payload.json` keeps its meaning: a body include.
    is_js.then(|| (kind, path.to_owned()))
}

/// Body parts plus the request's pre-request script and response handler.
fn body_parts(lines: &[&str], base_line: u32) -> (Vec<BodyPart>, Option<ScriptBlock>, Option<ScriptBlock>) {
    let mut out = Vec::new();
    let mut pre = None;
    let mut response = None;

    let mut i = 0;
    while i < lines.len() {
        let l = lines[i];
        let t = l.trim_start();

        if let Some((kind, rest)) = inline_handler(t) {
            let line = base_line + i as u32;
            let (source, next) = inline_source(rest, lines, i);
            kind.set(&mut pre, &mut response, ScriptBlock { source: ScriptSource::Inline(source), line });
            i = next;
            continue;
        }
        if let Some((kind, path)) = script_file(t) {
            let line = base_line + i as u32;
            kind.set(&mut pre, &mut response, ScriptBlock { source: ScriptSource::File(path), line });
            i += 1;
            continue;
        }
        // `>> file`, `<> file` and a non-JS `> file` are not body lines.
        if t.starts_with("<>") || t.starts_with(">>") || t.starts_with("> ") {
            i += 1;
            continue;
        }
        if let Some(path) = t.strip_prefix("< ") {
            out.push(BodyPart::File(path.trim().to_owned()));
        } else {
            out.push(BodyPart::Text(l.to_owned()));
        }
        i += 1;
    }

    while matches!(out.last(), Some(BodyPart::Text(t)) if t.trim().is_empty()) {
        out.pop();
    }
    while matches!(out.first(), Some(BodyPart::Text(t)) if t.trim().is_empty()) {
        out.remove(0);
    }
    (out, pre, response)
}

/// Inline handler text from `rest` (just after `{%`) to the closing `%}`.
/// Returns the source and the index of the first line after the handler.
fn inline_source(rest: &str, lines: &[&str], i: usize) -> (String, usize) {
    if let Some(end) = rest.trim_end().strip_suffix("%}") {
        return (end.trim().to_owned(), i + 1);
    }
    let mut source = String::from(rest.trim_start());
    let mut j = i + 1;
    while j < lines.len() {
        let line = lines[j];
        let t = line.trim_start();
        if let Some(end) = t.trim_end().strip_suffix("%}") {
            let tail = end.trim_end();
            if !tail.is_empty() {
                if !source.is_empty() {
                    source.push('\n');
                }
                source.push_str(tail);
            }
            j += 1;
            break;
        }
        source.push('\n');
        source.push_str(line);
        j += 1;
    }
    (source.trim().to_owned(), j)
}

/// The blocks only (gutter, Run All).
pub fn requests(text: &str) -> Vec<HttpRequestBlock> {
    parse(text).requests.into_iter().map(|r| r.block).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"@host = example.com
### Get user
# a comment
GET https://{{host}}/users/1 HTTP/1.1
Accept: application/json
# not a header
X-Trace: 1

###
# @name create
POST https://{{host}}/users
    ?page=1
    &size=2
Content-Type: application/json

{
  "a": 1
}
< ./extra.json

> {%
  client.log(1)
%}

### bare
https://example.com/health
"#;

    #[test]
    fn parses_requests_names_and_blocks() {
        let f = parse(SAMPLE);
        assert_eq!(f.variables, vec![("host".into(), "example.com".into())]);
        assert_eq!(f.requests.len(), 3);
        let a = &f.requests[0];
        assert_eq!(a.block.name.as_deref(), Some("Get user"));
        assert_eq!(a.block.method, "GET");
        assert_eq!(a.block.url, "https://{{host}}/users/1");
        assert_eq!(a.block.line, 3);
        assert_eq!(a.headers, vec![("Accept".into(), "application/json".into()), ("X-Trace".into(), "1".into())]);
        assert!(a.body.is_empty());

        let b = &f.requests[1];
        assert_eq!(b.block.name.as_deref(), Some("create"));
        assert_eq!(b.block.url, "https://{{host}}/users?page=1&size=2");
        assert_eq!(b.block.line, 10);
        assert_eq!(
            b.body,
            vec![
                BodyPart::Text("{".into()),
                BodyPart::Text("  \"a\": 1".into()),
                BodyPart::Text("}".into()),
                BodyPart::File("./extra.json".into()),
            ]
        );
        assert_eq!(
            b.response_script,
            Some(ScriptBlock { source: ScriptSource::Inline("client.log(1)".into()), line: 20 })
        );
        assert!(b.pre_script.is_none());

        let c = &f.requests[2];
        assert_eq!(c.block.method, "GET");
        assert_eq!(c.block.name.as_deref(), Some("bare"));
        assert_eq!(c.block.url, "https://example.com/health");
        assert_eq!(c.block.start_line, 25);
        assert_eq!(c.block.end_line, 25);
    }

    #[test]
    fn ignores_blocks_without_a_request_and_crlf() {
        let f = parse("### only comments\r\n# nothing\r\n###\r\nDELETE /x\r\nA: b\r\n");
        assert_eq!(f.requests.len(), 1);
        assert_eq!(f.requests[0].block.method, "DELETE");
        assert_eq!(f.requests[0].block.index, 0);
        assert_eq!(f.requests[0].headers, vec![("A".into(), "b".into())]);
    }

    #[test]
    fn plain_text_is_not_a_request() {
        assert!(parse("hello world\n").requests.is_empty());
        assert!(parse("GET\n").requests.is_empty());
    }

    #[test]
    fn parses_inline_pre_request_and_response_scripts() {
        let f = parse(
            "POST https://example.com/items\n\
             Content-Type: application/json\n\
             \n\
             {\"id\": 1}\n\
             < {%\n\
               request.variables.set(\"id\", 2);\n\
             %}\n\
             > {% client.log(response.status) %}\n",
        );
        let r = &f.requests[0];
        assert_eq!(r.body, vec![BodyPart::Text("{\"id\": 1}".into())]);
        assert_eq!(
            r.pre_script,
            Some(ScriptBlock { source: ScriptSource::Inline("request.variables.set(\"id\", 2);".into()), line: 4 })
        );
        assert_eq!(
            r.response_script,
            Some(ScriptBlock { source: ScriptSource::Inline("client.log(response.status)".into()), line: 7 })
        );
    }

    #[test]
    fn script_files_are_not_body_includes() {
        let f = parse(
            "GET https://example.com/\n\
             < ./pre.js\n\
             > ./handler.mjs\n\
             < ./payload.json\n",
        );
        let r = &f.requests[0];
        assert_eq!(r.pre_script, Some(ScriptBlock { source: ScriptSource::File("./pre.js".into()), line: 1 }));
        assert_eq!(
            r.response_script,
            Some(ScriptBlock { source: ScriptSource::File("./handler.mjs".into()), line: 2 })
        );
        // The JSON include keeps its body meaning.
        assert_eq!(r.body, vec![BodyPart::File("./payload.json".into())]);
    }

    #[test]
    fn scripts_directly_after_headers_are_not_lost() {
        let f = parse("GET https://example.com/\nAccept: */*\n> {% client.log(1) %}\n");
        let r = &f.requests[0];
        assert_eq!(r.headers, vec![("Accept".into(), "*/*".into())]);
        assert_eq!(
            r.response_script,
            Some(ScriptBlock { source: ScriptSource::Inline("client.log(1)".into()), line: 2 })
        );
        assert!(r.body.is_empty());
    }

    #[test]
    fn response_redirects_are_still_skipped() {
        let f = parse("GET https://example.com/\n\n>> ./response.json\n<> ./previous.json\n");
        let r = &f.requests[0];
        assert!(r.body.is_empty());
        assert!(r.pre_script.is_none());
        assert!(r.response_script.is_none());
    }
}
