// What the rig evens out before it compares the two sides: only values that differ from one run
// to the next on the same core (times, pids, lock tokens, durations). Both sides run in the same
// scratch folder one after the other, so paths need no rewriting to be compared. Differences
// between the cores themselves are evened out only by ../declared-differences.mjs.

const VOLATILE = [
  // ISO times, with or without a fraction and a zone
  [/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>'],
  // "2026-11-21 03:17:44" and "2026-11-21 03:17", as tables and logs print them
  [/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?\b/g, '<time>'],
  // the stamp in a backup's, an export's or a bundle's file name (standard_2026-11-21_033246)
  [/20\d{2}-[01]\d-[0-3]\d_\d{6}/g, '<stamp>'],
  // a bare date: "added" columns and file names made today
  [/\b20\d{2}-[01]\d-[0-3]\d\b/g, '<date>'],
  // a pid, in JSON (pid, javaPid, daemonPid, holderPid, ...) and in text
  [/"(\w*[pP]id)"(\s*):(\s*)\d+/g, '"$1"$2:$3<pid>'],
  [/\b(pid)([ =:]+)\d+/gi, '$1$2<pid>'],
  // a lock's token (src/util.mjs tryLock) and other per-run secrets
  [/"(token)"(\s*):(\s*)"[^"]*"/g, '"$1"$2:$3"<token>"'],
  // milliseconds since 1970, 2017 to 2033: written into state, metrics and activity records
  [/\b1[5-9]\d{11}\b/g, '<epoch-ms>'],
  // durations in JSON (uptimeMs, tookMs, ...) and in text
  [/"(\w*Ms)"(\s*):(\s*)\d+(?:\.\d+)?/g, '"$1"$2:$3<ms>'],
  [/\b\d+(?:\.\d+)? ?ms\b/g, '<ms>'],
]

// `extra` is a scenario's own list: [{ pattern, flags, replace }], for a value it knows is volatile.
export function normalizeText(text, extra = []) {
  let out = text
  for (const [re, to] of VOLATILE) out = out.replace(re, to)
  for (const rule of extra) out = out.replace(new RegExp(rule.pattern, rule.flags ?? 'g'), rule.replace ?? '<volatile>')
  return out
}

// For golden files, which are compared across machines: the machine's own paths become names.
export function machineNeutral(text, { run, repo, node, core }) {
  let out = text
  const pairs = [[run, '<run>'], [repo, '<repo>'], [node, '<node>'], [core, '<core>']].filter(([p]) => p)
  // longest first, so <run> wins over a <repo> that contains it (or the reverse)
  pairs.sort((a, b) => b[0].length - a[0].length)
  for (const [p, name] of pairs) {
    for (const form of new Set([JSON.stringify(p).slice(1, -1), p, p.replaceAll('\\', '/')])) out = out.split(form).join(name)
  }
  // and what follows a placeholder with Windows separators (plain or JSON-escaped) uses /, so one
  // golden file serves every platform
  return out.replace(/(<(?:run|repo)>)((?:\\{1,2}[^\\\s"'<>]+)+)/g, (_, name, tail) => name + tail.replace(/\\{1,2}/g, '/'))
}
