//! SpawnLoft's core library. Every binary in the workspace is a thin `main` over this crate.
//!
//! Internal phase: the build identity and the per-server daemon (R1) with what it needs.

pub mod activity;
pub mod build;
pub mod cancel;
pub mod collate;
pub mod control;
pub mod crashguard;
pub mod create;
pub mod daemon;
pub mod daemon_launch;
pub mod data_format;
pub mod diagnose;
pub mod download;
pub mod entry;
pub mod exposure;
pub mod failure;
pub mod fsx;
pub mod garnet;
pub mod handover;
pub mod java;
pub mod js;
pub mod jsdate;
pub mod jsjson;
pub mod json;
pub mod jspath;
pub mod jsregex;
pub mod linux_libs;
pub mod lock;
pub mod log_timeline;
pub mod mariadb;
pub mod metrics;
pub mod mysql;
pub mod nodecore;
pub mod notify;
pub mod panel;
pub mod panel_auth;
pub mod paths;
pub mod patterns;
pub mod platform;
pub mod plugins;
pub mod private_files;
pub mod procid;
pub mod props;
pub mod rcon;
pub mod registry;
pub mod resp;
pub mod runtime;
pub mod settings;
pub mod sha256;
pub mod software;
pub mod supervisor;
pub mod tar;
pub mod test_origins;
pub mod text;
pub mod tick;
pub mod time;
pub mod update;
pub mod user_path;
pub mod util;
pub mod zip;

/// The JSON library the daemon reads and writes with, for the binary crates.
pub use regex;
pub use serde_json;
