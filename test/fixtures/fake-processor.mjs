// Stands in for Java running an installer's build step (test/client-forge-install.test.mjs):
//   node fake-processor.mjs -cp <classpath> <MainClass> <args...>
// It writes one line per run to SL_FAKE_PROC_LOG, then makes each file named after --output,
// --slim or --extra with the text "made by <MainClass>". SL_FAKE_PROC_FAIL, _WRONG, _HANG and
// _SKIP name a main class to fail (exit 3 after a few lines), make the wrong file, never finish, or
// end well having made nothing.
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const cpAt = argv.indexOf('-cp')
const classpath = argv[cpAt + 1]
const main = argv[cpAt + 2]
const args = argv.slice(cpAt + 3)

if (process.env.SL_FAKE_PROC_LOG) {
  fs.appendFileSync(process.env.SL_FAKE_PROC_LOG, JSON.stringify({ main, classpath: classpath.split(path.delimiter), args, cwd: process.cwd() }) + '\n')
}
console.log(`${main} starting`)

if (process.env.SL_FAKE_PROC_HANG === main) {
  console.log('working...')
  setInterval(() => {}, 1000)
} else if (process.env.SL_FAKE_PROC_FAIL === main) {
  console.error('first problem line')
  console.error(`Exception in thread "main" java.lang.IllegalStateException: ${main} broke`)
  process.exit(3)
} else if (process.env.SL_FAKE_PROC_SKIP === main) {
  console.log('nothing to do, apparently')
} else {
  for (let i = 0; i < args.length - 1; i++) {
    if (['--output', '--slim', '--extra'].includes(args[i])) {
      const file = args[i + 1]
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, process.env.SL_FAKE_PROC_WRONG === main ? 'something else' : `made by ${main}`)
    }
  }
  console.log(`${main} done`)
}
