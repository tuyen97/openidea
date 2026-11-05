//! JavaScript handlers of `.http` files, run by Boa in this process.
//!
//! The engine only sees `client`, `request` and `response`; there is no file,
//! network or process API. Runtime limits stop runaway loops and recursion.

use crate::exec::{HttpResponse, PreparedRequest};
use crate::globals::Globals;
use boa_engine::object::ObjectInitializer;
use boa_engine::property::Attribute;
use boa_engine::vm::RuntimeLimits;
use boa_engine::{Context, JsError, JsResult, JsValue, NativeFunction, Source, js_string};
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

/// Scripts get one million loop iterations and 128 nested calls; enough for
/// request handling, small enough to stop a runaway script.
const LOOP_ITERATION_LIMIT: u64 = 1_000_000;
const RECURSION_LIMIT: usize = 128;
const STACK_SIZE_LIMIT: usize = 1024 * 1024;
/// Keep runaway `client.log` output out of the response history.
const MAX_LOG_LINES: usize = 100;
const MAX_LOG_TEXT: usize = 16 * 1024;
/// A handler larger than this is almost certainly not a request script.
const MAX_SCRIPT_BYTES: usize = 256 * 1024;

/// What a handler produced.
#[derive(Debug, Default)]
pub struct ScriptOutcome {
    pub logs: Vec<String>,
    /// Variables set through `request.variables.set`.
    pub variables: HashMap<String, String>,
    pub error: Option<String>,
}

struct ScriptHost {
    logs: RefCell<Vec<String>>,
    /// Variables set by this script (`request.variables.set`).
    variables: RefCell<HashMap<String, String>>,
    /// Variables readable by the script but not written back.
    initial: HashMap<String, String>,
    globals: Arc<Globals>,
}

/// Runs a response handler with the request and response it observed.
pub fn run_response(
    source: &str,
    request: &PreparedRequest,
    response: &HttpResponse,
    globals: &Arc<Globals>,
) -> ScriptOutcome {
    run(source, HashMap::new(), globals, |context| {
        install_client(context)?;
        install_request(context, request)?;
        install_response(context, response)
    })
}

/// Runs a pre-request script. It can set `client.global` and
/// `request.variables`, which the request substitution picks up afterwards.
pub fn run_pre_request(source: &str, variables: HashMap<String, String>, globals: &Arc<Globals>) -> ScriptOutcome {
    run(source, variables, globals, |context| {
        install_client(context)?;
        install_pre_request(context)
    })
}

fn run(
    source: &str,
    initial: HashMap<String, String>,
    globals: &Arc<Globals>,
    setup: impl FnOnce(&mut Context) -> JsResult<()>,
) -> ScriptOutcome {
    if source.len() > MAX_SCRIPT_BYTES {
        return ScriptOutcome {
            error: Some(format!("script is larger than {} KiB", MAX_SCRIPT_BYTES / 1024)),
            ..Default::default()
        };
    }

    let mut context = Context::default();
    install_limits(&mut context);
    context.insert_data(ScriptHost {
        logs: RefCell::new(Vec::new()),
        variables: RefCell::new(HashMap::new()),
        initial,
        globals: globals.clone(),
    });

    let mut setup_error = None;
    if let Err(e) = setup(&mut context) {
        setup_error = Some(format_error(&e));
    }

    let run_error = if setup_error.is_none() { eval(&mut context, source) } else { None };
    let (logs, variables) = snapshot(&context);
    ScriptOutcome { logs, variables, error: setup_error.or(run_error) }
}

fn install_limits(context: &mut Context) {
    let mut limits = RuntimeLimits::default();
    limits.set_loop_iteration_limit(LOOP_ITERATION_LIMIT);
    limits.set_recursion_limit(RECURSION_LIMIT);
    limits.set_stack_size_limit(STACK_SIZE_LIMIT);
    context.set_runtime_limits(limits);
}

fn eval(context: &mut Context, source: &str) -> Option<String> {
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        context.eval(Source::from_bytes(source))?;
        context.run_jobs()?;
        Ok::<(), JsError>(())
    }));
    match result {
        Ok(Ok(())) => None,
        Ok(Err(e)) => Some(format_error(&e)),
        Err(_) => Some("the script panicked".to_owned()),
    }
}

fn format_error(error: &JsError) -> String {
    error.to_string()
}

fn snapshot(context: &Context) -> (Vec<String>, HashMap<String, String>) {
    context
        .get_data::<ScriptHost>()
        .map(|host| (host.logs.borrow().clone(), host.variables.borrow().clone()))
        .unwrap_or_default()
}

fn install_client(context: &mut Context) -> JsResult<()> {
    let global = {
        let mut object = ObjectInitializer::new(context);
        object
            .function(NativeFunction::from_fn_ptr(global_set), js_string!("set"), 2)
            .function(NativeFunction::from_fn_ptr(global_get), js_string!("get"), 1)
            .function(NativeFunction::from_fn_ptr(global_clear), js_string!("clear"), 1)
            .function(NativeFunction::from_fn_ptr(global_clear_all), js_string!("clearAll"), 0)
            .function(NativeFunction::from_fn_ptr(global_is_empty), js_string!("isEmpty"), 0);
        object.build()
    };

    let mut client = ObjectInitializer::new(context);
    client.property(js_string!("global"), global, Attribute::all()).function(
        NativeFunction::from_fn_ptr(client_log),
        js_string!("log"),
        1,
    );
    let client = client.build();
    context.register_global_property(js_string!("client"), client, Attribute::all())
}

