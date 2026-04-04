use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub mod discovery;
pub mod env;
pub mod models;
pub mod runner;
pub mod stream;

static CLAUDE_HELP_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
