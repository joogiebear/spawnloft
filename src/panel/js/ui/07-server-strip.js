'use strict';
// ------------------------------------------------------------ server strip ---

/**
 * A server's state in a word and a tone. "Starting…" is the panel's word, said while a start it
 * asked for is under way: the core says running as soon as the process exists.
 */
function describeState(row, acting) {
  let tone = '';
  let text = STATE_TEXT[row.status] ?? row.status;
  let since = null;
  if (acting === 'start' || acting === 'restart') {
    tone = 'warn';
    text = acting === 'restart' ? 'Restarting…' : 'Starting…';
  } else if (acting === 'stop') {
    tone = 'warn';
    text = 'Stopping…';
  } else if (row.status === 'running' && !isDb(row)) {
    tone = 'live';
    if (row.startedAt) {
      since = row.startedAt;
      text = 'Running · ' + duration(Date.now() - row.startedAt);
    }
  } else if (row.status === 'running' || row.status === 'reachable') {
    tone = 'live';
  } else if (crashedNow(row)) {
    tone = 'fault';
    text = 'Crashed';
  } else if (row.status === 'stopping' || row.status === 'stale') {
    tone = 'warn';
  } else if (row.status === 'orphaned' || row.status === 'unknown' || row.status === 'unreachable') {
    tone = 'fault';
  }
  return { text, tone, since };
}

/** The state as a pill: its word, and a dot that says it again in shape and tone. */
function renderStatePill(row) {
  const st = $('#srvState');
  const said = describeState(row, state.acting);
  const words = st.querySelector('[data-state-text]');
  const dot = st.querySelector('.sl-dot');
  words.textContent = said.text;
  for (const el of [st, dot]) {
    if (said.tone) el.dataset.tone = said.tone;
    else delete el.dataset.tone;
  }
  dot.toggleAttribute('data-busy', said.tone === 'warn' && Boolean(state.acting));
  dot.toggleAttribute('data-hollow', !said.tone && row.status === 'stopped');
  // The uptime ticker (15-server-tools.js) rewrites the words each second from this.
  if (said.since) words.dataset.since = String(said.since);
  else delete words.dataset.since;
}

/**
 * The server's face beside its name, the same as its row in the sidebar: its own icon when it has
 * one, its initial on its colour when not, and a database's glyph.
 */
function renderServerTile(row) {
  const tile = $('#srvTile');
  const said = row.name + '|' + (row.label || '');
  if (tile.dataset.said === said) return;
  tile.dataset.said = said;
  const db = isDb(row);
  const face = Kit.tile({
    name: row.label || row.name, key: row.name, size: 'lg',
    icon: db ? (row.engineKind === 'redis' ? 'cache' : 'database') : null,
  });
  tile.dataset.tone = face.dataset.tone;
  tile.replaceChildren(...face.childNodes);
  if (!db) {
    const img = new Image();
    img.alt = '';
    img.onload = () => { if (tile.dataset.said === said) tile.replaceChildren(img); };
    img.src = '/api/instances/' + encodeURIComponent(row.name) + '/icon';
  }
}

const FILE_MANAGER = panelPlatform === 'darwin' ? 'Finder' : panelPlatform === 'win32' ? 'Explorer' : 'your file manager';

/**
 * An example path as it looks on the computer the panel runs on. Every placeholder was a
 * Windows one (C:\Downloads\..., java.exe), on a Mac and on Linux too.
 */
function examplePath(platform, what) {
  const win = platform === 'win32';
  const home = win ? 'C:\\Users\\you' : platform === 'darwin' ? '/Users/you' : '/home/you';
  const join = (...parts) => parts.join(win ? '\\' : '/');
  if (what === 'map') return join(home, 'Downloads', 'amazing-map.zip');
  if (what === 'server') return win ? 'C:\\Minecraft\\survival' : join(home, 'minecraft', 'survival');
  if (what === 'backups') return win ? 'D:\\spawnloft-backups' : platform === 'darwin' ? '/Volumes/Backup/spawnloft-backups' : '/mnt/backup/spawnloft-backups';
  if (what === 'java') return win ? 'C:\\Program Files\\Java\\jdk-21\\bin\\java.exe' : platform === 'darwin' ? '/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home/bin/java' : '/usr/lib/jvm/java-21/bin/java';
  return home;
}
const JAVA_FILE = panelPlatform === 'win32' ? 'java.exe' : 'java';

/**
 * One line of the Java picker. "java" alone is the one the computer runs by default, which the
 * list called "on PATH".
 */
function javaOptionWords(found, needs) {
  const where = found.path === 'java' ? 'this computer\u2019s default' : found.path;
  return 'Java ' + found.major + '  ·  ' + where + (needs && found.major < needs ? '  ·  too old for this server' : '');
}

/** What to say under the picker when the Java chosen cannot run this server, or '' when it can. */
function javaTooOldWords(list, chosen, needs) {
  const pick = (list || []).find((f) => f.path === chosen);
  if (!needs || !pick || !(pick.major < needs)) return '';
  return 'Java ' + pick.major + ' is too old: this server needs Java ' + needs + ' or newer, and will not start on it.';
}

/** Software and version, the address to connect to, and the Java it runs on. */
function renderMeta(row) {
  const meta = $('#srvMeta');
  const parts = [];
  const text = (s) => document.createTextNode(s);
  const addr = addrButton;
  if (isDb(row)) {
    parts.push(text((row.engineLabel || row.engine) + (row.version ? ' ' + row.version : '') + (row.external ? ', runs elsewhere' : '')));
    parts.push(addr((row.host || '127.0.0.1') + ':' + (row.port || '?')));
  } else {
    const sw = softwareById[row.loader ?? 'paper'];
    parts.push(text((sw ? sw.label : (row.loader || 'Paper')) + (row.mcVersion ? ' ' + row.mcVersion : '')));
    // "localhost:?" is not an address, and copying it gave someone nothing they could use
    parts.push(row.port ? addr('localhost:' + row.port) : text('port not known yet'));
    parts.push(joinButton(row));
    const jv = javaMajorFor(row);
    if (jv) parts.push(text('Java ' + jv));
  }
  // Drawn again only when what it says has changed: this runs on every poll, and a button that
  // is replaced every four seconds drops the keyboard focus it was holding.
  const said = row.name + '|' + parts.map((p) => p.textContent).join('|');
  if (meta.dataset.said === said && meta.childElementCount) return;
  meta.dataset.said = said;
  meta.textContent = '';
  parts.forEach((p, i) => {
    if (i) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.setAttribute('aria-hidden', 'true');
      dot.textContent = '·';
      meta.append(dot);
    }
    meta.append(p);
  });
}

/*
  Which Java each server runs on, by the path in its registry entry. Asked once: finding every Java
  on a machine starts a process per candidate, which is not something to repeat on a timer.
*/
const javaView = { found: null, onPath: null };

async function loadJavas() {
  try {
    const data = await api('/java');
    javaView.found = data.found || [];
    javaView.onPath = data.onPath;
  } catch {
    return;
  }
  const row = rowOf(state.current);
  if (row && state.view === 'server') renderMeta(row);
}

function javaMajorFor(row) {
  if (!javaView.found) return null;
  const bin = row.java || 'java';
  if (bin === 'java') return javaView.onPath ? javaView.onPath.major : null;
  const hit = javaView.found.find((j) => j.path === bin);
  return hit ? hit.major : null;
}

