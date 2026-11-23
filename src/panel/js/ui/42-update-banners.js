'use strict';
// ---- banners: what the 2.0 update did to running servers --------------------

const upgradeBanner = { off: false, last: '' };

function joinNames(names) {
  if (names.length < 2) return names.join('');
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

function upgradeNoticeNodes(data) {
  const out = [];
  const rec = data.record;
  if (rec) {
    const dismissRec = () => fetch('/api/handover/dismiss', { method: 'POST' }).catch(() => {});
    const servers = rec.servers || [];
    const restarted = servers.filter((e) => e.stop === 'stopped' || e.stop === 'was-stopped');
    const waiting = restarted.filter((e) => !e.start);
    const failed = restarted.filter((e) => e.start === 'failed' || e.start === 'skipped');
    const back1x = restarted.filter((e) => e.start === 'restored-1x');
    const orphans = servers.filter((e) => e.stop === 'orphaned' && !forceStopped.has(e.name));
    if (waiting.length) {
      out.push(noticeBox({ tone: 'warn', title: 'Updating.',
        text: 'Starting ' + joinNames(waiting.map((e) => e.name)) + ' again after the update.' }));
    } else if (back1x.length) {
      out.push(noticeBox({ tone: 'warn', title: 'The update was not applied.',
        text: joinNames(back1x.map((e) => e.name)) + ' did not stop in time, so SpawnLoft left everything as it was and started what it had stopped again.',
        dismiss: dismissRec }));
    } else if (restarted.length && !failed.length) {
      out.push(noticeBox({ tone: 'warn', title: 'Updated to SpawnLoft ' + rec.to + '.',
        text: 'SpawnLoft stopped ' + joinNames(restarted.map((e) => e.name)) + ' for the update and started ' + (restarted.length === 1 ? 'it' : 'them') + ' again.',
        dismiss: dismissRec }));
    } else if (!servers.length) {
      out.push(noticeBox({ tone: 'warn', title: 'Updated to SpawnLoft ' + rec.to + '.',
        text: 'No servers were running, so nothing had to be stopped.', dismiss: dismissRec }));
    }
    for (const e of failed) {
      out.push(noticeBox({ tone: 'fault', title: e.name + ' did not start again.',
        text: (e.error ? e.error + ' ' : '') + 'It was stopped for the update.',
        actions: [{ label: 'Start', primary: true, run: async () => {
          try { await post('/instances/' + encodeURIComponent(e.name) + '/start'); toast('Started ' + e.name + '.', 'good'); pollUpgradeNotices(); }
          catch (err) { toast(err.message, 'bad'); }
        } }],
        dismiss: dismissRec }));
    }
    for (const e of orphans) {
      out.push(noticeBox({ tone: 'fault', title: e.name + ' is still running, but out of reach.',
        text: 'It has been running since before the update with nothing looking after it, so it cannot be stopped the usual way or sent commands. Force stop it, then start it again.',
        actions: [{ label: 'Force stop', run: async () => {
          if (!(await forceStop(e.name, e.name))) return;
          upgradeBanner.last = null;
          pollUpgradeNotices();
        } }],
        dismiss: dismissRec }));
    }
  }
  for (const l of data.legacy || []) {
    out.push(noticeBox({ tone: 'warn', title: l.name + ' still runs on SpawnLoft 1.',
      text: 'Restart it to move it to this version. Nothing happens on its own, because players may be on it.',
      actions: [{ label: 'Restart', run: async () => {
        const ok = await ask({ title: 'Restart ' + l.name + '?',
          text: 'It stops gracefully, then starts again under this version. Players on it are disconnected.',
          confirmLabel: 'Restart' });
        if (!ok) return;
        const t = toast('Restarting ' + l.name + '...');
        try {
          await post('/instances/' + encodeURIComponent(l.name) + '/stop');
          await post('/instances/' + encodeURIComponent(l.name) + '/start');
          t.remove();
          toast(l.name + ' restarted.', 'good');
        } catch (err) { t.remove(); toast(err.message, 'bad'); }
        pollUpgradeNotices();
      } }] }));
  }
  return out;
}

async function pollUpgradeNotices() {
  if (upgradeBanner.off) return;
  let data;
  try {
    const res = await fetch('/api/handover');
    if (!res.ok) { if (res.status === 404 || res.status === 503) upgradeBanner.off = res.status === 404; return; }
    data = await res.json();
  } catch { return; }
  const key = JSON.stringify(data);
  if (key === upgradeBanner.last) return;
  upgradeBanner.last = key;
  $('#upgradeNotices').replaceChildren(...upgradeNoticeNodes(data));
}
pollUpgradeNotices();
setInterval(pollUpgradeNotices, 4000);

show('empty');
loadSettings();
loadJavas();
loadClientProfiles();
refresh().then(() => {
  if (consoleOnly) {
    if (rowOf(consoleOnly)) select(consoleOnly);
    return;
  }
  if (!state.current && (state.view === 'empty' || state.view === 'home')) showHome();
  // One server and nothing selected is not a choice worth making anyone click through.
  if (state.rows.length === 1 && state.view !== 'play') select(state.rows[0].name);
});
setInterval(refresh, 4000);

$('#bPopConsole').onclick = () => {
  if (!state.current) return;
  // Named per server, so asking twice brings the one already open forward rather than a second.
  window.open('/?console=' + encodeURIComponent(state.current), 'spawnloft-console-' + state.current, 'width=980,height=660');
};
