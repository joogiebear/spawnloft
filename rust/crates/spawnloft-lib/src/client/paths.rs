//! `client-paths.mjs`: where the client keeps its files, under `<data root>/client`. Paths are
//! text as `path.join` spells them, so messages and records match the Node core's.

use crate::jspath;
use crate::settings::Layout;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    /// `CLIENT_ROOT`.
    pub root: String,
}

impl Paths {
    pub fn new(layout: &Layout) -> Paths {
        Paths::under(&layout.data_root)
    }

    pub fn under(data_root: &str) -> Paths {
        Paths {
            root: jspath::join(&[data_root, "client"]),
        }
    }

    fn at(&self, parts: &[&str]) -> String {
        let mut all = vec![self.root.as_str()];
        all.extend_from_slice(parts);
        jspath::join(&all)
    }

    pub fn profiles_file(&self) -> String {
        self.at(&["profiles.json"])
    }
    pub fn libraries_dir(&self) -> String {
        self.at(&["libraries"])
    }
    pub fn assets_dir(&self) -> String {
        self.at(&["assets"])
    }
    /// `NATIVES_DIR`.
    pub fn natives_root(&self) -> String {
        self.at(&["natives"])
    }
    /// Mojang's Java runtimes, one folder per component and platform.
    pub fn runtime_dir(&self) -> String {
        self.at(&["runtime"])
    }
    pub fn accounts_file(&self) -> String {
        self.at(&["accounts.json"])
    }
    pub fn profile_dir(&self, name: &str) -> String {
        self.at(&["profiles", name])
    }
    pub fn versions_dir(&self) -> String {
        self.at(&["versions"])
    }
    pub fn version_dir(&self, id: &str) -> String {
        self.at(&["versions", id])
    }
    pub fn version_json(&self, id: &str) -> String {
        jspath::join(&[&self.version_dir(id), &format!("{id}.json")])
    }
    pub fn version_jar(&self, id: &str) -> String {
        jspath::join(&[&self.version_dir(id), &format!("{id}.jar")])
    }
    /// Mojang's layout for the log4j configs the version JSONs name.
    pub fn log_config_path(&self, id: &str) -> String {
        self.at(&["assets", "log_configs", id])
    }
    /// `nativesDir(id)`.
    pub fn natives_dir(&self, id: &str) -> String {
        self.at(&["natives", id])
    }
    pub fn run_dir(&self, name: &str) -> String {
        self.at(&["run", name])
    }
    pub fn state_file(&self, name: &str) -> String {
        jspath::join(&[&self.run_dir(name), "state.json"])
    }
    /// How the last game of this profile ended, kept after state.json is gone.
    pub fn last_exit(&self, name: &str) -> String {
        jspath::join(&[&self.run_dir(name), "last-exit.json"])
    }
    /// When this profile was last played and for how long in all.
    pub fn played(&self, name: &str) -> String {
        jspath::join(&[&self.run_dir(name), "played.json"])
    }
    /// Which entries of the profile's servers.dat SpawnLoft wrote.
    pub fn server_list(&self, name: &str) -> String {
        jspath::join(&[&self.run_dir(name), "server-list.json"])
    }
    pub fn log(&self, name: &str) -> String {
        jspath::join(&[&self.run_dir(name), "client.log"])
    }
    /// Held from the start of a launch until state.json is written.
    pub fn launch_lock(&self, name: &str) -> String {
        jspath::join(&[&self.run_dir(name), "launch.lock"])
    }
    /// `stop-asked.json`: Stop was asked for this pid, by any process.
    pub fn stop_mark(&self, name: &str) -> String {
        jspath::join(&[&self.run_dir(name), "stop-asked.json"])
    }
    /// `CLIENT_CACHE_DIR`: shared by every profile and by the version picker.
    pub fn cache_dir(&self) -> String {
        self.at(&["cache"])
    }

    /// `ensureClientDirs()`.
    pub fn ensure_dirs(&self) -> Result<(), crate::failure::Failure> {
        for d in [
            self.root.clone(),
            self.at(&["profiles"]),
            self.versions_dir(),
            self.libraries_dir(),
            self.assets_dir(),
            self.natives_root(),
            self.at(&["run"]),
        ] {
            crate::fsx::mkdir_all(std::path::Path::new(&d))?;
        }
        Ok(())
    }
}
