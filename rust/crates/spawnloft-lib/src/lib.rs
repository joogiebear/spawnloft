//! SpawnLoft's core library. Every binary in the workspace is a thin `main` over this crate.
//!
//! Internal phase: the build identity and the per-server daemon (R1) with what it needs.

pub mod activity;
pub mod build;
pub mod collate;
pub mod control;
pub mod crashguard;
pub mod daemon;
pub mod diagnose;
pub mod failure;
pub mod fsx;
pub mod handover;
pub mod js;
pub mod jsjson;
pub mod json;
pub mod jspath;
pub mod jsregex;
pub mod lock;
pub mod metrics;
pub mod nodecore;
pub mod notify;
pub mod panel;
pub mod panel_auth;
pub mod paths;
pub mod patterns;
pub mod platform;
pub mod procid;
pub mod props;
pub mod rcon;
pub mod registry;
pub mod resp;
pub mod runtime;
pub mod settings;
pub mod sha256;
pub mod supervisor;
pub mod test_origins;
pub mod text;
pub mod tick;
pub mod time;
pub mod update;
pub mod user_path;

/// The JSON library the daemon reads and writes with, for the binary crates.
pub use regex;
pub use serde_json;
