//! The accounts list of `client-auth.mjs`: accounts.json, owner-only on every platform, keyed by
//! uuid. Signed-in Microsoft accounts carry their tokens; offline ones only a name and the uuid
//! an offline-mode server derives from it. Nothing here touches the network.

use serde_json::{Value, json};

use super::paths::Paths;
use super::{nullish, object, or_null, prop, read_json};
use crate::failure::Failure;
use crate::js;

/// `loadAccounts()`: `readJson(ACCOUNTS_FILE, null)?.accounts ?? []`. A list that is not an
/// array is refused the way the callers' `.map` and `.find` would refuse it.
pub fn load(paths: &Paths) -> Result<Vec<Value>, Failure> {
    let data = read_json(&paths.accounts_file())?;
    match prop(data.as_ref(), "accounts") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(_) => Err(Failure::type_error("the accounts list is not a list")),
    }
}

/// `accountsOrNull()`: the list, or `None` when the file cannot be read at all.
pub fn load_or_none(paths: &Paths) -> Option<Vec<Value>> {
    load(paths).ok()
}

/// `publicAccount(a)`: what leaves the process about an account, never a token.
pub fn public(a: &Value) -> Value {
    let kind = match prop(Some(a), "type") {
        v if nullish(v) => json!("microsoft"),
        v => or_null(v),
    };
    let offline = prop(Some(a), "type") == Some(&json!("offline"));
    object(vec![
        ("name", prop(Some(a), "name").cloned()),
        ("uuid", prop(Some(a), "uuid").cloned()),
        ("type", Some(kind)),
        (
            "expiresAt",
            Some(if offline {
                Value::Null
            } else {
                or_null(prop(Some(a), "expiresAt"))
            }),
        ),
        ("refreshFailedAt", Some(or_null(prop(Some(a), "refreshFailedAt")))),
    ])
}

/// `sameUuid(a, b)`: case and dashes do not matter.
pub fn same_uuid(a: Option<&Value>, b: Option<&Value>) -> bool {
    let norm = |v: Option<&Value>| {
        if nullish(v) {
            String::new()
        } else {
            super::lower(v).replace('-', "")
        }
    };
    norm(a) == norm(b)
}

/// `a.name.toLowerCase()`, which throws for an entry whose name is not text.
fn name_lower(a: &Value) -> Result<String, Failure> {
    match prop(Some(a), "name") {
        Some(Value::String(s)) => Ok(s.to_lowercase()),
        _ => Err(Failure::type_error("a.name.toLowerCase is not a function")),
    }
}

