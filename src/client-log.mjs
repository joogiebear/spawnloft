// The game's process output as plain lines.
//
// Since the Log4Shell fix the client runs with Mojang's log config (version.logging.client), which
// writes log4j XML events to stdout, as the official launcher expects; latest.log in the profile
// folder keeps the plain form. This turns the XML back into latest.log's own lines
// ("[21:03:01] [Render thread/INFO]: Stopping!"), so the launcher's notice, `client logs`, the
// assistant's log tool and the diag bundle all read the same lines, and the bundle's de-duplication
// against latest.log works again. Anything that is not an event (JVM errors, launcher output, a
// line the tail cut in half) passes through as it is.

const EVENT_RE = /[ \t]*<log4j:Event\b([^>]*)>([\s\S]*?)<\/log4j:Event>/g
const ATTR_RE = /([\w:]+)="([^"]*)"/g
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }

function decode(s) {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m])
}

function attributes(s) {
  const out = {}
  for (const m of s.matchAll(ATTR_RE)) out[m[1]] = decode(m[2])
  return out
}

// <log4j:Message><![CDATA[...]]></log4j:Message>: CDATA is literal text, so nothing in it is
// decoded; the one exception is "]]>" inside a message, which log4j writes as "]]>]]&gt;<![CDATA[",
// so the markers go first and that one entity after.
function section(body, name) {
  const m = new RegExp(`<log4j:${name}>([\\s\\S]*?)</log4j:${name}>`).exec(body)
  if (!m) return ''
  return m[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').replace(/\]\]&gt;/g, ']]>')
}

// the clock as latest.log prints it, in this machine's time zone
export function clockTime(ms) {
  const d = new Date(ms)
  if (!Number.isFinite(ms) || Number.isNaN(d.getTime())) return '??:??:??'
  const two = (n) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

export function plainClientLog(text, { clock = clockTime } = {}) {
  if (typeof text !== 'string' || !text.includes('log4j:Event')) return text
  // a tail that begins inside an event: what is left of that event is not readable, drop it
  const firstOpen = text.indexOf('<log4j:Event')
  const firstClose = text.indexOf('</log4j:Event>')
  if (firstClose !== -1 && (firstOpen === -1 || firstClose < firstOpen)) {
    text = text.slice(firstClose + '</log4j:Event>'.length).replace(/^\r?\n/, '')
  }
  return text.replace(EVENT_RE, (_, attrs, body) => {
    const a = attributes(attrs)
    const line = `[${clock(Number(a.timestamp))}] [${a.thread ?? '?'}/${a.level ?? 'INFO'}]: ${section(body, 'Message')}`
    const thrown = section(body, 'Throwable').replace(/\s+$/, '')
    return thrown ? `${line}\n${thrown}` : line
  })
}

// the same, for lines already split
export function plainClientLines(lines, opts) {
  return plainClientLog(lines.join('\n'), opts).split(/\r?\n/)
}
