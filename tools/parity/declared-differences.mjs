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
    node: 'a `node: <version>` line and the code `root`',
    rust: 'the core\'s version; no `root`',
    commands: ['doctor', 'diag'],
    // text lines and JSON notes alike: "node: v22.1.0", "root: /path"
    apply: (text) => dropLines(/^\s*"?(?:node: v\d|root: )/)(text)
      .replace(/"(?:node: v[^"]*|root: [^"]*)",?/g, '')
      .replace(/,\]/g, ']'),
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
    where: 'a run-time pattern using lookaround or a backreference (`logs --grep`, MCP `get_logs`, bot scenarios)',
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
