'use strict';
// ----------------------------------------------------------------- paths ---

let themeSaving = false;
function showTheme(theme) {
  const selected = theme === 'classic' ? 'classic' : 'spawnloft';
  document.documentElement.dataset.theme = selected;
  $$('input[name="appTheme"]').forEach(input => { input.checked = input.value === selected; });
  // The Play page is its own document, served with the theme saved at the time it loaded; it
  // follows the panel from here on. Same origin, so its document is ours to reach.
  try {
    const doc = $('#playFrame').contentDocument;
    if (doc && doc.documentElement) doc.documentElement.dataset.theme = selected;
  } catch { /* not loaded yet, or not ours: it keeps the theme it was served with */ }
}

async function changeTheme(event) {
  if (themeSaving || !event.target.checked) return;
  const previous = document.documentElement.dataset.theme;
  const requested = event.target.value;
  const hadFocus = document.activeElement === event.target;
  themeSaving = true;
  $$('input[name="appTheme"]').forEach(input => { input.disabled = true; });
  showTheme(requested);
  $('#themeStatus').textContent = 'Saving appearance…';
  try {
    const out = await post('/appearance', { theme: requested });
    showTheme(out.theme);
    if (state.layout) state.layout.theme = out.theme;
    $('#themeStatus').textContent = (out.theme === 'spawnloft' ? 'SpawnLoft' : 'Classic') + ' theme saved.';
  } catch (error) {
    showTheme(previous);
    $('#themeStatus').textContent = 'Could not save your theme: ' + error.message;
    toast('Appearance was not saved. Your previous theme has been restored.', 'bad');
  } finally {
    themeSaving = false;
    $$('input[name="appTheme"]').forEach(input => { input.disabled = false; });
    // Disabling the in-flight radio releases keyboard focus. Restore it only
    // if the user has not moved elsewhere or closed Settings while saving.
    if (hadFocus && state.view === 'settings' && document.activeElement === document.body) {
      event.target.focus({ preventScroll: true });
    }
  }
}
showTheme(document.documentElement.dataset.theme);
$$('input[name="appTheme"]').forEach(input => { input.onchange = changeTheme; });

// The size also changes from the keyboard, so the select is read when Preferences opens, not once.
// Auto names the size it picked, so the entry reads "Auto (125%)" and the choice is never a mystery.
function paintUiSize(size) {
  $('#uiSizeAuto').textContent = 'Auto (' + Math.round(size.zoom * 100) + '%)';
  $('#uiSize').value = String(size.setting);
}
async function showUiSize() {
  if (!desktop || !desktop.getZoom) return;
  $('#uiSizeRow').hidden = false;
  paintUiSize(await desktop.getZoom());
}
$('#uiSize').onchange = async (event) => {
  const v = event.target.value;
  paintUiSize(await desktop.setZoom(v === 'auto' ? 'auto' : Number(v)));
};

async function loadSettings() {
  try {
    state.layout = await api('/settings');
  } catch {
    /* Preferences says it could not read them */
  }
}

function renderSettings() {
  showUiSize();
  showTheme(document.documentElement.dataset.theme);
  const l = state.layout;
  const paths = $('#setPaths');
  paths.textContent = '';
  const rows = l ? [
    ['Data folder', l.dataRoot],
    ['Servers', l.instancesDir + (l.separateInstances ? '   (separate drive)' : '')],
    ['Server jars', l.jarsDir],
    ['Backups', l.backupsDir],
    ['Templates', l.templatesDir],
    ['Settings file', l.settingsFile],
  ] : [['Locations', 'Could not read them. Try again in a moment.']];
  for (const r of rows) {
    const dt = document.createElement('dt');
    dt.textContent = r[0];
    const dd = document.createElement('dd');
    dd.textContent = r[1];
    paths.append(dt, dd);
  }

  const actions = $('#setActions');
  actions.textContent = '';
  if (desktop) {
    const b = document.createElement('button');
    b.textContent = 'Change the data folder…';
    b.onclick = async () => {
      const go = await ask({
        title: 'Change the data folder?',
        text: 'SpawnLoft restarts to pick up the new location. Servers that already exist stay exactly where they are — only new ones land in the new folder, and anything running keeps running.',
        confirmLabel: 'Choose a folder',
      });
      if (!go) return;
      const dir = await desktop.pickFolder('Choose where SpawnLoft keeps its files');
      if (!dir) return;
      const out = await desktop.saveSetup({ dataRoot: dir, instancesDir: null, separate: false });
      if (out && !out.ok) toast(out.error, 'bad');
    };
    actions.append(b);
  } else {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'These are moved from the SpawnLoft app, or in a terminal with: spawnloft config set-root <folder>';
    actions.append(hint);
  }

  renderCoreUpdates().then((on) => { if (on) $('#setUpdates').hidden = true; });
  renderUpdateChannel();
  renderMcp();

  const about = $('#setAbout');
  about.textContent = '';
  const info = [['Panel', 'Local only — bound to 127.0.0.1']];
  if (panelPlatform === 'darwin') {
    info.push(['Mac support', 'Scheduled tasks run while signed in. Managed MySQL requires macOS 15+. Redis (Garnet) is available on Windows and Mac.']);
  }
  if (state.appInfo) {
    if (state.appInfo.manualUpdates) {
      info.push(['Updates', 'Rolling Mac preview. Download and install each new build manually using Download Mac preview.']);
    }
    // The commit, not just the version: a version is a label, and a bug report that names the
    // build is the difference between reproducing something and guessing at it.
    if (state.appInfo.commit) {
      info.unshift(['Build', state.appInfo.commit + (state.appInfo.dirty ? ' (with uncommitted changes)' : '')]);
    }
    info.unshift(['Version', 'v' + state.appInfo.version + (state.appInfo.packaged ? '' : ' (' + state.appInfo.coreMode + ')')]);
  } else if (coreUpd.status && coreUpd.status.installed) {
    // the 2.x app: the core says which version this is
    info.unshift(['Version', 'v' + coreUpd.status.installed + (coreUpd.status.channel === 'beta' ? ' (beta releases)' : '')]);
  }
  for (const r of info) {
    const dt = document.createElement('dt');
    dt.textContent = r[0];
    const dd = document.createElement('dd');
    dd.textContent = r[1];
    about.append(dt, dd);
  }
}

