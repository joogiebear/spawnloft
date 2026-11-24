'use strict';
// --------------------------------------------------------------- chrome ----

/** How many toasts may stand at once. Past that the oldest that is not waiting on work goes. */
const TOAST_MAX = 4;

/**
 * Whether a toast stays until it is dismissed or its job removes it.
 *
 * An error always did. So does one that says work is under way - it ends in an ellipsis, and the
 * caller takes it down when the work ends; five seconds of "Restoring…" followed by nothing read
 * as a restore that had stopped. And so does one asked to stay because it carries something to
 * read or copy: a link, the path of a file just written.
 */
function toastStays(message, kind, opts) {
  if (kind === 'bad' || (opts && opts.stay)) return true;
  return /(\u2026|\.\.\.)$/.test(String(message).trim());
}

/** Which toasts to drop so a new one fits: the oldest first, sparing the ones still working. */
function toastsToDrop(list, max) {
  const over = list.length - max;
  if (over <= 0) return [];
  // Never the newest: it was shown this instant, and may be the error that matters.
  const idle = list.slice(0, -1).filter((t) => !t.working);
  return idle.slice(0, over);
}

function toast(message, kind, opts) {
  // the shared toast (components.css .sl-toast); 'bad' and 'good' are its fault and live tones
  const tone = kind === 'bad' ? 'fault' : kind === 'good' ? 'live' : null;
  const el = document.createElement('div');
  el.className = 'sl-toast';
  if (tone) el.dataset.tone = tone;
  const text = document.createElement('div');
  text.className = 'sl-toast-text';
  text.textContent = message;
  const close = Kit.button({ icon: 'close', kind: 'ghost', size: 'sm', title: 'Dismiss', onClick: () => el.remove() });
  close.classList.add('x'); // what a toast that grows its own buttons puts them before
  // The tone is said by a glyph as well as the colour, so it does not rest on colour alone.
  el.append(Kit.icon(tone === 'fault' ? 'alert' : tone === 'live' ? 'check' : 'bolt'), text, close);
  const stays = toastStays(message, kind, opts);
  // Work under way, or something to read or copy: neither is dropped to make room.
  if (stays && kind !== 'bad') el.dataset.working = '1';
  $('#toasts').append(el);
  $('#live').textContent = message;
  // A plain acknowledgement goes by itself: one that has to be dismissed is just more work.
  if (!stays) setTimeout(() => el.remove(), 5200);
  // Errors do not expire, so they are not left to pile up over the page either.
  const standing = [...$('#toasts').children].map((node) => ({ node, working: node.dataset.working === '1' }));
  for (const t of toastsToDrop(standing, TOAST_MAX)) t.node.remove();
  return el;
}

/**
 * One dialog for every decision that matters.
 *
 * Replaces prompt() and confirm(), which were doing two jobs badly: prompt() is not implemented in
 * Electron at all, and confirm() was carrying a semantic choice through OK/Cancel ("OK = keep
 * plugins, Cancel = wipe them"), which nobody reads correctly under pressure. Confirming by name
 * is kept - it is the moment you actually read which server this is - but the name can be clicked
 * into the box rather than typed, and it is one dialog with named options instead of two guesses
 * in a row.
 */
// One <dialog> serves every prompt, so a dialog that opens another one has to be careful about
// whose events it is hearing. See the note on `cancel` below.
let askSeq = 0;
// A refusal shown in the dialog belongs to that asking: the next thing to open it starts clean.
document.getElementById('dlg').addEventListener('close', () => {
  document.getElementById('dlgError').hidden = true;
  document.getElementById('dlgCancel').disabled = false;
});

/** Whether Confirm is held back: the name not typed yet, or a box left empty that needs a value. */
function askBlocked(opts, typed) {
  if (opts.typeToConfirm) return typed !== opts.typeToConfirm;
  return Boolean(opts.input && opts.input.required) && !String(typed).trim();
}

