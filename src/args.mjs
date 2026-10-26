export const BOOLEAN_FLAGS = [
  'json', 'csv', 'follow', 'f', 'thorough', 'setAsidePrivateCopies',
  'yes', 'force', 'purge', 'all', 'drop', 'check', 'raw', 'unstable', 'offline', 'acceptEula',
  'withWorlds', 'wipePlugins', 'data', 'detach', 'wait', 'sync', 'open', 'flush', 'onLogon', 'showIps', 'allowDestructive',
]

// Separate from the CLI because importing mcctl.mjs runs the command.
// --key value (next arg unless it starts with "-"), --key=value, --two-words -> twoWords,
// --no-thing -> thing: false, -x [value], and "--" makes the rest positional.
export function parseArgs(argv, { booleanFlags = [] } = {}) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s)
      const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      if (inlineValue !== undefined) {
        flags[key] = inlineValue
      } else if (rawKey.startsWith('no-')) {
        flags[rawKey.slice(3).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = false
      } else if (booleanFlags.includes(key)) {
        flags[key] = true
      } else if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
        flags[key] = argv[++i]
      } else {
        flags[key] = true
      }
    } else if (/^-[a-zA-Z]$/.test(arg)) {
      const key = arg.slice(1)
      if (booleanFlags.includes(key)) flags[key] = true
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) flags[key] = argv[++i]
      else flags[key] = true
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional }
}
