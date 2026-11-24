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
  wrap.className = 'mt-2 grid gap-2';
  const palette = document.createElement('div');
  palette.className = 'flex flex-wrap gap-[3px]';
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
    b.className = 'size-[18px] cursor-pointer rounded-[3px] border border-[rgba(255,255,255,.25)] p-0 hover:outline-2 hover:outline-accent-edge';
    b.style.background = hex;
    b.title = 'Colour \u00a7' + code;
    b.setAttribute('aria-label', 'Colour ' + code);
    b.onclick = () => insert(code);
    palette.append(b);
  }
  for (const [code, label, glyph] of [['l', 'Bold', 'B'], ['o', 'Italic', 'I'], ['n', 'Underline', 'U'], ['m', 'Strikethrough', 'S'], ['r', 'Reset', '\u21ba']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sl-btn sl-btn-sm h-[18px] w-[22px] p-0 font-mono text-1 leading-none font-bold';
    b.textContent = glyph;
    b.title = label + ' (\u00a7' + code + ')';
    b.setAttribute('aria-label', label);
    b.onclick = () => insert(code);
    palette.append(b);
  }

  const card = document.createElement('div');
  // the game's own multiplayer list, so its own colours: black, white and grey, not the panel's
  card.className = 'flex max-w-[460px] items-start gap-2.5 rounded-[2px] border border-[#2a2a2a] bg-[#0b0b0b] p-1.5';
  card.setAttribute('aria-label', 'How it looks in the multiplayer list');
  const img = document.createElement('img');
  img.className = 'size-16 flex-none bg-[#222] [image-rendering:pixelated]';
  img.alt = '';
  img.width = 64;
  img.height = 64;
  const blank = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#3b3b3b"/><rect x="1" y="1" width="6" height="6" fill="#555"/></svg>');
  const iconUrl = '/api/instances/' + encodeURIComponent(row.name) + '/icon';
  const loadIcon = () => { img.src = iconUrl + '?t=' + Date.now(); };
  img.onerror = () => { img.onerror = null; img.src = blank; img.dataset.none = ''; };
  loadIcon();
  const text = document.createElement('div');
  text.className = 'min-w-0 pt-0.5 font-mono text-[13px] leading-[1.35]';
  const title = document.createElement('div');
  title.className = 'text-[#fff]';
  title.textContent = row.label || row.name;
  const lines = document.createElement('div');
  lines.className = 'text-[#aaa] [overflow-wrap:anywhere]';
  text.append(title, lines);
  card.append(img, text);
  const draw = () => { lines.textContent = ''; lines.append(mcText(input.value)); };
  input.addEventListener('input', draw);
  draw();

  const iconRow = document.createElement('div');
  iconRow.className = 'flex flex-wrap items-center gap-2';
  const pick = document.createElement('input');
  pick.type = 'file';
  pick.accept = 'image/*';
  pick.hidden = true;
  const change = Kit.button({ label: 'Change icon', icon: 'upload', kind: 'ghost' });
  const remove = Kit.button({ label: 'Remove icon', kind: 'ghost' });
  const iconNote = document.createElement('span');
  iconNote.className = 'sl-hint';
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
      refreshServerIcon(row.name);
    } catch (e) {
      toast(e.message || 'That image could not be read.', 'bad');
    }
  };
  remove.onclick = async () => {
    try {
      await post('/instances/' + encodeURIComponent(row.name) + '/icon/remove');
      img.src = blank;
      img.dataset.none = '';
      refreshServerIcon(row.name);
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
  const { h } = Kit;
  let steps = action ? action.steps.map((st) => ({ ...st })) : STEP_PRESETS[0].steps.map((st) => ({ ...st }));
  const list = h('ol', { class: 'sl-list m-0', 'aria-label': 'Steps' });
  const addWrap = Kit.select({ label: 'Add a step', options: [{ value: '', label: 'Add a step…' }, ...Object.entries(STEP_LABELS).map(([k, label]) => ({ value: k, label }))], value: '' });
  const add = addWrap.querySelector('select');
  const presetWrap = Kit.select({ label: 'Start from a ready-made chain', options: [{ value: '', label: 'Start from…' }, ...STEP_PRESETS.map((p, i) => ({ value: String(i), label: p.label }))], value: '' });
  const preset = presetWrap.querySelector('select');
  const tools = h('div', { class: 'flex flex-wrap gap-2' }, h('span', { class: 'w-56 max-w-full' }, addWrap), h('span', { class: 'w-80 max-w-full' }, presetWrap));
  const running = Kit.checkbox({ label: 'Only while the server is running', note: 'Otherwise the whole task is skipped.', checked: Boolean(action && action.onlyWhenRunning) });
  const going = Kit.checkbox({ label: 'Keep going if a step fails', checked: Boolean(action && action.keepGoing) });
  const runningBox = running.querySelector('input');
  const goingBox = going.querySelector('input');
  const el = h('div', { class: 'flex flex-col gap-3' }, list, tools, h('div', { class: 'flex flex-col' }, running, going));

  const num = (value, min, max, label) => {
    const i = Kit.input({ type: 'number', value: String(value), label });
    i.min = String(min);
    i.max = String(max);
    i.classList.add('w-20');
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
      const fields = h('span', { class: 'flex flex-wrap items-center gap-2 flex-1 basis-64 min-w-0 type-meta text-ink-2' });
      if (st.do === 'say' || st.do === 'command') {
        const t = Kit.input({
          value: st.do === 'say' ? (st.text || '') : (st.line || ''),
          placeholder: st.do === 'say' ? 'What the players see' : 'save-all',
          label: st.do === 'say' ? 'What the players see' : 'The command to run',
          mono: st.do === 'command',
        });
        t.maxLength = 400;
        t.classList.add('flex-1', 'basis-40');
        t.oninput = () => { if (st.do === 'say') st.text = t.value; else st.line = t.value; };
        fields.append(t);
      } else if (st.do === 'wait') {
        const n = num(st.seconds != null ? Math.round(st.seconds / 60 * 10) / 10 : 1, 0.1, 60, 'Minutes to wait');
        n.step = '0.5';
        n.oninput = () => { st.seconds = Math.round(Number(n.value) * 60); };
        fields.append(n, 'minutes');
      } else if (st.do === 'countdown') {
        const n = num(st.minutes || 5, 1, 60, 'Minutes of countdown');
        const m = Kit.input({ value: st.message || 'Server restarting', label: 'What the countdown says' });
        m.maxLength = 120;
        m.classList.add('flex-1', 'basis-40');
        // what the players will read, shown: it was a tip on the box
        const eg = h('span', { class: 'basis-full sl-hint' });
        const sayEg = () => {
          const mins = Number(n.value) || 5;
          eg.textContent = 'Players see “' + (m.value || 'Server restarting') + ' in ' + mins + (mins === 1 ? ' minute' : ' minutes') + '”, then again at one minute and at ten seconds.';
        };
        n.oninput = () => { st.minutes = Number(n.value); sayEg(); };
        m.oninput = () => { st.message = m.value; sayEg(); };
        sayEg();
        fields.append(n, 'minutes:', m, eg);
      } else if (st.do === 'backup') {
        const n = num(st.keep || 7, 1, 365, 'How many backups to keep');
        n.oninput = () => { st.keep = Number(n.value); };
        fields.append('keeping', n);
      }
      const mv = (label, glyph, d) => {
        const j = i + d;
        const b = h('button', { type: 'button', class: 'sl-btn sl-btn-ghost sl-btn-sm sl-btn-icon', 'aria-label': label, title: label, text: glyph });
        b.disabled = j < 0 || j >= steps.length;
        // the step moved, and focus goes with it: on the same arrow, or the other one at an end
        b.onclick = () => { [steps[i], steps[j]] = [steps[j], steps[i]]; draw(); focusStep(j, label); };
        return b;
      };
      const rm = Kit.button({ icon: 'close', kind: 'ghost', size: 'sm', title: 'Remove this step' });
      rm.onclick = () => { steps.splice(i, 1); draw(); focusStep(Math.min(i, steps.length - 1), 'Remove this step'); };
      list.append(h('li', { class: 'sl-row flex-wrap' },
        h('span', { class: 'w-5 text-center font-mono text-1 text-ink-3', 'aria-hidden': 'true', text: String(i + 1) }),
        h('span', { class: 'w-36 type-body font-strong text-ink', text: STEP_LABELS[st.do] || st.do }),
        fields,
        h('span', { class: 'flex gap-1' }, mv('Move up', '↑', -1), mv('Move down', '↓', 1), rm)));
    });
    if (!steps.length) list.append(h('li', { class: 'sl-row sl-hint', text: 'No steps yet. Add one, or start from a ready-made chain.' }));
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
  const { h } = Kit;
  const pick = (label, options, value) => Kit.select({ label, options, value });
  const field = (label, control, width) => {
    const f = Kit.field({ label, control });
    return width ? h('div', { class: width + ' max-w-full' }, f) : f;
  };

  const actWrap = pick(null, actions.map((a) => ({ value: a.type, label: a.label })), task?.action?.type ?? 'backup');
  const act = actWrap.querySelector('select');
  const actField = field('What should happen', actWrap, 'w-80');

  const line = Kit.input({ value: task?.action?.line ?? '', placeholder: 'say Server restarting in 5 minutes', mono: true });
  line.maxLength = 400;
  const lineField = field('Console command to send', line);

  const keep = Kit.input({ type: 'number', value: String(task?.action?.keep ?? 7) });
  keep.min = '1';
  keep.max = '365';
  const keepField = field('Backups to keep', keep, 'w-40');

  const warn = Kit.input({ type: 'number', value: String(task?.action?.warnMinutes ?? 5) });
  warn.min = '0';
  warn.max = '60';
  const warnField = field('Minutes of warning first', warn, 'w-56');

  const kindWrap = pick(null, kinds.map((k) => ({ value: k, label: KIND_LABELS[k] || k })), task?.schedule?.kind ?? 'daily');
  const kind = kindWrap.querySelector('select');
  const every = Kit.input({ type: 'number', value: String(task?.schedule?.every ?? 6) });
  every.min = '1';
  const at = Kit.input({ type: 'time', value: task?.schedule?.at ?? '03:00' });
  const dayWrap = pick(null, days.map((d) => ({ value: d, label: DAY_NAMES[d] || d })), task?.schedule?.day ?? 'SUN');
  const day = dayWrap.querySelector('select');

  const everyField = field('How many', every, 'w-28');
  const atField = field('At', at, 'w-36');
  const dayField = field('On', dayWrap, 'w-44');
  const whenRow = h('div', { class: 'flex flex-wrap items-start gap-3' }, field('How often', kindWrap, 'w-56'), everyField, dayField, atField);

  const title = Kit.input({ value: task?.name ?? '' });
  title.maxLength = 60;
  const titleField = field('Call it', title, 'w-80');

  const note = h('p', { class: 'sl-hint m-0' });

  const save = Kit.button({ label: task ? 'Save changes' : 'Create task', kind: 'primary' });
  const cancel = Kit.button({ label: 'Cancel', kind: 'ghost' });
  const buttons = h('div', { class: 'flex flex-wrap gap-2' }, save, cancel);

  const chain = stepsEditor(task && task.action && task.action.type === 'steps' ? task.action : null);
  const chainField = h('div', { class: 'flex flex-col gap-2' }, h('span', { class: 'sl-label', text: 'Steps, in order' }), chain.el);

  // `task-form` is how the page knows a form is open and must not be redrawn under it
  const form = Kit.card({ label: task ? 'Edit ' + task.name : 'New task' },
    h('h3', { class: 'm-0 type-card text-ink', text: task ? 'Edit “' + task.name + '”' : 'New task' }),
    actField, lineField, keepField, warnField, chainField, whenRow, titleField, note, buttons);
  form.classList.add('task-form');

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
    Kit.busy(save, true);
    try {
      await onSubmit({ name: title.value.trim(), action, schedule: sched });
    } finally {
      Kit.busy(save, false);
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
  const headless = background.session !== 'desktop';
  const fix = Kit.button({ label: 'Keep running after logout', size: 'sm' });
  fix.title = 'Turns on lingering for your account (loginctl enable-linger)';
  fix.onclick = async () => {
    Kit.busy(fix, true);
    try {
      await api('/scheduler/linger', { method: 'POST' });
      toast('Scheduled tasks will now run while you are logged out.', 'good');
      await refresh();
    } catch (e) {
      // Policy may require a password, which a page cannot supply; the message carries the command.
      toast(e.message, 'bad');
      Kit.busy(fix, false);
    }
  };
  return Kit.banner({
    tone: headless ? 'warn' : null,
    icon: 'clock',
    title: headless ? 'These only run while you are logged in' : 'These pause when you log out',
    text: headless
      ? 'Your account stops its background tasks when you log out. On a server you connect to and disconnect from, a nightly backup would never run.'
      : 'They run while you are logged in, with the screen locked too. Turn this on if backups and servers should keep going after you log out of this computer.',
    actions: [fix],
  });
}

/** A run's outcome as a word and a tone: Windows' and SpawnLoft's words, said one way. */
function runOutcome(status) {
  if (status === 'ok') return { text: 'Worked', tone: 'live' };
  if (status === 'skipped') return { text: 'Skipped', tone: null };
  return { text: 'Did not work', tone: 'fault' };
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
  const { h } = Kit;
  const page = h('div', { class: 'flex flex-col gap-6' });
  body.append(page);
  if (data.available === false) {
    page.append(Kit.empty({ icon: 'clock', title: 'Scheduling is not available here', text: data.reason }));
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

  const lingering = lingerNotice(data.background, again);
  if (lingering) page.append(lingering);

  // ---- the tasks ------------------------------------------------------------
  const add = Kit.button({ label: 'New task', icon: 'plus', kind: 'primary' });
  // With no tasks the empty state carries the one primary action, so two never sit stacked.
  add.hidden = !data.tasks.length;
  const tasks = h('section', { class: 'flex flex-col gap-3', 'aria-label': 'Tasks' },
    h('div', { class: 'flex flex-wrap items-center gap-x-3 gap-y-2' },
      h('h2', { class: 'm-0 type-section text-ink', text: 'Tasks' }),
      h('span', { class: 'type-meta text-ink-3', text: data.tasks.length ? String(data.tasks.length) : '' }),
      // what runs them, and when they do not, for whoever asks
      Kit.help({ label: 'how scheduled work runs', text: ['Held by ' + schedulerName + '.', schedulerHint] }),
      h('span', { class: 'flex-1' }),
      add));
  page.append(tasks);
  const formSlot = h('div', { class: 'contents' });
  tasks.append(formSlot);

  add.onclick = () => {
    editor.close();
    add.hidden = true;
    const form = taskForm({
      actions: data.actions,
      kinds: data.kinds,
      days: data.days,
      onCancel: () => {
        editor.close();
        // with no tasks the button beside the heading is hidden: the empty page's own one is the place
        const back = [...page.querySelectorAll('button')].find((b) => !b.hidden && b.offsetParent && /New task/.test(b.textContent));
        (back || add).focus();
      },
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
    formSlot.append(form);
    form.querySelector('select, input').focus();
    editor.restore = () => { form.remove(); add.hidden = !data.tasks.length; };
  };

  if (!data.tasks.length) {
    tasks.append(Kit.empty({
      icon: 'clock',
      title: 'Nothing scheduled',
      text: 'A nightly backup and a daily restart are the two most servers ever need.',
      actions: [Kit.button({ label: 'New task', icon: 'plus', kind: 'primary', onClick: () => add.onclick() })],
    }));
  } else {
    tasks.append(h('div', { class: 'grid gap-3 grid-cols-[repeat(auto-fill,minmax(340px,1fr))] items-start' },
      data.tasks.map((task) => taskCard(task, data, base, again, editor))));
  }

  // ---- what actually ran ----------------------------------------------------
  // With no tasks there is nothing that could have run, and a second empty state under the first
  // said so at length. The runs section appears once there is a task to produce one.
  if (!data.tasks.length && !data.runs.length) return;

  const runs = h('section', { class: 'flex flex-col gap-3', 'aria-label': 'Recent runs' },
    h('h2', { class: 'm-0 type-section text-ink', text: 'Recent runs' }));
  page.append(runs);
  if (!data.runs.length) {
    runs.append(Kit.empty({ icon: 'bolt', title: 'Nothing has run yet', text: 'Every run writes a line here, including the ones that do not work.' }));
    return;
  }
  runs.append(Kit.list(data.runs.map((r) => {
    const task = (data.tasks || []).find((t) => t.id === r.id);
    // the folder a backup went to is the same every night; when it was taken is what differs
    const said = backupNamesToWords(String(r.detail || '').replace(/^.*[\\/](?=[^\\/]*\.tar\.gz)/, ''));
    const outcome = runOutcome(r.status);
    const line = h('div', { class: 'sl-row', dataset: { status: r.status } },
      h('span', { class: 'sl-row-main' },
        h('span', { class: 'sl-row-title', text: (task && task.name) || r.id || r.action }),
        h('span', { class: 'sl-row-meta whitespace-normal break-words' + (r.status === 'ok' || r.status === 'skipped' ? '' : ' text-fault-ink'), text: said, title: r.detail || '' })),
      h('span', { class: 'sl-row-end' }, Kit.pill({ text: outcome.text, tone: outcome.tone }), h('span', { class: 'whitespace-nowrap', text: stamp(r.at) })));
    return line;
  }), 'Recent runs'));
}

/** One scheduled task, with the four things you can do to it. */
function taskCard(task, data, base, again, editor) {
  const { h } = Kit;
  let said;
  if (!task.enabled) said = { text: 'Off', tone: null };
  // SpawnLoft has a definition the system scheduler has never heard of. Someone deleted it there,
  // or the query failed - either way it is not going to run, and saying "Ready" would be a lie.
  else if (!task.known) said = { text: 'Not in ' + (panelPlatform === 'win32' ? 'Windows' : 'the scheduler'), tone: 'fault' };
  else said = { text: task.state || 'Ready', tone: task.state === 'Running' ? 'live' : null };
  const pill = Kit.pill(said);
  if (!task.known && task.enabled) pill.title = 'SpawnLoft has this task but the system scheduler does not. Edit it to put it back.';

  const lines = [h('span', { class: 'sl-row-meta whitespace-normal', text: actionSummary(task, data.actions) + ' · ' + describeSchedule(task.schedule) })];
  if (task.enabled && task.known) {
    const next = whenNext(task.nextRun);
    lines.push(h('span', { class: 'sl-row-meta whitespace-normal', text: (next ? 'Next ' + next : 'No next run scheduled') + (task.lastResult ? ' · Last run: ' + task.lastResult : '') }));
  }
  // The Backups tab makes one of these and keeps a switch pointing at it. Showing it here without
  // saying so would leave someone wondering where it came from - and deleting it from here is
  // allowed, so the label also explains what the switch will read afterwards.
  if (task.owner === 'backups') lines.push(h('span', { class: 'sl-row-meta', text: 'Made by the Backups tab’s switch.' }));

  const runNow = Kit.button({ label: 'Run now', icon: 'bolt', size: 'sm' });
  const toggle = Kit.button({ label: task.enabled ? 'Turn off' : 'Turn on', size: 'sm' });
  const edit = Kit.button({ label: 'Edit', icon: 'pencil', size: 'sm' });
  const drop = Kit.button({ icon: 'trash', kind: 'ghost', size: 'sm', title: 'Delete ' + task.name });
  for (const [b, verb] of [[runNow, 'Run'], [toggle, task.enabled ? 'Turn off' : 'Turn on'], [edit, 'Edit']]) b.setAttribute('aria-label', verb + ' ' + task.name + (verb === 'Run' ? ' now' : ''));
  const buttons = [runNow, toggle, edit, drop];

  const el = Kit.card({ label: task.name, tone: !task.known && task.enabled ? 'fault' : null },
    h('div', { class: 'flex items-start gap-3' },
      h('span', { class: 'sl-row-main' }, h('span', { class: 'sl-row-title whitespace-normal font-strong', text: task.name }), lines),
      pill),
    h('div', { class: 'flex flex-wrap gap-2' }, buttons));
  el.dataset.task = task.id;
  if (!task.enabled) el.classList.add('opacity-70');

  const busy = (on, back) => { for (const b of buttons) Kit.busy(b, on); if (!on && back) back.focus(); };

  runNow.onclick = async () => {
    // The pane says whose tasks it is showing.
    const server = $('#schedulerBody').dataset.for;
    // A task that stops or restarts the server does it to whoever is on, now and not at 4 a.m.
    const question = stopQuestion(taskDisconnects(task), rowOf(server), []);
    if (question && !(await ask({ ...question, title: 'Run “' + task.name + '” now?', confirmLabel: 'Run now' }))) return;
    busy(true);
    try {
      await post(base + '/' + encodeURIComponent(task.id) + '/run');
      // Windows starts the task and returns immediately, so there is nothing to report yet beyond
      // having asked. The run log below is where the answer turns up.
      toast('Started. Watch Recent runs for what it did.', 'good');
      // Run now stays off for a few seconds: a second press would start it again
      setTimeout(() => { if (runNow.isConnected) busy(false); }, 5000);
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
      busy(false, runNow);
    }
  };

  toggle.onclick = async () => {
    busy(true);
    try {
      await post(base + '/' + encodeURIComponent(task.id) + '/enable', { enabled: !task.enabled });
      await again();
    } catch (e) {
      toast(e.message, 'bad');
      busy(false, toggle);
    }
  };

  edit.onclick = () => {
    editor.close();
    const form = taskForm({
      actions: data.actions,
      kinds: data.kinds,
      days: data.days,
      task,
      onCancel: () => { editor.close(); edit.focus(); },
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
    // the form takes the whole row of the grid: a form in a card-width cell has its fields crushed
    form.classList.add('col-span-full');
    el.hidden = true;
    el.after(form);
    form.querySelector('select, input').focus();
    editor.restore = () => { form.remove(); el.hidden = false; };
  };

  drop.onclick = async () => {
    const ok = await ask({
      title: 'Delete “' + task.name + '”?',
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
      busy(false, drop);
    }
  };
  return el;
}