/** The one dialog is shared; what the last asking laid out under its text is not the next one's. */
function clearDlgDetail() {
  const detail = document.getElementById('dlgDetail');
  detail.replaceChildren();
  detail.hidden = true;
}

function ask(opts) {
  const dlg = $('#dlg');
  $('#dlgTitle').textContent = opts.title;
  $('#dlgText').textContent = opts.text || '';
  $('#dlgText').hidden = !opts.text;

  // something laid out for the dialog to show under its text: a list, a few rows
  const detail = $('#dlgDetail');
  detail.replaceChildren(...(opts.detail ? [opts.detail] : []));
  detail.hidden = !opts.detail;

  const choiceBox = $('#dlgChoice');
  choiceBox.textContent = '';
  choiceBox.hidden = !opts.choices;
  if (opts.choices) {
    opts.choices.forEach((c, i) => {
      // a card per answer: the shared radio, the answer, and what it means
      const label = document.createElement('label');
      label.className = 'grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 rounded-sm border border-line bg-surface px-4 py-3 transition-colors hover:border-edge hover:bg-raised has-checked:border-accent-edge has-checked:bg-accent-wash';
      const input = document.createElement('input');
      input.type = 'radio';
      input.className = 'sl-radio row-span-2 mt-0';
      input.name = 'dlgchoice';
      input.value = c.value;
      if (i === 0) input.checked = true;
      const b = document.createElement('b');
      b.className = 'text-3 font-semibold text-ink';
      b.textContent = c.label;
      const s = document.createElement('span');
      s.className = 'text-3 leading-normal text-ink-3';
      s.textContent = c.hint;
      label.append(input, b, s);
      choiceBox.append(label);
    });
  }

  // One text box serves two jobs: typing a name to confirm something destructive, and answering a
  // question that needs a value. They never appear together, so they share the field rather than
  // the dialog growing a second one that is hidden nine times out of ten.
  const typeWrap = $('#dlgTypeWrap');
  const typeBox = $('#dlgType');
  typeWrap.hidden = !opts.typeToConfirm && !opts.input;
  typeBox.value = opts.input ? (opts.input.value || '') : '';
  typeBox.placeholder = opts.input ? (opts.input.placeholder || '') : '';
  const typeLabel = $('#dlgTypeLabel');
  if (opts.typeToConfirm) {
    // The name is a button. Typing it was the moment you read which server this is; clicking it
    // is the same moment with less to get wrong, and a name like "Survival-Season-3-2" is more
    // often mistyped than misread. The box is still there for anyone who prefers to type.
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'cursor-pointer appearance-none rounded-[3px] border-0 bg-transparent -mx-0.5 px-0.5 py-0 font-mono text-1 leading-none font-semibold tracking-[0] text-ink normal-case underline decoration-dotted underline-offset-3 transition-colors hover:bg-hover-hi';
    name.title = 'Click to fill it in';
    name.textContent = opts.typeToConfirm;
    name.onclick = () => {
      typeBox.value = opts.typeToConfirm;
      typeBox.dispatchEvent(new Event('input'));
      typeBox.focus();
    };
    typeLabel.replaceChildren('Type ', name, ' to confirm');
  } else if (opts.input) typeLabel.textContent = opts.input.label || '';

  const ok = $('#dlgOk');
  ok.textContent = opts.confirmLabel || 'Confirm';
  ok.className = 'sl-btn ' + (opts.danger ? 'sl-btn-danger' : 'sl-btn-primary');
  // Nothing to cancel when the dialog is telling you something rather than asking.
  $('#dlgCancel').hidden = Boolean(opts.tellOnly);

  const errBox = $('#dlgError');
  errBox.textContent = '';
  errBox.hidden = true;
  $('#dlgCancel').disabled = false;
  // Confirm waits for the name to be typed, or for a value the question cannot do without: a
  // dialog that closes on an empty box and then does nothing reads as a button that is broken.
  const check = () => { ok.disabled = askBlocked(opts, typeBox.value); };
  check();
  typeBox.oninput = () => { errBox.hidden = true; check(); };

  const mine = ++askSeq;
  let submitting = false;

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('close', onClose);
      ok.onclick = null;
      $('#dlgCancel').onclick = null;
      typeBox.oninput = null;
      typeBox.onkeydown = null;
      if (dlg.open) dlg.close();
      // Emptied here and not on 'close': that event arrives late, after the next dialog has
      // opened, and would take the next one's detail with it.
      clearDlgDetail();
      resolve(result);
    };
    /*
      'cancel' first, 'close' as the net.

      close() queues its 'close' event rather than firing it inline, so a dialog that answers by
      opening a second dialog - Manage, then Delete - had the first one's queued event arrive after
      the second had already opened, and shut it again immediately. 'cancel' fires only when the
      person actually dismisses the dialog, which is the thing being listened for.

      But a browser can close a modal without ever firing 'cancel' - Chrome does when it decides
      the Escape lacked user activation - and then the dialog was gone while this promise waited
      for an answer that would never come. So 'close' is heard too, behind the sequence guard: a
      stale close from a dialog this one replaced fails the guard, and a close of THIS dialog with
      no answer resolves as the cancel it was.
    */
    const onCancel = (e) => {
      if (mine !== askSeq) return;
      // Escape while the answer is being acted on would leave the request running with nobody
      // to hear how it went.
      if (submitting) return e.preventDefault();
      done(null);
    };
    // A stale 'close' - queued by the dialog this one replaced, arriving after showModal() - finds
    // the dialog open again; a real close finds it shut. Only the real one is an answer.
    const onClose = () => {
      if (mine !== askSeq || dlg.open) return;
      // Closed under a save that is still running (a second Escape is not always offered to
      // 'cancel'): put it back, so there is somewhere for the answer to be said.
      if (submitting) return dlg.showModal();
      done(null);
    };
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('close', onClose);
    ok.onclick = async () => {
      const picked = choiceBox.querySelector('input:checked');
      const result = { choice: picked ? picked.value : null, text: typeBox.value.trim() };
      if (!opts.submit) return done(result);
      /*
        `submit` does the thing the dialog asked about while the dialog is still open. A refusal -
        a name that is taken, a folder that is not there - is shown under the field with the
        typing still in it, where a toast after the dialog had closed threw the typing away.
      */
      submitting = true;
      errBox.hidden = true;
      ok.disabled = true;
      $('#dlgCancel').disabled = true;
      const label = ok.textContent;
      ok.textContent = 'Working\u2026';
      try {
        result.out = await opts.submit(result);
      } catch (err) {
        if (mine !== askSeq || settled) return;
        submitting = false;
        ok.textContent = label;
        $('#dlgCancel').disabled = false;
        errBox.textContent = err.message;
        errBox.hidden = false;
        check();
        if (!typeWrap.hidden) { typeBox.focus(); typeBox.select(); }
        return;
      }
      submitting = false;
      $('#dlgCancel').disabled = false;
      done(result);
    };
    $('#dlgCancel').onclick = () => done(null);
    typeBox.onkeydown = (e) => {
      if (e.key === 'Enter' && !ok.disabled) { e.preventDefault(); ok.click(); }
    };
    dlg.showModal();
    (opts.typeToConfirm || opts.input ? typeBox : ok).focus();
  });
}

const VIEW_EL = { empty: '#vEmpty', home: '#vHome', server: '#vServer', play: '#vPlay', add: '#vAdd', settings: '#vSettings', feedback: '#vFeedback' };

function show(view) {
  state.view = view;
  for (const key of Object.keys(VIEW_EL)) $(VIEW_EL[key]).toggleAttribute('data-active', key === view);
  // leaving the Play page with its setup sheet open must not leave the panel locked behind it
  lockBehindPlay();
  // The sections list belongs to the server screen; on the overview or a sheet the sidebar is servers only.
  if ($('#dock')) markTabs();
}

