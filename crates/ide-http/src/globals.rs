//! `client.global` values, shared by every request of a project session.

use parking_lot::Mutex;
use serde_json::Value;
use std::collections::BTreeMap;

/// Values set by `client.global.set(...)` in a response handler. They live
/// for the project session, like IntelliJ's HTTP Client globals.
#[derive(Default)]
pub struct Globals(Mutex<BTreeMap<String, Value>>);

impl Globals {
    pub fn set(&self, name: impl Into<String>, value: Value) {
        self.0.lock().insert(name.into(), value);
    }

    pub fn get(&self, name: &str) -> Option<Value> {
        self.0.lock().get(name).cloned()
    }

    pub fn clear(&self, name: &str) {
        self.0.lock().remove(name);
    }

    pub fn clear_all(&self) {
        self.0.lock().clear();
    }

    pub fn is_empty(&self) -> bool {
        self.0.lock().is_empty()
    }

    /// Globals as strings, for `{{name}}` substitution.
    pub fn variables(&self) -> BTreeMap<String, String> {
        self.0.lock().iter().map(|(k, v)| (k.clone(), display(v))).collect()
    }
}

fn display(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_owned(),
        other => other.to_string(),
    }
}
