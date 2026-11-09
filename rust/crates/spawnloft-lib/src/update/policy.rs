//! Whether a verified envelope may be offered (INSTALLER-UPDATER-DESIGN.md 5.3 and 5.5 step 3):
//! newer than the installed version, not held, not a replay, within `minVersion`, and able to
//! read the data folder. A rollback the person asked for (5.6) has its own, smaller rule set.
//! Pure functions over values, so every rule has a unit test.

use std::fmt;

use semver::Version;

use super::envelope::{Channel, Envelope};

/// The data-folder format this build reads and writes (`data-format.json`, design section 8).
pub const DATA_FORMAT: u32 = 1;

/// The oldest `generatedAt` any feed may carry for this build: the build's own release date,
/// set by the release tooling through `SPAWNLOFT_FEED_BASELINE`; the day the updater was written
/// otherwise. A replayed envelope older than this is refused on a fresh install too.
pub const FEED_BASELINE: &str = match option_env!("SPAWNLOFT_FEED_BASELINE") {
    Some(s) if !s.is_empty() => s,
    _ => "2026-11-09T00:00:00Z",
};

/// What the client knows about itself when it judges a feed.
#[derive(Debug, Clone)]
pub struct Install<'a> {
    pub version: &'a Version,
    pub channel: Channel,
    /// The format of the data folder (`data-format.json`), or this build's when there is none.
    pub data_format: u32,
    /// Seconds since the epoch of the baked-in baseline.
    pub baseline_secs: i64,
    /// `generatedAt` of the newest envelope this install has accepted before.
    pub last_accepted_secs: Option<i64>,
    /// `update-hold.json`: versions up to and including this one are not offered.
    pub hold_below: Option<&'a Version>,
    pub now_secs: i64,
}

/// Not an error, just not this one: the caller moves on to the next candidate or reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Skip {
    /// The release is not above the installed version.
    NotNewer,
    /// Within the hold a rollback left.
    Held,
    /// The installed version is below `minVersion`: a lower release must be taken first.
    NeedsHop { min_version: Version },
}

/// A verified envelope that must not be installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reason {
    /// `generatedAt` older than the baseline or the last accepted feed.
    Replayed { generated_at: i64, floor: i64 },
    /// The release's build could not read this data folder.
    DataFormatBelow { feed: u32, data: u32 },
    /// A rollback target whose data format differs from the data folder's.
    DataFormatDiffers { feed: u32, data: u32 },
    /// A rollback target that is not below the installed version.
    NotLower,
}

impl fmt::Display for Reason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Reason::Replayed { generated_at, floor } => write!(
                f,
                "the feed was generated at {} but this SpawnLoft has already seen one from {} (a replayed feed)",
                crate::time::iso(generated_at * 1000),
                crate::time::iso(floor * 1000)
            ),
            Reason::DataFormatBelow { feed, data } => write!(
                f,
                "this version writes data format {feed}, but your data is already format {data}; it could not read it"
            ),
            Reason::DataFormatDiffers { feed, data } => write!(
                f,
                "this version uses data format {feed}; your data is format {data} and this version cannot read it as it is now"
            ),
            Reason::NotLower => write!(f, "a rollback must name a version below the installed one"),
        }
    }
}

