'use strict';
// ---------------------------------------------------- server properties ----

/**
 * The handful of server.properties worth a control.
 *
 * <p>Built from what the API says is editable rather than from a list kept here, so the panel and
 * the core cannot drift about what exists or what a field accepts. The server reads this file once
 * at boot, so anything changed while it is running is announced as taking effect on restart.
 */
/**
 * An icon from the sprite at the top of the document.
 *
 * <p>`<use>` rather than a copy of the path per button: nineteen glyphs defined once, referenced
 * wherever they are needed, and restyled from one place. `currentColor` means an icon inherits the
 * colour of whatever it sits in, so a danger button's icon turns red without anybody saying so.
 *
 * <p>Always aria-hidden. An icon either sits beside its own word or is the whole of a button that
 * carries an aria-label saying what it does, so announcing the glyph would only read the same thing
 * twice.
 */
function icon(name, cls) {
  return Kit.icon(name, cls);
}

/**
 * A pane whose read failed: the error as the server worded it, an icon the size of the thing it
 * stands for, and Retry. A paragraph of grey text against a blank area reads as a page that did
 * not load rather than as a state.
 */
function paneError(body, message, retry) {
  // Kept from the loading state, so the error lands where the skeleton was.
  if (!body.parentElement.querySelector(':scope > .pane-head-wait')) clearPaneHead(body);
  const box = document.createElement('div');
  box.className = 'grid justify-items-center gap-3 px-5 py-10 text-center';
  box.setAttribute('role', 'alert');
  const p = document.createElement('p');
  p.className = 'm-0 max-w-[46ch] text-3 leading-[1.6] text-ink-2';
  p.textContent = message;
  box.append(icon('alert', 'size-[34px] text-fault [stroke-width:1.25]'), p);
  if (retry) {
    const again = Kit.button({ label: 'Retry', icon: 'restart', onClick: retry });
    again.classList.add('mt-1');
    box.append(again);
  }
  body.replaceChildren(box);
}

/**
 * Put a pane into its loading state: the previous server's title and rows go, and grey bars hold
 * the space at the rows' height, so nothing jumps when the answer arrives. Called only when the
 * pane is about to show a different server (or nothing yet), so a refresh of the same server
 * keeps what is on screen until the new answer replaces it.
 */
function paneLoading(body) {
  // An invisible stand-in the height of the title row, so the body does not drop when the real
  // title arrives with the data.
  paneHead(body, 'server', '\u00a0', '\u00a0').classList.add('pane-head-wait', 'invisible');
  const sk = document.createElement('div');
  sk.className = 'grid gap-3 pt-2';
  sk.setAttribute('aria-busy', 'true');
  sk.setAttribute('aria-label', 'Loading');
  const bars = ['w-[38%] h-[18px] mb-2', 'w-[64%] h-3.5', 'w-[72%] h-3.5', 'w-[86%] h-3.5', 'w-[64%] h-3.5', 'w-[72%] h-3.5', 'w-[86%] h-3.5'];
  for (const bar of bars) sk.append(Object.assign(document.createElement('span'), { className: 'sl-skeleton ' + bar }));
  body.replaceChildren(sk);
}

/**
 * Mark a button as working, or done. The label can change to say what is happening ("Updating")
 * and goes back afterwards; the button is disabled meanwhile so a second press cannot queue a
 * second request.
 */
function busy(button, on, label) {
  if (on) {
    if (!('idle' in button.dataset)) button.dataset.idle = button.lastChild ? button.lastChild.textContent : '';
    if (label && button.lastChild) button.lastChild.textContent = label;
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
  } else {
    if ('idle' in button.dataset && button.lastChild) button.lastChild.textContent = button.dataset.idle;
    delete button.dataset.idle;
    button.removeAttribute('aria-busy');
    button.disabled = false;
  }
}

