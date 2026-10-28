import readline from 'node:readline'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

const userName = (() => {
  const idx = process.argv.indexOf('--username')
  return idx !== -1 ? process.argv[idx + 1] : 'unknown'
})()

const tokenIdx = process.argv.findIndex(a => a.startsWith('-Dspawnloft.harness.token='))
const harnessToken = tokenIdx !== -1 ? process.argv[tokenIdx].slice('-Dspawnloft.harness.token='.length) : null

if (process.env.FAKE_CLIENT_FAIL === 'window') {
  process.stdout.write('[00:00:00] [Render thread/ERROR]: GLFW error 65542: WGL: The driver does not appear to support OpenGL\n')
  setTimeout(() => process.exit(1), 200)
} else {
  process.stdout.write(`[00:00:00] [Render thread/INFO]: Setting user: ${userName}\n`)
  process.stdout.write('[00:00:00] [Render thread/INFO]: Backend library: LWJGL version 3.3.3\n')

  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (l) => {
    if (l.trim() === 'quit') {
      fs.rmSync(path.join(process.cwd(), 'spawnloft-harness.json'), { force: true })
      process.exit(0)
    }
  })
  process.on('SIGTERM', () => {
    fs.rmSync(path.join(process.cwd(), 'spawnloft-harness.json'), { force: true })
    process.exit(0)
  })
  setInterval(() => {}, 1000)

  if (harnessToken !== null) {
    let screen = 'title'
    let connected = null
    let player = null
    // FAKE_CLIENT_BOOT_MS: like the real game, no screen ("other") while resources load.
    // FAKE_CLIENT_QUICKPLAY_MS: with --quickPlayMultiplayer, the connect screen ("connecting",
    // nothing the mod sees as a connection yet) for that long, then the world.
    const bootMs = Number(process.env.FAKE_CLIENT_BOOT_MS) || 0
    const quickPlayMs = Number(process.env.FAKE_CLIENT_QUICKPLAY_MS) || 0
    const qpIdx = process.argv.indexOf('--quickPlayMultiplayer')
    const quickPlay = quickPlayMs && qpIdx !== -1 ? process.argv[qpIdx + 1] : null
    // FAKE_CLIENT_SCREEN_TITLE: after the load, a titled screen of its own ("other"), as the
    // accessibility screen of a fresh profile. FAKE_CLIENT_QUICKPLAY_FAIL: the launch's join is
    // refused and the game goes back to the title screen.
    const firstTitle = process.env.FAKE_CLIENT_SCREEN_TITLE || ''
    let screenTitleOverride = ''
    if (bootMs) {
      screen = 'other'
      setTimeout(() => {
        if (screen !== 'other') return
        if (firstTitle) screenTitleOverride = firstTitle
        else screen = 'title'
      }, bootMs)
    }
    if (quickPlay) {
      setTimeout(() => {
        screen = 'connecting'
        setTimeout(() => {
          if (screen !== 'connecting') return
          if (process.env.FAKE_CLIENT_QUICKPLAY_FAIL) {
            screen = 'title'
            return
          }
          const [qpHost, qpPort] = quickPlay.split(':')
          screen = 'ingame'
          connected = { host: qpHost, port: Number(qpPort) }
          player = { name: userName, uuid: '00000000-0000-0000-0000-000000000000' }
        }, quickPlayMs)
      }, bootMs)
    }
    const messages = []
    let nextSeq = 1
    let activeSocket = null
    // Like the mod's accept loop: a second connection waits its turn instead of being dropped.
    const waiting = []

    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      fs.writeFileSync(
        path.join(process.cwd(), 'spawnloft-harness.json'),
        JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString(), version: '0.1.0+1.21.11' }),
      )
    })

    server.on('connection', (socket) => {
      if (activeSocket) {
        waiting.push(socket)
        return
      }
      serve(socket)
    })

    function serve(socket) {
      activeSocket = socket
      let firstRequest = true
      let buffer = ''

      socket.on('data', (data) => {
        buffer += data.toString('utf8')
        let idx
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (line.trim() === '') continue

          let req
          try { req = JSON.parse(line) } catch { continue }

          const { id, op, ...args } = req

          if (firstRequest) {
            firstRequest = false
            if (op !== 'hello' || args.token !== harnessToken) {
              socket.destroy()
              return
            }
            socket.write(JSON.stringify({ id, ok: true, version: '0.1.0+1.21.11', minecraft: '1.21.11', loader: '0.19.5' }) + '\n')
            return
          }

          switch (op) {
            case 'status': {
              const screenTitle = screen === 'title' ? 'Title Screen' : screen === 'other' ? screenTitleOverride : ''
              socket.write(JSON.stringify({ id, ok: true, screen, screenTitle, connected, player, fps: 60 }) + '\n')
              break
            }
            case 'join': {
              const { host, port: joinPort } = args
              if (connected !== null) {
                socket.write(JSON.stringify({ id, ok: false, error: 'already connected; call disconnect first' }) + '\n')
              } else if (screen === 'connecting') {
                // the real game logs this and carries on with the first connect
                process.stdout.write('[00:00:00] [Render thread/ERROR]: Attempt to connect while already connecting\n')
                socket.write(JSON.stringify({ id, ok: true, joined: true }) + '\n')
              } else if (host === 'refused.invalid') {
                setTimeout(() => {
                  if (socket.destroyed) return
                  screen = 'disconnected'
                  socket.write(JSON.stringify({ id, ok: false, error: 'disconnected: Connection refused' }) + '\n')
                }, 300)
              } else {
                setTimeout(() => {
                  if (socket.destroyed) return
                  // Like the real mod: join answers once the player exists, and the screen says
                  // "connecting" (Loading terrain) for FAKE_CLIENT_LOAD_MS more.
                  const loadMs = Number(process.env.FAKE_CLIENT_LOAD_MS) || 0
                  screen = loadMs ? 'connecting' : 'ingame'
                  if (loadMs) setTimeout(() => { if (screen === 'connecting') screen = 'ingame' }, loadMs)
                  connected = { host, port: joinPort }
                  player = { name: userName, uuid: '00000000-0000-0000-0000-000000000000' }
                  socket.write(JSON.stringify({ id, ok: true, joined: true }) + '\n')
                }, 300)
              }
              break
            }
            case 'disconnect': {
              screen = 'title'
              connected = null
              player = null
              socket.write(JSON.stringify({ id, ok: true }) + '\n')
              break
            }
            case 'chat': {
              const { text } = args
              const seq = nextSeq++
              messages.push({ seq, at: new Date().toISOString(), kind: 'chat', text: userName + ' ' + text })
              socket.write(JSON.stringify({ id, ok: true, sent: text }) + '\n')
              break
            }
            case 'messages': {
              const since = args.since ?? 0
              const filtered = messages.filter(m => m.seq > since)
              socket.write(JSON.stringify({ id, ok: true, messages: filtered, next: messages.length ? messages[messages.length - 1].seq : 0 }) + '\n')
              break
            }
            case 'player': {
              if (connected === null) {
                socket.write(JSON.stringify({ id, ok: false, error: 'not in a world' }) + '\n')
              } else {
                socket.write(JSON.stringify({ id, ok: true, name: userName, gameMode: 'survival', health: 20, food: 20, dimension: 'minecraft:overworld', position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, heldItem: null }) + '\n')
              }
              break
            }
            case 'screen': {
              socket.write(JSON.stringify({ id, ok: true, kind: 'none', title: '', slots: null }) + '\n')
              break
            }
            case 'screenshot': {
              const dir = path.join(process.cwd(), 'screenshots')
              fs.mkdirSync(dir, { recursive: true })
              const file = path.join(dir, 'spawnloft-' + Date.now() + '.png')
              fs.writeFileSync(file, 'x')
              socket.write(JSON.stringify({ id, ok: true, file }) + '\n')
              break
            }
            case 'quit': {
              socket.write(JSON.stringify({ id, ok: true }) + '\n')
              fs.rmSync(path.join(process.cwd(), 'spawnloft-harness.json'), { force: true })
              server.close()
              setTimeout(() => process.exit(0), 50)
              break
            }
            default: {
              socket.write(JSON.stringify({ id, ok: false, error: 'unknown op: ' + op }) + '\n')
              break
            }
          }
        }
      })

      socket.on('close', () => {
        activeSocket = null
        const next = waiting.shift()
        if (next && !next.destroyed) serve(next)
      })
      socket.on('error', () => {})
    }
  }
}
