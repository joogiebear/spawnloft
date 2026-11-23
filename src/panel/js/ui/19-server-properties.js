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
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ico' + (cls ? ' ' + cls : ''));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

/** A button that carries an icon and a word. The word is what is read out; the icon is for speed. */
function iconButton(name, label, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  if (cls) b.className = cls;
  b.append(icon(name), document.createTextNode(label));
  return b;
}

/**
 * An empty pane that says what would be here.
 *
 * <p>These were a paragraph of grey text against a large blank area, which reads as a page that
 * failed to load rather than one with nothing in it yet. An icon at the size of the thing it
 * stands for turns the same sentence into a state.
 */
function emptyState(name, text, action) {
  const wrap = document.createElement('div');
  wrap.className = 'empty-pane';
  wrap.append(icon(name, 'empty-mark'));
  const p = document.createElement('p');
  p.textContent = text;
  wrap.append(p);
  // The one thing that fills it, where there is one. An empty list with no way out of it is a
  // dead end; the action belongs where the eye already is.
  if (action) {
    const b = iconButton(action.icon || 'plus', action.label, 'primary');
    b.onclick = action.onClick;
    wrap.append(b);
  }
  return wrap;
}

/**
 * Put a pane into its loading state: the previous server's title and rows go, and a skeleton
 * holds the space. Called only when the pane is about to show a different server (or nothing yet),
 * so a refresh of the same server keeps what is on screen until the new answer replaces it.
 */
function paneLoading(body) {
  // An invisible stand-in the height of the title row, so the body does not drop when the real
  // title arrives with the data.
  paneHead(body, 'server', '\u00a0', '\u00a0').classList.add('pane-head-wait');
  const sk = document.createElement('div');
  sk.className = 'skeleton';
  sk.setAttribute('aria-busy', 'true');
  sk.setAttribute('aria-label', 'Loading');
  for (let i = 0; i < 7; i++) sk.append(document.createElement('i'));
  body.replaceChildren(sk);
}

/** A pane whose read failed: the error as the server worded it, and Retry. */
function paneError(body, message, retry) {
  // Kept from the loading state, so the error lands where the skeleton was.
  if (!body.parentElement.querySelector(':scope > .pane-head-wait')) clearPaneHead(body);
  const box = emptyState('alert', message, retry && { icon: 'restart', label: 'Retry', onClick: retry });
  box.classList.add('pane-error');
  box.setAttribute('role', 'alert');
  const b = box.querySelector('button');
  if (b) b.className = '';
  body.replaceChildren(box);
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

  const head = document.createElement('div');
  head.className = 'pane-head';
  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.append(icon(name));
  const h = document.createElement('h2');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = subtitle;
  head.append(mark, h, p);
  pane.insertBefore(head, bodyEl);
  return head;
}

