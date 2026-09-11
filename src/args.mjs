/**
 * Parse a command line into flags and positional arguments.
 *
 * <p>Lives apart from the CLI because importing mcctl.mjs runs the command it was invoked
 * with, which is the last thing a test wants to happen.
 *
 * <p>The shapes it understands:
 *
 *   --key value    → { key: 'value' }    the next arg, unless that starts with "-"
 *   --key=value    → { key: 'value' }    everything after the first "=" verbatim
 *   --two-words    → { twoWords: true }  kebab-case becomes camelCase
 *   --no-thing     → { thing: false }    a "no-" prefix negates the base name
 *   -x [value]     → { x: 'value' | true }
 *   --             → everything after it is positional, verbatim
 */
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
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) flags[key] = argv[++i]
      else flags[key] = true
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional }
}
