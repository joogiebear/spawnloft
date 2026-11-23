'use strict';
// ------------------------------------------------------------------ tools ----

/**
 * The tools a server has, as tabs under its header beside the console's.
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
  return tool === 'plugins' ? $('#tabPlugins [data-label]').textContent : TOOL_NAMES[tool];
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
  markToolTabs();
  updateConsoleBadge();
  for (const el of $$('.tool .pane')) el.toggleAttribute('data-active', Boolean(toolView.tool) && el.id === paneId(toolView.tool));

  const t = toolView.tool;
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

  if (!toolView.tool && state.atBottom) {
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

/** Select the tab of what is showing, and leave the one Tab stop on it. */
function markToolTabs() {
  const on = toolView.tool ? dockId(toolView.tool) : 'tabConsole';
  for (const b of $$('#dock [role="tab"]')) {
    const picked = b.id === on;
    b.setAttribute('aria-selected', String(picked));
    if (!$('#dock').contains(document.activeElement)) b.tabIndex = picked ? 0 : -1;
  }
  if (toolView.tool) $('#toolPanel').setAttribute('aria-labelledby', on);
}

for (const b of $$('#dock [data-pane]')) b.onclick = () => setTool(b.dataset.pane);
$('#tabConsole').onclick = () => setTool(null);

/*
  One Tab stop for the row. Left and Right move along the tabs that are showing, Home and End jump
  to the ends, and Enter or Space opens the one with focus: a tool reads from the disk as it opens,
  so walking past five of them must not open five.
*/
$('#dock').addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const tabs = $$('#dock [role="tab"]').filter((b) => !b.hidden);
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  let to = null;
  if (e.key === 'ArrowRight') to = tabs[(i + 1) % tabs.length];
  else if (e.key === 'ArrowLeft') to = tabs[(i - 1 + tabs.length) % tabs.length];
  else if (e.key === 'Home') to = tabs[0];
  else if (e.key === 'End') to = tabs[tabs.length - 1];
  else return;
  e.preventDefault();
  for (const b of tabs) b.tabIndex = b === to ? 0 : -1;
  to.focus();
});
// Leaving the row puts the Tab stop back on the tab that is selected.
$('#dock').addEventListener('focusout', (e) => {
  if ($('#dock').contains(e.relatedTarget)) return;
  for (const b of $$('#dock [role="tab"]')) b.tabIndex = b.getAttribute('aria-selected') === 'true' ? 0 : -1;
});

/** Escape inside a tool: back to the console, with focus on the tab that opened the tool. */
function closeTool() {
  const was = toolView.tool;
  rowMenu.close(false);
  setTool(null);
  if (was) $('#' + dockId(was))?.focus();
}

/**
 * While a tool has the console's place, the Console tab carries the number of errors it has
 * logged, so a server going wrong behind a plugin list is still seen. Its name says it too.
 */
function updateConsoleBadge() {
  const tab = $('#tabConsole');
  const badge = tab.querySelector('[data-badge]');
  const n = toolView.tool ? levelCounts.error : 0;
  badge.hidden = !n;
  badge.textContent = n ? String(n) : '';
  if (n) tab.setAttribute('aria-label', 'Console, ' + n + (n === 1 ? ' error' : ' errors'));
  else tab.removeAttribute('aria-label');
}