impl Reason {
    pub fn code(&self) -> &'static str {
        match self {
            Reason::Replayed { .. } => "replayed",
            Reason::DataFormatBelow { .. } => "data-format",
            Reason::DataFormatDiffers { .. } => "data-format",
            Reason::NotLower => "not-lower",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Offer it. `stale` says `expiresAt` has passed (accepted, but reported).
    Offer {
        stale: bool,
    },
    Skip(Skip),
    Refuse(Reason),
}

/// The rule for an update check: a candidate the discovery step put forward.
pub fn judge_update(install: &Install<'_>, env: &Envelope) -> Verdict {
    debug_assert_eq!(env.channel, install.channel);
    if env.version <= *install.version {
        return Verdict::Skip(Skip::NotNewer);
    }
    if let Some(hold) = install.hold_below
        && env.version <= *hold
    {
        return Verdict::Skip(Skip::Held);
    }
    let floor = install
        .last_accepted_secs
        .map_or(install.baseline_secs, |l| l.max(install.baseline_secs));
    if env.generated_at_secs < floor {
        return Verdict::Refuse(Reason::Replayed {
            generated_at: env.generated_at_secs,
            floor,
        });
    }
    if *install.version < env.min_version {
        return Verdict::Skip(Skip::NeedsHop {
            min_version: env.min_version.clone(),
        });
    }
    if env.data_format < install.data_format {
        return Verdict::Refuse(Reason::DataFormatBelow {
            feed: env.data_format,
            data: install.data_format,
        });
    }
    Verdict::Offer {
        stale: is_stale(install, env),
    }
}

/// The rule for a rollback the person chose: below the installed version, the same data format
/// (unless forced from the CLI), no freshness rule (an older feed is the point).
pub fn judge_rollback(install: &Install<'_>, env: &Envelope, force_data_format: bool) -> Verdict {
    debug_assert_eq!(env.channel, install.channel);
    if env.version >= *install.version {
        return Verdict::Refuse(Reason::NotLower);
    }
    if env.data_format != install.data_format && !force_data_format {
        return Verdict::Refuse(Reason::DataFormatDiffers {
            feed: env.data_format,
            data: install.data_format,
        });
    }
    Verdict::Offer {
        stale: is_stale(install, env),
    }
}

/// `expiresAt` has passed: the host may be frozen (design 5.3, review item 7).
pub fn is_stale(install: &Install<'_>, env: &Envelope) -> bool {
    env.expires_at_secs.is_some_and(|e| e < install.now_secs)
}

#[cfg(test)]
mod tests {
    use super::super::envelope::testkit::*;
    use super::super::envelope::{Expect, parse};
    use super::*;

    fn env(version: &str, edit: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>)) -> Envelope {
        parse(&envelope_json("0000000000000000", version, edit), beta()).unwrap()
    }

    fn install<'a>(version: &'a Version, hold: Option<&'a Version>) -> Install<'a> {
        Install {
            version,
            channel: Channel::Beta,
            data_format: 1,
            baseline_secs: crate::time::parse_iso_utc("2026-11-09T00:00:00Z").unwrap(),
            last_accepted_secs: None,
            hold_below: hold,
            now_secs: crate::time::parse_iso_utc("2026-12-02T00:00:00Z").unwrap(),
        }
    }

    const V: fn(&str) -> Version = |s| Version::parse(s).unwrap();

    #[test]
    fn newer_is_offered_and_lower_or_equal_is_not() {
        let installed = V("2.0.0-beta.2");
        let i = install(&installed, None);
        assert_eq!(
            judge_update(&i, &env("2.0.0-beta.3", |_| {})),
            Verdict::Offer { stale: false }
        );
        assert_eq!(
            judge_update(&i, &env("2.0.0-beta.2", |_| {})),
            Verdict::Skip(Skip::NotNewer)
        );
        assert_eq!(
            judge_update(&i, &env("2.0.0-beta.1", |_| {})),
            Verdict::Skip(Skip::NotNewer)
        );
        // a stable above a beta is an update on the beta channel
        assert_eq!(
            judge_update(&i, &env("2.0.0", |_| {})),
            Verdict::Offer { stale: false }
        );
    }

    #[test]
    fn replayed_feeds_are_refused_against_baseline_and_last_accepted() {
        let installed = V("2.0.0-beta.2");
        let mut i = install(&installed, None);
        let old = env("2.0.0-beta.3", |m| {
            m.insert("generatedAt".into(), "2026-11-08T23:59:59Z".into());
        });
        assert!(matches!(
            judge_update(&i, &old),
            Verdict::Refuse(Reason::Replayed { .. })
        ));
        // accepted once at 2026-12-01T18:02:11Z, then an envelope from a day before comes back
        i.last_accepted_secs = crate::time::parse_iso_utc("2026-12-01T18:02:11Z");
        let before = env("2.0.0-beta.4", |m| {
            m.insert("generatedAt".into(), "2026-11-30T00:00:00Z".into());
        });
        assert!(matches!(
            judge_update(&i, &before),
            Verdict::Refuse(Reason::Replayed { .. })
        ));
        // the same moment is fine (the same envelope seen again)
        assert_eq!(
            judge_update(&i, &env("2.0.0-beta.3", |_| {})),
            Verdict::Offer { stale: false }
        );
        // a fresh install with a feed exactly at the baseline is fine
        i.last_accepted_secs = None;
        let at = env("2.0.0-beta.3", |m| {
            m.insert("generatedAt".into(), "2026-11-09T00:00:00Z".into());
        });
        assert_eq!(judge_update(&i, &at), Verdict::Offer { stale: false });
    }

