//! The profiles of `client.mjs`: profiles.json (`{ version, profiles: { <name>: {...} },
//! defaultAccount? }`), read and written as the Node core does, key order kept.

use serde_json::{Map, Value, json};

use super::paths::Paths;
use super::{accounts, prop, read_json};
use crate::failure::Failure;
use crate::js;

/// The fields a profile may hold (`PROFILE_KEYS`).
pub const PROFILE_KEYS: &[&str] = &[
    "mc",
    "loader",
    "loaderVersion",
    "java",
    "memory",
    "harness",
    "server",
    "account",
    "assistantAccount",
    "serverList",
];

/// The fields that make up a running game's command line (`RUNNING_KEYS`).
pub const RUNNING_KEYS: &[&str] = &["mc", "loader", "loaderVersion", "java", "memory", "harness"];

/// Every loader id a profile may name, vanilla first (`LOADERS`).
pub const LOADERS: &[&str] = &["vanilla", "fabric", "quilt", "forge", "neoforge"];

pub const DEFAULT_MEMORY: &str = "2G";

/// `validateProfileName(name)`: the server-name rule, worded for a profile.
pub fn validate_name(name: &str) -> Result<(), Failure> {
    crate::registry::validate_name(name).map_err(|_| {
        Failure::user(format!(
            "invalid profile name \"{name}\" - use letters, digits, dash, underscore (max 32 chars)"
        ))
    })
}

/// profiles.json as `loadProfiles()` leaves it.
#[derive(Debug, Clone, PartialEq)]
pub struct Doc(pub Value);

fn kind_of(v: &Value) -> &'static str {
    match v {
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        _ => "object",
    }
}

/// `loadProfiles()`.
pub fn load(paths: &Paths) -> Result<Doc, Failure> {
    let mut data = match read_json(&paths.profiles_file())? {
        None | Some(Value::Null) => json!({ "version": 1, "profiles": {} }),
        Some(v) => v,
    };
    match &mut data {
        Value::Object(m) => {
            if !js::truthy(m.get("profiles")) {
                m.insert("profiles".into(), json!({}));
            }
        }
        // a property set on an array is not part of its JSON
        Value::Array(_) => {}
        other => {
            return Err(Failure::type_error(format!(
                "Cannot create property 'profiles' on {} '{}'",
                kind_of(other),
                js::string(Some(other))
            )));
        }
    }
    Ok(Doc(data))
}

impl Doc {
    fn profiles_value(&self) -> Option<&Value> {
        prop(Some(&self.0), "profiles")
    }

    /// `Object.entries(reg.profiles)`.
    pub fn entries(&self) -> Vec<(String, Value)> {
        self.profiles_value()
            .map(crate::registry::entries_of)
            .unwrap_or_default()
    }

    /// `Object.keys(reg.profiles)`.
    pub fn names(&self) -> Vec<String> {
        self.entries().into_iter().map(|(k, _)| k).collect()
    }

    /// `Object.hasOwn(reg.profiles, name) ? reg.profiles[name] : null`.
    pub fn get(&self, name: &str) -> Option<Value> {
        self.entries()
            .into_iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v)
    }

    /// `reg.profiles[name] = cfg`.
    pub fn set(&mut self, name: &str, cfg: Value) -> Result<(), Failure> {
        match self.0.get_mut("profiles") {
            Some(Value::Object(m)) => {
                m.insert(name.to_string(), cfg);
                Ok(())
            }
            Some(other @ (Value::Bool(_) | Value::Number(_) | Value::String(_))) => {
                Err(Failure::type_error(format!(
                    "Cannot create property '{name}' on {} '{}'",
                    kind_of(other),
                    js::string(Some(other))
                )))
            }
            // an array's own property, which its JSON leaves out
            _ => Ok(()),
        }
    }

    /// `delete reg.profiles[name]`, the other keys keeping their order.
    pub fn delete(&mut self, name: &str) {
        if let Some(Value::Object(m)) = self.0.get_mut("profiles") {
            m.shift_remove(name);
        }
    }

    /// The top-level `defaultAccount`.
    pub fn default_account(&self) -> Option<&Value> {
        prop(Some(&self.0), "defaultAccount")
    }

    pub fn set_default_account(&mut self, uuid: Option<Value>) {
        if let Value::Object(m) = &mut self.0 {
            match uuid {
                Some(u) => {
                    m.insert("defaultAccount".into(), u);
                }
                None => {
                    m.shift_remove("defaultAccount");
                }
            }
        }
    }

    /// Replaces the profiles with these entries in this order (a rename).
    pub fn replace_profiles(&mut self, entries: Vec<(String, Value)>) {
        if let Value::Object(m) = &mut self.0 {
            m.insert("profiles".into(), Value::Object(entries.into_iter().collect()));
        }
    }
}

