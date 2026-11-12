// YAML for confy/yaml: the output of serde_yaml 0.9 (libyaml emitter, block style, 2-space indent)
// (writer); reading is the serde_yaml / libyaml port in yaml-read.js.

import { FormatError } from '../errors.js'
import { entriesOf, mismatch } from '../schema.js'
import { ryuFloat } from '../numbers.js'

// ---------------------------------------------------------------------------------------------
// Writing

// libyaml's IS_PRINTABLE (U+0085 and the other C1 controls are not printable).
function printable(code) {
  return code === 0x0a || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd && code !== 0xfeff) || (code >= 0x10000 && code <= 0x10ffff)
}

const isBreakChar = (ch) => ch === '\n' || ch === '\r' || ch === '\u0085' || ch === '\u2028' || ch === '\u2029'

const U64_MAX = (1n << 64n) - 1n
const I64 = [-(1n << 63n), (1n << 63n) - 1n]
const U128_MAX = (1n << 128n) - 1n
const I128 = [-(1n << 127n), (1n << 127n) - 1n]
const RADIX_DIGITS = { 2: /^[01]+$/, 8: /^[0-7]+$/, 10: /^[0-9]+$/, 16: /^[0-9a-fA-F]+$/ }

// Rust's `from_str_radix` for an integer type with the bounds [min, max].
function fromStrRadix(src, radix, min, max) {
  let digits = src
  let negative = false
  if (digits.startsWith('+')) digits = digits.slice(1)
  else if (digits.startsWith('-') && min < 0n) {
    negative = true
    digits = digits.slice(1)
  }
  if (!RADIX_DIGITS[radix].test(digits)) return false
  let n = 0n
  for (const c of digits) n = n * BigInt(radix) + BigInt(parseInt(c, radix))
  if (negative) n = -n
  return n >= min && n <= max
}

const PREFIXES = [['0x', 16], ['0o', 8], ['0b', 2]]

function digitsButNotNumber(scalar) {
  const s = scalar.startsWith('-') || scalar.startsWith('+') ? scalar.slice(1) : scalar
  return s.length > 1 && s.startsWith('0') && /^[0-9]+$/.test(s.slice(1))
}

function parseUnsignedInt(scalar, max) {
  const unpositive = scalar.startsWith('+') ? scalar.slice(1) : scalar
  for (const [prefix, radix] of PREFIXES) {
    if (!unpositive.startsWith(prefix)) continue
    const rest = unpositive.slice(2)
    if (rest.startsWith('+') || rest.startsWith('-')) return false
    if (fromStrRadix(rest, radix, 0n, max)) return true
  }
  if (unpositive.startsWith('+') || unpositive.startsWith('-') || digitsButNotNumber(scalar)) return false
  return fromStrRadix(unpositive, 10, 0n, max)
}

function parseNegativeInt(scalar, [min, max]) {
  for (const [prefix, radix] of PREFIXES) {
    if (scalar.startsWith(`-${prefix}`) && fromStrRadix(`-${scalar.slice(3)}`, radix, min, max)) return true
  }
  return !digitsButNotNumber(scalar) && fromStrRadix(scalar, 10, min, max)
}

function parseF64(scalar) {
  let unpositive = scalar
  if (scalar.startsWith('+')) {
    unpositive = scalar.slice(1)
    if (unpositive.startsWith('+') || unpositive.startsWith('-')) return false
  }
  if (['.inf', '.Inf', '.INF'].includes(unpositive) || ['-.inf', '-.Inf', '-.INF', '.nan', '.NaN', '.NAN'].includes(scalar)) {
    return true
  }
  // Rust's f64 grammar; an overflow to infinity does not count as a number.
  return /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(unpositive) && Number.isFinite(Number(unpositive))
}

// serde_yaml writes a string single-quoted when a plain scalar would read back as null, a bool, an integer or
// a float (visit_untagged_scalar), or when it is digits with a leading zero.
function resolvesToNonString(s) {
  if (s === '' || ['~', 'null', 'Null', 'NULL', 'true', 'True', 'TRUE', 'false', 'False', 'FALSE'].includes(s)) {
    return true
  }
  if (parseUnsignedInt(s, U64_MAX) || parseNegativeInt(s, I64) || parseUnsignedInt(s, U128_MAX) ||
      parseNegativeInt(s, I128)) return true
  return digitsButNotNumber(s) || parseF64(s)
}

