'use strict';
// -------------------------------------------------------------- console ----

/**
 * What level a console line is.
 *
 * Paper does not have one log format, it has four, and all of them turn up in a single session:
 *
 *   Starting org.bukkit.craftbukkit.Main                          (before logging is configured)
 *   2026-08-31T05:42:27.5Z ServerMain WARN Advanced terminal...   (log4j, pre-init, no brackets)
 *   [00:42:27 INFO]: [bootstrap] Running Java 25 ...              (normal Paper)
 *   [12:34:56] [Server thread/INFO]: ...                          (vanilla-style, some forks)
 *
 * Plus stack traces, which are the whole reason anyone opens a console and which carry no level of
 * their own. A trace inherits the level of the line that introduced it - otherwise "filter to
 * errors" shows the one-line summary and hides the twenty lines saying what actually broke.
 */
const LEVEL_RE = /\[(?:[^\]]*[\/ ])?(INFO|WARN|WARNING|ERROR|SEVERE|FATAL|DEBUG|TRACE)\]/i;
const BARE_LEVEL_RE = /^\S+\s+\S+\s+(INFO|WARN|WARNING|ERROR|SEVERE|FATAL)\s/;
const CONT_RE = /^(?:\s+|at\s|Caused by:|Suppressed:|\.\.\.\s*\d+\s+more)/;
const EXC_RE = /^[a-z][\w.$]*(?:\.[A-Z][\w$]*)+(?::|\s*$)/;
const MCCTL_RE = /^\[(?:spawnloft|mcctl)\]/; // consoles written before the rename say [mcctl]

function levelOf(text, previous) {
  if (MCCTL_RE.test(text)) return 'sys';
  const m = LEVEL_RE.exec(text) || BARE_LEVEL_RE.exec(text);
  if (m) {
    const lvl = m[1].toUpperCase();
    if (lvl === 'ERROR' || lvl === 'SEVERE' || lvl === 'FATAL') return 'error';
    if (lvl === 'WARN' || lvl === 'WARNING') return 'warn';
    return 'info';
  }
  if (CONT_RE.test(text) || EXC_RE.test(text)) return previous === 'sys' ? 'info' : (previous || 'info');
  return 'info';
}

// The repeated scaffolding - timestamp, level, thread - is dimmed so the message leads. It is
// still there; it just stops competing with what you are reading.
const PREFIX_RE = /^(\[[^\]]*\](?:\s*\[[^\]]*\])?:?\s*)/;

function makeLine(entry) {
  const div = document.createElement('div');
  div.className = 'ln' + (entry.level === 'info' ? '' : ' ' + entry.level);
  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = entry.n;
  div.append(num);
  const txt = document.createElement('span');
  txt.className = 'txt';
  const pm = PREFIX_RE.exec(entry.text);
  const prefix = pm ? pm[1] : '';
  if (prefix) {
    const s = document.createElement('span');
    s.className = 'pre';
    s.textContent = prefix;
    txt.append(s);
  }
  appendSearched(txt, pm ? entry.text.slice(prefix.length) : entry.text);
  div.append(txt);
  return div;
}

