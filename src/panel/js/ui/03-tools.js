'use strict';
// ------------------------------------------------------------------ tools ----

/**
 * The tools a server has, beside the console in the sidebar.
 *
 * <p>Each opens in the console's place - one thing at a time, and on a wide window the console keeps
 * a column of its own. The console keeps streaming either way: its lines are appended to an element
 * that may be hidden, which costs nothing, and means coming back to it has the scrollback intact.
 */
const TOOL_NAMES = {
  plugins: 'Plugins', files: 'Files', worlds: 'Worlds', backups: 'Backups', activity: 'Activity', players: 'Players',
  performance: 'Stats', scheduler: 'Schedule', settings: 'Settings',
};
// A database has no plugins, worlds, players or tasks of its own. Its Backups are SQL dumps, and
// its Activity is its starts, stops and crashes.
const DB_TOOLS = new Set(['performance', 'backups', 'activity', 'settings']);

const toolView = { tool: null };

/*
  The open tool, remembered per server: someone who keeps Plugins open on the modded server and
  nothing open on the lobby should come back to both that way.
  localStorage can be missing or refuse (a locked-down profile, a private window), and a panel that
  fails to remember still opens.
*/
function toolKey(name) { return 'mcctl.tool.' + name; }

function recallTool(name) {
  try {
    const saved = JSON.parse(localStorage.getItem(toolKey(name)) || 'null');
    if (saved && (saved.tool === null || Object.hasOwn(TOOL_NAMES, saved.tool))) return { tool: saved.tool };
  } catch { /* nothing remembered is the same as nothing open */ }
  // A database's console is its log, rarely what anyone opened it for, and an external one has
  // none here at all. It opens on its connection details and attached servers instead.
  const row = rowOf(name);
  return { tool: row && isDb(row) ? 'settings' : null };
}

function rememberTool() {
  if (!state.current || consoleOnly) return;
  try { localStorage.setItem(toolKey(state.current), JSON.stringify(toolView)); } catch { /* see recallTool */ }
}

const paneId = (tool) => 'pane' + tool[0].toUpperCase() + tool.slice(1);
const dockId = (tool) => 'tab' + tool[0].toUpperCase() + tool.slice(1);

function toolLabel(tool) {
  return tool === 'plugins' ? $('#tabPlugins .lbl').textContent : TOOL_NAMES[tool];
}

/** Open a tool in the console's place, or close it and show the console (tool null). */
function setTool(tool) {
  if (consoleOnly) tool = null;
  if (tool && isDb(rowOf(state.current)) && !DB_TOOLS.has(tool)) tool = null;
  toolView.tool = tool || null;
  state.pane = toolView.tool || 'console';

  const work = $('#work');
  work.toggleAttribute('data-tool', Boolean(toolView.tool));
  $('#toolPanel').hidden = !toolView.tool;
  $('#conMini').hidden = !toolView.tool;
  $('#tabConsole').setAttribute('aria-current', toolView.tool ? 'false' : 'page');
  for (const b of $$('.dock [data-pane]')) b.setAttribute('aria-expanded', String(b.dataset.pane === toolView.tool));
  for (const el of $$('.tool .pane')) el.toggleAttribute('data-active', Boolean(toolView.tool) && el.id === paneId(toolView.tool));

  const t = toolView.tool;
  if (t) $('#toolTitle').textContent = toolLabel(t);
  if (t === 'settings') renderServerSettings();
  if (t === 'backups') renderBackupsTool();
  // Read afresh each time they are opened, unless a half-filled form is waiting there: who is
  // online and what ran last night are the point of these two, and both change with nobody here.
  if (t === 'scheduler') renderScheduler({ force: !paneHolds($('#schedulerBody')) });
  if (t === 'players') renderPlayers({ force: !paneHolds($('#playersBody')) });
  if (t === 'plugins') renderPlugins();
  if (t === 'worlds') renderWorlds();
  if (t === 'files') renderFiles();
  // Always read afresh: history is the one tool whose whole point is what changed since last time.
  if (t === 'activity') renderActivity();
  if (t === 'performance') renderPerformance();
  // Only a visible Stats tool polls. A graph nobody is looking at is a request every ten seconds
  // for as long as the app is open.
  if (t !== 'performance') stopPerfPolling();

  if (toolView.tool) {
    updateConMini();
  } else if (state.atBottom) {
    // Scroll position is not kept while a pre is hidden, so the console has to be put back where
    // it was - and "at the bottom" is where it was for anyone who had not scrolled up.
    const log = $('#log');
    log.scrollTop = log.scrollHeight;
  }
  rememberTool();
}

/**
 * Show one part of the selected server - the name every finding and shortcut in the panel already
 * calls. 'console' means the console: whatever tool had its place closes.
 */
function showPane(pane) {
  if (pane === 'console') { if (toolView.tool) setTool(null); return; }
  if (toolView.tool === pane) return;
  setTool(pane);
}

// Pressing the open tool's row again closes it; the console comes back.
for (const b of $$('.dock [data-pane]')) {
  b.onclick = () => {
    const tool = b.dataset.pane;
    setTool(toolView.tool === tool ? null : tool);
  };
}
$('#tabConsole').onclick = () => setTool(null);

function closeTool() {
  const was = toolView.tool;
  rowMenu.close(false);
  setTool(null);
  // Focus goes back to the button that opened it, not to the top of the page with the panel gone.
  if (was) $('#' + dockId(was))?.focus();
}

$('#toolClose').onclick = closeTool;
$('#conMini').onclick = () => setTool(null);
$('#conMini').title = 'Back to the console';

/** The console's one line while a tool fills its space: its newest line and how many errors. */
function updateConMini() {
  if (!toolView.tool) return;
  const last = state.lines.length ? state.lines[state.lines.length - 1].text : '';
  $('#conMiniLast').textContent = last;
  $('#conMiniErr').textContent = levelCounts.error
    ? levelCounts.error + (levelCounts.error === 1 ? ' error' : ' errors') : '';
}

