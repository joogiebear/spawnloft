'use strict';
// ------------------------------------------------------------ server list look ---

const MC_COLOURS = {
  0: '#000000', 1: '#0000AA', 2: '#00AA00', 3: '#00AAAA', 4: '#AA0000', 5: '#AA00AA', 6: '#FFAA00', 7: '#AAAAAA',
  8: '#555555', 9: '#5555FF', a: '#55FF55', b: '#55FFFF', c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF',
};

/**
 * A MOTD as Minecraft draws it. server.properties spells the section sign as \u00A7 and a line break
 * as \n; both are read that way here, and a literal \u00a7 too. Obfuscated text (k) is shown plainly.
 */
function mcText(raw) {
  const text = String(raw || '').replace(/\\u00a7/gi, '\u00a7').replace(/\\n/g, '\n');
  const frag = document.createDocumentFragment();
  let style = { color: MC_COLOURS[7], b: false, i: false, u: false, s: false };
  let buf = '';
  const flush = () => {
    if (!buf) return;
    const span = document.createElement('span');
    span.textContent = buf;
    span.style.color = style.color;
    if (style.b) span.style.fontWeight = '700';
    if (style.i) span.style.fontStyle = 'italic';
    const lines = [style.u && 'underline', style.s && 'line-through'].filter(Boolean);
    if (lines.length) span.style.textDecoration = lines.join(' ');
    frag.append(span);
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\u00a7' && i + 1 < text.length) {
      flush();
      const code = text[++i].toLowerCase();
      if (Object.hasOwn(MC_COLOURS, code)) style = { color: MC_COLOURS[code], b: false, i: false, u: false, s: false };
      else if (code === 'l') style.b = true;
      else if (code === 'o') style.i = true;
      else if (code === 'n') style.u = true;
      else if (code === 'm') style.s = true;
      else if (code === 'r') style = { color: MC_COLOURS[7], b: false, i: false, u: false, s: false };
    } else if (ch === '\n') {
      flush();
      frag.append(document.createElement('br'));
    } else {
      buf += ch;
    }
  }
  flush();
  return frag;
}

