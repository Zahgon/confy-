// A small TOML serializer/parser covering what confy needs to round-trip serde
// config structs through the `toml` crate's `to_string_pretty` / `from_str`.
//
// Supported value types: string, integer, float, boolean, arrays, and nested
// tables (plain objects). This is not a full TOML implementation, but it matches
// the output shape of the `toml` crate for the flat/nested config data confy
// deals with and parses that output back losslessly.

class TomlError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TomlError'
  }
}

// ---------- Serialization ----------

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function serializeString(s) {
  let out = '"'
  for (const ch of s) {
    switch (ch) {
      case '"':
        out += '\\"'
        break
      case '\\':
        out += '\\\\'
        break
      case '\n':
        out += '\\n'
        break
      case '\r':
        out += '\\r'
        break
      case '\t':
        out += '\\t'
        break
      case '\b':
        out += '\\b'
        break
      case '\f':
        out += '\\f'
        break
      default: {
        const code = ch.codePointAt(0)
        if (code < 0x20) {
          out += '\\u' + code.toString(16).padStart(4, '0')
        } else {
          out += ch
        }
      }
    }
  }
  return out + '"'
}

function serializeNumber(n) {
  if (!Number.isFinite(n)) {
    throw new TomlError(`cannot serialize non-finite number: ${n}`)
  }
  if (Number.isInteger(n)) return String(n)
  return String(n)
}

// Serialize a value that must be inline (not a table): string, number, bool, array.
function serializeInline(value) {
  const t = typeof value
  if (t === 'string') return serializeString(value)
  if (t === 'boolean') return value ? 'true' : 'false'
  if (t === 'number') return serializeNumber(value)
  if (t === 'bigint') return value.toString()
  if (Array.isArray(value)) {
    return '[' + value.map(serializeInline).join(', ') + ']'
  }
  throw new TomlError(`cannot serialize value of type ${t}`)
}

// Serialize a table (plain object). `prefix` is the dotted key path of the
// current table (empty for the root). Following the `toml` crate's pretty
// output, scalar/array keys are emitted first, then nested `[table]` sections.
function serializeTable(obj, prefix, lines) {
  const scalarKeys = []
  const tableKeys = []
  for (const key of Object.keys(obj)) {
    const value = obj[key]
    if (value === undefined) continue // serde skips these; also guards against holes
    if (isPlainObject(value)) tableKeys.push(key)
    else tableKeys // no-op
    if (!isPlainObject(value)) scalarKeys.push(key)
  }

  for (const key of scalarKeys) {
    lines.push(`${keyToken(key)} = ${serializeInline(obj[key])}`)
  }

  for (const key of tableKeys) {
    const path = prefix ? `${prefix}.${keyToken(key)}` : keyToken(key)
    lines.push('')
    lines.push(`[${path}]`)
    serializeTable(obj[key], path, lines)
  }
}

// A bare TOML key if it matches [A-Za-z0-9_-]+, otherwise a quoted key.
function keyToken(key) {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key
  return serializeString(key)
}

export function toTomlString(value) {
  if (!isPlainObject(value)) {
    throw new TomlError('top-level TOML value must be a table (object)')
  }
  const lines = []
  serializeTable(value, '', lines)
  const body = lines.join('\n').replace(/^\n+/, '')
  return body.length ? body + '\n' : ''
}

// ---------- Parsing ----------

function parseValue(raw, ctx) {
  const s = raw.trim()
  if (s.length === 0) throw new TomlError(`${ctx}: empty value`)

  const first = s[0]
  if (first === '"' || first === "'") return parseStringValue(s, ctx)
  if (first === '[') return parseArrayValue(s, ctx)
  if (s === 'true') return true
  if (s === 'false') return false

  // number (integer or float)
  const num = parseNumber(s)
  if (num !== undefined) return num

  throw new TomlError(`${ctx}: cannot parse value: ${s}`)
}

function parseNumber(s) {
  const cleaned = s.replace(/_/g, '')
  if (/^[+-]?\d+$/.test(cleaned)) {
    return Number(cleaned)
  }
  if (/^[+-]?(\d+\.\d+([eE][+-]?\d+)?|\d+[eE][+-]?\d+|\d*\.\d+|\d+\.)$/.test(cleaned)) {
    return Number(cleaned)
  }
  if (/^[+-]?(inf|nan)$/.test(cleaned)) {
    if (cleaned.endsWith('nan')) return NaN
    return cleaned[0] === '-' ? -Infinity : Infinity
  }
  return undefined
}

