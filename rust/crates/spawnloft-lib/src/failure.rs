//! How a ported command fails, in the three ways the Node CLI tells apart (`mcctl.mjs` main):
//! a usage error (exit 2), a person's mistake (`UserError`, `error: <message>`, exit 1), and
//! anything else (exit 1), which the Node core prints as a JavaScript stack. The Rust side prints
//! only the stack's first line; the rig drops the stack's `at` lines (the declared difference
//! `internal-error-stack`).

use std::path::Path;

use crate::jspath;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// `UsageError`.
    Usage(String),
    /// `UserError`, with the code a caller may act on (`fail(msg, code)`).
    User { message: String, code: Option<String> },
    /// Any other error: `head` is what precedes the message in `err.stack` (`SyntaxError`,
    /// `Error`, `RangeError [ERR_OUT_OF_RANGE]`), `code` is `err.code` when it has one.
    Internal {
        head: String,
        message: String,
        code: Option<String>,
    },
}

impl Failure {
    pub fn user(message: impl Into<String>) -> Failure {
        Failure::User {
            message: message.into(),
            code: None,
        }
    }
    pub fn usage(message: impl Into<String>) -> Failure {
        Failure::Usage(message.into())
    }
    /// A file that is not JSON (`JSON.parse` threw).
    pub fn syntax(message: impl Into<String>) -> Failure {
        Failure::Internal {
            head: "SyntaxError".into(),
            message: message.into(),
            code: None,
        }
    }
    /// A `TypeError` from JavaScript itself.
    pub fn type_error(message: impl Into<String>) -> Failure {
        Failure::Internal {
            head: "TypeError".into(),
            message: message.into(),
            code: None,
        }
    }
    /// A failed file-system call, as Node reports it.
    pub fn io(e: &std::io::Error, syscall: &str, path: Option<&Path>) -> Failure {
        Failure::Internal {
            head: "Error".into(),
            message: jspath::node_error(e, syscall, path),
            code: Some(jspath::error_code(e).0.to_string()),
        }
    }
    /// A failed whole-file read (`readFileSync`).
    pub fn read(e: &std::io::Error, file: &Path) -> Failure {
        let message = jspath::read_error(e, file);
        let code = message.split(':').next().unwrap_or("EIO").to_string();
        Failure::Internal {
            head: "Error".into(),
            message,
            code: Some(code),
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Failure::Usage(m) => m,
            Failure::User { message, .. } | Failure::Internal { message, .. } => message,
        }
    }

    /// The exit code: 2 for usage, 1 otherwise.
    pub fn exit_code(&self) -> u8 {
        if matches!(self, Failure::Usage(_)) { 2 } else { 1 }
    }

    /// The `error.code` of the `--json` envelope.
    pub fn json_code(&self) -> String {
        match self {
            Failure::Usage(_) => "INVALID_USAGE".into(),
            Failure::User { code, .. } | Failure::Internal { code, .. } => {
                code.clone().unwrap_or_else(|| "COMMAND_FAILED".into())
            }
        }
    }

    /// What stderr shows without `--json`.
    pub fn stderr_text(&self) -> String {
        match self {
            Failure::Usage(m) | Failure::User { message: m, .. } => format!("error: {m}\n"),
            Failure::Internal { head, message, .. } => format!("{head}: {message}\n"),
        }
    }
}