function serverListPreview(row, input) {
  const wrap = document.createElement('div');
  wrap.className = 'mc-look';
  const palette = document.createElement('div');
  palette.className = 'mc-palette';
  palette.setAttribute('role', 'group');
  palette.setAttribute('aria-label', 'Insert a colour or style');
  const insert = (code) => {
    const at = input.selectionStart ?? input.value.length;
    const tag = '\\u00A7' + code;
    input.setRangeText(tag, at, input.selectionEnd ?? at, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  };
  for (const [code, hex] of Object.entries(MC_COLOURS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mc-swatch';
    b.style.background = hex;
    b.title = 'Colour \u00a7' + code;
    b.setAttribute('aria-label', 'Colour ' + code);
    b.onclick = () => insert(code);
    palette.append(b);
  }
  for (const [code, label, glyph] of [['l', 'Bold', 'B'], ['o', 'Italic', 'I'], ['n', 'Underline', 'U'], ['m', 'Strikethrough', 'S'], ['r', 'Reset', '\u21ba']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mc-style';
    b.textContent = glyph;
    b.title = label + ' (\u00a7' + code + ')';
    b.setAttribute('aria-label', label);
    b.onclick = () => insert(code);
    palette.append(b);
  }

  const card = document.createElement('div');
  card.className = 'mc-entry';
  card.setAttribute('aria-label', 'How it looks in the multiplayer list');
  const img = document.createElement('img');
  img.className = 'mc-icon';
  img.alt = '';
  img.width = 64;
  img.height = 64;
  const blank = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#3b3b3b"/><rect x="1" y="1" width="6" height="6" fill="#555"/></svg>');
  const iconUrl = '/api/instances/' + encodeURIComponent(row.name) + '/icon';
  const loadIcon = () => { img.src = iconUrl + '?t=' + Date.now(); };
  img.onerror = () => { img.onerror = null; img.src = blank; img.dataset.none = ''; };
  loadIcon();
  const text = document.createElement('div');
  text.className = 'mc-text';
  const title = document.createElement('div');
  title.className = 'mc-name';
  title.textContent = row.label || row.name;
  const lines = document.createElement('div');
  lines.className = 'mc-motd';
  text.append(title, lines);
  card.append(img, text);
  const draw = () => { lines.textContent = ''; lines.append(mcText(input.value)); };
  input.addEventListener('input', draw);
  draw();

  const iconRow = document.createElement('div');
  iconRow.className = 'row';
  const pick = document.createElement('input');
  pick.type = 'file';
  pick.accept = 'image/*';
  pick.hidden = true;
  const change = iconButton('upload', 'Change icon', 'ghost');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'ghost';
  remove.textContent = 'Remove icon';
  const iconNote = document.createElement('span');
  iconNote.className = 'hint';
  iconNote.textContent = 'Any image; it is cut to a square and scaled to 64 by 64. Saved at once.';
  iconRow.append(change, remove, iconNote, pick);
  change.onclick = () => pick.click();
  pick.onchange = async () => {
    const file = pick.files && pick.files[0];
    pick.value = '';
    if (!file) return;
    try {
      const bitmap = await createImageBitmap(file);
      const side = Math.min(bitmap.width, bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const g = canvas.getContext('2d');
      // Pixel art stays sharp; a photo is smoothed. Small sources are the pixel art.
      g.imageSmoothingEnabled = side > 128;
      g.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 64, 64);
      const out = await post('/instances/' + encodeURIComponent(row.name) + '/icon', { png: canvas.toDataURL('image/png') });
      toast('Icon saved.' + (out.appliesOnRestart ? ' Players see it after the next restart.' : ''), 'good');
      delete img.dataset.none;
      img.onerror = () => { img.onerror = null; img.src = blank; img.dataset.none = ''; };
      loadIcon();
    } catch (e) {
      toast(e.message || 'That image could not be read.', 'bad');
    }
  };
  remove.onclick = async () => {
    try {
      await post('/instances/' + encodeURIComponent(row.name) + '/icon/remove');
      img.src = blank;
      img.dataset.none = '';
      toast('Icon removed.', 'good');
    } catch (e) { toast(e.message, 'bad'); }
  };

  wrap.append(palette, card, iconRow);
  return wrap;
}

/**
 * The steps of a chained task: a list to add to, reorder and remove from, and a few ready-made
 * chains to start from, since most people want one of the same three.
 *
 * <p>Returns the element and a `value()` for the form to send. The server checks every step again;
 * this only keeps the form from offering what it would refuse.
 */
const STEP_LABELS = {
  say: 'Tell the players', command: 'Run a command', wait: 'Wait', countdown: 'Count down',
  backup: 'Take a backup', verify: 'Verify the backups', stop: 'Stop the server', start: 'Start the server', restart: 'Restart the server',
};
const STEP_PRESETS = [
  { label: 'Restart with a warning and a backup first', steps: [{ do: 'countdown', minutes: 5 }, { do: 'backup', keep: 7 }, { do: 'restart' }] },
  { label: 'Back up, telling the players', steps: [{ do: 'say', text: 'Backing up - expect a moment of lag' }, { do: 'backup', keep: 7 }, { do: 'say', text: 'Backup done' }] },
  { label: 'Stop, take a full backup, start again', steps: [{ do: 'countdown', minutes: 1, message: 'Server stopping for a backup' }, { do: 'stop' }, { do: 'backup', keep: 7 }, { do: 'start' }] },
];

function stepsEditor(action) {
  const el = document.createElement('div');
  el.className = 'steps';
  let steps = action ? action.steps.map((st) => ({ ...st })) : STEP_PRESETS[0].steps.map((st) => ({ ...st }));
  const list = document.createElement('ol');
  list.className = 'step-list';
  const tools = document.createElement('div');
  tools.className = 'row';
  const add = document.createElement('select');
  add.setAttribute('aria-label', 'Add a step');
  add.append(new Option('Add a step\u2026', ''));
  for (const [k, label] of Object.entries(STEP_LABELS)) add.append(new Option(label, k));
  const preset = document.createElement('select');
  preset.setAttribute('aria-label', 'Start from a ready-made chain');
  preset.append(new Option('Start from\u2026', ''));
  STEP_PRESETS.forEach((p, i) => preset.append(new Option(p.label, String(i))));
  tools.append(add, preset);

  const running = document.createElement('label');
  running.className = 'check';
  const runningBox = document.createElement('input');
  runningBox.type = 'checkbox';
  runningBox.checked = Boolean(action && action.onlyWhenRunning);
  running.append(runningBox, document.createTextNode(' Only while the server is running - otherwise the whole task is skipped'));
  const going = document.createElement('label');
  going.className = 'check';
  const goingBox = document.createElement('input');
  goingBox.type = 'checkbox';
  goingBox.checked = Boolean(action && action.keepGoing);
  going.append(goingBox, document.createTextNode(' Keep going if a step fails'));
  el.append(list, tools, running, going);

  const num = (value, min, max, width) => {
    const i = document.createElement('input');
    i.type = 'number';
    i.min = String(min);
    i.max = String(max);
    i.value = String(value);
    i.style.maxWidth = width || '80px';
    return i;
  };

  const focusStep = (at, label) => {
    const row = list.children[at];
    const buttons = row ? [...row.querySelectorAll('button')].filter((b) => !b.disabled) : [];
    const to = buttons.find((b) => b.getAttribute('aria-label') === label) || buttons[0] || add;
    to.focus();
  };
  const draw = () => {
    list.textContent = '';
    steps.forEach((st, i) => {
      const li = document.createElement('li');
      li.className = 'step';
      const name = document.createElement('b');
      name.textContent = STEP_LABELS[st.do] || st.do;
      const fields = document.createElement('span');
      fields.className = 'step-fields';
      if (st.do === 'say' || st.do === 'command') {
        const t = document.createElement('input');
        t.maxLength = 400;
        t.value = st.do === 'say' ? (st.text || '') : (st.line || '');
        t.placeholder = st.do === 'say' ? 'What the players see' : 'save-all';
        t.setAttribute('aria-label', st.do === 'say' ? 'What the players see' : 'The command to run');
        t.oninput = () => { if (st.do === 'say') st.text = t.value; else st.line = t.value; };
        fields.append(t);
      } else if (st.do === 'wait') {
        const n = num(st.seconds != null ? Math.round(st.seconds / 60 * 10) / 10 : 1, 0.1, 60);
        n.step = '0.5';
        n.setAttribute('aria-label', 'Minutes to wait');
        n.oninput = () => { st.seconds = Math.round(Number(n.value) * 60); };
        fields.append(n, document.createTextNode(' minutes'));
      } else if (st.do === 'countdown') {
        const n = num(st.minutes || 5, 1, 60);
        n.setAttribute('aria-label', 'Minutes of countdown');
        const m = document.createElement('input');
        m.maxLength = 120;
        m.value = st.message || 'Server restarting';
        m.setAttribute('aria-label', 'What the countdown says');
        // what the players will read, shown: it was a tip on the box
        const eg = document.createElement('span');
        eg.className = 'hint';
        const sayEg = () => {
          const mins = Number(n.value) || 5;
          eg.textContent = 'Players see \u201c' + (m.value || 'Server restarting') + ' in ' + mins + (mins === 1 ? ' minute' : ' minutes') + '\u201d, then again at one minute and at ten seconds.';
        };
        n.oninput = () => { st.minutes = Number(n.value); sayEg(); };
        m.oninput = () => { st.message = m.value; sayEg(); };
        sayEg();
        fields.append(n, document.createTextNode(' minutes: '), m, eg);
      } else if (st.do === 'backup') {
        const n = num(st.keep || 7, 1, 365);
        n.setAttribute('aria-label', 'How many backups to keep');
        n.oninput = () => { st.keep = Number(n.value); };
        fields.append(document.createTextNode('keeping '), n);
      }
      const acts = document.createElement('span');
      acts.className = 'step-acts';
      const mv = (label, glyph, d) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'icon-btn';
        b.textContent = glyph;
        b.setAttribute('aria-label', label);
        b.title = label;
        const j = i + d;
        b.disabled = j < 0 || j >= steps.length;
        // the step moved, and focus goes with it: on the same arrow, or the other one at an end
        b.onclick = () => { [steps[i], steps[j]] = [steps[j], steps[i]]; draw(); focusStep(j, label); };
        return b;
      };
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'icon-btn';
      rm.setAttribute('aria-label', 'Remove this step');
      rm.title = 'Remove this step';
      rm.append(icon('close'));
      rm.onclick = () => { steps.splice(i, 1); draw(); focusStep(Math.min(i, steps.length - 1), 'Remove this step'); };
      acts.append(mv('Move up', '\u2191', -1), mv('Move down', '\u2193', 1), rm);
      li.append(name, fields, acts);
      list.append(li);
    });
  };
  add.onchange = () => {
    if (!add.value) return;
    const k = add.value;
    steps.push(k === 'say' ? { do: k, text: '' } : k === 'command' ? { do: k, line: '' } : k === 'wait' ? { do: k, seconds: 60 }
      : k === 'countdown' ? { do: k, minutes: 5 } : k === 'backup' ? { do: k, keep: 7 } : { do: k });
    add.value = '';
    draw();
  };
  preset.onchange = () => {
    if (preset.value === '') return;
    steps = STEP_PRESETS[Number(preset.value)].steps.map((st) => ({ ...st }));
    preset.value = '';
    draw();
  };
  draw();
  return {
    el,
    value: () => ({ steps: steps.map((st) => ({ ...st })), onlyWhenRunning: runningBox.checked, keepGoing: goingBox.checked }),
  };
}

/**
 * The form for a new task, or for editing one that exists.
 *
 * <p>Which fields it shows depends on what is chosen: a command needs a line to send, a weekly
 * schedule needs a day, an interval needs a number. Showing all of them at once and ignoring the
 * irrelevant ones is how a form ends up asking what time a "every 30 minutes" task should run.
 *
 * <p>Returns the element; the caller decides where it goes and what happens on submit.
 */
function taskForm({ actions, kinds, days, task, onCancel, onSubmit }) {
  const form = document.createElement('div');
  form.className = 'task-form';

  const mk = (label, control) => {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const l = document.createElement('label');
    l.textContent = label;
    wrap.append(l, control);
    return wrap;
  };
  const select = (options, value) => {
    const el = document.createElement('select');
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      opt.selected = o.value === value;
      el.append(opt);
    }
    return el;
  };

  const act = select(actions.map((a) => ({ value: a.type, label: a.label })), task?.action?.type ?? 'backup');
  const actField = mk('What should happen', act);

  const line = document.createElement('input');
  line.placeholder = 'say Server restarting in 5 minutes';
  line.value = task?.action?.line ?? '';
  line.maxLength = 400;
  const lineField = mk('Console command to send', line);

  const keep = document.createElement('input');
  keep.type = 'number';
  keep.min = '1';
  keep.max = '365';
  keep.value = String(task?.action?.keep ?? 7);
  keep.style.maxWidth = '90px';
  const keepField = mk('Backups to keep', keep);

  const warn = document.createElement('input');
  warn.type = 'number';
  warn.min = '0';
  warn.max = '60';
  warn.value = String(task?.action?.warnMinutes ?? 5);
  warn.style.maxWidth = '90px';
  const warnField = mk('Minutes of warning first', warn);

  const kind = select(kinds.map((k) => ({ value: k, label: KIND_LABELS[k] || k })), task?.schedule?.kind ?? 'daily');
  const every = document.createElement('input');
  every.type = 'number';
  every.min = '1';
  every.value = String(task?.schedule?.every ?? 6);
  every.style.maxWidth = '90px';
  const at = document.createElement('input');
  at.type = 'time';
  at.value = task?.schedule?.at ?? '03:00';
  at.style.maxWidth = '130px';
  const day = select(days.map((d) => ({ value: d, label: DAY_NAMES[d] || d })), task?.schedule?.day ?? 'SUN');
  day.style.maxWidth = '150px';

  const everyField = mk('How many', every);
  const atField = mk('At', at);
  const dayField = mk('On', day);
  const whenRow = document.createElement('div');
  whenRow.className = 'when-row';
  whenRow.append(mk('How often', kind), everyField, dayField, atField);

  const title = document.createElement('input');
  title.maxLength = 60;
  title.value = task?.name ?? '';
  const titleField = mk('Call it', title);

  const note = document.createElement('div');
  note.className = 'hint';

  const row = document.createElement('div');
  row.className = 'row';
  const save = document.createElement('button');
  save.className = 'primary';
  save.textContent = task ? 'Save changes' : 'Create task';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  row.append(save, cancel);

  const chain = stepsEditor(task && task.action && task.action.type === 'steps' ? task.action : null);
  const chainField = mk('Steps, in order', chain.el);

  form.append(actField, lineField, keepField, warnField, chainField, whenRow, titleField, note, row);

  const sync = () => {
    const a = act.value;
    const k = kind.value;
    lineField.hidden = a !== 'command';
    keepField.hidden = a !== 'backup';
    warnField.hidden = a !== 'restart';
    chainField.hidden = a !== 'steps';
    everyField.hidden = k !== 'minutes' && k !== 'hourly';
    dayField.hidden = k !== 'weekly';
    atField.hidden = k !== 'daily' && k !== 'weekly';
    // The limits are Windows', enforced for real in normaliseSchedule. Applying them here too
    // means switching from "every 90 minutes" to hours corrects the 90 rather than letting it be
    // sent and bounced - a number input's max is advisory, not enforced on submit.
    const most = k === 'minutes' ? 1439 : 23;
    every.min = '1';
    every.max = String(most);
    const n = Number(every.value);
    if (!Number.isInteger(n) || n < 1) every.value = '1';
    else if (n > most) every.value = String(most);
    const meta = actions.find((x) => x.type === a);
    // The example name follows the action, so a command task is not prompted with "Nightly backup".
    title.placeholder = meta ? meta.label : 'Scheduled task';
    note.textContent = meta && meta.needsRunning
      ? 'Skipped, and recorded as skipped, whenever the server is not running at that moment.'
      : a === 'steps'
      ? 'One after another in one run: a step waits for the one before it, however long that takes. A step that fails stops the rest unless you say otherwise.'
      : '';
    note.hidden = !note.textContent;
  };
  act.onchange = sync;
  kind.onchange = sync;
  sync();

  cancel.onclick = onCancel;
  save.onclick = async () => {
    const action = { type: act.value };
    if (act.value === 'command') action.line = line.value.trim();
    // Cleared or zeroed, this used to store as "no limit" and quietly disable pruning on a task
    // that runs unattended - which is how a backups folder fills a disk.
    if (act.value === 'backup') action.keep = Math.min(Math.max(Math.round(Number(keep.value)) || 1, 1), 365);
    // Zero is a real choice - an empty 5am server has nobody to warn - so || is not used here.
    if (act.value === 'restart') action.warnMinutes = Math.min(Math.max(Math.round(Number(warn.value) || 0), 0), 60);
    if (act.value === 'steps') Object.assign(action, chain.value());
    const sched = { kind: kind.value };
    // sync() clamps when a dropdown changes; this catches a number typed straight into the box
    // afterwards, which nothing else was checking before it was sent and bounced.
    if (kind.value === 'minutes' || kind.value === 'hourly') {
      const most = kind.value === 'minutes' ? 1439 : 23;
      sched.every = Math.min(Math.max(Math.round(Number(every.value)) || 1, 1), most);
    }
    if (kind.value === 'daily' || kind.value === 'weekly') sched.at = at.value;
    if (kind.value === 'weekly') sched.day = day.value;
    save.disabled = true;
    try {
      await onSubmit({ name: title.value.trim(), action, schedule: sched });
    } finally {
      save.disabled = false;
    }
  };
  return form;
}

/**
 * Everything scheduled for this server, and what happened when it ran.
 *
 * <p>The run log is the half Task Scheduler cannot give you. Windows records an exit code per task
 * and nothing else, so "0" is all it can say about a backup; spawnloft writes its own line naming the
 * file it produced, and both are shown - the state from Windows, the detail from us.
 */
/**
 * The line under the Schedule title: what runs the tasks, and when they do not run.
 *
 * It used to end by saying they run with the panel open or not, which is true and reads as
 * "always". Tasks belong
 * to the signed-in account on every system, and stop when it signs out: that was said only inside
 * a closed "How this runs". On Linux an account with lingering on is the one exception.
 */
function scheduleSubtitle(platform, linger) {
  const by = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'your system';
  const what = 'Backups, restarts and console commands on a clock, run by ' + by;
  if (platform === 'linux' && linger === true) return what + ' even with SpawnLoft closed and after you log out.';
  return what + ' while you are ' + (platform === 'linux' ? 'logged in' : 'signed in') + ' to this computer, even with SpawnLoft closed.';
}

/**
 * On Linux, scheduled work stops at logout unless lingering is on for the account.
 *
 * <p>On a desktop that is what Windows promises too. On a server someone reaches over SSH and
 * disconnects from, it means the nightly backup never runs, and nothing reports a failure because
 * nothing was started - so it is said where the schedule is made, with the way out beside it, rather
 * than left in a hint. At a desktop the same fact is the ordinary arrangement, not a fault, so
 * there it is a plain note with the same button. Returns null when there is nothing to say:
 * lingering is on, the answer is unknown, or this is not Linux.
 */
function lingerNotice(background, refresh) {
  if (panelPlatform !== 'linux' || !background || background.linger !== false) return null;
  const box = document.createElement('div');
  const headless = background.session !== 'desktop';
  box.className = headless ? 'notice warn' : 'notice';
  const text = document.createElement('div');
  text.className = 'text';
  const lead = document.createElement('b');
  lead.textContent = headless ? 'These only run while you are logged in.' : 'These pause when you log out.';
  text.append(lead, headless
    ? ' Your account stops its background tasks when you log out. On a server you connect to and disconnect from, a nightly backup would never run.'
    : ' They run while you are logged in, with the screen locked too. Turn this on if backups and servers should keep going after you log out of this computer.');
  const acts = document.createElement('div');
  acts.className = 'acts';
  const fix = document.createElement('button');
  fix.textContent = 'Keep running after logout';
  fix.title = 'Turns on lingering for your account (loginctl enable-linger)';
  fix.onclick = async () => {
    fix.disabled = true;
    try {
      await api('/scheduler/linger', { method: 'POST' });
      toast('Scheduled tasks will now run while you are logged out.', 'good');
      await refresh();
    } catch (e) {
      // Policy may require a password, which a page cannot supply; the message carries the command.
      toast(e.message, 'bad');
      fix.disabled = false;
    }
  };
  acts.append(fix);
  box.append(text, acts);
  return box;
}

async function renderScheduler(opts) {
  const force = Boolean(opts && opts.force);
  const row = rowOf(state.current);
  const body = $('#schedulerBody');
  if (!row) { body.textContent = ''; clearPaneHead(body); return; }
  if (!force && body.dataset.for === row.name && body.childElementCount) return;
  if (body.dataset.for !== row.name) paneLoading(body);
  body.dataset.for = row.name;

  let data;
  try {
    data = await api('/instances/' + encodeURIComponent(row.name) + '/schedules');
  } catch (e) {
    paneError(body, e.message, () => renderScheduler({ force: true }));
    // Cleared, so leaving the tab and coming back tries again. Leaving it set cached the failure
    // as if it were the drawn pane, and the error stayed until the server was reselected.
    body.dataset.for = '';
    return;
  }
  if (body.dataset.for !== row.name) return;
  body.textContent = '';
  paneHead(body, 'clock', 'Scheduled work',
    data.available === false ? 'Not available in this preview.'
      : scheduleSubtitle(panelPlatform, data.background && data.background.linger));
  if (data.available === false) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = data.reason;
    body.append(note);
    return;
  }

  const base = '/instances/' + encodeURIComponent(row.name) + '/schedules';
  const again = () => renderScheduler({ force: true });

  // One form open at a time. Two of them - New task plus an edit, or two edits - put two "Save
  // changes" buttons on screen with nothing to say which task either belonged to, and hid the
  // cards that would have said.
  const editor = {
    restore: null,
    close() {
      const undo = this.restore;
      this.restore = null;
      if (undo) undo();
    },
  };

  // ---- what a schedule is, before the list of them ---------------------------
  // The title row already says tasks run with SpawnLoft closed; which scheduler holds them and
  // what happens at sleep or sign-out is for whoever asks.
  const intro = document.createElement('details');
  intro.className = 'more';
  const introTitle = document.createElement('summary');
  introTitle.textContent = 'How this runs';
  const introText = document.createElement('p');
  introText.className = 'hint';
  introText.textContent = 'Held by ' + schedulerName + '. ' + schedulerHint;
  intro.append(introTitle, introText);
  body.append(intro);
  const lingering = lingerNotice(data.background, again);
  if (lingering) body.append(lingering);

  // ---- add ------------------------------------------------------------------
  const addWrap = document.createElement('div');
  const add = iconButton('plus', 'New task', 'primary');
  addWrap.append(add);
  body.append(addWrap);
  // With no tasks the empty state carries the one primary action, so two never sit stacked.
  add.hidden = !data.tasks.length;

  add.onclick = () => {
    editor.close();
    add.hidden = true;
    const form = taskForm({
      actions: data.actions,
      kinds: data.kinds,
      days: data.days,
      onCancel: () => editor.close(),
      onSubmit: async (payload) => {
        try {
          await post(base, payload);
          toast('Task created.', 'good');
          await again();
        } catch (e) {
          toast(e.message, 'bad');
        }
      },
    });
    addWrap.append(form);
    editor.restore = () => { form.remove(); add.hidden = !data.tasks.length; };
  };

  // ---- the tasks ------------------------------------------------------------
  const listTitle = document.createElement('h3');
  listTitle.className = 'hist-title';
  listTitle.textContent = 'Tasks (' + data.tasks.length + ')';

  if (!data.tasks.length) {
    body.append(emptyState('clock', 'Nothing scheduled. A nightly backup and a daily restart are '
      + 'the two most servers ever need.', { icon: 'plus', label: 'New task', onClick: () => add.onclick() }));
  } else {
    body.append(listTitle);
    const list = document.createElement('div');
    list.className = 'tasks';
    for (const task of data.tasks) list.append(taskCard(task, data, base, again, editor));
    body.append(list);
  }

  // ---- what actually ran ----------------------------------------------------
  // With no tasks there is nothing that could have run, and a second empty state under the first
  // said so at length. The runs section appears once there is a task to produce one.
  if (!data.tasks.length && !data.runs.length) return;

  const runTitle = document.createElement('h3');
  runTitle.className = 'hist-title';
  runTitle.style.marginTop = '18px';
  runTitle.textContent = 'Recent runs';
  body.append(runTitle);

  if (!data.runs.length) {
    body.append(emptyState('bolt', 'Nothing has run yet. Every run writes a line here, including '
      + 'the ones that fail.'));
  } else {
    const runs = document.createElement('div');
    runs.className = 'runs';
    for (const r of data.runs) {
      const el = document.createElement('div');
      el.className = 'run';
      el.dataset.status = r.status;
      const when = document.createElement('span');
      when.className = 'r-when';
      when.textContent = stamp(r.at);
      const who = document.createElement('span');
      who.className = 'r-who';
      const task = (data.tasks || []).find((t) => t.id === r.id);
      who.textContent = (task && task.name) || r.id || r.action;
      const what = document.createElement('span');
      what.className = 'r-what';
      // A skip is neither a success nor a failure and reads as neither. Prefixing every line with
      // its outcome would be noise when almost all of them say ok.
      // the folder a backup went to is the same every night; when it was taken is what differs
      const said = backupNamesToWords(String(r.detail || '').replace(/^.*[\\/](?=[^\\/]*\.tar\.gz)/, ''));
      what.textContent = (r.status === 'ok' ? '' : r.status + ': ') + said;
      what.title = r.detail || '';
      el.append(when, who, what);
      runs.append(el);
    }
    body.append(runs);
  }
}

