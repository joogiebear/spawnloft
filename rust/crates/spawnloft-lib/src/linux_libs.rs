//! `linux-libs.mjs`: the shared libraries a downloaded Linux engine expects. C2 part 1 has the
//! environment a managed engine runs with (`libraryEnv`); the check and repair at install
//! (`ensureLibraries`) come with the `db` command.

use std::path::Path;

pub const LIBS_FOLDER: &str = "spawnloft-libs";

/// `libsDirFor(binaryPath)`: beside the folder that holds the binary's `bin/`.
pub fn libs_dir_for(binary_path: &str) -> String {
    let bin_dir = crate::jspath::dirname(binary_path);
    let root = crate::jspath::dirname(&bin_dir);
    crate::jspath::join(&[&root, LIBS_FOLDER])
}

/// `libraryEnv(binaryPath, env)` as overrides on top of `env`: on Linux, when the engine carries
/// its own libraries, they go first on `LD_LIBRARY_PATH`.
pub fn library_env(binary_path: &str, env: &mut Vec<(String, String)>) {
    if !cfg!(target_os = "linux") {
        return;
    }
    let dir = libs_dir_for(binary_path);
    if !Path::new(&dir).exists() {
        return;
    }
    let current = crate::daemon_launch::env_value(env, "LD_LIBRARY_PATH");
    let value = match current.filter(|v| !v.is_empty()) {
        Some(v) => format!("{dir}:{v}"),
        None => dir,
    };
    crate::daemon_launch::set_env(env, "LD_LIBRARY_PATH", value);
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_libs_folder_is_beside_bin() {
        assert_eq!(
            super::libs_dir_for("/e/mysql-8/bin/mysqld"),
            format!("/e/mysql-8/{}", super::LIBS_FOLDER)
        );
    }
}