/**
 * Which releases this copy follows. Desktop only, and not where updates are installed by hand.
 *
 * The status line exists for the one case that would otherwise look broken: turning betas off
 * while running one. Nothing is downgraded, so nothing visibly happens until the release that
 * beta was leading to ships, and saying which release that is beats leaving someone to wonder.
 */
function updateChannelStatus(c) {
  if (c.beta) return c.onBetaBuild
    ? 'You are on a beta and will get each new one, then the release itself when it ships.'
    : 'The next check will offer the newest beta.';
  if (c.waitingFor) return 'You will stay on this beta build. Betas stop, and SpawnLoft ' + c.waitingFor
    + ' installs when it is released. Nothing is downgraded.';
  return 'You get the monthly releases.';
}

async function renderUpdateChannel() {
  const box = $('#setUpdates');
  if (coreUpd.on) { box.hidden = true; return; }
  if (!desktop || !desktop.updateChannel || !state.appInfo || state.appInfo.manualUpdates || !state.appInfo.packaged) {
    box.hidden = true;
    return;
  }
  const show = (c) => {
    $('#setBeta').checked = c.beta;
    $('#setBetaStatus').textContent = updateChannelStatus(c);
  };
  box.hidden = false;
  show(await desktop.updateChannel());
  $('#setBeta').onchange = async (e) => {
    const want = e.target.checked;
    e.target.disabled = true;
    const out = await desktop.setUpdateChannel(want);
    e.target.disabled = false;
    if (!out || !out.ok) {
      toast((out && out.message) || 'Could not save that choice.', 'bad');
      show(await desktop.updateChannel());
      return;
    }
    show(out);
  };
}

/**
 * The launch line for `spawnloft mcp`, as an AI client wants it. The paths come from the core,
 * which knows where this install actually lives; the two switches only add flags, so nothing
 * here is saved - the client's config is where the choice lives.
 */
function mcpQuote(s) {
  return /[\s"]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
}

function mcpSnippets(launch, { destructive, ips }) {
  const args = [...launch.args, ...(destructive ? ['--allow-destructive'] : []), ...(ips ? ['--show-ips'] : [])];
  const entry = { command: launch.command, args };
  if (Object.keys(launch.env).length) entry.env = launch.env;
  const json = JSON.stringify({ mcpServers: { spawnloft: entry } }, null, 2);
  const env = Object.entries(launch.env).map(([k, v]) => '--env ' + k + '=' + v + ' ').join('');
  const cli = 'claude mcp add --transport stdio --scope user ' + env + 'spawnloft -- '
    + [launch.command, ...args].map(mcpQuote).join(' ');
  return { json, cli };
}

async function renderMcp() {
  let launch;
  try {
    launch = await api('/mcp');
  } catch {
    $('#setMcp').hidden = true;
    return;
  }
  $('#setMcp').hidden = false;
  const show = () => {
    const s = mcpSnippets(launch, { destructive: $('#mcpDestructive').checked, ips: $('#mcpIps').checked });
    $('#mcpJson').value = s.json;
    $('#mcpCli').value = s.cli;
  };
  $('#mcpDestructive').onchange = show;
  $('#mcpIps').onchange = show;
  $('#bMcpJson').onclick = () => copyText($('#mcpJson').value, 'the Claude Desktop configuration');
  $('#bMcpCli').onclick = () => copyText($('#mcpCli').value, 'the Claude Code command');
  show();
}

$('#bSettings').onclick = () => { if (state.view !== 'settings') openSheet('settings', renderSettings); };
$('#bSetClose').onclick = back;

