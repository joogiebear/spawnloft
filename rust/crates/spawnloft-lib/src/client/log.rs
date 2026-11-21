//! `client-log.mjs`: the game's process output as plain lines. Since the Log4Shell fix the game
//! writes log4j XML events to stdout (Mojang's `logging.client` config); this turns them back
//! into latest.log's own lines (`[21:03:01] [Render thread/INFO]: Stopping!`). Anything that is
//! not an event passes through as it is.

use regex::{Captures, Regex};
use std::sync::LazyLock;

use super::paths::Paths;
use crate::failure::Failure;

// JavaScript's `\s`, for the patterns below
const JS_SPACE: &str =
    r"\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";

static EVENT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[ \t]*<log4j:Event(?-u:\b)([^>]*)>((?s:.)*?)</log4j:Event>").expect("valid")
});
static ATTR_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"([A-Za-z0-9_:]+)="([^"]*)""#).expect("valid"));
static ENTITY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&(amp|lt|gt|quot|apos);").expect("valid"));
static TRAILING_SPACE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("[{JS_SPACE}]+$")).expect("valid"));
static SECTIONS: LazyLock<[(&str, Regex); 2]> = LazyLock::new(|| {
    ["Message", "Throwable"].map(|name| {
        (
            name,
            Regex::new(&format!("<log4j:{name}>((?s:.)*?)</log4j:{name}>")).expect("valid"),
        )
    })
});

fn decode(s: &str) -> String {
    ENTITY_RE
        .replace_all(s, |c: &Captures<'_>| match &c[1] {
            "amp" => "&",
            "lt" => "<",
            "gt" => ">",
            "quot" => "\"",
            _ => "'",
        })
        .into_owned()
}

fn attribute<'a>(attrs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    // later duplicates win, as assignment to an object does
    attrs
        .iter()
        .rev()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

/// `<log4j:Message><![CDATA[...]]></log4j:Message>`: CDATA is literal text; log4j writes a
/// `]]>` inside a message as `]]>]]&gt;<![CDATA[`, so the markers go first and that one entity
/// after.
fn section(body: &str, name: &str) -> String {
    let re = &SECTIONS
        .iter()
        .find(|(n, _)| *n == name)
        .expect("known section")
        .1;
    match re.captures(body) {
        None => String::new(),
        Some(m) => m[1]
            .replace("<![CDATA[", "")
            .replace("]]>", "")
            .replace("]]&gt;", "]]>"),
    }
}

/// `clockTime(ms)`: the clock as latest.log prints it, in this machine's time zone.
pub fn clock_time(ms: f64) -> String {
    // new Date(ms) keeps the whole milliseconds of a time within the date range
    let t = if ms.is_finite() && ms.abs() <= 8.64e15 {
        ms.trunc()
    } else {
        f64::NAN
    };
    match crate::jsdate::local_fields(t) {
        Some(f) => format!("{:02}:{:02}:{:02}", f.hour, f.minute, f.second),
        None => "??:??:??".into(),
    }
}

/// `plainClientLog(text)`.
pub fn plain(text: &str) -> String {
    plain_with(text, &clock_time)
}

pub fn plain_with(text: &str, clock: &dyn Fn(f64) -> String) -> String {
    if !text.contains("log4j:Event") {
        return text.to_string();
    }
    let mut text = text.to_string();
    // a tail that begins inside an event: what is left of that event is not readable
    let first_open = text.find("<log4j:Event");
    let first_close = text.find("</log4j:Event>");
    if let Some(close) = first_close
        && first_open.is_none_or(|open| close < open)
    {
        let rest = &text[close + "</log4j:Event>".len()..];
        let rest = rest
            .strip_prefix("\r\n")
            .or_else(|| rest.strip_prefix('\n'))
            .unwrap_or(rest);
        text = rest.to_string();
    }
    let mut out = EVENT_RE
        .replace_all(&text, |c: &Captures<'_>| {
            let attrs: Vec<(String, String)> = ATTR_RE
                .captures_iter(&c[1])
                .map(|m| (m[1].to_string(), decode(&m[2])))
                .collect();
            // Number(undefined) is NaN
            let stamp = attribute(&attrs, "timestamp").map_or(f64::NAN, crate::js::string_to_number);
            let line = format!(
                "[{}] [{}/{}]: {}",
                clock(stamp),
                attribute(&attrs, "thread").unwrap_or("?"),
                attribute(&attrs, "level").unwrap_or("INFO"),
                section(&c[2], "Message")
            );
            let thrown = section(&c[2], "Throwable");
            let thrown = TRAILING_SPACE.replace(&thrown, "");
            if thrown.is_empty() {
                line
            } else {
                format!("{line}\n{thrown}")
            }
        })
        .into_owned();
    // an event still being written at the end (the game is running) is not readable either
    if let Some(open) = out.rfind("<log4j:Event") {
        out = TRAILING_SPACE.replace(&out[..open], "").into_owned();
    }
    out
}

/// `text.split(/\r?\n/)`.
pub fn split_lines(text: &str) -> Vec<String> {
    text.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect()
}

