'use strict';
// The components page: every block Kit makes, in every state it has. Nothing here talks to the
// panel; the servers and numbers are made up, and a press only changes this page.
(() => {
  const { h } = Kit;
  const gallery = document.getElementById('gallery');

  /** One block: its name, a line on when to use it, and its states side by side. */
  function section(title, note, ...rows) {
    gallery.append(h('section', { class: 'flex flex-col gap-4', 'aria-label': title },
      h('div', null,
        h('h2', { class: 'type-section m-0 text-ink', text: title }),
        h('p', { class: 'type-meta m-0 mt-1 text-ink-3', text: note })),
      ...rows));
  }
  /** A row of examples, each under a small caption. */
  function line(...items) {
    return h('div', { class: 'flex flex-wrap items-end gap-6' }, items.map(([caption, el]) =>
      h('div', { class: 'flex flex-col items-start gap-2' }, h('span', { class: 'type-meta text-ink-4', text: caption }), el)));
  }
  const btn = Kit.button;

  // ---- the head: which theme ----
  const themes = Kit.segmented({
    label: 'Theme',
    value: document.documentElement.dataset.theme,
    options: [{ value: 'spawnloft', label: 'SpawnLoft' }, { value: 'classic', label: 'Classic' }],
    onChange: (theme) => { document.documentElement.dataset.theme = theme; },
  });
  gallery.append(Kit.pageHead({
    title: 'Components',
    lede: 'Every shared building block in every state. Made with Kit (js/shared/kit.js), drawn by components.css. The theme here is not saved.',
    actions: [themes],
  }));

  // ---- type ----
  section('Type', 'The roles in tokens.css: a role is size, weight, line height and family together.',
    h('div', { class: 'flex flex-col gap-3' },
      h('div', { class: 'sl-page-title', text: 'Your servers' }),
      h('div', { class: 'type-page text-ink', text: 'Survival with friends' }),
      h('div', { class: 'type-section text-ink', text: 'Nightly backups' }),
      h('div', { class: 'type-card text-ink', text: 'Creative build world' }),
      h('p', { class: 'type-body m-0 max-w-[60ch] text-ink-2', text: 'Body text inside a pane: a sentence or two about what a control does, never a paragraph where a control would do.' }),
      h('div', { class: 'type-meta text-ink-3', text: 'Paper 1.21.11 \u00b7 last played 2 days ago' }),
      Kit.eyebrow('Section label', 'div'),
      h('div', { class: 'type-mono text-ink', text: 'localhost:45565   C:\\SpawnLoft\\servers\\survival' }),
      h('div', { class: 'type-body text-ink-2' }, 'Inline ', h('code', { class: 'sl-code', text: 'server.properties' }), ' and a key: ', h('kbd', { class: 'sl-kbd', text: 'Ctrl' }), ' ', h('kbd', { class: 'sl-kbd', text: 'K' }))));

  // ---- buttons ----
  const working = btn({ label: 'Saving', icon: 'check', kind: 'primary' });
  Kit.busy(working, true);
  section('Button', 'Primary is the one thing an area is for. Secondary is the default. Ghost is a quiet verb among content; danger is for what cannot be undone; link sits inside a sentence.',
    line(
      ['primary', btn({ label: 'Start', icon: 'play', kind: 'primary' })],
      ['secondary', btn({ label: 'Restart', icon: 'restart' })],
      ['ghost', btn({ label: 'Review', kind: 'ghost' })],
      ['danger', btn({ label: 'Delete world', icon: 'trash', kind: 'danger' })],
      ['link', btn({ label: 'How friends join', kind: 'link' })]),
    line(
      ['small', btn({ label: 'Open', size: 'sm' })],
      ['medium', btn({ label: 'Open' })],
      ['large', btn({ label: 'Play', icon: 'play', kind: 'primary', size: 'lg' })],
      ['icon', btn({ icon: 'gear', kind: 'ghost', title: 'Preferences' })],
      ['icon, small', btn({ icon: 'dots', size: 'sm', title: 'More actions' })]),
    line(
      ['disabled', btn({ label: 'Start', kind: 'primary', disabled: true })],
      ['disabled', btn({ label: 'Stop', disabled: true })],
      ['working', working],
      ['pressed', btn({ icon: 'wrap', kind: 'ghost', title: 'Wrap long lines', pressed: true })]));

  // ---- fields ----
  const refused = Kit.field({ label: 'Port', control: Kit.input({ value: '25565', mono: true }), hint: 'The one players type after the address.' });
  refused.setError('Another server already uses 25565. Try 25566.');
  section('Field', 'A label over its control, then one line: the hint, or why the value was refused.',
    h('div', { class: 'flex flex-wrap gap-6 [&>*]:w-[300px]' },
      Kit.field({ label: 'Name', control: Kit.input({ placeholder: 'Survival (Season 3)' }), hint: 'Anything you like.' }),
      refused,
      Kit.field({ label: 'Filter', control: Kit.input({ placeholder: 'Filter the console', lead: 'search' }) }),
      Kit.field({ label: 'Command', control: Kit.input({ placeholder: 'Type a command', mono: true, lead: h('span', { text: '/' }) }) }),
      Kit.field({ label: 'Memory', control: Kit.select({ value: '2G', options: [{ value: '1G', label: '1 GB' }, { value: '2G', label: '2 GB' }, { value: '4G', label: '4 GB' }] }), hint: '6 of 16 GB already reserved.' }),
      Kit.field({ label: 'Minecraft version', control: Kit.select({ value: '1.21.4', options: [
        { group: 'Releases', options: ['1.21.4', '1.21.3', '1.21.1', '1.20.6', '1.20.4', '1.20.2', '1.19.4', '1.18.2', '1.17.1', '1.16.5', '1.12.2'].map((v) => ({ value: v, label: v, note: Number(v.split('.')[1]) >= 21 ? 'Java 21' : 'Java 17' })) },
        { group: 'Snapshots and previews', options: ['25w02a', '25w01a', '24w46a'] },
      ] }), hint: 'Eleven or more choices bring a search box.' }),
      Kit.field({ label: 'Disabled', control: Kit.input({ value: 'survival', disabled: true, mono: true }) }),
      Kit.field({ label: 'Message of the day', control: Kit.textarea({ value: 'A Minecraft server\nrun with SpawnLoft' }) })));

  // ---- choices ----
  section('Check box, radio, switch', 'The words are part of the control. A switch acts at once; a check box waits for Save.',
    line(
      ['check box', Kit.checkbox({ label: 'Keep plugins', checked: true })],
      ['unchecked', Kit.checkbox({ label: 'Keep the world' })],
      ['two lines', Kit.checkbox({ label: 'Back up first', note: 'Takes about a minute.', checked: true })],
      ['disabled', Kit.checkbox({ label: 'Not here', disabled: true })]),
    line(
      ['radio', h('div', { class: 'flex flex-col', role: 'radiogroup', 'aria-label': 'When' },
        Kit.radio({ label: 'Every night at 3:00 AM', name: 'when', checked: true }),
        Kit.radio({ label: 'Every hour', name: 'when' }))],
      ['switch on', Kit.toggle({ label: 'Nightly backups', checked: true })],
      ['switch off', Kit.toggle({ label: 'Restart after a crash' })],
      ['two lines', Kit.toggle({ label: 'Anyone can join', note: 'Accounts are not checked.' })]));

  // ---- segmented ----
  section('Segmented control', 'One of a few, all in view: a filter, a range.',
    line(
      ['console levels', Kit.segmented({ label: 'Filter by level', value: 'all', options: [
        { value: 'all', label: 'All' }, { value: 'warn', label: 'Warnings', count: 1, tone: 'warn' }, { value: 'error', label: 'Errors', count: 0 }] })],
      ['range', Kit.segmented({ label: 'Range', value: '24h', options: [{ value: '1h', label: '1 hour' }, { value: '24h', label: '24 hours' }, { value: '7d', label: '7 days' }] })]));

  // ---- pill, dot, count ----
  section('Pill, dot, count', 'A state in a word, with a dot so it never rests on colour alone. Amber and red only for a real problem.',
    line(
      ['running', Kit.pill({ text: 'Running 2h 14m', tone: 'live' })],
      ['stopped', Kit.pill({ text: 'Stopped' })],
      ['starting', Kit.pill({ text: 'Starting', tone: 'accent', busy: true })],
      ['needs a look', Kit.pill({ text: 'Never backed up', tone: 'warn' })],
      ['crashed', Kit.pill({ text: 'Crashed', tone: 'fault' })]),
    line(
      ['dots', h('span', { class: 'flex items-center gap-3' }, Kit.dot({ tone: 'live', label: 'Running' }), Kit.dot({ label: 'Stopped' }), Kit.dot({ tone: 'warn', label: 'Needs a look' }), Kit.dot({ tone: 'fault', label: 'Crashed' }), Kit.dot({ tone: 'accent', label: 'Starting', busy: true }))],
      ['counts', h('span', { class: 'flex items-center gap-2' }, Kit.count(3), Kit.count(1, 'warn'), Kit.count(2, 'fault'), Kit.count(12, 'accent'))]));

  // ---- tiles ----
  const names = ['survival', 'creative', 'skyblock', 'lobby', 'minigames', 'hardcore'];
  section('Tile', "A server's face: its own server-icon.png, else its initial on a colour picked from its name, the same everywhere.",
    line(
      ['small', h('span', { class: 'flex gap-2' }, names.map((name) => Kit.tile({ name, size: 'sm' })))],
      ['medium', h('span', { class: 'flex gap-2' }, names.map((name) => Kit.tile({ name })))],
      ['large', h('span', { class: 'flex gap-2' }, names.slice(0, 3).map((name) => Kit.tile({ name, size: 'lg' })))],
      ['a database', Kit.tile({ icon: 'database', name: 'main-db' })]));

  // ---- cards and stats ----
  const running = Kit.card({ label: 'Survival with friends' },
    h('div', { class: 'sl-card-head' },
      Kit.tile({ name: 'Survival with friends', key: 'survival', size: 'lg' }),
      h('div', { class: 'min-w-0 flex-[1_1_240px]' },
        h('div', { class: 'flex flex-wrap items-center gap-2.5' }, h('h3', { class: 'type-page m-0', text: 'Survival with friends' }), Kit.pill({ text: 'Running 2h 14m', tone: 'live' })),
        h('div', { class: 'type-meta text-ink-3' }, 'Paper 1.21.11 \u00b7 ', h('span', { class: 'sl-code', text: 'localhost:45565' }))),
      h('div', { class: 'flex gap-2' }, btn({ label: 'Stop' }), btn({ label: 'Play' }), btn({ label: 'Open' }))),
    h('div', { class: 'sl-card-part flex flex-wrap gap-x-10 gap-y-4' },
      Kit.stat({ label: 'Players', value: 3, unit: 'of 20' }),
      Kit.stat({ label: 'TPS', value: '20.0' }),
      Kit.stat({ label: 'Memory', value: '1.4', unit: 'of 2 GB' }),
      Kit.stat({ label: 'Last backup', value: '3h', unit: 'ago' })));
  const stopped = Kit.card({ compact: true, label: 'Creative build world' },
    Kit.tile({ name: 'Creative build world', key: 'creative' }),
    h('div', { class: 'min-w-0 flex-[1_1_240px]' },
      h('div', { class: 'flex flex-wrap items-center gap-2.5' }, h('h3', { class: 'type-card m-0', text: 'Creative build world' }), Kit.pill({ text: 'Stopped' })),
      h('div', { class: 'type-meta text-ink-3', text: 'Paper 1.21.11 \u00b7 last played 2 days ago' })),
    h('div', { class: 'flex gap-2' }, btn({ label: 'Start', kind: 'primary' }), btn({ label: 'Open' })));
  section('Card and stat', 'One box for a group. A running server shows its live numbers; a stopped one is a compact row.',
    h('div', { class: 'flex flex-col gap-3' }, running, stopped),
    line(['small stats', h('div', { class: 'flex gap-8' }, Kit.stat({ label: 'Players', value: 3, unit: 'of 20', small: true }), Kit.stat({ label: 'Memory', value: '\u2014', small: true }))]));

  // ---- list and row ----
  section('List and row', 'Rows in a box. A row is a face, a name over one line of facts, and what ends it.',
    h('div', { class: 'flex flex-wrap gap-6 [&>*]:flex-[1_1_360px]' },
      Kit.list([
        Kit.row({ title: 'Steve joined Survival with friends', meta: 'Player', end: '4m ago' }),
        Kit.row({ title: 'Survival with friends backed up, 412 MB', meta: 'Nightly backup', end: '3h ago' }),
        Kit.row({ title: 'EssentialsX updated to 2.21.0', meta: 'You, in the panel', end: 'Yesterday' }),
      ], 'Recent activity'),
      Kit.list([
        Kit.row({ lead: Kit.tile({ name: 'Steve', size: 'sm' }), title: 'Steve', meta: 'Operator', end: [Kit.pill({ text: 'Online', tone: 'live' })], onClick: () => {} }),
        Kit.row({ lead: Kit.tile({ name: 'Alex', size: 'sm' }), title: 'Alex', meta: 'Joined 45m ago', end: [btn({ label: 'Kick', size: 'sm', kind: 'ghost' })] }),
        Kit.row({ lead: Kit.tile({ name: 'Notch_Jr', size: 'sm' }), title: 'Notch_Jr', meta: 'Banned \u00b7 griefing', end: [btn({ label: 'Pardon', size: 'sm' })] }),
      ], 'Players')));

  // ---- table ----
  section('Table', 'For facts that line up in columns. Numbers align right.',
    h('div', { class: 'sl-card' }, Kit.table({
      caption: 'Backups',
      columns: [{ key: 'when', label: 'When' }, { key: 'kind', label: 'Kind' }, { key: 'size', label: 'Size', num: true }, { key: 'act', label: '' }],
      rows: [
        { when: 'Today, 3:00 AM', kind: Kit.pill({ text: 'Nightly' }), size: '412 MB', act: btn({ label: 'Restore', size: 'sm' }) },
        { when: 'Yesterday, 3:00 AM', kind: Kit.pill({ text: 'Nightly' }), size: '409 MB', act: btn({ label: 'Restore', size: 'sm' }) },
        { when: 'Nov 21, 6:12 PM', kind: Kit.pill({ text: 'Before an update', tone: 'accent' }), size: '398 MB', act: btn({ label: 'Restore', size: 'sm' }) },
      ],
    })));

  // ---- tabs ----
  const tabPanel = h('div', { class: 'type-body p-4 text-ink-2', role: 'tabpanel', text: 'The console.' });
  const tools = ['Console', 'Plugins', 'Files', 'Worlds', 'Backups', 'Players', 'Stats', 'Schedule', 'Activity', 'Settings'];
  section('Tabs', "A row of places under a header: a server's tools. One Tab stop; the arrow keys move along them.",
    h('div', { class: 'sl-card gap-0 p-0' },
      h('div', { class: 'border-b border-line-soft px-4' }, Kit.tabs({
        label: 'Server tools', current: 'console', panel: tabPanel,
        items: tools.map((t) => ({ id: t.toLowerCase(), label: t, count: t === 'Plugins' ? 2 : null, tone: 'accent' })),
        onSelect: (id) => { tabPanel.textContent = 'The ' + id + ' page.'; },
      })),
      tabPanel));

  // ---- navigation ----
  const status = (tone, label) => ({ tone, label });
  section('Navigation item', 'A row of the sidebar. The current one is lit along its left edge.',
    h('nav', { class: 'flex w-[248px] flex-col gap-0.5 rounded-lg border border-line bg-chrome p-3', 'aria-label': 'Example sidebar' },
      Kit.navItem({ label: 'Overview', icon: 'grid', current: true }),
      Kit.navItem({ label: 'Play', icon: 'play' }),
      Kit.navHead('Servers', btn({ icon: 'plus', kind: 'ghost', size: 'sm', title: 'New server' })),
      Kit.navItem({ label: 'Survival with friends', meta: 'Paper 1.21.11', tile: Kit.tile({ name: 'Survival with friends', key: 'survival', size: 'sm' }), status: status('live', 'Running') }),
      Kit.navItem({ label: 'Creative build world', meta: 'Paper 1.21.11', tile: Kit.tile({ name: 'Creative build world', key: 'creative', size: 'sm' }), status: status(null, 'Stopped') }),
      Kit.navItem({ label: 'Skyblock modded test', meta: 'Fabric 1.21.1', tile: Kit.tile({ name: 'Skyblock modded test', key: 'skyblock', size: 'sm' }), status: status('fault', 'Crashed') }),
      Kit.navHead('Databases'),
      Kit.navItem({ label: 'main-db', meta: 'MariaDB 11.4', tile: Kit.tile({ name: 'main-db', icon: 'database', size: 'sm' }), status: status('live', 'Running') })));

  // ---- menu ----
  section('Menu', 'A short list of verbs under a button. The arrow keys walk it; Escape closes it.',
    line(
      ['closed', Kit.menu({ icon: 'dots', title: 'More actions', kind: 'ghost', items: [
        { label: 'Open the server folder' }, { label: 'Rename' }, 'sep', { label: 'Delete', note: 'Keeps a backup for 30 days.', tone: 'fault' }] })],
      ['with words', Kit.menu({ label: 'Share log', icon: 'share', items: [
        { label: 'Save to a .log file', note: "Keeps a copy beside this server's backups." },
        { label: 'Upload to mclo.gs', note: 'Publishes a shareable link and opens it.' }] })]),
    (() => {
      // an open one, drawn in place so the picture shows it
      const open = Kit.menu({ label: 'Opened', items: [{ label: 'Restart now' }, { label: 'Restart with a warning', note: 'Tells players 60 seconds before.' }, 'sep', { label: 'Not available', disabled: true }] });
      open.querySelector('.sl-menu').hidden = false;
      open.querySelector('.sl-menu').classList.add('static', 'mt-2');
      open.classList.add('flex-col', 'items-start');
      return line(['open', open]);
    })());

  // ---- dialog and sheet ----
  const confirmDialog = Kit.dialog({
    title: 'Delete Creative build world?',
    body: ['The server folder and its worlds are moved to the trash. Backups are kept for 30 days.'],
    actions: [btn({ label: 'Cancel', onClick: () => confirmDialog.close() }), btn({ label: 'Delete', kind: 'danger', onClick: () => confirmDialog.close() })],
  });
  const sheet = Kit.dialog({
    title: 'New setup', sheet: true,
    body: [Kit.field({ label: 'Name', control: Kit.input({ value: 'survival-friends' }) }), Kit.field({ label: 'Version', control: Kit.select({ options: ['1.21.11', '1.21.1', '1.20.4'] }) })],
    actions: [btn({ label: 'Cancel', onClick: () => sheet.close() }), btn({ label: 'Create', kind: 'primary', onClick: () => sheet.close() })],
  });
  document.body.append(confirmDialog, sheet);
  const preview = Kit.dialog({
    title: 'Restore this backup?',
    body: ['Survival with friends goes back to today at 3:00 AM. A backup of how it is now is made first.'],
    actions: [btn({ label: 'Cancel' }), btn({ label: 'Restore', kind: 'primary' })],
  });
  // drawn in the page rather than over it, for the picture
  preview.setAttribute('open', '');
  preview.classList.add('static', 'm-0');
  section('Dialog and sheet', 'A dialog asks one thing. A sheet holds a form too long for one.',
    line(['dialog', btn({ label: 'Open a dialog', onClick: () => confirmDialog.showModal() })], ['sheet', btn({ label: 'Open a sheet', onClick: () => sheet.showModal() })]),
    preview);

  // ---- toast ----
  const still = (message, tone) => { const t = Kit.toast(message, { tone, stay: true }); t.remove(); return t; };
  section('Toast', 'A short word that something happened. Errors stay until dismissed.',
    line(['show one', btn({ label: 'Show a toast', onClick: () => Kit.toast('Survival with friends started.', { tone: 'live' }) })]),
    h('div', { class: 'flex flex-col gap-2' },
      still('Survival with friends started.', 'live'),
      still('Backing up Survival with friends\u2026'),
      still('Could not reach the mod list. Check the connection and try again.', 'fault')));

  // ---- banner ----
  section('Banner', 'Something that needs someone, said once, with what to do beside it.',
    Kit.banner({ tone: 'warn', icon: 'archive', title: '2 servers have never been backed up', text: 'Creative build world and Skyblock modded test. Nightly at 3:00 AM, keeping the last 7.', actions: [btn({ label: 'Turn on for both', kind: 'primary' }), btn({ label: 'Review' })] }),
    Kit.banner({ tone: 'fault', title: 'Skyblock modded test crashed', text: 'A mod failed to load: create-0.5.1. The console has the full message.', actions: [btn({ label: 'Open the console' })] }),
    Kit.banner({ tone: 'live', icon: 'check', title: 'SpawnLoft 2.0 is ready', text: 'It finishes installing when you restart the app.', actions: [btn({ label: 'Restart now', kind: 'primary' })] }),
    Kit.banner({ title: 'Java 21 is needed for Minecraft 1.21', text: 'SpawnLoft can download it for you.', actions: [btn({ label: 'Download Java 21' })] }));

  // ---- empty ----
  section('Empty state', 'Nothing here yet: what would be here, and the one thing to do.',
    h('div', { class: 'sl-card' }, Kit.empty({ icon: 'plug', title: 'No plugins yet', text: 'Plugins add commands, protection and minigames. Find one by name, or drop a .jar file here.', actions: [btn({ label: 'Find plugins', kind: 'primary' }), btn({ label: 'Add a .jar file' })] })));

  // ---- progress ----
  section('Progress, spinner, skeleton', 'How far known work has got; work of unknown length; text on its way.',
    h('div', { class: 'flex max-w-[480px] flex-col gap-4' },
      Kit.progress({ value: 0.62, label: 'Downloading Paper' }),
      Kit.progress({ value: 0.91, label: 'Memory', tone: 'warn' }),
      Kit.progress({ label: 'Starting' }),
      h('span', { class: 'flex items-center gap-3 type-body text-ink-2' }, Kit.spinner('Loading the mod list'), 'Loading the mod list\u2026'),
      Kit.skeleton()));

  // ---- help ----
  const folded = Kit.help({ label: 'view distance', text: ['How far around each player the server sends the world, in chunks. Lower uses less memory and CPU; 10 is the usual.'] });
  const unfolded = Kit.help({ label: 'online mode', text: ['When on, players must own Minecraft and sign in. When off, anyone can join under any name. Only for a server nobody else can reach.'] });
  unfolded.open = true;
  section('Help', 'One line beside a control; the longer story behind a "?".',
    line(['folded', h('span', { class: 'flex items-center gap-2 type-body' }, 'View distance', folded)], ['open', unfolded]));
})();