// Highlighting is built from text nodes and <mark>, never from innerHTML. A server name, a plugin
// message or a jar filename is not markup and must never get the chance to become it.
function appendSearched(parent, text) {
  const needle = state.search.toLowerCase();
  if (!needle) { parent.append(document.createTextNode(text)); return; }
  const hay = text.toLowerCase();
  let at = 0;
  for (;;) {
    const hit = hay.indexOf(needle, at);
    if (hit === -1) break;
    if (hit > at) parent.append(document.createTextNode(text.slice(at, hit)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(hit, hit + needle.length);
    parent.append(mark);
    at = hit + needle.length;
  }
  if (at < text.length) parent.append(document.createTextNode(text.slice(at)));
}

function visible(entry) {
  if (state.filter === 'error' && entry.level !== 'error') return false;
  if (state.filter === 'warn' && entry.level !== 'warn' && entry.level !== 'error') return false;
  if (state.search && !entry.text.toLowerCase().includes(state.search.toLowerCase())) return false;
  return true;
}

/*
  How many warnings and errors the console holds, beside the filters that would show them.
  Counted by the line that raises one, not by every line of its stack trace: "Errors 1" for a
  twenty-line exception is the answer to "how many things went wrong".
*/
const levelCounts = { warn: 0, error: 0 };
const raisesLevel = (entry) => (entry.level === 'warn' || entry.level === 'error') && !CONT_RE.test(entry.text) && !EXC_RE.test(entry.text);

function updateCount(shown) {
  $('#nWarn').textContent = String(levelCounts.warn);
  $('#nErr').textContent = String(levelCounts.error);
  const total = state.lines.length;
  const count = shown == null ? state.lines.filter(visible).length : shown;
  const filtered = state.filter !== 'all' || Boolean(state.search);
  const held = state.paused ? total - state.pausedAt : 0;
  let text = filtered ? count + ' of ' + total + ' lines' : total + (total === 1 ? ' line' : ' lines');
  if (held > 0) text = held + ' held \u00b7 ' + text;
  $('#conCount').textContent = text;
}

function renderLog() {
  const log = $('#log');
  log.textContent = '';
  const frag = document.createDocumentFragment();
  let shown = 0;
  for (const entry of state.lines) {
    if (!visible(entry)) continue;
    frag.append(makeLine(entry));
    shown++;
  }
  log.append(frag);
  if (!shown) {
    const p = document.createElement('div');
    p.className = 'log-empty';
    const row = rowOf(state.current);
    p.textContent = state.lines.length
      ? 'Nothing matches. Clear the search or the level filter to see the rest.'
      : row && isDb(row) && row.external ? 'This database runs elsewhere, so its log is on that machine, not here.'
        : row && isDb(row) ? 'No output yet. Start the database and its log appears here as it runs.'
          : 'No console output yet. Start the server and it appears here as it runs.';
    log.append(p);
  }
  updateCount(shown);
  if (state.atBottom) log.scrollTop = log.scrollHeight;
}

// The panel is a log reader, not a terminal. Strip formatting before classifying, searching
// or copying so an escape inside WARN cannot hide a warning. Keep indentation and Unicode.
const ANSI_STRING_RE = /(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)|(?:\x1b[P^_]|\x90|\x9e|\x9f)[^\x1b\x9c]*(?:\x1b\\|\x9c|$)/g;
const ANSI_CSI_RE = /(?:\x1b\[|\x9b)[0-?]*[ -/]*(?:[@-~]|$)/g;
const ANSI_ESCAPE_RE = /\x1b[ -/]*[0-~]/g;
const LOG_CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
function cleanConsoleText(text) {
  return text.replace(ANSI_STRING_RE, '').replace(ANSI_CSI_RE, '')
    .replace(ANSI_ESCAPE_RE, '').replace(LOG_CONTROL_RE, '');
}

function pushLine(text) {
  text = cleanConsoleText(text);
  const prev = state.lines.length ? state.lines[state.lines.length - 1].level : null;
  const entry = { text: text, level: levelOf(text, prev), n: ++state.seq };
  state.lines.push(entry);
  if (raisesLevel(entry)) levelCounts[entry.level]++;
  updateConMini();

  // A busy server writes thousands of lines a minute. Without a ceiling the panel keeps a DOM node
  // per line until the window stops responding - a bug that only appears after someone has left it
  // open for an afternoon, which is exactly the session this tool is for.
  const log = $('#log');
  while (state.lines.length > MAX_LINES) {
    const gone = state.lines.shift();
    if (raisesLevel(gone)) levelCounts[gone.level]--;
    if (state.pausedAt > 0) state.pausedAt--;
    // Only drop a node if that line had one. With a filter on, most lines never reached the DOM.
    if (visible(gone)) {
      const first = log.firstElementChild;
      if (first && !first.classList.contains('log-empty')) first.remove();
    }
  }

  if (state.paused || !visible(entry)) { updateCount(); return; }

  const placeholder = log.querySelector('.log-empty');
  if (placeholder) placeholder.remove();
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.append(makeLine(entry));
  if (atBottom) log.scrollTop = log.scrollHeight;
  else { state.unseen++; paintJump(); }
  updateCount();
}

function clearLines() {
  state.lines = [];
  state.seq = 0;
  levelCounts.warn = 0;
  levelCounts.error = 0;
  updateConMini();
}

function stopStream() {
  if (state.stream) state.stream.close();
  state.stream = null;
  state.streamName = null;
}

/** What the question says before unsaved Settings changes are left behind for another server. */
function leaveSettingsWords(waiting, label) {
  const n = waiting.count;
  return {
    title: 'Leave ' + label + ' without saving?',
    text: (n === 1 ? '1 change' : n + ' changes') + ' in its Settings ' + (n === 1 ? 'has' : 'have') + ' not been saved, and will be lost.',
    confirmLabel: n === 1 ? 'Discard the change' : 'Discard the changes',
    danger: true,
  };
}

function select(name, { discard = false, then = null } = {}) {
  if (state.current === name && state.view === 'server' && state.streamName === name) { if (then) then(); return; }
  // Settings is one form per page, drawn for one server. Choosing another draws it again, so
  // whatever is typed and not saved is asked about first. The question is the only async step:
  // the choice is made again, for real, once it is answered.
  const waiting = settingsWaiting();
  if (waiting && waiting.name !== name && !discard) {
    const left = rowOf(waiting.name);
    // `then` is what the caller wanted done once the server is open, a tool to show for one. It
    // waits for the answer with the choice, and is dropped with it.
    ask(leaveSettingsWords(waiting, (left && left.label) || waiting.name)).then((ok) => { if (ok) select(name, { discard: true, then }); });
    return;
  }
  sheetStack.length = 0;
  state.current = name;
  clearLines();
  state.paused = false;
  state.pausedAt = 0;
  state.atBottom = true;
  if (!state.histories.has(name)) state.histories.set(name, []);
  state.history = state.histories.get(name);
  state.histAt = state.history.length;
  state.draft = '';
  state.unseen = 0;
  state.search = '';
  setPauseButton(false);
  $('#conSearch').value = '';
  $('#bJump').hidden = true;
  setFilter('all');

  stopStream();
  show('server');
  // The settings pane caches which server it drew, so a different one must not inherit it. Coming
  // back to the same server with changes waiting keeps the form those changes are in.
  if (!waiting || waiting.name !== name) $('#settingsBody').dataset.for = '';
  $('#backupsBody').dataset.for = '';
  $('#schedulerBody').dataset.for = '';
  $('#playersBody').dataset.for = '';
  $('#pluginsBody').dataset.for = '';
  $('#worldsBody').dataset.for = '';
  $('#performanceBody').dataset.for = '';
  $('#srvDiag').textContent = '';
  diagKey = '';
  const chosen = rowOf(name);
  renderServer(chosen);
  // From now, not from the next poll: a Start pressed in the seconds between is a change too.
  if (chosen) followFrom(chosen);
  const saved = recallTool(name);
  setTool(saved.tool);
  renderLog();
  renderList(state.rows, state.dbs);
  $('#list [data-name="' + CSS.escape(name) + '"]')?.scrollIntoView({ block: 'nearest' });
  startVitals(name);

  // Server-Sent Events rather than polling: the console is a stream by nature, and the browser
  // reconnects on its own if the panel is left open while a server restarts.
  const stream = new EventSource('/api/instances/' + encodeURIComponent(name) + '/stream');
  state.stream = stream;
  state.streamName = name;
  stream.onmessage = (e) => {
    if (state.streamName !== name) return;
    let line;
    try { line = JSON.parse(e.data); } catch { return; }
    pushLine(line);
  };
  // The server replays the last 200 lines on every connection, so a dropped stream would otherwise
  // paste them in a second time and make it look like the server repeated itself. Clearing on
  // reconnect keeps the console honest about what actually happened.
  stream.onerror = () => {
    if (state.streamName !== name || stream.readyState !== EventSource.CONNECTING) return;
    clearLines();
    state.pausedAt = 0;
    renderLog();
  };
  if (then) then();
  refresh();
}

