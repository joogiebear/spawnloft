'use strict';


const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const MAX_LINES = 5000;
const desktop = window.spawnloftDesktop;
const panelPlatform = $('meta[name="spawnloft-platform"]').content;
const windowsFeatures = panelPlatform === 'win32';
const schedulerName = { darwin: 'macOS launchd', linux: 'systemd' }[panelPlatform] || 'Windows Task Scheduler';
const schedulerHint = panelPlatform === 'linux'
  ? 'Runs with SpawnLoft closed while you are logged in. Daily and weekly jobs missed while the machine was off run once when it is back; interval jobs skip missed runs. Tasks stop at logout unless lingering is on for your account (loginctl enable-linger).'
  : panelPlatform === 'darwin'
  ? 'Runs with SpawnLoft closed while you are signed in, including with the screen locked. Daily and weekly jobs missed during sleep run once on wake; interval jobs skip missed runs. Tasks do not run after sign-out. Login tasks also run when first enabled.'
  : 'Runs with this window closed while you are signed in, including with the screen locked, but not after sign-out.';
const managedDatabaseFeatures = windowsFeatures || panelPlatform === 'darwin' || panelPlatform === 'linux';
// A platform can manage databases without being able to manage every engine: Oracle publishes no
// small MySQL build for Linux on arm64, where Redis (Garnet) still runs. The one-click button on a
// server's Settings tab is MySQL, so it has to know.
const managedMysql = $('meta[name="spawnloft-managed-mysql"]').content !== 'false';
const databasePreviewNote = 'Automatic database installation is not available in this preview. Connect to an existing MySQL or Redis database instead.';

const state = {
  rows: [],
  // Game client profiles, from /api/client/profiles; a server's Play uses the one that fits it.
  clientProfiles: [],
  // Databases, listed apart from the servers so nothing that iterates servers sees one.
  dbs: [],
  current: null,
  view: 'empty',
  stream: null,
  streamName: null,
  lines: [],
  paused: false,
  pausedAt: 0,
  filter: 'all',
  search: '',
  wrap: false,
  nums: false,
  seq: 0,
  atBottom: true,
  history: [],
  histAt: -1,
  // Each server's typed commands, kept while the panel is open, so switching away and back does
  // not lose them. Not saved to disk: a command can carry a password (/login, /auth).
  histories: new Map(),
  draft: '',
  unseen: 0,
  layout: null,
  appInfo: null,
  busy: false,
  // 'start', 'stop' or 'restart' while one is under way.
  acting: null,
  // Which tool is open beside the console, or 'console' for none. Remembered per server; see
  // recallTool().
  pane: 'console',
  // What /health said, for the Java chip.
  health: null,
};

/*
  A server's console in a window of its own - on a second screen while the panel does something else
  - is this same page at ?console=<name>, with everything but that server's strip and console
  hidden. It never opens a tool and never records one as open, so it cannot change what the main
  window shows for that server next time.
*/
const consoleOnly = new URLSearchParams(location.search).get('console');
if (consoleOnly) {
  document.documentElement.setAttribute('data-console-only', '');
  document.title = consoleOnly + ' \u2014 console';
}

/** The selected thing, whichever list it is in. */
function rowOf(name) {
  return state.rows.find((r) => r.name === name) || state.dbs.find((r) => r.name === name) || null;
}
const isDb = (row) => Boolean(row && row.kind === 'database');

