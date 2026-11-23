'use strict';
// ------------------------------------------------------------ performance ---

const SVG_NS = 'http://www.w3.org/2000/svg';

// One clock for the whole page, the computer's own: "3:00 AM" or "03:00" as it is set. A schedule
// said "every day at 03:00" beside "next Nov 15, 3:00 AM".
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** A schedule's "03:00" as this computer writes a time of day. */
function clockWords(at, clock) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || ''));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return String(at || '');
  return (clock || CLOCK).format(new Date(2000, 0, 1, Number(m[1]), Number(m[2])));
}

const RANGES = [
  { key: 60, label: '1m', say: 'Last minute' },
  { key: 300, label: '5m', say: 'Last 5 minutes' },
  { key: 1800, label: '30m', say: 'Last 30 minutes' },
  { key: 3600, label: '1h', say: 'Last hour' },
  { key: 14400, label: '4h', say: 'Last 4 hours' },
];

/** A chart in words, for someone who cannot see its line: "Processor, last 5 minutes: 3.1%, peak 12%". */
function chartWords(title, now, aside, seconds) {
  const range = RANGES.find((r) => r.key === seconds);
  return title + (range ? ', ' + range.say.toLowerCase() : '') + ': ' + now + (aside ? ', ' + String(aside).replace(/\s*·\s*/g, ', ') : '');
}

const perfView = { seconds: 300 };
let perfTimer = null;

function stopPerfPolling() {
  if (perfTimer) { clearInterval(perfTimer); perfTimer = null; }
}

function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  return el;
}

/**
 * One measurement over time.
 *
 * <p>Drawn into a fixed viewBox and stretched by CSS, with non-scaling-stroke so the line keeps its
 * thickness rather than being squashed along with the coordinates.
 *
 * <p>The vertical scale is given, not derived from the data. An auto-scaled CPU graph makes 0.4%
 * look identical to 90% - the shape is the same and only the axis label differs, which is exactly
 * the mistake a glance at a graph is meant to avoid.
 */
function chart(samples, { pick, max, colour, label }) {
  const W = 600;
  const H = 96;
  const el = svg('svg', {
    class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img',
  });
  if (label) el.setAttribute('aria-label', label);

  for (let i = 1; i < 4; i++) {
    const y = (H / 4) * i;
    el.append(svg('line', { class: 'gridline', x1: 0, y1: y, x2: W, y2: y }));
  }
  if (samples.length < 2) return el;

  const first = samples[0].at;
  const span = Math.max(1, samples[samples.length - 1].at - first);
  const x = (s) => ((s.at - first) / span) * W;
  const y = (s) => H - Math.min(1, Math.max(0, pick(s) / max)) * H;

  const points = samples.map((s) => `${x(s).toFixed(1)},${y(s).toFixed(1)}`);
  el.append(svg('polygon', {
    class: 'area', fill: colour,
    points: `0,${H} ${points.join(' ')} ${W},${H}`,
  }));
  el.append(svg('polyline', { class: 'line', stroke: colour, points: points.join(' ') }));
  return el;
}

/**
 * One gauge: a title, the current reading, a note beside it, and the chart.
 *
 * <p>With `empty` set, the chart is drawn anyway - its grid lines and nothing else - and the text
 * sits centred over it. A pane that has no data yet still looks like the pane it will become,
 * rather than a sentence where two charts are about to be.
 */
function gauge({ title, now, aside, samples, pick, max, colour, empty, fmt }) {
  const wrap = document.createElement('div');
  wrap.className = 'gauge';
  const head = document.createElement('div');
  head.className = 'gauge-head';
  const h = document.createElement('h3');
  h.textContent = title;
  const value = document.createElement('span');
  value.className = 'now';
  value.textContent = now;
  const note = document.createElement('span');
  note.className = 'aside';
  note.textContent = aside;
  head.append(h, value, note);
  const plot = document.createElement('div');
  plot.className = 'chart-wrap';
  plot.append(chart(samples, { pick, max, colour, label: chartWords(title, empty ? 'no readings yet' : now, empty ? '' : aside, perfView.seconds) }));
  if (empty) {
    const p = document.createElement('p');
    p.className = 'chart-note';
    p.textContent = empty;
    plot.append(p);
  }
  wrap.append(head, plot);
  // The range's numbers, shown under the chart when the pane is Ultra (the stylesheet decides).
  if (samples.length && fmt) {
    const values = samples.map(pick).filter((v) => v != null && Number.isFinite(v));
    if (values.length) {
      const nums = document.createElement('dl');
      nums.className = 'gauge-nums';
      const cell = (label, v) => {
        const d = document.createElement('div');
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = fmt(v);
        d.append(dt, dd);
        return d;
      };
      nums.append(
        cell('Now', values[values.length - 1]),
        cell('Average', values.reduce((a, b) => a + b, 0) / values.length),
        cell('Peak', Math.max(...values)),
        cell('Low', Math.min(...values)),
      );
      wrap.append(nums);
    }
  }
  return wrap;
}