/// `accountExists(uuid)`: an unreadable accounts list counts as yes.
fn account_exists(paths: &Paths, uuid: &Value) -> bool {
    match accounts::load_or_none(paths) {
        None => true,
        Some(list) => list
            .iter()
            .any(|a| accounts::same_uuid(prop(Some(a), "uuid"), Some(uuid))),
    }
}

/// `saveProfiles(data)`: a default account that was signed out is dropped, not an error.
pub fn save(paths: &Paths, doc: &mut Doc) -> Result<(), Failure> {
    if let Some(d) = doc.default_account().cloned()
        && !d.is_null()
        && !account_exists(paths, &d)
    {
        doc.set_default_account(None);
    }
    super::write_json(&paths.profiles_file(), &doc.0)
}

/// `withDefaults(cfg)`: `{ assistantAccount: false, serverList: true, ...cfg }`.
pub fn with_defaults(cfg: &Value) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("assistantAccount".into(), json!(false));
    m.insert("serverList".into(), json!(true));
    super::spread_into(&mut m, cfg);
    m
}

/// One profile as the Node core hands it around: `{ name, ...withDefaults(cfg) }`.
#[derive(Debug, Clone, PartialEq)]
pub struct Profile {
    pub fields: Map<String, Value>,
}

impl Profile {
    pub fn of(name: &str, cfg: &Value) -> Profile {
        let mut fields = Map::new();
        fields.insert("name".into(), json!(name));
        for (k, v) in with_defaults(cfg) {
            fields.insert(k, v);
        }
        Profile { fields }
    }
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.fields.get(key)
    }
    /// `p.name`, which a record's own `name` field may have replaced.
    pub fn name(&self) -> String {
        js::string(self.get("name"))
    }
    pub fn text(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::as_str)
    }
    pub fn to_json(&self) -> Value {
        Value::Object(self.fields.clone())
    }
}

/// `listProfiles()`: every profile, by name.
pub fn list(paths: &Paths) -> Result<Vec<Profile>, Failure> {
    let doc = load(paths)?;
    let mut out: Vec<Profile> = doc
        .entries()
        .iter()
        .map(|(name, cfg)| Profile::of(name, cfg))
        .collect();
    out.sort_by(|a, b| crate::collate::compare(&a.name(), &b.name()));
    Ok(out)
}

/// `getProfile(name)`.
pub fn get(paths: &Paths, name: &str) -> Result<Profile, Failure> {
    validate_name(name)?;
    let doc = load(paths)?;
    match doc.get(name) {
        Some(cfg) if js::truthy(Some(&cfg)) => Ok(Profile::of(name, &cfg)),
        _ => {
            let known = doc.names();
            Err(Failure::user(format!(
                "no profile named \"{name}\"{}",
                if known.is_empty() {
                    ". Create one with: spawnloft client new <name> --mc <version>".to_string()
                } else {
                    format!(". Known profiles: {}", known.join(", "))
                }
            )))
        }
    }
}

/// `getDefaultAccount()`: the launcher's default account, a uuid from accounts.json, or `None`
/// when none is set or the account is gone.
pub fn default_account(paths: &Paths) -> Result<Option<String>, Failure> {
    let doc = load(paths)?;
    let Some(Value::String(uuid)) = doc.default_account() else {
        return Ok(None);
    };
    let list = accounts::load_or_none(paths);
    Ok(list
        .filter(|l| {
            l.iter()
                .any(|a| accounts::same_uuid(prop(Some(a), "uuid"), Some(&json!(uuid))))
        })
        .map(|_| uuid.clone()))
}

