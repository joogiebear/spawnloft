'use strict';
// ---- session ended (ui.html and launcher.html hold this block word for word; test/panel-session.test.mjs) ----
// The panel signs a page in with a cookie that lives as long as the panel process
// (rust/PANEL-AUTH-DESIGN.md 3.3). When the panel answers {code: "auth"}, this page's sign-in is
// gone: the panel restarted, or the tab sat closed past the idle time. Say so once, close the
// event streams (a stream cut off reconnects on its own; one that then meets the 401 stops) and stop asking: every later
// request waits for ever instead of failing, so nothing behind the notice retries or toasts.
const panelSession = (() => {
  const state = { ended: false, checking: false, streams: new Set() };
  const rawFetch = window.fetch.bind(window);
  const RawEventSource = window.EventSource;
  const never = () => new Promise(() => {});

  function notice() {
    if (document.getElementById('sessionEnded')) return;
    // A page in a frame of the panel (the Play page) leaves the notice to the panel around it,
    // so there is one notice and not two stacked. The panel is asked something, which ends
    // its session the same way if it had not noticed yet.
    try {
      if (window.parent !== window && window.parent.location.origin === location.origin && typeof window.parent.fetch === 'function') {
        window.parent.fetch('/api/appearance', { cache: 'no-store' }).catch(() => {});
        return;
      }
    } catch (err) { /* a parent of another origin is not the panel: the notice shows here */ }
    const box = document.createElement('div');
    box.id = 'sessionEnded';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'sessionEndedTitle');
    // Inline, so the notice draws even where a stylesheet is what failed; the page's own tokens
    // when it has them, the SpawnLoft look's values when it does not.
    box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;'
      + 'background:rgba(4,6,6,.86);font:var(--t-4,15px)/1.55 var(--ui,system-ui,sans-serif);color:var(--ink,#efeee6)';
    const card = document.createElement('div');
    card.style.cssText = 'max-width:460px;padding:24px 28px;border:1px solid var(--line,#30382e);border-radius:var(--r-lg,12px);'
      + 'background:var(--surface,#141b15);box-shadow:var(--shadow-lg,none)';
    const title = document.createElement('h2');
    title.id = 'sessionEndedTitle';
    title.style.cssText = 'margin:0 0 8px;font:650 var(--t-5,18px)/1.3 var(--display,inherit);letter-spacing:-.015em';
    title.textContent = 'This panel session has ended';
    const text = document.createElement('p');
    text.style.cssText = 'margin:0;color:var(--ink-2,#b5bcac)';
    card.append(title, text);
    if (window.spawnloftDesktop && window.spawnloftDesktop.shell === 'tauri') {
      // In the app the window can sign itself in again: loading the page anew is answered with
      // the sign-in page, which the window sends through a new one-use link (bridge.rs).
      text.append('SpawnLoft restarted, or this window sat unused for a while. Anything typed and not saved here is lost.');
      const again = document.createElement('button');
      again.type = 'button';
      again.textContent = 'Sign in again';
      again.style.cssText = 'margin-top:16px;min-height:var(--hit,34px);padding:0 14px;border:1px solid var(--primary-edge,#c4f566);border-radius:var(--r-sm,6px);'
        + 'background:var(--primary-top,#c4f566);color:var(--primary-ink,#14200b);font:600 var(--t-3,14px)/1 var(--ui,inherit);cursor:pointer';
      again.onclick = () => location.reload();
      card.append(again);
      setTimeout(() => again.focus(), 0);
    } else {
      text.append('Open SpawnLoft again from the app, or run ');
      const cmd = document.createElement('code');
      cmd.style.cssText = 'color:var(--ink,#efeee6);font-family:var(--mono,monospace)';
      cmd.textContent = 'spawnloft ui';
      text.append(cmd, ' for a new sign-in link.');
    }
    box.append(card);
    // nothing behind the notice works any more: it is taken out of reach of Tab and of screen
    // readers, and focus goes to the notice (to its button, where it has one)
    const host = document.body || document.documentElement;
    // an open dialog would stay on top of the notice and keep it out of reach
    for (const d of document.querySelectorAll('dialog[open]')) { try { d.close(); } catch { /* not a dialog that closes */ } }
    for (const el of host.children) el.inert = true;
    host.append(box);
    card.tabIndex = -1;
    if (!card.querySelector('button')) card.focus();
  }

  function end() {
    if (state.ended) return;
    state.ended = true;
    for (const stream of state.streams) RawEventSource.prototype.close.call(stream);
    state.streams.clear();
    if (document.body) notice();
    else document.addEventListener('DOMContentLoaded', notice, { once: true });
  }

  // only this panel's own answers count: a 401 from anywhere else says nothing about this page
  const own = (res) => {
    try { return new URL(res.url).origin === location.origin; } catch { return false; }
  };

  window.fetch = async (input, init) => {
    if (state.ended) return never();
    const res = await rawFetch(input, init);
    if (res.status === 401 && own(res)) {
      const body = await res.clone().json().catch(() => null);
      if (body && body.code === 'auth') {
        end();
        return never();
      }
    }
    return res;
  };

  // A stream that fails asks the panel once, with an ordinary request, whether the sign-in still
  // holds; fetch above ends the session if it does not. A panel that is only down answers
  // nothing, and the stream keeps reconnecting until it is back.
  function check() {
    if (state.ended || state.checking) return;
    state.checking = true;
    window.fetch('/api/appearance', { cache: 'no-store' }).catch(() => {}).finally(() => { state.checking = false; });
  }

  window.EventSource = class extends RawEventSource {
    constructor(url, options) {
      super(url, options);
      if (state.ended) {
        super.close();
        return;
      }
      state.streams.add(this);
      this.addEventListener('error', () => {
        if (this.readyState === RawEventSource.CLOSED) state.streams.delete(this);
        check();
      });
    }

    close() {
      state.streams.delete(this);
      super.close();
    }
  };

  return { get ended() { return state.ended; } };
})();
// ---- end session ended ----