// yaml_emitter_analyze_scalar
function analyze(s) {
  const chars = [...s]
  const a = { flowPlain: true, blockPlain: true, single: true, block: true, multiline: false }
  if (chars.length === 0) return a
  if (s.startsWith('---') || s.startsWith('...')) a.flowPlain = a.blockPlain = false
  let flowInd = false
  let blockInd = false
  let lineBreaks = false
  let special = false
  let leadingSpace = false
  let leadingBreak = false
  let trailingSpace = false
  let trailingBreak = false
  let breakSpace = false
  let spaceBreak = false
  let prevSpace = false
  let prevBreak = false
  let precededByWs = true
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    const code = ch.codePointAt(0)
    const next = chars[i + 1]
    const followedByWs = next === undefined || next === ' ' || next === '\t' || next === '\n' || next === '\r'
    if (i === 0) {
      if ('#,[]{}&*!|>\'"%@`'.includes(ch)) flowInd = blockInd = true
      if (ch === '?' || ch === ':') {
        flowInd = true
        if (followedByWs) blockInd = true
      }
      if (ch === '-' && followedByWs) flowInd = blockInd = true
    } else {
      if (',?[]{}'.includes(ch)) flowInd = true
      if (ch === ':') {
        flowInd = true
        if (followedByWs) blockInd = true
      }
      if (ch === '#' && precededByWs) flowInd = blockInd = true
    }
    if (!printable(code)) special = true
    const isBreak = ch === '\n' || ch === '\r' || code === 0x85 || code === 0x2028 || code === 0x2029
    if (isBreak) lineBreaks = true
    if (ch === ' ') {
      if (i === 0) leadingSpace = true
      if (i === chars.length - 1) trailingSpace = true
      if (prevBreak) breakSpace = true
      prevSpace = true
      prevBreak = false
    } else if (isBreak) {
      if (i === 0) leadingBreak = true
      if (i === chars.length - 1) trailingBreak = true
      if (prevSpace) spaceBreak = true
      prevBreak = true
      prevSpace = false
    } else {
      prevSpace = false
      prevBreak = false
    }
    precededByWs = ch === ' ' || ch === '\t' || isBreak
  }
  a.multiline = lineBreaks
  if (leadingSpace || leadingBreak || trailingSpace || trailingBreak) a.flowPlain = a.blockPlain = false
  if (trailingSpace) a.block = false
  if (breakSpace) a.flowPlain = a.blockPlain = a.single = false
  if (spaceBreak || special) a.flowPlain = a.blockPlain = a.single = a.block = false
  if (lineBreaks) a.flowPlain = a.blockPlain = false
  if (flowInd) a.flowPlain = false
  if (blockInd) a.blockPlain = false
  return a
}

const DOUBLE_ESCAPES = {
  0x00: '0', 0x07: 'a', 0x08: 'b', 0x09: 't', 0x0a: 'n', 0x0b: 'v', 0x0c: 'f', 0x0d: 'r', 0x1b: 'e',
  0x22: '"', 0x5c: '\\', 0x85: 'N', 0xa0: '_', 0x2028: 'L', 0x2029: 'P',
}

function doubleQuoted(s) {
  let out = '"'
  for (const ch of s) {
    const code = ch.codePointAt(0)
    if (code in DOUBLE_ESCAPES) out += `\\${DOUBLE_ESCAPES[code]}`
    else if (!printable(code) || code === 0xfeff) {
      const hex = code.toString(16).toUpperCase()
      if (code <= 0xff) out += `\\x${hex.padStart(2, '0')}`
      else if (code <= 0xffff) out += `\\u${hex.padStart(4, '0')}`
      else out += `\\U${hex.padStart(8, '0')}`
    } else out += ch
  }
  return `${out}"`
}

// yaml_emitter_write_single_quoted: after a run of line breaks (LS or PS here; a space after a break rules
// single quotes out) the next character, or the closing quote, is indented to the scalar's indentation.
function singleQuoted(s, indent) {
  let out = "'"
  let breaks = false
  for (const ch of s) {
    if (isBreakChar(ch)) {
      out += ch
      breaks = true
      continue
    }
    if (breaks) out += ' '.repeat(indent)
    breaks = false
    out += ch === "'" ? "''" : ch
  }
  if (breaks) out += ' '.repeat(indent)
  return `${out}'`
}

