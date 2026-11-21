//! The parts of JavaScript's `Date` that work in local time, for the log timeline: reading a
//! date's local fields, `setDate` and `setHours`, and `new Date(text)` for the two timestamp
//! shapes a log line can carry. Times are milliseconds since the epoch as `f64`, NaN for an
//! invalid date, as in JavaScript.
//!
//! The zone is the system's (`platform::local_offset_secs`). A local time that does not exist (the
//! hour skipped when clocks go forward) or exists twice (the hour repeated when they go back)
//! takes the offset from before the change, as V8 does.

const DAY_MS: f64 = 86_400_000.0;
/// `TimeClip`: a date further than this from the epoch is invalid.
const MAX_MS: f64 = 8.64e15;

fn clip(t: f64) -> f64 {
    if !t.is_finite() || t.abs() > MAX_MS {
        f64::NAN
    } else {
        t.trunc() + 0.0
    }
}

/// Local time minus UTC at the UTC time `t`, in milliseconds.
pub fn offset_at(t: f64) -> f64 {
    if !t.is_finite() {
        return 0.0;
    }
    crate::platform::local_offset_secs((t / 1000.0).floor() as i64) as f64 * 1000.0
}

/// `UTC(t)` for a local time: the offset in force before a nearby change wins for a skipped or a
/// repeated local time.
pub fn utc_of_local(local: f64) -> f64 {
    if !local.is_finite() {
        return f64::NAN;
    }
    let before = offset_at(local - DAY_MS);
    let after = offset_at(local + DAY_MS);
    if before == after {
        return local - before;
    }
    let early = local - before;
    if offset_at(early) == before {
        return early;
    }
    let late = local - after;
    if offset_at(late) == after {
        return late;
    }
    early
}

/// A date's fields in local time: year, month (1-12), day, hours, minutes, seconds, ms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fields {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
    pub ms: u32,
}

fn fields_of(local: f64) -> Fields {
    let local = local as i64;
    let days = local.div_euclid(86_400_000);
    let in_day = local.rem_euclid(86_400_000);
    let (year, month, day) = crate::time::civil_from_days(days);
    Fields {
        year,
        month,
        day,
        hour: (in_day / 3_600_000) as u32,
        minute: (in_day / 60_000 % 60) as u32,
        second: (in_day / 1000 % 60) as u32,
        ms: (in_day % 1000) as u32,
    }
}

/// The local fields of the UTC time `t` (`getFullYear`, `getHours`...); `None` for NaN.
pub fn local_fields(t: f64) -> Option<Fields> {
    t.is_finite().then(|| fields_of(t + offset_at(t)))
}

/// `MakeDay(year, month, date)` with JavaScript's overflow: day 0 is the last of the month before.
fn make_day(year: i64, month: i64, date: f64) -> f64 {
    let y = year + month.div_euclid(12);
    let m = month.rem_euclid(12) as u32 + 1;
    crate::time::days_from_civil(y, m, 1) as f64 + date - 1.0
}

/// `d.setDate(date)`: the same local time of day on another day of the same month (overflowing
/// into the next ones).
pub fn set_date(t: f64, date: f64) -> f64 {
    let Some(f) = local_fields(t) else {
        return f64::NAN;
    };
    let local = t + offset_at(t);
    let time_in_day = local.rem_euclid(DAY_MS);
    clip(utc_of_local(
        make_day(f.year, i64::from(f.month) - 1, date) * DAY_MS + time_in_day,
    ))
}

/// `d.setHours(h, m, s, ms)`, on the date's local day.
pub fn set_hours(t: f64, h: f64, m: f64, s: f64, ms: f64) -> f64 {
    if !t.is_finite() {
        return f64::NAN;
    }
    let local = t + offset_at(t);
    let day = (local / DAY_MS).floor();
    clip(utc_of_local(
        day * DAY_MS + h * 3_600_000.0 + m * 60_000.0 + s * 1000.0 + ms,
    ))
}

/// `toISOString`; `None` where JavaScript throws (an invalid date).
pub fn to_iso(t: f64) -> Option<String> {
    t.is_finite().then(|| crate::time::iso(t as i64))
}

fn digits(s: &[u8]) -> Option<i64> {
    if s.is_empty() || !s.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(s).ok()?.parse().ok()
}

/// `new Date(text).getTime()` for the shapes a log line's timestamp has
/// (`YYYY-MM-DD[Tt ]HH:MM:SS[.fff][Z|+HH:MM|+HHMM]`), each with V8's rules: a `T` (either case)
/// is the ISO form, a space the legacy parser, which reads a year below 100 as 19xx or 20xx and
/// takes any hours and minutes in a colonless offset. Both overflow day 29 to 31 into the next month,
/// and a time with no offset is local. Anything else is NaN. Not followed: the legacy parser's
/// reading of a year from 0001 to 0031 as a month and day (`0001-10-09` is 2009-01-10 in V8),
/// which no log writes.
pub fn parse(text: &str) -> f64 {
    let b = text.as_bytes();
    // the six-digit signed year toISOString writes outside 0-9999 (ISO form only)
    if let [sign @ (b'+' | b'-'), rest @ ..] = b
        && rest.len() > 6
        && let Some(y) = digits(&rest[..6])
        && !(*sign == b'-' && y == 0)
    {
        let mut shaped = b"0000".to_vec();
        shaped.extend_from_slice(&rest[6..]);
        if !matches!(shaped.get(10), Some(b'T' | b't')) {
            return f64::NAN;
        }
        let year = if *sign == b'-' { -y } else { y };
        return parse_parts(&shaped, Some(year)).unwrap_or(f64::NAN);
    }
    parse_parts(b, None).unwrap_or(f64::NAN)
}

