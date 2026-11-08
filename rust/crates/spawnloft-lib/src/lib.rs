//! SpawnLoft's core library. Every binary in the workspace is a thin `main` over this crate.
//!
//! Internal phase: only the build identity lives here so far. The daemon (R1) is next.

pub mod build;
pub mod json;