function parseStringValue(s, ctx) {
  const quote = s[0]
  if (quote === "'") {
    // literal string: no escapes
    const end = s.indexOf("'", 1)
    if (end === -1) throw new TomlError(`${ctx}: unterminated literal string`)
    return s.slice(1, end)
  }
  // basic string with escapes
  let out = ''
  let i = 1
  while (i < s.length) {
    const ch = s[i]
    if (ch === '"') return out
    if (ch === '\\') {
      const next = s[i + 1]
      switch (next) {
        case 'n':
          out += '\n'
          break
        case 'r':
          out += '\r'
          break
        case 't':
          out += '\t'
          break
        case 'b':
          out += '\b'
          break
        case 'f':
          out += '\f'
          break
        case '"':
          out += '"'
          break
        case '\\':
          out += '\\'
          break
        case 'u': {
          const hex = s.slice(i + 2, i + 6)
          out += String.fromCharCode(parseInt(hex, 16))
          i += 4
          break
        }
        case 'U': {
          const hex = s.slice(i + 2, i + 10)
          out += String.fromCodePoint(parseInt(hex, 16))
          i += 8
          break
        }
        default:
          throw new TomlError(`${ctx}: invalid escape \\${next}`)
      }
      i += 2
      continue
    }
    out += ch
    i++
  }
  throw new TomlError(`${ctx}: unterminated string`)
}

function parseArrayValue(s, ctx) {
  if (s[s.length - 1] !== ']') throw new TomlError(`${ctx}: unterminated array`)
  const inner = s.slice(1, -1).trim()
  if (inner.length === 0) return []
  const parts = splitTopLevel(inner)
  return parts.map((p) => parseValue(p, ctx))
}

// Split a comma-separated list respecting strings and nested brackets.
function splitTopLevel(s) {
  const parts = []
  let depth = 0
  let inStr = false
  let strCh = ''
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      cur += ch
      if (ch === '\\' && strCh === '"') {
        cur += s[i + 1] ?? ''
        i++
      } else if (ch === strCh) {
        inStr = false
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      inStr = true
      strCh = ch
      cur += ch
      continue
    }
    if (ch === '[') depth++
    if (ch === ']') depth--
    if (ch === ',' && depth === 0) {
      if (cur.trim().length) parts.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim().length) parts.push(cur.trim())
  return parts
}

// Split a `key = value` line at the first top-level `=` (outside of strings).
function splitKeyValue(line) {
  let inStr = false
  let strCh = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inStr) {
      if (ch === '\\' && strCh === '"') {
        i++
      } else if (ch === strCh) {
        inStr = false
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      inStr = true
      strCh = ch
      continue
    }
    if (ch === '=') return [line.slice(0, i), line.slice(i + 1)]
  }
  return null
}

function parseKey(raw, ctx) {
  const segments = []
  let s = raw.trim()
  while (s.length) {
    if (s[0] === '"' || s[0] === "'") {
      const quote = s[0]
      let end
      if (quote === "'") {
        end = s.indexOf("'", 1)
        if (end === -1) throw new TomlError(`${ctx}: unterminated key`)
        segments.push(s.slice(1, end))
      } else {
        segments.push(parseStringValue(s, ctx))
        // find closing quote position
        end = 1
        while (end < s.length) {
          if (s[end] === '\\') {
            end += 2
            continue
          }
          if (s[end] === '"') break
          end++
        }
      }
      s = s.slice(end + 1).trim()
    } else {
      const m = s.match(/^[A-Za-z0-9_-]+/)
      if (!m) throw new TomlError(`${ctx}: invalid key: ${raw}`)
      segments.push(m[0])
      s = s.slice(m[0].length).trim()
    }
    if (s[0] === '.') {
      s = s.slice(1).trim()
    } else if (s.length) {
      throw new TomlError(`${ctx}: invalid key: ${raw}`)
    }
  }
  if (segments.length === 0) throw new TomlError(`${ctx}: empty key`)
  return segments
}

function tableAt(root, path, ctx) {
  let cur = root
  for (const seg of path) {
    if (!(seg in cur)) cur[seg] = {}
    else if (!isPlainObject(cur[seg])) {
      throw new TomlError(`${ctx}: key "${seg}" is not a table`)
    }
    cur = cur[seg]
  }
  return cur
}

export function fromTomlString(input) {
  const root = {}
  let current = root
  const lines = input.split(/\r?\n/)

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const ctx = `line ${lineNo + 1}`
    let line = stripComment(lines[lineNo]).trim()
    if (line.length === 0) continue

    if (line[0] === '[') {
      if (line[1] === '[') {
        throw new TomlError(`${ctx}: array-of-tables not supported`)
      }
      const end = line.indexOf(']')
      if (end === -1) throw new TomlError(`${ctx}: unterminated table header`)
      const path = parseKey(line.slice(1, end), ctx)
      current = tableAt(root, path, ctx)
      continue
    }

    const kv = splitKeyValue(line)
    if (!kv) throw new TomlError(`${ctx}: expected key = value`)
    const keyPath = parseKey(kv[0], ctx)
    const value = parseValue(kv[1], ctx)
    const leaf = keyPath.pop()
    const target = keyPath.length ? tableAt(current, keyPath, ctx) : current
    target[leaf] = value
  }

  return root
}

// Strip a `#` comment that is not inside a string.
function stripComment(line) {
  let inStr = false
  let strCh = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inStr) {
      if (ch === '\\' && strCh === '"') {
        i++
      } else if (ch === strCh) {
        inStr = false
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      inStr = true
      strCh = ch
      continue
    }
    if (ch === '#') return line.slice(0, i)
  }
  return line
}

export { TomlError }
