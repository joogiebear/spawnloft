//! Wall-clock times as the Node core writes them: milliseconds since the epoch, and ISO 8601 in UTC
//! with milliseconds (`Date.prototype.toISOString`).

use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch, like `Date.now()`.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Seconds since the epoch with a fraction, like `Date.now() / 1000`.
pub fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// `2026-11-08T18:33:54.123Z` for a time in milliseconds.
pub fn iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let milli = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{milli:03}Z",
        sod / 3600,
        sod % 3600 / 60,
        sod % 60
    )
}

/// The current time as [`iso`].
pub fn iso_now() -> String {
    iso(now_ms())
}

/// Seconds since the epoch for `2026-12-01T18:02:11Z` (or with a fraction, or `+00:00`); `None`
/// for anything else. The updater's feed timestamps are compared with this, so only the UTC form
/// release tooling writes is accepted, never a local offset.
pub fn parse_iso_utc(text: &str) -> Option<i64> {
    let t = text.trim();
    let b = t.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    if !t.is_ascii() {
        return None;
    }
    let num = |s: &str| -> Option<i64> {
        if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        s.parse().ok()
    };
    let (y, m, d) = (num(&t[0..4])?, num(&t[5..7])?, num(&t[8..10])?);
    let (hh, mm, ss) = (num(&t[11..13])?, num(&t[14..16])?, num(&t[17..19])?);
    let mut rest = &t[19..];
    if let Some(stripped) = rest.strip_prefix('.') {
        let digits = stripped.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        rest = &stripped[digits..];
    }
    if rest != "Z" && rest != "+00:00" {
        return None;
    }
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    let days = days_from_civil(y, m as u32, d as u32);
    // reject the 31st of a 30-day month and so on by round-tripping
    if civil_from_days(days) != (y, m as u32, d as u32) {
        return None;
    }
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss)
}

// Howard Hinnant's civil-to-days algorithm, the inverse of civil_from_days.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// Howard Hinnant's days-to-civil algorithm, exact for the proleptic Gregorian calendar.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::{iso, parse_iso_utc};

    #[test]
    fn parses_what_iso_writes_and_only_utc() {
        assert_eq!(parse_iso_utc("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_utc("2025-11-08T18:33:54.123Z"), Some(1_762_626_834));
        assert_eq!(parse_iso_utc("2025-11-08T18:33:54+00:00"), Some(1_762_626_834));
        assert_eq!(parse_iso_utc(" 2000-02-29T00:00:00Z\n"), Some(951_782_400));
        assert_eq!(parse_iso_utc("2001-02-29T00:00:00Z"), None);
        assert_eq!(parse_iso_utc("2025-11-08T18:33:54+01:00"), None);
        assert_eq!(parse_iso_utc("2025-11-08 18:33:54Z"), None);
        assert_eq!(parse_iso_utc("2025-11-08T18:33:54.Z"), None);
        assert_eq!(parse_iso_utc("not a date"), None);
        for ms in [0i64, 1_762_626_834_123, 4_102_444_799_999, 951_782_400_000] {
            assert_eq!(parse_iso_utc(&iso(ms)), Some(ms.div_euclid(1000)));
        }
    }

    #[test]
    fn formats_like_to_iso_string() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_762_626_834_123), "2025-11-08T18:33:54.123Z");
        assert_eq!(iso(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso(4_102_444_799_999), "2099-12-31T23:59:59.999Z");
    }
}
