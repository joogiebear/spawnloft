// The declared differences (rust/PLAN-CORE-PORT.md section 6.1): the only ways a ported command
// may answer differently from its Node twin, and the only evening-out the rig applies between the
// two sides. Adding a row needs a reason in the pull request that adds it.
//
// A row with `apply` rewrites both sides' text to one form before the comparison; `commands`
// limits it to steps whose first argument is one of them. A row with `apply: null` is kept out
// of the scenarios by construction instead, and `held` says how.

const dropLines = (re) => (text) => text.split('\n').filter(line => !re.test(line)).join('\n')

export const DECLARED = [
  {
    id: 'doctor-node-line',
    where: '`doctor`, the diagnostics bundle, the panel\'s diagnostics',
    node: 'a `node: <version>` line and the code `root`; the bundle\'s facts name Node\'s version and `spawnloft` is package.json\'s, as is the panel\'s `SpawnLoft:` line',
    rust: 'a `core: spawnloft-core <version> (<target>)` line, no `root`; no `node` fact, and `spawnloft` (the panel\'s `SpawnLoft:` line too) is the core\'s own version',
    commands: ['doctor', 'diag', 'ui'],
    // text lines and JSON notes alike: "node: v22.1.0", "root: /path", "core: spawnloft-core 2.0.0 (...)";
    // diag's facts: "node":"v22.1.0" and "spawnloft":"<version>", and the text form's "spawnloft: <version>"
    apply: (text) => dropLines(/^\s*"?(?:node: v\d|root: |core: spawnloft-core )/)(text)
      .replace(/"(?:node: v[^"]*|root: [^"]*|core: spawnloft-core [^"]*)",?/g, '')
      .replace(/"node":\s*"v[^"]*",?\s*/g, '')
      .replace(/^spawnloft: .*$/gm, 'spawnloft: <version>')
      .replace(/"spawnloft"(\s*):(\s*)"[^"]*"/g, '"spawnloft"$1:$2"<version>"')
      .replace(/,\]/g, ']')
      // the panel's diagnostics: as text (the node or core line is gone by now), and in
      // /api/feedback inside a JSON string and inside the bug link's query
      .replace(/^SpawnLoft: \d.*$/gm, 'SpawnLoft: <version>')
      .replace(/SpawnLoft: \d[^\\"]*\\n(?:node: v|core: spawnloft-core )[^\\"]*\\n/g, 'SpawnLoft: <version>\\n')
      .replace(/SpawnLoft%3A\+\d[^%]*%0A(?:node%3A\+v[^%]*|core%3A\+spawnloft-core\+(?:(?!%0A).)*)%0A/g, 'SpawnLoft%3A+<version>%0A'),
  },
  {
    // found by C6b's Windows parity run: on a file whose entries all come from its folder (SDDL
    // `ID` flags, Get-Acl IsInherited), icacls can print them without "(I)", so Node's
    // icacls-based check calls the file private; the core reads the access list itself and sees
    // the inheritance. The text form's repair follows, with its "made owner-only" note.
    id: 'windows-inherited-acl',
    where: '`doctor` on Windows, a secrets file whose access list is all inherited',
    node: 'no problem when icacls prints the inherited entries without "(I)"',
    rust: '"other users on this computer can read ... (it inherits its folder\'s permissions ...)", and the text form makes it owner-only',
    commands: ['doctor'],
    // the line or JSON string that says so, and on Windows the problem counts it adds to
    apply: (text) => {
      // text lines only: a --json answer is one line, and only its string goes
      const out = dropLines(/^(?!\s*\{).*it inherits its folder's permissions/)(text)
        .replace(/"(?:[^"\\]|\\.)*it inherits its folder's permissions(?:[^"\\]|\\.)*",?/g, '')
        .replace(/,\]/g, ']')
      if (process.platform !== 'win32') return out
      return out
        .replace(/\b\d+ environment problem\(s\) found/g, '<n> environment problem(s) found')
        .replace(/^\d+ problem\(s\):$/gm, '<n> problem(s):')
    },
  },
  {
    id: 'repair-runtime',
    where: '`repair` text and `--json`',
    node: '`runtime: <node path>`',
    rust: 'the core\'s own path',
    commands: ['repair'],
    apply: (text) => text
      .replace(/^(\s*runtime: ).*$/gm, '$1<runtime>')
      .replace(/"runtime"(\s*):(\s*)"[^"]*"/g, '"runtime"$1:$2"<runtime>"'),
  },
  {
    // C10: the Node core's folder left with it; what was its path is now the core's own folder
    id: 'code-folder',
    where: '`repair --json`\'s `root`, `run/runtime.json`\'s `root`, the first-run wizard\'s `coreDir`',
    node: 'the Node core\'s folder (`resources/core`, a checkout in the rig)',
    rust: 'the folder holding spawnloft-core; `root` is written for 1.x and no longer compared',
    // a data root is the same on both sides and kept: it is always under the rig's scratch folder
    // (`<tmp>/sl-parity`, `<run>` once neutral), where no code folder is
    apply: (text) => text.replace(/"(root|coreDir)"(\s*):(\s*)"(?!<run>|[^"]*sl-parity)(?:[^"\\]|\\.)*"/g, '"$1"$2:$3"<code folder>"'),
  },
  {
    id: 'collation-outside-ascii',
    where: 'free-text sort order outside ASCII',
    node: 'ICU collation',
    rust: 'the port\'s comparison function (spawnloft-lib collate.rs)',
    apply: null,
    held: 'scenarios sort ASCII names only; test/fixtures/contracts/ordering.json pins the ASCII order on both sides',
  },
  {
    // found by the C0 review: not in the plan's table. Node's localeCompare() with no locale uses
    // the machine's, and Danish, Norwegian, Lithuanian, Estonian and others reorder ASCII letters
    // (Danish puts "aa" after "z"); collate.rs is the root order every en-US machine sees
    id: 'collation-machine-locale',
    where: 'sort order on a machine whose locale tailors ASCII letters (da, nb, lt, et, ...)',
    node: 'that locale\'s order',
    rust: 'the root order (what an en-US machine shows)',
    apply: null,
    held: 'the rig runs both sides with LANG and LC_ALL set to en_US.UTF-8',
  },
  {
    id: 'number-grouping',
    where: 'number grouping (`toLocaleString`, mcctl.mjs)',
    node: 'the system locale',
    rust: 'fixed en-US grouping',
    apply: null,
    held: 'the rig runs both sides with LANG and LC_ALL set to en_US.UTF-8 (Windows runners are en-US)',
  },
  {
    id: 'runtime-pattern-syntax',
    // C1 added the last three: a lone surrogate escape cannot be a Rust char, a count beyond
    // 2^32 cannot be a Rust repetition, and the crate caps a pattern's compiled size and nesting
    where: 'a run-time pattern using lookaround, a backreference, a lone surrogate escape (`\\uD83D`), a repetition count beyond 2^32, or more than the matcher\'s size or nesting allows (`logs --grep`, MCP `get_logs`; not bot scenarios, whose patterns the host matches in JavaScript)',
    node: 'accepted',
    rust: 'refused with a clear message',
    apply: null,
    held: 'scenarios give such a pattern only in a step that expects the refusal, and test/fixtures/contracts/regex.json lists the sites',
  },
  {
    id: 'invalid-pattern-text',
    where: 'the error text for an invalid run-time pattern',
    node: 'V8\'s (`Invalid regular expression: /(/: Unterminated group`)',
    rust: 'the `regex` crate\'s',
    commands: ['logs', 'log', 'mcp', 'bot'],
    // the message after the fixed prefix each core prints; the Rust side keeps the same prefix
    apply: (text) => text
      .replace(/Invalid regular expression: [^\n"]*/g, '<invalid pattern>')
      .replace(/regex parse error:[^\n"]*/g, '<invalid pattern>'),
  },
  {
    // found in C1: a failure that is not a person's mistake (a registry that is not JSON, a file
    // that cannot be read, a nonsense -n) prints the error and then JavaScript's stack, whose
    // lines name the Node core's own files and line numbers; the Rust core prints the first line
    id: 'internal-error-stack',
    where: 'an unexpected failure (a file that is not JSON or cannot be read, a nonsense argument)',
    node: 'the error line, then JavaScript\'s stack (`    at ...` lines)',
    rust: 'the error line alone',
    apply: (text) => text.replace(/^ {4}at [^\n]*\n?/gm, ''),
  },
  {
    // found in C1: JSON.parse's messages are V8's ("Expected ',' or '}' after property value in
    // JSON at position 41 (line 1 column 42)"); the Rust core says "JSON parse error: " and
    // serde_json's own text. The prefix and exit code are the same; only the description differs
    id: 'json-parse-error-text',
    where: 'the text of a JSON file that does not parse (registry, state file, settings)',
    node: 'V8\'s `JSON.parse` message',
    rust: '`JSON parse error: ` and serde_json\'s message',
    apply: (text) => text
      .replace(/Unexpected end of JSON input|(?:Unexpected token|Expected |Bad (?:control|escaped|Unicode)|Unterminated (?:string|fractional)|No number after|Exponent part|Unexpected non-whitespace|Unexpected (?:number|string))[^\n]*?(?:in JSON at position \d+(?: \(line \d+ column \d+\))?|is not valid JSON)/g, '<invalid json>')
      .replace(/JSON parse error: [^\n")]*/g, '<invalid json>'),
  },
  {
    // found by the C1 review: without the u flag JavaScript sees an emoji as two UTF-16 units,
    // so `.` matches half of one and `[😀]` is a class of two halves; the Rust matcher works in
    // whole characters
    id: 'pattern-astral-units',
    where: 'a run-time pattern meeting a character outside the Basic Multilingual Plane (an emoji)',
    node: 'matched as two UTF-16 units (`^.{2} x` matches `😀 x`)',
    rust: 'matched as one character (`^. x` matches `😀 x`)',
    apply: null,
    held: 'scenarios grep consoles whose emoji the pattern matches whole or not at all; test/fixtures/contracts/js-patterns.json has no pattern that splits one',
  },
  {
    // found by the C1 review: a label cut at 48 UTF-16 units can end in half of an emoji, which
    // the registry then holds as "\ud83d". Node prints it as U+FFFD and re-escapes it in --json;
    // a Rust string cannot hold the half, so it reads as U+FFFD from the start
    id: 'lone-surrogate',
    where: 'a JSON file holding half of a surrogate pair (`"\\ud83d"`), or a jar manifest string the reader cuts inside a pair (an unterminated `\'\'\'` string in mods.toml)',
    node: 'kept; printed as U+FFFD, re-escaped as `\\ud83d` in JSON output',
    rust: 'read as U+FFFD, printed and written as that character',
    apply: (text) => text.replace(/\\ud[89a-f][0-9a-f]{2}/gi, '\ufffd'),
  },
  {
    // found by the C1 review: JSON.parse reads 1e400 as Infinity; serde_json refuses it
    id: 'json-number-out-of-range',
    where: 'a JSON file holding a number beyond the double range (`1e400`)',
    node: 'read as Infinity',
    rust: 'refused as a file that does not parse',
    apply: null,
    held: 'no SpawnLoft writer can produce one (JSON.stringify writes Infinity as null); a mod\'s own fabric.mod.json could, and its row then falls back to mods.toml or the file name (no published mod writes one); scenarios do not hand-write one',
  },
  {
    // found by the C5 modpack review: zlib names what is wrong with a stream; miniz does not
    id: 'inflate-error-text',
    where: 'a zip entry (a jar, a modpack override) whose deflate data is corrupt',
    node: "zlib's message (`invalid code lengths set`, `invalid distance too far back`, ...)",
    rust: '`invalid compressed data` or `unexpected end of file`',
    apply: null,
    held: 'the exit code and the cleanup are the same; scenarios ship no corrupt deflate stream',
  },
  {
    // found by the C5 modpack review: undici asks for and undoes gzip, deflate and br; ureq is
    // built without them
    id: 'content-encoding',
    where: 'a download or an API answer sent with `Content-Encoding` (gzip, deflate, br)',
    node: 'asks for it (`accept-encoding`) and decodes it',
    rust: 'asks for none and reads the bytes as sent, so a compressed answer fails its size or checksum, or does not parse',
    apply: null,
    held: 'a server compresses only when asked, and Rust never asks; the fake hosts never compress',
  },
  {
    // found by the C5 review: js_sort (spawnloft-lib plugins.rs) is V8's TimSort below 64 items
    // only; beyond, it makes a superset of V8's comparisons
    id: 'sort-comparisons-over-64',
    where: '`plugins` on a folder of 64 or more jars, one of whose manifests gives a name that is not text',
    node: 'lists, unless V8\'s merge happens to compare that name on the left',
    rust: 'can fail with `a.name.localeCompare is not a function` where Node lists',
    apply: null,
    held: 'scenarios list fewer than 64 jars, or only text names',
  },
  {
    // design D4 (rust/INSTALLER-UPDATER-DESIGN.md): 2.0's daemon records daemonStartTime, the
    // kernel creation time of its process, which a reused pid cannot repeat; Node never reads it
    id: 'process-start-time',
    where: 'a state file whose `daemonStartTime` (written by 2.0\'s daemon) differs from the live process under that pid',
    node: 'the field is ignored; the pid and the image name decide',
    rust: 'the creation time decides where the system reports one',
    apply: null,
    held: 'the Node daemon never writes the field; scenarios write it only as the running daemon\'s own',
  },
  {
    // found by the C1 review: paths.mjs resolves the layout on import, so a setting such as
    // {"dataRoot": 5} crashes the Node core before main() runs, printing Node's source excerpt,
    // the stack, the error's properties and its version line
    id: 'settings-type-crash',
    where: 'a settings value of the wrong type (`"dataRoot": 5`)',
    node: 'an uncaught crash: source excerpt, the error line, the stack, `{ code: ... }` and `Node.js v<version>`',
    rust: 'the error line alone, exit 1',
    apply: (text) => text
      .replace(/^node:[\w/]+:\d+\n[^\n]*\n *\^\n\n/m, '')
      // the stack (and the ` {` that ends its last line) is gone by now: internal-error-stack
      .replace(/^ {2}code: '[A-Z_]+'\n\}\n\nNode\.js v[^\n]*\n/m, ''),
  },
  {
    // C2: the forwarding binary hands its pipes to the Node core, whose detached daemon keeps a
    // copy; spawnloft-core clears the inherit flag on its standard handles before a detached start
    id: 'windows-daemon-holds-pipes',
    where: 'Windows: `start`, `restart`, `db create` for a server (which starts it), `task run` of a start or restart task and `client launch` (the game), read through a pipe (the rig, a script capturing the output)',
    node: 'the pipe stays open after the command exits, until the server or the game stops (the rig waits 10 s and notes it)',
    rust: 'the pipe closes when the command exits',
    commands: ['start', 'restart', 'db', 'task', 'client'],
    apply: dropLines(/^rig: the command exited but its output stayed open/),
  },
  {
    // C2: readline goes on emitting the lines of a chunk it already read after close()
    id: 'console-after-detach',
    where: '`console` (`attach`) given `/detach` or `/exit` with more lines behind it in the same read (piped input)',
    node: 'the lines after it in that read are still sent to the server',
    rust: 'nothing after `/detach` or `/exit` is sent',
    apply: null,
    held: 'scenarios feed `console` input that ends at `/detach` or `/exit`, or none',
  },
  {
    // plan section 3.4 and test/fixtures/contracts/C0-CHECKS.md section 2
    id: 'data-root-code-folder',
    where: 'a checkout whose code folder holds `instances.json` and no settings choose a data root',
    node: 'the code folder is the data root (and is listed among other registries)',
    rust: 'the per-user data folder; the code folder is never a data root',
    apply: null,
    held: 'no installed build can be in that state (C0-CHECKS.md section 2); the rig\'s code folder is the checkout, which has no instances.json',
  },
  {
    // C9 (plan section 5.4): the Rust core has no code folder to run the host from after C10, so
    // it carries bot-host.cjs inside itself and writes it beside mineflayer before each run
    id: 'bot-host-script',
    where: '`bot run` once mineflayer is installed: where the Mineflayer host script lives and which Node runs it',
    node: 'runs `src/bot-host.cjs` from the code folder on its own Node',
    rust: 'writes its embedded copy to `bot-host/bot-host.cjs` in the data folder and runs it there, on the bundled runtime\'s Node, else `node` on PATH, with `NODE_OPTIONS` and `NODE_PATH` removed',
    apply: null,
    held: 'c9-bot ignores data/bot-host/bot-host.cjs; nothing but the host run reads it, and both sides run the same script on the same Node in the rig',
  },
]

// Both sides' text for one step, evened out by every row that applies to it.
export function applyDeclared(text, command) {
  let out = text
  for (const row of DECLARED) {
    if (!row.apply) continue
    if (row.commands && !row.commands.includes(command)) continue
    out = row.apply(out)
  }
  return out
}

// The table as Markdown, for the README (node tools/parity/run.mjs --declared).
export function declaredTable() {
  const lines = ['| Where | Node | Rust | How the rig holds it |', '| --- | --- | --- | --- |']
  for (const r of DECLARED) lines.push(`| ${r.where} | ${r.node} | ${r.rust} | ${r.apply ? `evened out (\`${r.id}\`)` : r.held} |`)
  return lines.join('\n')
}