fn is_bare_uuid(s: &str) -> bool {
    s.len() == 32
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `findAccount(list, selector)`: a uuid (dashed or not) or a name, case-insensitive; the uuid
/// wins when both could match.
pub fn find(list: &[Value], selector: &str) -> Result<Option<usize>, Failure> {
    let sel = selector.to_lowercase();
    let bare = sel.replace('-', "");
    if is_bare_uuid(&bare) {
        let hit = list
            .iter()
            .position(|a| super::lower(prop(Some(a), "uuid")).replace('-', "") == bare);
        if hit.is_some() {
            return Ok(hit);
        }
    }
    for (i, a) in list.iter().enumerate() {
        if name_lower(a)? == sel {
            return Ok(Some(i));
        }
    }
    Ok(None)
}

/// `saveAccounts(list)`: owner-only, and not written at all when that cannot be done.
pub fn save(paths: &Paths, list: &[Value]) -> Result<(), Failure> {
    let file = paths.accounts_file();
    crate::fsx::write_json_node(
        std::path::Path::new(&file),
        &json!({ "version": 1, "accounts": list }),
        Some(0o600),
        true,
    )
    .map(|_| ())
}

/// `updateAccounts(change)`: re-reads the file first and writes what `change` makes of it.
pub fn update(
    paths: &Paths,
    change: impl FnOnce(Vec<Value>) -> Result<Vec<Value>, Failure>,
) -> Result<Vec<Value>, Failure> {
    let next = change(load(paths)?)?;
    save(paths, &next)?;
    Ok(next)
}

/// `removeAccount(uuid)`: by uuid, whatever else changed meanwhile. The removed entry, without
/// tokens, or `None`.
pub fn remove(paths: &Paths, uuid: Option<&Value>) -> Result<Option<Value>, Failure> {
    let mut gone = None;
    update(paths, |list| {
        Ok(list
            .into_iter()
            .filter(|a| {
                if !same_uuid(prop(Some(a), "uuid"), uuid) {
                    return true;
                }
                gone = Some(public(a));
                false
            })
            .collect())
    })?;
    Ok(gone)
}

/// `upsertAccount(list, account, { uuid })`: a login replaces the entry with the same uuid and
/// drops a stale entry still holding the same name.
pub fn upsert(list: Vec<Value>, account: Value, uuid: Option<&Value>) -> Result<Vec<Value>, Failure> {
    let own = prop(Some(&account), "uuid").cloned();
    let uuid = uuid.cloned().or_else(|| own.clone());
    let name = name_lower(&account)?;
    let mut out = Vec::new();
    let mut placed = false;
    for a in list {
        if super::strict_eq(prop(Some(&a), "uuid"), uuid.as_ref()) {
            if !placed {
                out.push(account.clone());
            }
            placed = true;
        } else if !super::strict_eq(prop(Some(&a), "uuid"), own.as_ref()) && name_lower(&a)? != name {
            out.push(a);
        }
    }
    if !placed {
        out.push(account);
    }
    Ok(out)
}

/// `microsoftIdentities(list)`: the names and uuids (dashed and bare) of the signed-in Microsoft
/// accounts, which a diagnostics bundle must not carry.
pub fn microsoft_identities(list: &[Value]) -> Vec<String> {
    let mut out = Vec::new();
    for a in list {
        if prop(Some(a), "type") != Some(&json!("microsoft")) {
            continue;
        }
        if let Some(Value::String(n)) = prop(Some(a), "name")
            && crate::text::js_len(n) >= 3
        {
            out.push(n.clone());
        }
        if let Some(Value::String(u)) = prop(Some(a), "uuid")
            && crate::text::js_len(u) >= 32
        {
            out.push(u.clone());
            out.push(u.replace('-', ""));
        }
    }
    out
}

/// The text a person reads for an account's sign-in in `client accounts`.
pub fn state_text(a: &Value) -> String {
    if prop(Some(a), "type") == Some(&json!("offline")) {
        "offline (offline-mode servers only)".into()
    } else if js::truthy(prop(Some(a), "refreshFailedAt")) {
        format!(
            "sign in again (the saved sign-in stopped working {})",
            js::string(prop(Some(a), "refreshFailedAt"))
        )
    } else {
        format!("token until {}", js::string(prop(Some(a), "expiresAt")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_takes_a_uuid_first_then_a_name() {
        let list = vec![
            json!({ "name": "Steve", "uuid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }),
            json!({ "name": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "uuid": "b" }),
        ];
        assert_eq!(find(&list, "STEVE").unwrap(), Some(0));
        assert_eq!(find(&list, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap(), Some(0));
        assert_eq!(
            find(&list, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").unwrap(),
            Some(0)
        );
        assert_eq!(find(&list, "nobody").unwrap(), None);
        assert!(find(&[json!({ "uuid": "x" })], "x").is_err());
    }

    #[test]
    fn public_never_carries_a_token() {
        let a = json!({ "type": "microsoft", "name": "S", "uuid": "u", "accessToken": "t", "refreshToken": "r", "expiresAt": "2026" });
        assert_eq!(
            public(&a),
            json!({ "name": "S", "uuid": "u", "type": "microsoft", "expiresAt": "2026", "refreshFailedAt": null })
        );
        let old = json!({ "name": "S", "uuid": "u" });
        assert_eq!(public(&old)["type"], "microsoft");
        let off = json!({ "type": "offline", "name": "S", "uuid": "u", "expiresAt": "x" });
        assert_eq!(public(&off)["expiresAt"], Value::Null);
        // an entry with no name leaves the key out, as JSON.stringify drops undefined
        assert!(public(&json!({ "uuid": "u" })).get("name").is_none());
    }

    #[test]
    fn upsert_replaces_by_uuid_and_drops_a_stale_name() {
        let list = vec![
            json!({ "name": "Old", "uuid": "1" }),
            json!({ "name": "steve", "uuid": "2" }),
            json!({ "name": "Other", "uuid": "3" }),
        ];
        let got = upsert(list, json!({ "name": "Steve", "uuid": "1" }), None).unwrap();
        assert_eq!(
            got,
            vec![
                json!({ "name": "Steve", "uuid": "1" }),
                json!({ "name": "Other", "uuid": "3" })
            ]
        );
        let got = upsert(vec![], json!({ "name": "A", "uuid": "9" }), None).unwrap();
        assert_eq!(got.len(), 1);
    }

    #[test]
    fn same_uuid_ignores_case_and_dashes() {
        assert!(same_uuid(Some(&json!("AB-cd")), Some(&json!("abcd"))));
        assert!(same_uuid(None, Some(&json!(""))));
        assert!(!same_uuid(Some(&json!("a")), Some(&json!("b"))));
    }

    #[test]
    fn identities_are_microsoft_names_and_uuids() {
        let list = vec![
            json!({ "type": "microsoft", "name": "Steve", "uuid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }),
            json!({ "type": "offline", "name": "Alex", "uuid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }),
            json!({ "type": "microsoft", "name": "Al", "uuid": "short" }),
        ];
        assert_eq!(
            microsoft_identities(&list),
            vec![
                "Steve".to_string(),
                "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".to_string(),
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string()
            ]
        );
    }
}
