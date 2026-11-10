/**
 * The checker for the shape language the contract fixtures in this folder are written in. Kept
 * small and plain so a Rust port can re-implement it from this file alone.
 *
 *   "string" "integer" "number" "boolean" "null" "any"   a JSON type ("object" and "array" too,
 *                                                      for a value of that type with any content)
 *   "integer|null"                                     any of several, separated by |
 *   { "const": v }                                     exactly v (deep equal)
 *   { "enum": [a, b] }                                 one of the listed values
 *   { "match": "regex" }                               a string the regex finds a match in
 *   { "array": spec }                                  an array whose items all match spec
 *   { "map": spec }                                    an object of any keys whose values match spec
 *   { "object": { "key": spec, "opt?": spec },         an object: keys ending in ? may be absent,
 *     "extra": true }                                  other keys are refused unless extra is true
 *   { "oneOf": [spec, spec] }                          matches at least one
 *   { "ref": "name" }                                  the spec named name in defs (the file's "shapes")
 *
 * A spec object holds exactly one of those keywords (plus "extra" beside "object"); anything else
 * is refused as a bad spec, so a typo in a fixture fails instead of loosening it.
 *
 * Returns a list of problems, empty when the value fits.
 */
import { isDeepStrictEqual } from 'node:util'

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function fitsType(value, type) {
  if (type === 'any') return true
  const t = typeOf(value)
  return t === type || (type === 'number' && t === 'integer')
}

const KEYWORDS = ['const', 'enum', 'match', 'oneOf', 'array', 'map', 'object', 'ref']

export function check(value, spec, at = '$', defs = {}) {
  if (typeof spec === 'string') {
    const types = spec.split('|')
    for (const type of types) {
      if (!['string', 'integer', 'number', 'boolean', 'null', 'any', 'object', 'array'].includes(type)) {
        return [`${at}: unknown type "${type}" in the fixture`]
      }
    }
    return types.some((t) => fitsType(value, t)) ? [] : [`${at}: expected ${spec}, got ${JSON.stringify(value)}`]
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return [`${at}: bad spec ${JSON.stringify(spec)}`]
  const keys = Object.keys(spec)
  const keywords = keys.filter((k) => KEYWORDS.includes(k))
  const stray = keys.filter((k) => !KEYWORDS.includes(k) && !(k === 'extra' && 'object' in spec))
  if (keywords.length !== 1 || stray.length) return [`${at}: bad spec ${JSON.stringify(spec)}`]
  if (spec.ref) return Object.hasOwn(defs, spec.ref) ? check(value, defs[spec.ref], at, defs) : [`${at}: no shape named "${spec.ref}"`]
  if ('const' in spec) return isDeepStrictEqual(value, spec.const) ? [] : [`${at}: expected ${JSON.stringify(spec.const)}, got ${JSON.stringify(value)}`]
  if (spec.enum) return spec.enum.some((v) => isDeepStrictEqual(v, value)) ? [] : [`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(spec.enum)}`]
  if ('match' in spec) {
    if (typeof value !== 'string') return [`${at}: expected a string matching /${spec.match}/, got ${JSON.stringify(value)}`]
    return new RegExp(spec.match).test(value) ? [] : [`${at}: ${JSON.stringify(value)} does not match /${spec.match}/`]
  }
  if (spec.oneOf) {
    const tries = spec.oneOf.map((s) => check(value, s, at, defs))
    return tries.some((p) => p.length === 0) ? [] : [`${at}: matches none of ${spec.oneOf.length} shapes (${tries.map((p) => p[0]).join('; ')})`]
  }
  if (spec.array) {
    if (!Array.isArray(value)) return [`${at}: expected an array, got ${JSON.stringify(value)}`]
    return value.flatMap((v, i) => check(v, spec.array, `${at}[${i}]`, defs))
  }
  if (spec.map) {
    if (typeOf(value) !== 'object') return [`${at}: expected an object, got ${JSON.stringify(value)}`]
    return Object.entries(value).flatMap(([k, v]) => check(v, spec.map, `${at}.${k}`, defs))
  }
  if (spec.object) {
    if (typeOf(value) !== 'object') return [`${at}: expected an object, got ${JSON.stringify(value)}`]
    const problems = []
    const known = new Set()
    for (const [rawKey, sub] of Object.entries(spec.object)) {
      const optional = rawKey.endsWith('?')
      const key = optional ? rawKey.slice(0, -1) : rawKey
      known.add(key)
      if (!Object.hasOwn(value, key)) {
        if (!optional) problems.push(`${at}: missing "${key}"`)
        continue
      }
      problems.push(...check(value[key], sub, `${at}.${key}`, defs))
    }
    if (!spec.extra) {
      for (const key of Object.keys(value)) if (!known.has(key)) problems.push(`${at}: unexpected field "${key}"`)
    }
    return problems
  }
  return [`${at}: bad spec ${JSON.stringify(spec)}`]
}

/** Every key a spec names, optional or not, without the ? (for "the fixture lists every field" checks). */
export function fieldsOf(spec) {
  return Object.keys(spec?.object ?? {}).map((k) => k.replace(/\?$/, ''))
}
