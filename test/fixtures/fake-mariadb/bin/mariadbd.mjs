/**
 * Stands in for mariadbd --console: reads the port and data folder from the ini, listens on
 * loopback, says "ready for connections" on stderr the way the real one does, takes no stdin,
 * and speaks a one-line protocol the fake admin and client use:
 *
 *   shutdown          exit 0 after saying so (and a line in <datadir>/fake-shutdowns.log, which
 *                     outlives the console log a restart starts again)
 *   sql <base64>      append the statements to <datadir>/sql.log, answer "ok"
 *   dump <base64 db>  answer "ok <base64 dump text>" and close, the way a dump streams
 *
 * FAKE_MARIADB_FAIL=start makes it die during startup the way a taken port does.
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const ini = process.argv.find((a) => a.startsWith('--defaults-file='))?.slice('--defaults-file='.length)
const text = ini ? fs.readFileSync(ini, 'utf8') : ''
const port = Number(/^port=(\d+)/m.exec(text)?.[1])
const datadir = /^datadir=(.+)$/m.exec(text)?.[1]?.trim()
const note = (line) => process.stderr.write(`2026-09-05 12:00:00 0 [Note] mariadbd: ${line}\n`)

note(`Starting fake MariaDB ${process.argv.slice(2).join(' ')}`)
if (process.env.FAKE_MARIADB_FAIL === 'start') {
  process.stderr.write("2026-09-05 12:00:00 0 [ERROR] Can't start server: Bind on TCP/IP port. Got error: 10048\n")
  process.stderr.write('2026-09-05 12:00:00 0 [ERROR] Aborting\n')
  process.exit(1)
}

const server = net.createServer((socket) => {
  let buf = ''
  socket.on('data', (c) => {
    buf += c.toString()
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line === 'shutdown') {
        note('Normal shutdown')
        try {
          fs.appendFileSync(path.join(datadir, 'fake-shutdowns.log'), JSON.stringify({ pid: process.pid, at: Date.now() }) + '\n')
        } catch {
          /* the console line is the evidence then */
        }
        socket.end('ok\n')
        setTimeout(() => process.exit(0), 50)
      } else if (line.startsWith('sql ')) {
        const sql = Buffer.from(line.slice(4), 'base64').toString('utf8')
        fs.appendFileSync(path.join(datadir, 'sql.log'), sql + '\n')
        socket.write('ok\n')
      } else if (line.startsWith('dump ')) {
        const db = Buffer.from(line.slice(5), 'base64').toString('utf8')
        const text = `-- MariaDB dump (fake) of ${db}\nCREATE DATABASE IF NOT EXISTS \`${db}\`;\nUSE \`${db}\`;\n-- dumped at ${Date.now()}\n`
        socket.end(`ok ${Buffer.from(text).toString('base64')}\n`)
      } else {
        socket.write('error unknown\n')
      }
    }
  })
  socket.on('error', () => {})
})
server.listen(port, '127.0.0.1', () => setTimeout(() => note('ready for connections.'), 150))
server.on('error', (err) => {
  process.stderr.write(`2026-09-05 12:00:00 0 [ERROR] Can't start server: ${err.message}\n`)
  process.exit(1)
})
setInterval(() => {}, 1 << 30)
