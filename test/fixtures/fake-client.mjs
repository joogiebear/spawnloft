import readline from 'node:readline'

const userName = (() => {
  const idx = process.argv.indexOf('--username')
  return idx !== -1 ? process.argv[idx + 1] : 'unknown'
})()

if (process.env.FAKE_CLIENT_FAIL === 'window') {
  process.stdout.write('[00:00:00] [Render thread/ERROR]: GLFW error 65542: WGL: The driver does not appear to support OpenGL\n')
  setTimeout(() => process.exit(1), 200)
} else {
  process.stdout.write(`[00:00:00] [Render thread/INFO]: Setting user: ${userName}\n`)
  process.stdout.write('[00:00:00] [Render thread/INFO]: Backend library: LWJGL version 3.3.3\n')

  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (l) => {
    if (l.trim() === 'quit') process.exit(0)
  })
  process.on('SIGTERM', () => process.exit(0))
  setInterval(() => {}, 1000)
}