// A scalar in key or value position; `indent` is the block indentation of a literal's content.
function scalarText(s, isKey, indent) {
  const a = analyze(s)
  let style = s.includes('\n') ? 'literal' : resolvesToNonString(s) ? 'single' : 'any'
  if (style === 'any') style = a.blockPlain && !(isKey && a.multiline) ? 'plain' : 'single'
  if (style === 'single' && !a.single) style = 'double'
  if (style === 'literal' && (!a.block || isKey)) style = 'double'
  if (style === 'plain') return s
  if (style === 'single') return singleQuoted(s, indent)
  if (style === 'double') return doubleQuoted(s)
  const chomp = s.endsWith('\n') ? (s.endsWith('\n\n') || s === '\n' ? '+' : '') : '-'
  const body = s.endsWith('\n') ? s.slice(0, -1) : s
  const pad = ' '.repeat(indent)
  const hint = s.startsWith(' ') || s.startsWith('\n') ? '2' : ''
  return `|${hint}${chomp}\n${body.split('\n').map((line) => (line ? pad + line : '')).join('\n')}`
}

function unwrap(schema, value) {
  if (schema.kind === 'option') return value === null || value === undefined ? null : unwrap(schema.inner, value)
  return { schema, value }
}

function scalar(schema, value, indent) {
  switch (schema.kind) {
    case 'bool':
      return String(value)
    case 'string':
      return scalarText(value, false, indent)
    case 'f32':
    case 'f64':
      if (Number.isNaN(value)) return '.nan'
      if (!Number.isFinite(value)) return value > 0 ? '.inf' : '-.inf'
      return ryuFloat(value, schema.kind === 'f32')
    default:
      return String(value)
  }
}

function isCollection(schema, value) {
  if (schema.kind === 'vec') return value.length > 0
  if (schema.kind === 'struct') return true
  if (schema.kind === 'map') return Object.keys(value).length > 0
  return false
}

function emptyCollection(schema) {
  return schema.kind === 'vec' ? '[]' : '{}'
}

// Lines of a block node written at `indent` columns.
function node(schema, value, indent) {
  const pad = ' '.repeat(indent)
  if (schema.kind === 'vec') {
    return value.map((item) => {
      const u = unwrap(schema.item, item)
      if (u === null) return `${pad}- null`
      if (isCollection(u.schema, u.value)) {
        const inner = node(u.schema, u.value, indent + 2)
        return `${pad}- ${inner.slice(indent + 2)}`
      }
      const text = u.schema.kind === 'vec' || u.schema.kind === 'map' || u.schema.kind === 'struct'
        ? emptyCollection(u.schema) : scalar(u.schema, u.value, indent + 2)
      return `${pad}- ${text}`
    }).join('\n')
  }
  return entriesOf(schema, value).map(([key, field, fieldValue]) => {
    // libyaml writes a key with a line break, or longer than 128 bytes, as a complex key: "? key" then ": value".
    const simple = ![...key].some(isBreakChar) && Buffer.byteLength(key) <= 128
    const head = simple ? `${pad}${scalarText(key, true, indent)}:` : `${pad}? ${scalarText(key, false, indent + 2)}\n${pad}:`
    const u = unwrap(field, fieldValue)
    if (u === null) return `${head} null`
    if (isCollection(u.schema, u.value)) {
      if (!simple) return `${head} ${node(u.schema, u.value, indent + 2).slice(indent + 2)}`
      const childIndent = u.schema.kind === 'vec' ? indent : indent + 2
      return `${head}\n${node(u.schema, u.value, childIndent)}`
    }
    const text = u.schema.kind === 'vec' || u.schema.kind === 'map' || u.schema.kind === 'struct'
      ? emptyCollection(u.schema) : scalar(u.schema, u.value, indent + 2)
    return `${head} ${text}`
  }).join('\n')
}

export function serializeYaml(value, schema) {
  const reason = mismatch(schema, value)
  if (reason) throw new FormatError(reason)
  const u = unwrap(schema, value)
  if (u === null) return 'null\n'
  if (!isCollection(u.schema, u.value)) {
    if (u.schema.kind === 'vec' || u.schema.kind === 'map' || u.schema.kind === 'struct') return `${emptyCollection(u.schema)}\n`
    return `${scalar(u.schema, u.value, 2)}\n`
  }
  return `${node(u.schema, u.value, 0)}\n`
}

export { parseYaml } from './yaml-read.js'