fn parse_parts(b: &[u8], year_override: Option<i64>) -> Option<f64> {
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let iso = match b[10] {
        b'T' | b't' => true,
        b' ' => false,
        _ => return None,
    };
    let mut year = match year_override {
        Some(y) => y,
        None => digits(&b[0..4])?,
    };
    let month = digits(&b[5..7])?;
    let day = digits(&b[8..10])?;
    let hour = digits(&b[11..13])?;
    let minute = digits(&b[14..16])?;
    let second = digits(&b[17..19])?;
    let mut rest = &b[19..];
    let mut ms = 0i64;
    let mut fraction_zero = true;
    if let Some(after) = rest.strip_prefix(b".") {
        let n = after.iter().take_while(|c| c.is_ascii_digit()).count();
        if n == 0 {
            return None;
        }
        let f = &after[..n];
        fraction_zero = f.iter().all(|&c| c == b'0');
        let mut three = [b'0'; 3];
        for (slot, &c) in three.iter_mut().zip(f) {
            *slot = c;
        }
        ms = digits(&three)?;
        rest = &after[n..];
    }
    // the offset in minutes east of UTC, or none (local time)
    let offset: Option<i64> = match rest {
        [] => None,
        [b'Z'] => Some(0),
        [sign @ (b'+' | b'-'), tail @ ..] => {
            let sign = if *sign == b'+' { 1 } else { -1 };
            let minutes = match tail {
                [h1, h2, b':', m1, m2] => {
                    let (h, m) = (digits(&[*h1, *h2])?, digits(&[*m1, *m2])?);
                    if m > 59 || (iso && h > 23) {
                        return None;
                    }
                    h * 60 + m
                }
                [_, _, _, _] => {
                    let n = digits(tail)?;
                    let (h, m) = (n / 100, n % 100);
                    if iso && (h > 23 || m > 59) {
                        return None;
                    }
                    h * 60 + m
                }
                _ => return None,
            };
            Some(sign * minutes)
        }
        _ => return None,
    };
    if !iso && year < 100 {
        year += if year < 50 { 2000 } else { 1900 };
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || minute > 59 || second > 59 || hour > 24 {
        return None;
    }
    if hour == 24 && (minute != 0 || second != 0 || (iso && !fraction_zero) || (!iso && ms != 0)) {
        return None;
    }
    let local = make_day(year, month - 1, day as f64) * DAY_MS
        + (hour * 3_600_000 + minute * 60_000 + second * 1000 + ms) as f64;
    let t = match offset {
        Some(east) => local - east as f64 * 60_000.0,
        None => utc_of_local(local),
    };
    let t = clip(t);
    (!t.is_nan()).then_some(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_utc_forms_without_the_zone() {
        let at = |s: &str| to_iso(parse(s));
        assert_eq!(
            at("2026-08-31T05:42:27.5Z").as_deref(),
            Some("2026-08-31T05:42:27.500Z")
        );
        assert_eq!(
            at("2026-08-31 05:42:27.123456Z").as_deref(),
            Some("2026-08-31T05:42:27.123Z")
        );
        assert_eq!(
            at("2026-08-31t05:42:27+0100").as_deref(),
            Some("2026-08-31T04:42:27.000Z")
        );
        assert_eq!(
            at("2026-08-31 05:42:27+0099").as_deref(),
            Some("2026-08-31T04:03:27.000Z")
        );
        assert_eq!(
            at("2026-08-31 05:42:27+2400").as_deref(),
            Some("2026-08-30T05:42:27.000Z")
        );
        assert_eq!(
            at("2026-08-31 05:42:27+0023").as_deref(),
            Some("2026-08-31T05:19:27.000Z")
        );
        assert_eq!(
            at("2026-02-30T05:42:27Z").as_deref(),
            Some("2026-03-02T05:42:27.000Z")
        );
        assert_eq!(
            at("2026-08-31T24:00:00.000Z").as_deref(),
            Some("2026-09-01T00:00:00.000Z")
        );
        assert_eq!(
            at("0001-01-01 00:00:00Z").as_deref(),
            Some("2001-01-01T00:00:00.000Z")
        );
        assert_eq!(
            at("0001-01-01T00:00:00Z").as_deref(),
            Some("0001-01-01T00:00:00.000Z")
        );
        for bad in [
            "2026-13-31T05:42:27Z",
            "2026-02-32T05:42:27Z",
            "2026-08-31T24:00:00.001Z",
            "2026-08-31T05:42:27+2400",
            "2026-08-31T05:42:27+24:00",
            "2026-08-31 05:42:27+23:60",
            "2026-08-31T05:42:27.Z",
            "2026-08-31T25:00:00Z",
            "2026-08-31 05:42:60Z",
        ] {
            assert!(parse(bad).is_nan(), "{bad}");
        }
    }
}
