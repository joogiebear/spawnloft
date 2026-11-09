//! Which releases exist (INSTALLER-UPDATER-DESIGN.md 5.2): the tags in `releases.atom`, or in
//! the GitHub releases API when the atom window (about ten entries) is not enough. Only the tag
//! names are taken from either; the order GitHub gives is never trusted (P0-E 4b), and nothing
//! here is authenticated: the envelope fetched for a chosen tag is what gets verified.

use semver::Version;

/// A release tag as a version: `v2.0.0-beta.3` -> 2.0.0-beta.3. Anything that is not `v` plus
/// strict semver is not a SpawnLoft release.
pub fn tag_version(tag: &str) -> Option<Version> {
    let rest = tag.strip_prefix('v')?;
    if rest.len() > 64 {
        return None;
    }
    Version::parse(rest).ok()
}

/// The tags named by the atom feed's entry links (`.../releases/tag/<tag>`), in document order.
/// GitHub lists bare tags (no release yet) here too; a tag without an envelope is skipped later
/// by the 404 rule.
pub fn tags_from_atom(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find("/releases/tag/") {
        let after = &rest[i + "/releases/tag/".len()..];
        let end = after
            .find(|c: char| c == '"' || c == '\'' || c == '<' || c == '&' || c.is_whitespace())
            .unwrap_or(after.len());
        let tag = &after[..end];
        if !tag.is_empty() && tag.len() <= 80 && !out.iter().any(|t| t == tag) {
            out.push(tag.to_string());
        }
        rest = &after[end..];
    }
    out
}

/// The tags of one page of `GET /repos/<owner>/<repo>/releases`, drafts left out.
pub fn tags_from_api(json: &[u8]) -> Result<Vec<String>, String> {
    let doc: serde_json::Value =
        serde_json::from_slice(json).map_err(|e| format!("releases API: not JSON: {e}"))?;
    let serde_json::Value::Array(list) = doc else {
        return Err("releases API: not a list".to_string());
    };
    let mut out = Vec::new();
    for item in &list {
        if item.get("draft").and_then(|d| d.as_bool()) == Some(true) {
            continue;
        }
        if let Some(tag) = item.get("tag_name").and_then(|t| t.as_str())
            && !tag.is_empty()
            && tag.len() <= 80
        {
            out.push(tag.to_string());
        }
    }
    Ok(out)
}

/// A release that may be looked at: its version and tag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub version: Version,
    pub tag: String,
}

/// The releases of `channel` among `tags`, highest version first, each tag once. 1.x tags, `next`
/// and `internal` prereleases and tags that are not semver fall out here.
pub fn candidates(tags: &[String], channel: super::envelope::Channel) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = Vec::new();
    for tag in tags {
        let Some(version) = tag_version(tag) else { continue };
        if version.major < 2 || !channel.accepts(&version) {
            continue;
        }
        if out.iter().any(|c| c.version == version) {
            continue;
        }
        out.push(Candidate {
            version,
            tag: tag.clone(),
        });
    }
    out.sort_by(|a, b| b.version.cmp(&a.version));
    out
}

#[cfg(test)]
mod tests {
    use super::super::envelope::Channel;
    use super::*;

    const ATOM: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/joogiebear/spawnloft/releases</id>
  <link type="text/html" rel="alternate" href="https://github.com/joogiebear/spawnloft/releases"/>
  <entry>
    <id>tag:github.com,2008:Repository/1/v2.0.0-beta.2</id>
    <updated>2026-12-01T18:02:11Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/joogiebear/spawnloft/releases/tag/v2.0.0-beta.2"/>
    <title>v2.0.0-beta.2</title>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1/v1.6.0-beta.413</id>
    <link rel="alternate" type="text/html" href="https://github.com/joogiebear/spawnloft/releases/tag/v1.6.0-beta.413"/>
  </entry>
  <entry>
    <link rel="alternate" type="text/html" href="https://github.com/joogiebear/spawnloft/releases/tag/v2.0.0-next.4"/>
  </entry>
  <entry>
    <link rel="alternate" type="text/html" href="https://github.com/joogiebear/spawnloft/releases/tag/v2.0.0-beta.3"/>
  </entry>
  <entry>
    <link rel="alternate" type="text/html" href="https://github.com/joogiebear/spawnloft/releases/tag/v2.0.0"/>
  </entry>
  <entry>
    <link rel="alternate" type="text/html" href="https://github.com/joogiebear/spawnloft/releases/tag/index"/>
  </entry>
  <entry>
    <link rel="alternate" type="text/html" href="https://github.com/joogiebear/spawnloft/releases/tag/v1.5.0"/>
  </entry>
</feed>"#;

    #[test]
    fn atom_tags_in_order() {
        assert_eq!(
            tags_from_atom(ATOM),
            [
                "v2.0.0-beta.2",
                "v1.6.0-beta.413",
                "v2.0.0-next.4",
                "v2.0.0-beta.3",
                "v2.0.0",
                "index",
                "v1.5.0"
            ]
        );
        assert!(tags_from_atom("<feed></feed>").is_empty());
    }

    #[test]
    fn selection_ignores_github_order_and_other_channels() {
        let tags = tags_from_atom(ATOM);
        let beta: Vec<String> = candidates(&tags, Channel::Beta)
            .iter()
            .map(|c| c.tag.clone())
            .collect();
        assert_eq!(beta, ["v2.0.0", "v2.0.0-beta.3", "v2.0.0-beta.2"]);
        let stable: Vec<String> = candidates(&tags, Channel::Stable)
            .iter()
            .map(|c| c.tag.clone())
            .collect();
        assert_eq!(stable, ["v2.0.0"]);
    }

    #[test]
    fn api_tags_skip_drafts() {
        let json = br#"[{"tag_name":"v2.0.1","draft":false,"prerelease":false},{"tag_name":"v2.0.2","draft":true},{"name":"no tag"}]"#;
        assert_eq!(tags_from_api(json).unwrap(), ["v2.0.1"]);
        assert!(tags_from_api(b"{}").is_err());
    }

    #[test]
    fn tag_versions() {
        assert_eq!(tag_version("v2.0.0-beta.3").unwrap().to_string(), "2.0.0-beta.3");
        assert!(tag_version("2.0.0").is_none());
        assert!(tag_version("v2.0").is_none());
        assert!(tag_version("index").is_none());
    }
}