fn install_pre_request(context: &mut Context) -> JsResult<()> {
    let variables = variables_object(context);
    let mut object = ObjectInitializer::new(context);
    object.property(js_string!("variables"), variables, Attribute::all());
    let object = object.build();
    context.register_global_property(js_string!("request"), object, Attribute::all())
}

fn variables_object(context: &mut Context) -> boa_engine::object::JsObject {
    let mut object = ObjectInitializer::new(context);
    object.function(NativeFunction::from_fn_ptr(variable_set), js_string!("set"), 2).function(
        NativeFunction::from_fn_ptr(variable_get),
        js_string!("get"),
        1,
    );
    object.build()
}

fn install_request(context: &mut Context, request: &PreparedRequest) -> JsResult<()> {
    let variables = variables_object(context);
    let headers = headers_value(context, &request.headers);
    let mut object = ObjectInitializer::new(context);
    object
        .property(js_string!("method"), JsValue::from(js_string!(request.method.as_str())), Attribute::all())
        .property(js_string!("url"), JsValue::from(js_string!(request.url.as_str())), Attribute::all())
        .property(js_string!("headers"), headers, Attribute::all())
        .property(js_string!("body"), js_body(request.body.as_deref()), Attribute::all())
        .property(js_string!("variables"), variables, Attribute::all());
    let object = object.build();
    context.register_global_property(js_string!("request"), object, Attribute::all())
}

fn install_response(context: &mut Context, response: &HttpResponse) -> JsResult<()> {
    let body = match &response.body {
        None => Value::Null,
        Some(text) => match is_json(response.content_type.as_deref(), text) {
            true => serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.clone())),
            false => Value::String(text.clone()),
        },
    };
    let mut headers = Map::new();
    for (name, value) in &response.headers {
        headers.insert(name.clone(), Value::String(value.clone()));
    }
    let value = json!({
        "status": response.status,
        "statusText": response.status_text.clone(),
        "version": response.version.clone(),
        "headers": Value::Object(headers),
        "contentType": response.content_type.clone(),
        "body": body,
        "size": response.size,
        "ttfbMs": response.ttfb_ms,
        "totalMs": response.total_ms,
        "truncated": response.truncated,
    });
    let value = JsValue::from_json(&value, context)?;
    context.register_global_property(js_string!("response"), value, Attribute::all())
}

fn headers_value(context: &mut Context, headers: &[(String, String)]) -> JsValue {
    let mut map = Map::new();
    for (name, value) in headers {
        map.insert(name.clone(), Value::String(value.clone()));
    }
    JsValue::from_json(&Value::Object(map), context).unwrap_or_else(|_| JsValue::null())
}

fn js_body(body: Option<&str>) -> JsValue {
    body.map_or_else(JsValue::null, |body| JsValue::from(js_string!(body)))
}

fn is_json(content_type: Option<&str>, body: &str) -> bool {
    content_type.is_some_and(|ct| ct.to_ascii_lowercase().contains("json")) || body.trim_start().starts_with(['{', '['])
}

fn name_arg(args: &[JsValue], context: &mut Context) -> String {
    args.first().map_or_else(String::new, |value| js_to_string(value, context))
}

fn js_to_string(value: &JsValue, context: &mut Context) -> String {
    value.to_string(context).map(|text| text.to_std_string_escaped()).unwrap_or_default()
}

fn display(value: &JsValue, context: &mut Context) -> String {
    if value.is_object()
        && let Ok(Some(json)) = value.to_json(context)
    {
        return serde_json::to_string(&json).unwrap_or_default();
    }
    js_to_string(value, context)
}

fn global_set(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let name = name_arg(args, context);
    let value = args.get(1).cloned().unwrap_or_else(JsValue::undefined);
    let json = value.to_json(context)?.unwrap_or(Value::Null);
    if let Some(host) = context.get_data::<ScriptHost>() {
        host.globals.set(name, json);
    }
    Ok(JsValue::undefined())
}

fn global_get(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let name = name_arg(args, context);
    let value = context.get_data::<ScriptHost>().and_then(|host| host.globals.get(&name));
    match value {
        Some(value) => JsValue::from_json(&value, context),
        None => Ok(JsValue::undefined()),
    }
}

fn global_clear(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let name = name_arg(args, context);
    if let Some(host) = context.get_data::<ScriptHost>() {
        host.globals.clear(&name);
    }
    Ok(JsValue::undefined())
}

fn global_clear_all(_this: &JsValue, _args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    if let Some(host) = context.get_data::<ScriptHost>() {
        host.globals.clear_all();
    }
    Ok(JsValue::undefined())
}