/// `tailClientLog(name, count)`: the last lines of the process capture, as plain lines. An event
/// is a handful of raw lines, hence the window of at least 64 KB.
pub fn tail(paths: &Paths, name: &str, count: f64) -> Result<Vec<String>, Failure> {
    let file = paths.log(name);
    let path = std::path::Path::new(&file);
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if crate::jspath::is_enoent(&e) => return Ok(Vec::new()),
        Err(e) => return Err(Failure::io(&e, "stat", Some(path))),
    };
    let size = meta.len();
    let want = (count * 2048.0).max(65536.0);
    let read_bytes = if (size as f64) < want { size } else { want as u64 };
    let mut buf = vec![0u8; read_bytes as usize];
    {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = std::fs::File::open(path).map_err(|e| Failure::io(&e, "open", Some(path)))?;
        f.seek(SeekFrom::Start(size - read_bytes))
            .map_err(|e| Failure::io(&e, "read", None))?;
        let mut got = 0;
        while got < buf.len() {
            match f.read(&mut buf[got..]) {
                Ok(0) => break,
                Ok(n) => got += n,
                Err(e) => return Err(Failure::io(&e, "read", None)),
            }
        }
        buf.truncate(got);
        buf.resize(read_bytes as usize, 0);
    }
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if size > read_bytes {
        text = match text.find('\n') {
            None => String::new(),
            Some(nl) => text[nl + 1..].to_string(),
        };
    }
    let mut lines = split_lines(&plain(&text));
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    Ok(last(lines, count))
}

/// `lines.slice(-count)` for a whole count of at least one.
pub fn last(lines: Vec<String>, count: f64) -> Vec<String> {
    let keep = if count >= lines.len() as f64 {
        lines.len()
    } else {
        count as usize
    };
    let skip = lines.len() - keep;
    lines.into_iter().skip(skip).collect()
}

/// `latestLogPath(name)`: the game's own latest.log.
pub fn latest_path(paths: &Paths, name: &str) -> String {
    crate::jspath::join(&[&paths.profile_dir(name), "logs", "latest.log"])
}

/// `redactClientLine(line)`: the harness token, the Minecraft access token and the old versions'
/// session string, as the diag bundle redacts them.
pub fn redact_line(line: &str) -> String {
    static TOKEN: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(&format!(r"spawnloft\.harness\.token=[^{JS_SPACE}]+")).expect("valid"));
    static ACCESS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(&format!(r"(--accessToken[{JS_SPACE}=]+)[^{JS_SPACE}]+")).expect("valid")
    });
    static SESSION: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(&format!(r"(?-u:\b)token:[^:{JS_SPACE}]+:")).expect("valid"));
    let a = TOKEN.replace_all(line, "spawnloft.harness.token=[redacted]");
    let b = ACCESS.replace_all(&a, "${1}[redacted]");
    SESSION.replace_all(&b, "token:[redacted]:").into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed(ms: f64) -> String {
        if ms.is_nan() {
            "??:??:??".into()
        } else {
            format!("t{ms}")
        }
    }

    #[test]
    fn events_become_latest_log_lines() {
        let xml = concat!(
            "<log4j:Event logger=\"x\" timestamp=\"1700000000000\" level=\"WARN\" thread=\"Render thread\">\n",
            "  <log4j:Message><![CDATA[a <b> & ]]>]]&gt;<![CDATA[ c]]></log4j:Message>\n",
            "  <log4j:Throwable><![CDATA[java.lang.X: boom\n\tat y\n]]></log4j:Throwable>\n",
            "</log4j:Event>\n",
            "plain line\n",
            "<log4j:Event timestamp=\"x\" thread=\"a&amp;b\"><log4j:Message><![CDATA[hi]]></log4j:Message></log4j:Event>\n",
        );
        assert_eq!(
            plain_with(xml, &fixed),
            "[t1700000000000] [Render thread/WARN]: a <b> & ]]> c\njava.lang.X: boom\n\tat y\nplain line\n[??:??:??] [a&b/INFO]: hi\n"
        );
    }

    #[test]
    fn half_events_at_either_end_are_dropped() {
        let text = "ge></log4j:Message></log4j:Event>\r\nkept\n<log4j:Event timestamp=\"1\"><log4j:Mess";
        assert_eq!(plain_with(text, &fixed), "kept");
        assert_eq!(plain_with("no events here", &fixed), "no events here");
    }

    #[test]
    fn redaction_covers_the_three_secrets() {
        assert_eq!(
            redact_line("java -Dspawnloft.harness.token=abc --accessToken  xyz --x token:abc:uuid:"),
            "java -Dspawnloft.harness.token=[redacted] --accessToken  [redacted] --x token:[redacted]:uuid:"
        );
    }

    #[test]
    fn last_takes_the_tail() {
        let l = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(last(l(&["a", "b", "c"]), 2.0), l(&["b", "c"]));
        assert_eq!(last(l(&["a"]), 5.0), l(&["a"]));
    }
}