/// `accountInfo(value)`: the name to show for a profile's account key (a uuid, a name, or
/// `offline:<name>`), and its type: `microsoft`, `offline`, or null for a name no longer listed.
pub fn account_info(paths: &Paths, value: Option<&Value>) -> Result<(Value, Value), Failure> {
    let Some(Value::String(text)) = value else {
        return Ok((super::or_null(value), Value::Null));
    };
    if let Some(name) = text.strip_prefix("offline:") {
        return Ok((json!(name), json!("offline")));
    }
    let Some(list) = accounts::load_or_none(paths) else {
        return Ok((json!(text), Value::Null));
    };
    Ok(match accounts::find(&list, text)? {
        None => (json!(text), Value::Null),
        Some(i) => {
            let a = &list[i];
            let kind = match prop(Some(a), "type") {
                v if super::nullish(v) => json!("microsoft"),
                v => super::or_null(v),
            };
            (super::or_null(prop(Some(a), "name")), kind)
        }
    })
}

/// `accountUuid(value)`: the uuid a profile's account key resolves to, or `None` for an offline
/// selector or a name no longer in the list.
pub fn account_uuid(paths: &Paths, value: Option<&Value>) -> Result<Option<Value>, Failure> {
    let Some(Value::String(text)) = value else {
        return Ok(None);
    };
    if text.starts_with("offline:") {
        return Ok(None);
    }
    let Some(list) = accounts::load_or_none(paths) else {
        return Ok(None);
    };
    Ok(accounts::find(&list, text)?.map(|i| super::or_null(prop(Some(&list[i]), "uuid"))))
}

/// `accountKeyFor(value)`: a name in the list is stored as its uuid; `offline:<name>` and an
/// unknown name as typed.
pub fn account_key_for(paths: &Paths, value: &Value) -> Result<Value, Failure> {
    let Value::String(text) = value else {
        return Ok(value.clone());
    };
    if text.starts_with("offline:") {
        return Ok(value.clone());
    }
    let Some(list) = accounts::load_or_none(paths) else {
        return Ok(value.clone());
    };
    Ok(match accounts::find(&list, text)? {
        None => value.clone(),
        Some(i) => super::or_null(prop(Some(&list[i]), "uuid")),
    })
}

/// `holderText(name)`: the pid holding the profile's launch lock, `?` when it is not known.
pub fn holder_text(paths: &Paths, name: &str) -> String {
    match crate::lock::holder(std::path::Path::new(&paths.launch_lock(name))) {
        None | Some(-1) => "?".into(),
        Some(pid) => pid.to_string(),
    }
}

/// The files of a run folder that belong to one profile's past games (how the last one ended,
/// the time played, which list entries SpawnLoft wrote).
pub fn history_files(paths: &Paths, name: &str) -> [String; 3] {
    [paths.last_exit(name), paths.played(name), paths.server_list(name)]
}

/// `removeProfile(name, { purge })`.
pub fn remove(paths: &Paths, name: &str, purge: bool) -> Result<(), Failure> {
    if super::state::status(paths, name)?.running {
        return Err(Failure::user(format!(
            "profile \"{name}\" is running; stop it first: spawnloft client stop {name}"
        )));
    }
    get(paths, name)?;
    // under the launch lock, so a launch that passed getProfile cannot recreate the run folder
    // after the purge
    let lock_file = paths.launch_lock(name);
    let lock = crate::lock::acquire(std::path::Path::new(&lock_file), crate::lock::Options::fail())
        .map_err(|e| lock_failure(&e))?;
    let Some(lock) = lock else {
        return Err(Failure::user(format!(
            "profile \"{name}\" is being launched (pid {}); wait for it",
            holder_text(paths, name)
        )));
    };
    let result = (|| {
        let mut doc = load(paths)?;
        doc.delete(name);
        save(paths, &mut doc)?;
        if purge {
            super::rm_tree_retrying(&paths.profile_dir(name))?;
        }
        Ok(())
    })();
    let released = lock.release();
    result?;
    released.map_err(|e| Failure::io(&e, "unlink", Some(std::path::Path::new(&lock_file))))?;
    if purge {
        super::rm_tree_retrying(&paths.run_dir(name))?;
    } else {
        for file in history_files(paths, name) {
            super::rm_force(&file)?;
        }
    }
    Ok(())
}