/** One scheduled task, with the four things you can do to it. */
function taskCard(task, data, base, again, editor) {
  const el = document.createElement('div');
  el.className = 'task';
  if (!task.enabled) el.setAttribute('data-off', '');
  else if (!task.known) el.setAttribute('data-missing', '');

  const what = document.createElement('div');
  what.className = 't-what';
  what.textContent = task.name;
  // The Backups tab makes one of these and keeps a toggle pointing at it. Showing it here without
  // saying so would leave someone wondering where it came from - and deleting it from here is
  // allowed, so the label also explains what the toggle will read afterwards.
  if (task.owner === 'backups') {
    const from = document.createElement('span');
    from.className = 't-owner';
    from.textContent = 'from the Backups tab';
    what.append(' ', from);
  }

  const state = document.createElement('div');
  state.className = 't-state';
  if (!task.enabled) {
    state.textContent = 'Off';
    state.dataset.tone = 'off';
  } else if (!task.known) {
    // spawnloft has a definition Windows has never heard of. Someone deleted it in Task Scheduler, or
    // the query failed - either way it is not going to run, and saying "Ready" would be a lie.
    state.textContent = 'Not in Windows';
    state.dataset.tone = 'bad';
    state.title = 'SpawnLoft has this task but the system scheduler does not. Edit it to put it back.';
  } else {
    state.textContent = task.state || 'Ready';
    state.dataset.tone = task.state === 'Running' ? 'good' : '';
  }

  const when = document.createElement('div');
  when.className = 't-when';
  const bits = [actionSummary(task, data.actions), describeSchedule(task.schedule)];
  when.textContent = bits.join('  \u00b7  ');
  if (task.enabled && task.known) {
    const next = whenNext(task.nextRun);
    const extra = document.createElement('div');
    extra.textContent = (next ? 'Next ' + next : 'No next run scheduled')
      + (task.lastResult ? '  \u00b7  last run: ' + task.lastResult : '');
    when.append(extra);
  }

  const acts = document.createElement('div');
  acts.className = 't-acts';
  const runNow = iconButton('bolt', 'Run now');
  const toggle = document.createElement('button');
  toggle.textContent = task.enabled ? 'Turn off' : 'Turn on';
  const edit = iconButton('pencil', 'Edit');
  const drop = iconButton('trash', 'Delete', 'danger');
  acts.append(runNow, toggle, edit, drop);
  el.append(what, state, when, acts);

  const busy = (on) => { for (const b of acts.children) b.disabled = on; };

  runNow.onclick = async () => {
    // The pane says whose tasks it is showing; `state` in here is this card's own status cell.
    const server = $('#schedulerBody').dataset.for;
    // A task that stops or restarts the server does it to whoever is on, now and not at 4 a.m.
    const question = stopQuestion(taskDisconnects(task), rowOf(server), []);
    if (question && !(await ask({ ...question, title: 'Run \u201c' + task.name + '\u201d now?', confirmLabel: 'Run now' }))) return;
    busy(true);
    try {
      await post(base + '/' + encodeURIComponent(task.id) + '/run');
      // Windows starts the task and returns immediately, so there is nothing to report yet beyond
      // having asked. The run log below is where the answer turns up.
      toast('Started. Watch Recent runs for what it did.', 'good');
      // Only if nothing is being edited. The refresh rebuilds the whole pane, and doing that under
      // a half-filled form throws the typing away with nothing said.
      // A restart is in the log in a couple of seconds and a backup of a large world in a minute,
      // so it is looked for more than once. Each look reads the list whole, which is also what
      // moves "Next" on.
      for (const ms of RUN_CHECKS_MS) {
        setTimeout(() => {
          if ($('#schedulerBody').dataset.for !== server || toolView.tool !== 'scheduler') return;
          if (!paneHolds($('#schedulerBody'))) redrawTool('scheduler');
        }, ms);
      }
    } catch (e) {
      toast(e.message, 'bad');
      busy(false);
    }
  };

  toggle.onclick = async () => {
    busy(true);
    try {
      await post(base + '/' + encodeURIComponent(task.id) + '/enable', { enabled: !task.enabled });
      await again();
    } catch (e) {
      toast(e.message, 'bad');
      busy(false);
    }
  };

  edit.onclick = () => {
    editor.close();
    const form = taskForm({
      actions: data.actions,
      kinds: data.kinds,
      days: data.days,
      task,
      onCancel: () => editor.close(),
      onSubmit: async (payload) => {
        try {
          await post(base + '/' + encodeURIComponent(task.id), payload);
          toast('Saved.', 'good');
          await again();
        } catch (e) {
          toast(e.message, 'bad');
        }
      },
    });
    el.hidden = true;
    el.after(form);
    editor.restore = () => { form.remove(); el.hidden = false; };
  };

  drop.onclick = async () => {
    const ok = await ask({
      title: 'Delete "' + task.name + '"?',
      text: 'It stops running and is removed from the system scheduler. Backups it already took '
        + 'are not touched.',
      confirmLabel: 'Delete task',
      danger: true,
    });
    if (!ok) return;
    busy(true);
    try {
      await post(base + '/' + encodeURIComponent(task.id) + '/delete');
      toast('Deleted.', 'good');
      await again();
    } catch (e) {
      toast(e.message, 'bad');
      busy(false);
    }
  };
  return el;
}