/*
  Tooltips. The browser's own title tooltip only appears for a mouse, after a long wait, in the
  operating system's style. Here an element's title moves into #tip while it is pointed at or
  focused from the keyboard, and goes back afterwards, so every existing title becomes this tooltip
  without each control having to ask for one. Dialogs keep the native ones: the dialog is drawn
  above anything a page element can reach.
*/
(() => {
  const tip = $('#tip');
  let owner = null;
  let timer = 0;
  const hide = () => {
    clearTimeout(timer);
    if (owner) {
      // Code that changed the title while it was lifted wins over the one put back.
      if (!owner.hasAttribute('title') && owner.dataset.tip) owner.setAttribute('title', owner.dataset.tip);
      delete owner.dataset.tip;
      if (owner.getAttribute('aria-describedby') === 'tip') owner.removeAttribute('aria-describedby');
      owner = null;
    }
    tip.removeAttribute('data-on');
  };
  const place = (el) => {
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const x = Math.max(8, Math.min(r.left + r.width / 2 - t.width / 2, innerWidth - t.width - 8));
    let y = r.bottom + 6;
    if (y + t.height > innerHeight - 8) y = r.top - t.height - 6;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  };
  const showFor = (el, delay) => {
    if (owner === el) return;
    hide();
    const text = el.getAttribute('title');
    if (!text || el.closest('dialog')) return;
    owner = el;
    el.dataset.tip = text;
    el.removeAttribute('title');
    timer = setTimeout(() => {
      if (owner !== el || !el.isConnected) return hide();
      tip.textContent = el.dataset.tip;
      if (!el.hasAttribute('aria-describedby')) el.setAttribute('aria-describedby', 'tip');
      tip.setAttribute('data-on', '');
      place(el);
    }, delay);
  };
  document.addEventListener('pointerover', (e) => {
    if (owner && owner.contains(e.target)) return;
    const el = e.target.closest && e.target.closest('[title]');
    if (el) showFor(el, 450);
    else hide();
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest && e.target.closest('[title]');
    if (el && e.target.matches(':focus-visible')) showFor(el, 150);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  // Escape puts the tip away and does nothing else: this listener is on the document before the
  // page's own, which closed the sheet or the tool the tip was in with the same press.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const showing = tip.hasAttribute('data-on');
    hide();
    if (showing) { e.preventDefault(); e.stopImmediatePropagation(); }
  });
  addEventListener('scroll', hide, true);
  addEventListener('blur', hide);
})();

/**
 * The title block a pane opens with.
 *
 * <p>The nav says where you are in one word. This says what the screen is for in a sentence, which
 * is the difference between recognising a screen and working it out. Built here rather than in the
 * markup because every pane's body is cleared and rebuilt on each render.
 */
/**
 * Whether the pane a body sits in is at the Ultra tier, the width from which a pane splits into a
 * well and a companion. The same 2000px the stylesheet's container queries use, measured on the
 * same element, so a script-side decision (load the raw file, keep the form showing) agrees with
 * the layout.
 */
const ULTRA_PANE = 2000;
function paneIsUltra(bodyEl) {
  const scroller = bodyEl.closest('.pane-scroll');
  return Boolean(scroller) && scroller.clientWidth >= ULTRA_PANE;
}

/** Drop whatever title is showing. Every path that empties a pane has to do this too. */
function clearPaneHead(bodyEl) {
  bodyEl.parentElement.querySelector(':scope > .pane-head')?.remove();
}

function paneHead(bodyEl, name, title, subtitle) {
  // A sibling of the body, not a child of it: the body is width-limited and padded for reading,
  // and a title indented to match a text column does not read as the title of the pane.
  const pane = bodyEl.parentElement;
  const existing = pane.querySelector(':scope > .pane-head');
  if (existing) existing.remove();

  // Inside a tool the tab above already names the pane, so only the line saying what it is for
  // shows; the title stays for whoever reads the pane's text.
  const head = document.createElement('div');
  head.className = 'pane-head block px-5 pt-4';
  const h = document.createElement('h2');
  h.hidden = true;
  h.textContent = title;
  const p = document.createElement('p');
  p.className = 'm-0 text-2 leading-[1.45] text-ink-3';
  p.textContent = subtitle;
  head.append(h, p);
  pane.insertBefore(head, bodyEl);
  return head;
}

