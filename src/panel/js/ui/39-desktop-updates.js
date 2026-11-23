'use strict';
// ---- desktop-only: version and updates -------------------------------------
// The same page runs in a plain browser, where window.spawnloftDesktop does not exist. Everything here
// is additive and silent when it is absent.

if (desktop && typeof desktop.appInfo === 'function') {
  desktop.appInfo().then((info) => {
    state.appInfo = info;
    $('#bUpdate').hidden = false;
    if (info.manualUpdates) {
      $('#bUpdate').textContent = 'Download Mac preview';
      $('#bUpdate').title = 'Rolling development builds are installed manually; this opens the preview release.';
    }
  });

  // What the button is offering right now: null when there is nothing to do, a version string
  // while it is being fetched, 'ready' once the installer is on disk and only a restart is left.
  let pending = null;
  // a new major version: it installs only from this button, never on quit (desktop/major-update.js)
  let pendingMajor = false;

  // Whether someone is waiting on an answer, which is knowable here and nowhere else: they pressed
  // the button on this page. The app also checks by itself every six hours, and those results are
  // nobody's business - an offline laptop must not toast every six hours about a check nobody asked
  // for, and a background "nothing new" must not overwrite the answer a person is still waiting for.
  let awaitingAnswer = false;

  const idle = () => {
    const b = $('#bUpdate');
    pending = null;
    b.textContent = 'Check for updates';
    b.title = '';
    b.disabled = false;
    b.classList.add('ghost');
    b.classList.remove('primary');
  };

  desktop.onUpdate((kind, data) => {
    if (state.appInfo && state.appInfo.manualUpdates) return;
    const b = $('#bUpdate');
    if (kind === 'available') {
      // Nothing to click: the download has already started. The button reports rather than asks.
      pending = data.version;
      b.textContent = 'Downloading ' + data.version + '…';
      b.disabled = true;
    } else if (kind === 'none') {
      // A background check finding nothing is not worth saying. One someone pressed for is.
      if (awaitingAnswer) {
        awaitingAnswer = false;
        pending = null;
        b.textContent = 'Up to date';
        b.disabled = true;
        setTimeout(() => { if (!pending) idle(); }, 4000);
      }
    } else if (kind === 'progress') {
      b.textContent = 'Downloading ' + data.percent + '%';
      b.disabled = true;
    } else if (kind === 'ready') {
      awaitingAnswer = false;
      pending = 'ready';
      pendingMajor = Boolean(data.major);
      b.textContent = pendingMajor ? 'Restart to update to SpawnLoft ' + String(data.version).split('.')[0] : 'Restart to update';
      b.title = 'SpawnLoft ' + data.version + ' is ready — restart to switch to it';
      b.disabled = false;
      // The one moment this button is worth looking at, so it stops being a ghost.
      b.classList.remove('ghost');
      b.classList.add('primary');
    } else if (kind === 'error') {
      idle();
      // A machine that is offline should not raise a toast every six hours about a check nobody
      // asked for. Anything someone pressed for has to answer - including a download that started
      // from their press and then failed, which is why this is not cleared when one begins.
      if (awaitingAnswer) toast('Update failed: ' + data.error, 'bad');
      awaitingAnswer = false;
    }
  });

  $('#bUpdate').onclick = async () => {
    const b = $('#bUpdate');
    if (state.appInfo && state.appInfo.manualUpdates) {
      await desktop.openExternal(state.appInfo.downloadUrl);
      return;
    }
    if (pending === 'ready') {
      // Servers survive the restart - they are detached daemons - but saying so beats letting
      // someone guess whether updating will drop their running world.
      const go = await ask(pendingMajor ? {
        title: 'Update to a new major version?',
        text: 'This is a new major version of SpawnLoft. It is not installed when you close the app, only from '
          + 'here. On Windows, stop every server first. SpawnLoft closes, swaps itself for the new version and reopens.',
        confirmLabel: 'Restart and update',
      } : {
        title: 'Restart to update?',
        text: 'SpawnLoft closes, swaps itself for the new version and reopens. No installer window '
          + 'appears. Running servers keep running — SpawnLoft supervises them as separate processes.',
        confirmLabel: 'Restart and update',
      });
      if (!go) return;
      const res = await desktop.installUpdate();
      if (res && res.ok === false && res.message) toast(res.message, 'bad');
      return;
    }
    awaitingAnswer = true;
    b.textContent = 'Checking…';
    b.disabled = true;
    const res = await desktop.checkUpdate();
    if (!res.ok) {
      awaitingAnswer = false;
      idle();
      toast(res.message || 'Could not check for updates.', 'bad');
      return;
    }
    // A successful check resolves through onUpdate. If the feed answers nothing at all, do not
    // leave the button stuck on "Checking…" forever.
    setTimeout(() => {
      if (b.textContent === 'Checking…') { awaitingAnswer = false; idle(); }
    }, 20000);
  };
}