fn global_is_empty(_this: &JsValue, _args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let empty = context.get_data::<ScriptHost>().is_none_or(|host| host.globals.is_empty());
    Ok(JsValue::from(empty))
}

fn client_log(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let text = args.iter().map(|value| display(value, context)).collect::<Vec<_>>().join(" ");
    if let Some(host) = context.get_data::<ScriptHost>() {
        let mut logs = host.logs.borrow_mut();
        if logs.len() < MAX_LOG_LINES {
            logs.push(text.chars().take(MAX_LOG_TEXT).collect());
        }
    }
    Ok(JsValue::undefined())
}

fn variable_set(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let name = name_arg(args, context);
    let value = args.get(1).map_or_else(String::new, |value| js_to_string(value, context));
    if let Some(host) = context.get_data::<ScriptHost>() {
        host.variables.borrow_mut().insert(name, value);
    }
    Ok(JsValue::undefined())
}

fn variable_get(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let name = name_arg(args, context);
    let value = context
        .get_data::<ScriptHost>()
        .and_then(|host| host.variables.borrow().get(&name).cloned().or_else(|| host.initial.get(&name).cloned()));
    Ok(value.map_or_else(JsValue::undefined, |value| JsValue::from(js_string!(value))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn request() -> PreparedRequest {
        PreparedRequest {
            name: Some("login".into()),
            method: "POST".into(),
            url: "https://example.test/login".into(),
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: Some(r#"{"user":"me"}"#.into()),
        }
    }

    fn response() -> HttpResponse {
        HttpResponse {
            status: 200,
            status_text: "OK".into(),
            version: "HTTP/1.1".into(),
            headers: vec![("Content-Type".into(), "application/json".into())],
            content_type: Some("application/json".into()),
            body: Some(r#"{"token":"abc"}"#.into()),
            size: 17.0,
            truncated: false,
            ttfb_ms: 2.0,
            total_ms: 3.0,
        }
    }

    #[test]
    fn globals_and_logs_are_available() {
        let globals = Arc::new(Globals::default());
        let out = run_response(
            "client.global.set('token', response.body.token); \
             client.global.set('status', response.status); \
             client.log('got', client.global.get('token'));",
            &request(),
            &response(),
            &globals,
        );
        assert_eq!(out.error, None);
        assert_eq!(globals.get("token"), Some(Value::String("abc".into())));
        assert_eq!(globals.get("status"), Some(Value::from(200)));
        assert_eq!(out.logs, vec!["got abc"]);
    }

    #[test]
    fn request_and_response_are_visible() {
        let globals = Arc::new(Globals::default());
        let out = run_response(
            "client.global.set('line', request.method + ' ' + request.url); \
             client.global.set('header', request.headers['Content-Type']); \
             client.global.set('body', response.body.token);",
            &request(),
            &response(),
            &globals,
        );
        assert_eq!(out.error, None);
        assert_eq!(globals.get("line"), Some(Value::String("POST https://example.test/login".into())));
        assert_eq!(globals.get("header"), Some(Value::String("application/json".into())));
        assert_eq!(globals.get("body"), Some(Value::String("abc".into())));
    }

    #[test]
    fn syntax_errors_are_reported() {
        let globals = Arc::new(Globals::default());
        let out = run_response("client.log(", &request(), &response(), &globals);
        assert!(out.error.is_some(), "expected a syntax error");
    }

    #[test]
    fn runaway_loops_stop() {
        let globals = Arc::new(Globals::default());
        let out = run_response("while (true) {}", &request(), &response(), &globals);
        assert!(out.error.is_some(), "expected the loop limit to fire");
    }

    #[test]
    fn host_apis_are_not_exposed() {
        let globals = Arc::new(Globals::default());
        let out = run_response(
            "client.global.set('hasFetch', typeof fetch); \
             client.global.set('hasRequire', typeof require); \
             client.global.set('hasProcess', typeof process);",
            &request(),
            &response(),
            &globals,
        );
        assert_eq!(out.error, None);
        for name in ["hasFetch", "hasRequire", "hasProcess"] {
            assert_eq!(globals.get(name), Some(Value::String("undefined".into())), "{name}");
        }
    }

    #[test]
    fn variables_can_be_set_by_a_handler() {
        let globals = Arc::new(Globals::default());
        let out =
            run_response("request.variables.set('next', response.body.token);", &request(), &response(), &globals);
        assert_eq!(out.error, None);
        assert_eq!(out.variables, HashMap::from([("next".into(), "abc".into())]));
    }

    #[test]
    fn pre_request_reads_initial_variables_and_returns_changes() {
        let globals = Arc::new(Globals::default());
        let out = run_pre_request(
            "request.variables.set('id', Number(request.variables.get('base')) + 1); \
             client.global.set('base', request.variables.get('base'));",
            HashMap::from([("base".into(), "41".into())]),
            &globals,
        );
        assert_eq!(out.error, None);
        assert_eq!(out.variables, HashMap::from([("id".into(), "42".into())]));
        assert_eq!(globals.get("base"), Some(Value::String("41".into())));
    }
}