    #[test]
    fn min_version_asks_for_a_hop() {
        let installed = V("2.0.0-beta.2");
        let i = install(&installed, None);
        let e = env("2.1.0", |m| {
            m.insert("minVersion".into(), "2.0.0".into());
        });
        assert_eq!(
            judge_update(&i, &e),
            Verdict::Skip(Skip::NeedsHop {
                min_version: V("2.0.0")
            })
        );
        let e = env("2.1.0", |m| {
            m.insert("minVersion".into(), "2.0.0-beta.2".into());
        });
        assert_eq!(judge_update(&i, &e), Verdict::Offer { stale: false });
    }

    #[test]
    fn data_format_rules() {
        let installed = V("2.0.0-beta.2");
        let mut i = install(&installed, None);
        i.data_format = 2;
        let e = env("2.0.0-beta.3", |_| {});
        assert_eq!(
            judge_update(&i, &e),
            Verdict::Refuse(Reason::DataFormatBelow { feed: 1, data: 2 })
        );
        let e3 = env("2.0.0-beta.3", |m| {
            m.insert("dataFormat".into(), 3.into());
        });
        assert_eq!(judge_update(&i, &e3), Verdict::Offer { stale: false });
        // rollback: equality or --force-data-format
        let e1 = env("2.0.0-beta.1", |_| {});
        assert_eq!(
            judge_rollback(&i, &e1, false),
            Verdict::Refuse(Reason::DataFormatDiffers { feed: 1, data: 2 })
        );
        assert_eq!(judge_rollback(&i, &e1, true), Verdict::Offer { stale: false });
    }

    #[test]
    fn hold_skips_up_to_the_held_version_and_not_above() {
        let installed = V("2.0.0");
        let held = V("2.1.0");
        let i = install(&installed, Some(&held));
        assert_eq!(judge_update(&i, &env("2.0.1", |_| {})), Verdict::Skip(Skip::Held));
        assert_eq!(judge_update(&i, &env("2.1.0", |_| {})), Verdict::Skip(Skip::Held));
        assert_eq!(
            judge_update(&i, &env("2.1.1", |_| {})),
            Verdict::Offer { stale: false }
        );
    }

    #[test]
    fn rollback_rules_ignore_freshness_but_need_a_lower_version() {
        let installed = V("2.1.0");
        let mut i = install(&installed, None);
        i.last_accepted_secs = crate::time::parse_iso_utc("2027-01-01T00:00:00Z");
        let e = env("2.0.0", |m| {
            m.insert("generatedAt".into(), "2026-11-20T00:00:00Z".into());
        });
        assert_eq!(judge_rollback(&i, &e, false), Verdict::Offer { stale: false });
        assert_eq!(
            judge_rollback(&i, &env("2.1.0", |_| {}), false),
            Verdict::Refuse(Reason::NotLower)
        );
        assert_eq!(
            judge_rollback(&i, &env("2.2.0", |_| {}), false),
            Verdict::Refuse(Reason::NotLower)
        );
    }

    #[test]
    fn expired_is_accepted_but_stale() {
        let installed = V("2.0.0-beta.2");
        let i = install(&installed, None);
        let e = env("2.0.0-beta.3", |m| {
            m.insert("expiresAt".into(), "2026-12-01T00:00:00Z".into());
        });
        assert_eq!(judge_update(&i, &e), Verdict::Offer { stale: true });
        let e = env("2.0.0-beta.3", |m| {
            m.remove("expiresAt");
        });
        assert_eq!(judge_update(&i, &e), Verdict::Offer { stale: false });
    }

    #[test]
    fn baseline_constant_parses() {
        assert!(crate::time::parse_iso_utc(FEED_BASELINE).is_some());
        let _ = Expect {
            channel: Channel::Beta,
            download_base: BASE,
        };
    }
}
