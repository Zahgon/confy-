import { escapedAsUnicode } from './formats/escape-debug.js'

const BACKSLASH = { '\0': '\\0', '\t': '\\t', '\r': '\\r', '\n': '\\n', '\\': '\\\\' }

// Rust's char::escape_debug_ext with `quote` (the delimiter of the Debug form) escaped.
function escapeDebug(ch, quote) {
  if (ch in BACKSLASH) return BACKSLASH[ch]
  if (ch === quote) return `\\${quote}`
  const code = ch.codePointAt(0)
  return escapedAsUnicode(code) ? `\\u{${code.toString(16)}}` : ch
}

// Rust `{:?}` of a string (std's str Debug), used for paths and serde messages.
export function rustDebugString(text) {
  let out = '"'
  for (const ch of text) out += escapeDebug(ch, '"')
  return `${out}"`
}

// Rust `{:?}` of a char.
export function rustDebugChar(ch) {
  return `'${escapeDebug(ch, "'")}'`
}
