// RON for confy/ron: ron 0.12 `to_string_pretty` with `PrettyConfig::default()` (4-space indent,
// trailing commas, anonymous structs, no final newline); reading is the ron port in ron-read.js.

import { FormatError } from '../errors.js'
import { entriesOf, mismatch } from '../schema.js'
import { decimalFloat } from '../numbers.js'
import { escapedAsUnicode } from './escape-debug.js'

// ---------------------------------------------------------------------------------------------
// Writing

function ronString(s) {
  let out = '"'
  for (const ch of s) {
    const code = ch.codePointAt(0)
    if (ch === '"') out += '\\"'
    else if (ch === "'") out += "\\'"
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (ch === '\0') out += '\\0'
    else if (escapedAsUnicode(code)) out += `\\u{${code.toString(16)}}`
    else out += ch
  }
  return `${out}"`
}

function floatText(value, single) {
  if (Number.isNaN(value)) return 'NaN'
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf'
  return decimalFloat(value, single)
}

function write(schema, value, depth) {
  const pad = '    '.repeat(depth + 1)
  const close = '    '.repeat(depth)
  switch (schema.kind) {
    case 'option':
      return value === null || value === undefined ? 'None' : `Some(${write(schema.inner, value, depth)})`
    case 'bool':
      return String(value)
    case 'string':
      return ronString(value)
    case 'f32':
      return floatText(value, true)
    case 'f64':
      return floatText(value, false)
    case 'vec':
      if (value.length === 0) return '[]'
      return `[\n${value.map((item) => `${pad}${write(schema.item, item, depth + 1)},\n`).join('')}${close}]`
    case 'map': {
      const entries = entriesOf(schema, value)
      if (entries.length === 0) return '{}'
      return `{\n${entries.map(([k, s, v]) => `${pad}${ronString(k)}: ${write(s, v, depth + 1)},\n`).join('')}${close}}`
    }
    case 'struct': {
      const entries = entriesOf(schema, value)
      if (entries.length === 0) return '()'
      return `(\n${entries.map(([k, s, v]) => `${pad}${k}: ${write(s, v, depth + 1)},\n`).join('')}${close})`
    }
    default:
      return String(value)
  }
}

export function serializeRon(value, schema) {
  const reason = mismatch(schema, value)
  if (reason) throw new FormatError(reason)
  return write(schema, value, 0)
}

export { parseRon } from './ron-read.js'
