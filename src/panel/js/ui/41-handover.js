'use strict';
// ---- 2.x updates and the handover banners ------------------------------------
// The Rust core answers /api/update* and /api/handover* itself. A panel served by the old Node
// core answers 404 to both, and everything here stays hidden. Release notes are text from a signed
// feed, but still only ever set as textContent.

const coreUpd = { on: false, status: null };

/**
 * What the header's update button says for the 2.x update status, or null to leave it hidden.
 * The 1.x app drove that button from its own updater; in 2.x an update that was ready showed
 * only to someone who opened Preferences and scrolled to Updates.
 */
function headerUpdateWords(st) {
  const p = st && st.pending;
  if (!p || p.rollback) return null;
  return { label: 'Update to ' + p.version, title: 'SpawnLoft ' + p.version + ' is ready to install. Opens Preferences at Updates.' };
}

async function watchCoreUpdate() {
  // the 1.x window has its own updater, and its own use for this button
  if (desktop && typeof desktop.appInfo === 'function') return;
  let st;
  try { st = await updJson(''); } catch { return; }
  coreUpd.on = true;
  coreUpd.status = st;
  const words = headerUpdateWords(st);
  const b = $('#bUpdate');
  b.hidden = !words;
  if (!words) return;
  b.textContent = words.label;
  b.title = words.title;
  b.classList.remove('sl-btn-ghost');
  b.classList.add('sl-btn-primary');
  b.onclick = () => {
    if (state.view !== 'settings') openSheet('settings', renderSettings);
    // the section is filled in by a request of its own
    setTimeout(() => { const at = $('#setUpdCore'); if (at && !at.hidden) at.scrollIntoView({ block: 'start' }); }, 400);
  };
}
watchCoreUpdate();
// the core checks the feed by itself a few times a day; this only reads what it found
setInterval(() => { if (!document.hidden) watchCoreUpdate(); }, 30 * 60 * 1000);

const updWhen = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? stamp(t) : 'never';
};

function updEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function updJson(path, method, body) {
  const res = await fetch('/api/update' + path, {
    method: method || 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || (res.status + ' ' + res.statusText));
  return data;
}

function updOutcomeText(r) {
  if (r.result === 'update') return '';
  if (r.result === 'blocked') return 'A newer release exists but cannot be installed here: ' + (r.reason || 'it is not allowed') + '.';
  if (r.result === 'unreachable') return 'SpawnLoft could not check for updates (' + (r.reason || 'no answer') + '). Check your connection and try again.';
  return 'SpawnLoft ' + r.installed + ' is the newest ' + r.channel + ' release.';
}

function updRenderOffer(st, installing) {
  const box = $('#updOffer');
  box.textContent = '';
  const p = st.pending;
  box.hidden = !p;
  if (!p) return;
  const lead = updEl('div', 'text-3');
  const title = updEl('b', null, p.rollback
    ? 'SpawnLoft ' + p.version + ' is ready to reinstall'
    : 'SpawnLoft ' + p.version + ' is available');
  lead.append(title, updEl('span', 'type-meta text-ink-3', st.downloaded
    ? ' - downloaded and verified, ready to install.'
    : ' - verified; it downloads when you install.'));
  box.append(lead);
  if (p.notes) {
    const d = updEl('details', 'my-1.5');
    d.append(updEl('summary', 'cursor-pointer text-3 font-semibold text-ink-2', 'What changed'), updEl('pre', 'sl-hint mt-2 mb-0 whitespace-pre-wrap', p.notes));
    box.append(d);
  }
  const go = updEl('button', 'sl-btn sl-btn-primary', installing ? 'Installing...' : (p.rollback ? 'Reinstall and restart' : 'Install and restart'));
  go.type = 'button';
  go.disabled = Boolean(installing);
  go.onclick = async () => {
    const ok = await ask({
      title: p.rollback ? 'Reinstall SpawnLoft ' + p.version + '?' : 'Update to SpawnLoft ' + p.version + '?',
      text: 'SpawnLoft closes, swaps itself for that version and reopens. Servers keep running; they are separate processes.',
      confirmLabel: 'Restart and update',
    });
    if (!ok) return;
    go.disabled = true;
    go.textContent = 'Installing...';
    try {
      await updJson('/install', 'POST');
      $('#updMsg').hidden = false;
      $('#updMsg').textContent = 'The window is installing this. SpawnLoft will restart in a moment.';
    } catch (e) {
      go.disabled = false;
      go.textContent = p.rollback ? 'Reinstall and restart' : 'Install and restart';
      toast(e.message, 'bad');
    }
  };
  box.append(go);
}

function updRenderHold(st) {
  const box = $('#updHold');
  box.textContent = '';
  box.hidden = !st.hold;
  if (!st.hold) return;
  const b = updEl('button', 'sl-btn sl-btn-sm', 'Resume updates');
  b.type = 'button';
  b.onclick = async () => {
    try { await updJson('/hold', 'DELETE'); await renderCoreUpdates(); } catch (e) { toast(e.message, 'bad'); }
  };
  box.append(updEl('span', null, 'Updates to SpawnLoft ' + st.hold + ' and newer are paused because you went back to an older version. '), b);
}

async function updLoadRollbacks() {
  const box = $('#updRollbacks');
  box.textContent = 'Loading...';
  try {
    const data = await updJson('/rollbacks');
    box.textContent = '';
    if (!data.releases.length) { box.append(updEl('p', 'sl-hint', 'No older version is available.')); return; }
    for (const r of data.releases) {
      const row = updEl('div', 'my-1 flex flex-wrap items-baseline gap-2.5');
      const name = updEl('b', 'text-3', r.version);
      const btn = updEl('button', 'sl-btn sl-btn-ghost sl-btn-sm', 'Reinstall');
      btn.type = 'button';
      btn.disabled = !r.allowed;
      btn.onclick = async () => {
        const ok = await ask({
          title: 'Go back to SpawnLoft ' + r.version + '?',
          text: 'SpawnLoft restarts on that version and stops offering newer ones until you resume updates here.',
          confirmLabel: 'Reinstall',
        });
        if (!ok) return;
        try {
          await updJson('/rollback', 'POST', { version: r.version });
          toast('Reinstalling ' + r.version + '. SpawnLoft will restart.', 'good');
        } catch (e) { toast(e.message, 'bad'); }
      };
      row.append(name, btn);
      if (!r.allowed) row.append(updEl('span', 'sl-hint', r.reason || 'This version cannot read your data.'));
      box.append(row);
    }
  } catch (e) {
    box.textContent = '';
    box.append(updEl('p', 'sl-hint', 'Could not list versions: ' + e.message));
  }
}

async function renderCoreUpdates(reportText) {
  let st;
  try {
    st = await updJson('');
  } catch {
    coreUpd.on = false;
    $('#setUpdCore').hidden = true;
    return false;
  }
  coreUpd.on = true;
  coreUpd.status = st;
  $('#setUpdCore').hidden = false;
  $('#updSummary').textContent = 'SpawnLoft ' + st.installed + ', ' + st.channel + ' releases. Last checked: '
    + updWhen(st.lastCheckAt) + '.' + (st.staleFeed ? ' The update list is older than expected, so a newer release may exist.' : '');
  updRenderOffer(st);
  updRenderHold(st);
  const msg = $('#updMsg');
  if (reportText) { msg.hidden = false; msg.textContent = reportText; } else if (msg.textContent && !st.pending) { /* keep */ } else { msg.hidden = true; }
  $('#updBeta').checked = st.channel === 'beta';

  $('#updCheck').onclick = async () => {
    const b = $('#updCheck');
    b.disabled = true;
    b.textContent = 'Checking...';
    try {
      const r = await updJson('/check', 'POST');
      await renderCoreUpdates(updOutcomeText(r));
    } catch (e) {
      toast('Update check failed: ' + e.message, 'bad');
    } finally {
      b.disabled = false;
      b.textContent = 'Check now';
    }
  };
  $('#updBeta').onchange = async (e) => {
    e.target.disabled = true;
    try {
      await updJson('/channel', 'POST', { beta: e.target.checked });
      await renderCoreUpdates('The next check will look for ' + (e.target.checked ? 'beta releases too.' : 'finished releases only.'));
    } catch (err) { toast(err.message, 'bad'); e.target.checked = !e.target.checked; }
    e.target.disabled = false;
  };
  $('#updRollbackBox').ontoggle = (e) => { if (e.target.open) updLoadRollbacks(); };
  $('#updLogBox').ontoggle = async (e) => {
    if (!e.target.open) return;
    try { $('#updLog').textContent = (await updJson('/log?n=60')).lines.join('\n') || 'Nothing logged yet.'; }
    catch (err) { $('#updLog').textContent = err.message; }
  };
  return true;
}