/** "4m 12s", "3h 07m" - the two units that matter at whatever scale it has reached. */
function humanUptime(ms) {
  if (!ms || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  return Math.floor(h / 24) + 'd ' + String(h % 24).padStart(2, '0') + 'h';
}

/** The memory ceiling the server was given, as a number of megabytes. "2G" and "3072M" both count. */
function memoryCeilingMb(text) {
  const m = /^(\d+)\s*([gm])?$/i.exec(String(text || '').trim());
  if (!m) return null;
  return m[2] && m[2].toLowerCase() === 'm' ? Number(m[1]) : Number(m[1]) * 1024;
}

/**
 * How hard this server is working, and how hard it has been working.
 *
 * <p>The numbers come from the daemon, which is the only thing alive at the moment each sample is
 * taken. A stopped server therefore has no live reading and whatever history it left behind, which
 * is worth showing rather than blanking - "what was it doing before it died" is the question.
 */
async function renderPerformance(opts) {
  const force = Boolean(opts && opts.force);
  const row = rowOf(state.current);
  const body = $('#performanceBody');
  if (!row) { body.textContent = ''; stopPerfPolling(); return; }
  // Not the usual cache guard. Leaving this tab stops the timer, so returning has to start it
  // again even when the drawing is still good - otherwise the chart sits frozen at whatever it last
  // showed and only a server change ever clears it.
  const drawn = !force && body.dataset.for === row.name && body.childElementCount;
  if (body.dataset.for !== row.name) paneLoading(body);
  body.dataset.for = row.name;
  if (!drawn) await paintPerformance(row.name);

  stopPerfPolling();
  if (!['win32', 'darwin', 'linux'].includes(panelPlatform)) return;
  // Matched to how often the daemon samples. Polling faster would redraw the same points.
  perfTimer = setInterval(() => {
    if (state.pane !== 'performance' || state.current !== row.name) return stopPerfPolling();
    paintPerformance(row.name, { quiet: true });
  }, 10000);
}

async function paintPerformance(name, opts) {
  const body = $('#performanceBody');
  let data;
  try {
    data = await api('/instances/' + encodeURIComponent(name) + '/metrics?seconds=' + perfView.seconds);
  } catch (e) {
    if (opts && opts.quiet) return;
    paneError(body, e.message, () => renderPerformance({ force: true }));
    body.dataset.for = '';
    return;
  }
  if (body.dataset.for !== name || state.current !== name) return;
  body.textContent = '';
  paneHead(body, 'pulse', 'Performance',
    data.available === false ? 'Not available in this preview.'
      : 'Processor and memory while the server runs, sampled every ten seconds.');
  if (data.available === false) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = data.reason;
    body.append(note);
    return;
  }

  // ---- how far back to look ------------------------------------------------
  const ranges = document.createElement('div');
  ranges.className = 'ranges';
  ranges.setAttribute('role', 'group');
  ranges.setAttribute('aria-label', 'Time range');
  for (const r of RANGES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = r.label;
    b.title = r.say;
    b.setAttribute('aria-pressed', String(perfView.seconds === r.key));
    b.onclick = () => { perfView.seconds = r.key; paintPerformance(name); };
    ranges.append(b);
  }
  body.append(ranges);

  const samples = data.samples;
  const history = data.history || { count: 0 };
  if (!samples.length) {
    let none;
    if (history.count) {
      // There IS history, just not in this window - which is the normal state of a server that
      // stopped an hour ago. Saying "nothing recorded" here would be a lie about their own data.
      const wide = RANGES.find((r) => r.key > history.staleSeconds);
      none = 'Nothing in this range. This server last ran ' + ago(history.newest * 1000)
        + ', and ' + history.count + ' readings are kept'
        + (wide ? ' - try ' + wide.label + '.' : '.');
    } else {
      none = data.running
        ? 'Measuring. The first reading takes about ' + data.everySeconds + ' seconds.'
        : 'Nothing recorded. This is measured while the server runs, and history is cleared when it '
          + 'starts so two runs are never drawn as one line.';
    }
    // The pane's own shape, empty: both gauges with their grids, the reason written once across
    // the processor chart, and the memory chart saying only what it will measure against.
    const ceilingNote = data.memory ? data.memory + ' allowed' : '';
    body.append(gauge({
      title: 'Processor', now: data.running ? '…' : '—',
      aside: data.cores ? 'share of all ' + data.cores + ' cores' : '',
      samples: [], pick: (s) => s.cpu, max: 10, colour: 'var(--chart-cpu)', empty: none,
    }));
    body.append(gauge({
      title: 'Memory', now: data.running ? '…' : '—', aside: ceilingNote,
      samples: [], pick: (s) => s.rss, max: 256, colour: '#8fd3a8',
      empty: data.running ? 'Waiting for the first reading.' : 'No readings in this range.',
    }));
    return;
  }

  const last = samples[samples.length - 1];
  const peakCpu = samples.reduce((m, s) => Math.max(m, s.cpu), 0);
  const peakRss = samples.reduce((m, s) => Math.max(m, s.rss), 0);
  const ceiling = memoryCeilingMb(data.memory);
  // Headroom above the peak, so a flat line does not sit against the top of the box; and never
  // below the ceiling the JVM was given, so "nearly full" looks like nearly full.
  const rssMax = Math.max(ceiling || 0, peakRss * 1.15, 256);

  body.append(gauge({
    title: 'Processor',
    now: data.running ? last.cpu.toFixed(1) + '%' : 'stopped',
    aside: 'peak ' + peakCpu.toFixed(1) + '%  ·  share of all ' + data.cores + ' cores',
    samples,
    pick: (s) => s.cpu,
    // A fixed 100% scale would draw every ordinary server as a flat line on the floor. The scale
    // follows the peak instead, with a floor of 10% so a quiet server is not magnified into drama.
    max: Math.max(10, peakCpu * 1.15),
    colour: 'var(--chart-cpu)',
    fmt: (v) => v.toFixed(1) + '%',
  }));

  body.append(gauge({
    title: 'Memory',
    now: data.running ? last.rss + ' MB' : 'stopped',
    aside: 'peak ' + peakRss + ' MB' + (ceiling ? '  ·  ' + data.memory + ' allowed' : ''),
    samples,
    pick: (s) => s.rss,
    max: rssMax,
    colour: '#8fd3a8',
    fmt: (v) => Math.round(v) + ' MB',
  }));

  // What the server says about itself, when it says it. Read over RCON by the daemon, so a server
  // without RCON has no line here rather than a flat one at zero.
  const ticks = samples.filter((s) => s.tps != null);
  if (ticks.length) {
    const low = ticks.reduce((m, s) => Math.min(m, s.tps), 20);
    body.append(gauge({
      title: 'TPS',
      now: data.running ? ticks[ticks.length - 1].tps.toFixed(1) : 'stopped',
      aside: 'low ' + low.toFixed(1) + '  ·  20 is full speed',
      samples: ticks,
      pick: (s) => s.tps,
      // Fixed at the game's own ceiling: a dip from 20 to 18 should look like the small thing it is.
      max: 20,
      colour: 'var(--live)',
      fmt: (v) => v.toFixed(1),
    }));
  }

  // Only when it would otherwise read as a breach. -Xmx caps the heap; this graph is the whole
  // process, which includes the JVM itself, metaspace and anything off-heap, and sitting above the
  // heap limit is ordinary rather than a problem.
  if (ceiling && peakRss > ceiling) {
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = 'Memory can sit above the limit you set. That is normal: ' + data.memory
      + ' is what the game itself may use, and Java needs some more on top of it.';
    body.append(note);
  }

  const facts = document.createElement('div');
  facts.className = 'facts';
  const add = (label, value) => {
    const span = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = value;
    span.append(label + ' ', b);
    facts.append(span);
  };
  const up = humanUptime(data.uptimeMs);
  add('Uptime', up || (data.running ? 'just started' : 'not running'));
  if (data.startedAt) add('Started', stamp(new Date(data.startedAt).toISOString()));
  add('Readings', samples.length + ', one every ' + data.everySeconds + ' seconds');
  body.append(facts);
}