/// A lock that could not be taken for a reason other than its holder, as Node throws it.
pub fn lock_failure(e: &crate::lock::LockError) -> Failure {
    match e {
        crate::lock::LockError::Io(io) => Failure::io(io, "open", None),
        other => Failure::Internal {
            head: "Error".into(),
            message: other.to_string(),
            code: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> (std::path::PathBuf, Paths) {
        let d = std::env::temp_dir().join(format!("sl-client-prof-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let p = Paths::under(&d.to_string_lossy());
        (d, p)
    }

    #[test]
    fn a_fresh_root_is_the_empty_registry() {
        let (d, p) = scratch("fresh");
        assert_eq!(load(&p).unwrap().0, json!({ "version": 1, "profiles": {} }));
        std::fs::create_dir_all(&p.root).unwrap();
        std::fs::write(p.profiles_file(), "null").unwrap();
        assert_eq!(load(&p).unwrap().0, json!({ "version": 1, "profiles": {} }));
        std::fs::write(p.profiles_file(), "{\"version\":1}").unwrap();
        assert_eq!(load(&p).unwrap().0, json!({ "version": 1, "profiles": {} }));
        std::fs::write(p.profiles_file(), "5").unwrap();
        assert_eq!(
            load(&p).unwrap_err().message(),
            "Cannot create property 'profiles' on number '5'"
        );
        std::fs::write(p.profiles_file(), "{").unwrap();
        assert!(matches!(load(&p), Err(Failure::Internal { head, .. }) if head == "SyntaxError"));
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn profiles_list_by_name_with_their_defaults() {
        let (d, p) = scratch("list");
        std::fs::create_dir_all(&p.root).unwrap();
        std::fs::write(
            p.profiles_file(),
            r#"{"version":1,"profiles":{"b":{"mc":"1.21.4"},"a":{"mc":"1.20.1","serverList":false}}}"#,
        )
        .unwrap();
        let got: Vec<Value> = list(&p).unwrap().iter().map(Profile::to_json).collect();
        assert_eq!(
            got,
            vec![
                json!({ "name": "a", "assistantAccount": false, "serverList": false, "mc": "1.20.1" }),
                json!({ "name": "b", "assistantAccount": false, "serverList": true, "mc": "1.21.4" }),
            ]
        );
        assert_eq!(
            get(&p, "c").unwrap_err().message(),
            "no profile named \"c\". Known profiles: b, a"
        );
        assert_eq!(
            get(&p, "bad name").unwrap_err().message(),
            "invalid profile name \"bad name\" - use letters, digits, dash, underscore (max 32 chars)"
        );
        std::fs::write(p.profiles_file(), r#"{"profiles":{}}"#).unwrap();
        assert_eq!(
            get(&p, "c").unwrap_err().message(),
            "no profile named \"c\". Create one with: spawnloft client new <name> --mc <version>"
        );
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_signed_out_default_account_is_dropped_on_save() {
        let (d, p) = scratch("default");
        std::fs::create_dir_all(&p.root).unwrap();
        std::fs::write(
            p.accounts_file(),
            r#"{"version":1,"accounts":[{"type":"offline","name":"Alex","uuid":"AB-CD"}]}"#,
        )
        .unwrap();
        let mut doc = Doc(json!({ "version": 1, "profiles": {}, "defaultAccount": "abcd" }));
        save(&p, &mut doc).unwrap();
        assert_eq!(default_account(&p).unwrap(), Some("abcd".into()));
        let mut doc = Doc(json!({ "version": 1, "defaultAccount": "gone", "profiles": {} }));
        save(&p, &mut doc).unwrap();
        assert_eq!(load(&p).unwrap().0, json!({ "version": 1, "profiles": {} }));
        assert_eq!(
            account_info(&p, Some(&json!("alex"))).unwrap(),
            (json!("Alex"), json!("offline"))
        );
        assert_eq!(
            account_info(&p, Some(&json!("offline:Zed"))).unwrap(),
            (json!("Zed"), json!("offline"))
        );
        assert_eq!(
            account_info(&p, Some(&json!("Nobody"))).unwrap(),
            (json!("Nobody"), Value::Null)
        );
        std::fs::remove_dir_all(d).unwrap();
    }
}
