'use strict'
// A stand-in for src/bot-host.cjs that needs no mineflayer and no server: it speaks the same
// JSON-lines handshake so test/bots.test.mjs can drive runHost through its awkward paths. The
// job file's "mode" picks the misbehaviour.
const fs = require('node:fs')
const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const report = (extra) => JSON.stringify({ name: job.name, ok: true, steps: [{ index: 0, step: { bot: 'alice', chat: 'hi' }, status: 'passed' }], bots: {}, ...extra }) + '\n'
const joined = '{"event":"joined"}\n'

function readWord() {
  return new Promise((resolve) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => { buf += d; if (buf.includes('\n')) resolve(JSON.parse(buf.split('\n')[0])) })
    process.stdin.on('end', () => resolve(null))
  })
}

async function main() {
  switch (job.mode) {
    case 'split': {
      // "joined" arrives in two writes, with a pause between them.
      process.stdout.write(joined.slice(0, 7))
      await new Promise((r) => setTimeout(r, 50))
      process.stdout.write(joined.slice(7))
      break
    }
    case 'dies-after-joined':
      process.stdout.write(joined)
      process.stderr.write('mineflayer blew up\n')
      process.exit(3)
      return
    default:
      process.stdout.write(joined)
  }
  const word = await readWord()
  fs.writeFileSync(job.wordFile, JSON.stringify(word))
  let out = word?.abort ? report({ ok: false, error: word.abort, steps: [] }) : report({})
  if (job.mode === 'stray') out += 'mineflayer: some late warning\n'
  // The stdin listener keeps the process alive, as mineflayer's timers do in the real host.
  process.stdout.write(out, () => process.exit(0))
}
main()
