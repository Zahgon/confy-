// TOML for the default entry point (the `toml` crate 1.1: from_str and to_string_pretty) and for
// confy/basic-toml (the `basic-toml` crate: same documents, compact arrays, basic strings only).

import { isUtf8 } from 'node:buffer'

import { FormatError } from '../errors.js'
import { decode, DecodeError } from '../decode.js'
import { entriesOf, mismatch } from '../schema.js'
import { decimalFloat } from '../numbers.js'

// ---------------------------------------------------------------------------------------------
// Parsing: the toml crate 1.1 pipeline (toml_parser lexer, event parser and decoders, then the
// document builder). The first error reported anywhere wins, as in `toml::from_str`.

class ParseError extends Error {
  constructor(message, span) {
    super(message)
    this.span = span
  }
}

const fail = (description, expectedText, start, end = start) => {
  throw new ParseError(`${description}, expected ${expectedText}`, [start, end])
}
const failBare = (message, start, end) => {
  throw new ParseError(message, [start, end])
}

const STRING_TOKENS = new Set(['lit', 'basic', 'mllit', 'mlbasic'])
const PUNCT = '.=,[]{}'
const ATOM_END = '.=,[]{} \t#\r\n'

function lex(text) {
  const tokens = []
  const n = text.length
  let p = text.startsWith('\uFEFF') ? 1 : 0
  while (p < n) {
    const s = p
    const c = text[p]
    let kind
    if (PUNCT.includes(c)) {
      p++
      kind = c
    } else if (c === ' ' || c === '\t') {
      while (p < n && (text[p] === ' ' || text[p] === '\t')) p++
      kind = 'ws'
    } else if (c === '#') {
      while (p < n && text[p] !== '\r' && text[p] !== '\n') p++
      kind = 'comment'
    } else if (c === '\r') {
      p += text[p + 1] === '\n' ? 2 : 1
      kind = 'nl'
    } else if (c === '\n') {
      p++
      kind = 'nl'
    } else if (c === "'" && text.startsWith("'''", p)) {
      const end = text.indexOf("'''", p + 3)
      p = end < 0 ? n : end + 3
      if (text[p] === "'") p += text[p + 1] === "'" ? 2 : 1
      kind = 'mllit'
    } else if (c === "'") {
      p++
      while (p < n && text[p] !== "'" && text[p] !== '\n') p++
      if (text[p] === "'") p++
      kind = 'lit'
    } else if (c === '"' && text.startsWith('"""', p)) {
      p += 3
      for (;;) {
        const quote = text.indexOf('"""', p)
        const escape = text.indexOf('\\', p)
        if (quote < 0 && escape < 0) {
          p = n
          break
        }
        if (escape >= 0 && (quote < 0 || escape < quote)) {
          p = escape + 1
          if (text[p] === '\\' || text[p] === '"') p++
          continue
        }
        p = quote + 3
        break
      }
      if (text[p] === '"') p += text[p + 1] === '"' ? 2 : 1
      kind = 'mlbasic'
    } else if (c === '"') {
      p++
      while (p < n) {
        const ch = text[p]
        if (ch === '"') {
          p++
          break
        }
        if (ch === '\n') break
        p++
        if (ch === '\\' && (text[p] === '\\' || text[p] === '"')) p++
      }
      kind = 'basic'
    } else {
      while (p < n && !ATOM_END.includes(text[p])) p++
      kind = 'atom'
    }
    tokens.push({ k: kind, s, e: p })
  }
  tokens.push({ k: 'eof', s: p, e: p })
  return tokens
}

// Comment and newline validation (toml_parser decoder::ws), run as the parser meets them.
function checkComment(text, tok) {
  for (let i = tok.s + 1; i < tok.e; i++) {
    const code = text.charCodeAt(i)
    if (code !== 0x09 && (code < 0x20 || code === 0x7f)) fail('invalid comment character', 'printable characters', i)
  }
}

function checkNewline(text, tok) {
  if (tok.e - tok.s === 1 && text[tok.s] === '\r') fail('carriage return must be followed by newline', 'newline', tok.e)
}

class EventParser {
  constructor(text, tokens) {
    this.text = text
    this.tokens = tokens
    this.i = 0
    this.events = []
    this.depth = 0
  }

  // toml's RecursionGuard: arrays and inline tables nest at most 80 deep.
  enter(open) {
    this.depth++
    if (this.depth > 80) failBare('cannot recurse further; max recursion depth met', open.s, open.e)
  }

  next() {
    return this.i < this.tokens.length ? this.tokens[this.i++] : undefined
  }

  first(offset = 0) {
    return this.tokens[this.i + offset]
  }

  back() {
    this.i--
  }

  emit(k, s, e, enc = null) {
    this.events.push({ k, s, e, enc })
  }

  previousSpan() {
    for (let j = this.i - 1; j >= 0; j--) {
      const t = this.tokens[j]
      if (!['ws', 'comment', 'nl', 'eof'].includes(t.k)) return t
    }
    return { s: 0, e: 0 }
  }

  encoding(tok) {
    return STRING_TOKENS.has(tok.k) ? tok.k : null
  }

  newline(tok) {
    checkNewline(this.text, tok)
    this.emit('nl', tok.s, tok.e)
  }

  document() {
    for (let tok = this.next(); tok; tok = this.next()) {
      switch (tok.k) {
        case '[':
          this.onTable(tok)
          break
        case ']':
          fail('missing table open', '`[`', tok.s)
          break
        case 'lit': case 'basic': case 'mllit': case 'mlbasic': case 'atom':
          this.onExpressionKey(tok)
          break
        case '=':
          this.emit('key', tok.s, tok.s)
          this.onKeyValSep(tok)
          break
        case '.':
          this.onExpressionDot(tok)
          break
        case ',': case '}': case '{':
          fail('invalid key-value pair', 'key', tok.s)
          break
        case 'ws':
          break
        case 'nl':
          this.newline(tok)
          break
        case 'comment':
          this.onComment(tok)
          break
        case 'eof':
          return
      }
    }
  }

  optWs() {
    if (this.first()?.k === 'ws') this.next()
  }

  onTable(open) {
    const isArray = this.first()?.k === '['
    if (isArray) this.next()
    this.emit(isArray ? 'aotOpen' : 'stdOpen', open.s, open.e)
    this.optWs()
    const validKey = this.key('invalid table')
    this.optWs()
    let success = false
    if (this.first()?.k === ']') {
      const close = this.next()
      if (!isArray) {
        this.emit('stdClose', close.s, close.e)
        success = true
      } else if (this.first()?.k === ']') {
        this.next()
        this.emit('aotClose', close.s, close.e + 1)
        success = true
      } else {
        fail('unclosed array table', '`]`', close.e)
      }
    } else if (validKey) {
      let last = open
      for (let j = this.i - 1; j >= 0; j--) {
        if (this.tokens[j].k !== 'ws') {
          last = this.tokens[j]
          break
        }
      }
      if (isArray) fail('unclosed array table', '`]]`', last.e)
      fail('unclosed table', '`]`', last.e)
    }
    if (success) this.wsCommentNewline()
    else this.ignoreToNewline()
  }

  key(description) {
    for (let tok = this.next(); tok; tok = this.next()) {
      switch (tok.k) {
        case ']': case 'comment': case '=': case ',': case '[': case '{': case '}': case 'nl': case 'eof':
          this.emit('key', tok.s, tok.s)
          this.back()
          return false
        case 'ws':
          continue
        case '.':
          this.emit('key', tok.s, tok.s)
          this.emit('keySep', tok.s, tok.e)
          continue
        default:
          this.emit('key', tok.s, tok.e, this.encoding(tok))
          return this.optDotKeys()
      }
    }
    const prev = this.previousSpan()
    return fail(description, 'key', prev.e)
  }

  onExpressionKey(tok) {
    this.emit('key', tok.s, tok.e, this.encoding(tok))
    this.optDotKeys()
    this.optWs()
    if (this.first()?.k === '=') return this.onKeyValSep(this.next())
    const peek = this.first()
    if (peek) fail('key with no value', '`=`', peek.s)
    return this.ignoreToNewline()
  }

  onExpressionDot(dot) {
    this.emit('key', dot.s, dot.s)
    this.back()
    this.optDotKeys()
    this.optWs()
    if (this.first()?.k === '=') return this.onKeyValSep(this.next())
    const peek = this.first()
    if (peek) fail('missing value for key', '`=`', peek.s)
    return this.ignoreToNewline()
  }

  onKeyValSep(eq) {
    this.emit('kv', eq.s, eq.e)
    this.optWs()
    this.value()
    this.wsCommentNewline()
  }

  optDotKeys() {
    this.optWs()
    let success = true
    outer: while (this.first()?.k === '.') {
      const dot = this.next()
      this.emit('keySep', dot.s, dot.e)
      for (let tok = this.next(); tok; tok = this.next()) {
        switch (tok.k) {
          case '=': case ',': case '[': case ']': case '{': case '}': case 'comment': case 'nl': case 'eof':
            this.emit('key', tok.s, tok.s)
            this.back()
            success = false
            break outer
          case 'ws':
            continue
          case '.':
            this.emit('key', tok.s, tok.s)
            this.emit('keySep', tok.s, tok.e)
            continue
          default:
            this.emit('key', tok.s, tok.e, this.encoding(tok))
            this.optWs()
            continue outer
        }
      }
      this.emit('key', dot.e, dot.e)
    }
    return success
  }

  value() {
    let tok
    for (;;) {
      tok = this.next()
      if (!tok) {
        const prev = this.previousSpan()
        fail('missing value', 'value', prev.e)
      }
      if (tok.k !== '=') break
      fail('extra `=`', 'nothing', tok.s, tok.e)
    }
    switch (tok.k) {
      case 'comment': case ',': case 'nl': case 'eof': case 'ws':
        this.emit('scalar', tok.s, tok.s)
        this.back()
        return
      case '{':
        return this.onInlineTableOpen(tok)
      case '}':
        return fail('missing inline table opening', '`{`', tok.s)
      case '[':
        return this.onArrayOpen(tok)
      case ']':
        return fail('missing array opening', '`[`', tok.s)
      default:
        return this.onScalar(tok)
    }
  }

  onScalar(tok) {
    let end = tok.e
    if (tok.k === '.' || tok.k === 'atom') {
      for (;;) {
        const next = this.first()
        if (!next) break
        if (next.k === 'ws') {
          const second = this.first(1)
          if (second?.k === 'atom') {
            end = second.e
            this.i += 2
            continue
          }
          break
        }
        if (next.k === '.' || next.k === 'atom') {
          end = next.e
          this.i++
          continue
        }
        break
      }
    }
    this.emit('scalar', tok.s, end, this.encoding(tok))
  }

  onArrayOpen(open) {
    this.emit('arrOpen', open.s, open.e)
    this.enter(open)
    let needsValue = true
    const missingComma = (tok) => {
      if (!needsValue) fail('missing comma between array elements', '`,`', tok.s)
    }
    for (let tok = this.next(); tok; tok = this.next()) {
      switch (tok.k) {
        case 'comment':
          this.onComment(tok)
          break
        case 'ws':
          break
        case 'nl':
          this.newline(tok)
          break
        case ',':
          if (needsValue) fail('extra comma in array', 'value', tok.s, tok.e)
          this.emit('sep', tok.s, tok.e)
          needsValue = true
          break
        case '=':
          fail('unexpected `=` in array', 'value, `]`', tok.s, tok.e)
          break
        case '{':
          missingComma(tok)
          this.onInlineTableOpen(tok)
          needsValue = false
          break
        case '}':
          missingComma(tok)
          fail('missing inline table opening', '`{`', tok.s)
          break
        case '[':
          missingComma(tok)
          this.onArrayOpen(tok)
          needsValue = false
          break
        case ']':
          this.emit('arrClose', tok.s, tok.e)
          this.depth--
          return
        case 'eof':
          this.i = this.tokens.length
          break
        default:
          missingComma(tok)
          this.onScalar(tok)
          needsValue = false
      }
      if (tok.k === 'eof') break
    }
    const prev = this.previousSpan()
    fail('unclosed array', '`]`', prev.e)
  }

  onInlineTableOpen(open) {
    this.emit('itOpen', open.s, open.e)
    this.enter(open)
    const EXPECTED = { key: 'key', eq: '`=`', value: 'value', comma: '`,`' }
    let state = 'key'
    for (let tok = this.next(); tok; tok = this.next()) {
      if (tok.k === 'eof') break
      switch (tok.k) {
        case 'comment':
          this.onComment(tok)
          break
        case 'ws':
          break
        case 'nl':
          this.newline(tok)
          break
        case ',':
          if (state !== 'comma') fail('extra comma in inline table', EXPECTED[state], tok.s)
          this.emit('sep', tok.s, tok.e)
          state = 'key'
          break
        case '=':
          if (state === 'key') {
            this.emit('key', tok.s, tok.s)
            this.emit('kv', tok.s, tok.e)
            state = 'value'
          } else if (state === 'eq') {
            this.emit('kv', tok.s, tok.e)
            state = 'value'
          } else {
            fail('extra assignment between key-value pairs', EXPECTED[state], tok.s)
          }
          break
        case '{':
        case '[':
          if (state === 'key' || state === 'comma') fail('missing key for inline table element', EXPECTED[state], tok.s)
          if (state === 'eq') fail('missing assignment between key-value pairs', EXPECTED[state], tok.s)
          if (tok.k === '{') this.onInlineTableOpen(tok)
          else this.onArrayOpen(tok)
          state = 'comma'
          break
        case '}':
          if (state === 'eq') this.emit('kv', tok.s, tok.s)
          if (state === 'eq' || state === 'value') this.emit('scalar', tok.s, tok.s, 'lit')
          this.emit('itClose', tok.s, tok.e)
          this.depth--
          return
        case ']':
          if (state === 'value') fail('missing array opening', '`[`', tok.s)
          fail('invalid inline table element', EXPECTED[state], tok.s)
          break
        default:
          if (state === 'key') {
            if (tok.k === '.') {
              this.emit('key', tok.s, tok.s)
              this.back()
            } else {
              this.emit('key', tok.s, tok.e, this.encoding(tok))
            }
            this.optDotKeys()
            state = 'eq'
          } else if (state === 'eq') {
            fail('missing assignment between key-value pairs', EXPECTED[state], tok.s)
          } else if (state === 'value') {
            this.onScalar(tok)
            state = 'comma'
          } else {
            fail('missing comma between key-value pairs', EXPECTED[state], tok.s)
          }
      }
    }
    const prev = this.previousSpan()
    fail('unclosed inline table', '`}`', prev.e)
  }

  wsCommentNewline() {
    for (let tok = this.next(); tok; tok = this.next()) {
      switch (tok.k) {
        case 'comment':
          return this.onComment(tok)
        case 'ws':
          continue
        case 'nl':
          return this.newline(tok)
        case 'eof':
          return undefined
        default:
          return fail('unexpected key or value', 'newline, `#`', tok.s)
      }
    }
    return undefined
  }

  onComment(tok) {
    checkComment(this.text, tok)
    const next = this.next()
    if (!next || next.k === 'eof') return
    if (next.k === 'nl') return this.newline(next)
    fail('unexpected content between comment and newline', 'newline', next.s)
  }

  ignoreToNewline() {
    for (let tok = this.next(); tok; tok = this.next()) {
      if (tok.k === 'comment') return this.onComment(tok)
      if (tok.k === 'nl') return this.newline(tok)
      if (tok.k === 'eof') return undefined
    }
    return undefined
  }

  eof() {
    const tok = this.next()
    if (tok && tok.k !== 'eof') fail('unexpected content', 'nothing', tok.s)
  }
}

// --- decoders (toml_parser::decoder), spans rebased onto the document -------------------------

const LETTERS_LIST = 'letters, numbers, `-`, `_`'
const isLiteralChar = (code) => code === 0x09 || (code >= 0x20 && code <= 0x26) || (code >= 0x28 && code <= 0x7e) || code >= 0x80
const isBasicUnescaped = (code) => code === 0x20 || code === 0x09 || code === 0x21 ||
  (code >= 0x23 && code <= 0x5b) || (code >= 0x5d && code <= 0x7e) || code >= 0x80
const isHex = (c) => /^[0-9A-Fa-f]$/.test(c ?? '')

function decodeEscape(raw, base, i) {
  // raw[i] is the character after the backslash; returns [char, next index].
  const EXPECTED = '`b`, `e`, `f`, `n`, `r`, `\\`, `"`, `x`, `u`, `U`'
  if (i >= raw.length) fail('missing escaped value', EXPECTED, base + i)
  const id = raw[i]
  const simple = { b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"' }
  if (id in simple) return [simple[id], i + 1]
  const width = { x: 2, u: 4, U: 8 }[id]
  if (!width) fail('missing escaped value', EXPECTED, base + i)
  let j = i + 1
  while (j < raw.length && j < i + 1 + width && isHex(raw[j])) j++
  if (j - (i + 1) !== width) fail('too few unicode value digits', 'unicode hexadecimal value', base + j)
  const code = parseInt(raw.slice(i + 1, j), 16)
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail('invalid value', 'unicode hexadecimal value', base + i + 1)
  return [String.fromCodePoint(code), j]
}

function decodeLiteral(raw, base) {
  const INVALID = 'invalid literal string'
  let body = raw.startsWith("'") ? raw.slice(1) : fail(INVALID, "`'`", base)
  const offset = 1
  if (body.endsWith("'")) body = body.slice(0, -1)
  else fail(INVALID, "`'`", base + raw.length)
  for (let i = 0; i < body.length; i++) {
    if (!isLiteralChar(body.charCodeAt(i))) fail(INVALID, 'non-single-quote visible characters', base + offset + i)
  }
  return body
}

function stripStartNewline(s) {
  if (s.startsWith('\n')) return [s.slice(1), 1]
  if (s.startsWith('\r\n')) return [s.slice(2), 2]
  return [s, 0]
}

function decodeMlLiteral(raw, base) {
  const INVALID = 'invalid multi-line literal string'
  if (!raw.startsWith("'''")) fail(INVALID, "`'`", base)
  let [body, skipped] = stripStartNewline(raw.slice(3))
  const offset = 3 + skipped
  if (body.endsWith("'''")) body = body.slice(0, -3)
  else {
    fail(INVALID, "`'`", base + raw.length)
  }
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i)
    if (code === 0x27 || code === 0x0a) continue
    if (code === 0x0d) {
      if (body[i + 1] !== '\n') fail('carriage return must be followed by newline', 'newline', base + offset + i + 1)
    } else if (!isLiteralChar(code)) {
      fail(INVALID, 'non-single-quote characters', base + offset + i)
    }
  }
  return body
}

function decodeBasic(raw, base) {
  const INVALID = 'invalid basic string'
  if (!raw.startsWith('"')) fail(INVALID, '`"`', base)
  let end = raw.length
  if (raw.length >= 2 && raw.endsWith('"')) end = raw.length - 1
  else fail(INVALID, '`"`', base + raw.length)
  let out = ''
  let i = 1
  while (i < end) {
    const code = raw.charCodeAt(i)
    if (raw[i] === '\\') {
      const [ch, next] = decodeEscape(raw.slice(0, end), base, i + 1)
      out += ch
      i = next
    } else if (isBasicUnescaped(code)) {
      out += raw[i]
      i++
    } else {
      fail(INVALID, 'non-double-quote visible characters, `\\`', base + i, base + i + 1)
    }
  }
  return out
}

function decodeMlBasic(raw, base) {
  const INVALID = 'invalid multi-line basic string'
  if (!raw.startsWith('"""')) fail(INVALID, '`"`', base)
  const [, skipped] = stripStartNewline(raw.slice(3))
  let i = 3 + skipped
  let end = raw.length
  if (raw.length - i >= 3 && raw.endsWith('"""')) end = raw.length - 3
  else fail(INVALID, '`"`', base + raw.length)
  let out = ''
  while (i < end) {
    const c = raw[i]
    const code = raw.charCodeAt(i)
    if (c === '\\') {
      const after = raw[i + 1]
      if (after === ' ' || after === '\t' || after === '\r' || after === '\n') {
        i++
        while (raw[i] === ' ' || raw[i] === '\t') i++
        if (raw[i] === '\n') i++
        else if (raw[i] === '\r') {
          i++
          if (raw[i] === '\n') i++
          else fail('carriage return must be followed by newline', 'newline', base + i)
        } else fail(INVALID, 'newline', base + i)
        for (;;) {
          const start = i
          while (i < end && (raw[i] === ' ' || raw[i] === '\t' || raw[i] === '\n')) i++
          if (raw[i] === '\r') {
            if (raw[i + 1] === '\n') i += 2
            else fail('carriage return must be followed by newline', 'newline', base + i + 1)
          }
          if (i === start) break
        }
        continue
      }
      const [ch, next] = decodeEscape(raw.slice(0, end), base, i + 1)
      out += ch
      i = next
    } else if (c === '\r') {
      if (raw[i + 1] === '\n') {
        out += '\r\n'
        i += 2
      } else {
        fail('carriage return must be followed by newline', 'newline', base + i + 1)
      }
    } else if (isBasicUnescaped(code) || c === '"' || c === '\n') {
      out += c
      i++
    } else {
      let j = i
      while (j < end && !(isBasicUnescaped(raw.charCodeAt(j)) || '"\n\\\r'.includes(raw[j]))) j++
      fail(INVALID, '`\\`, characters', base + i, base + j)
    }
  }
  return out
}

function decodeUnquotedKey(raw, base) {
  if (raw === '') fail('unquoted keys cannot be empty', LETTERS_LIST, base, base)
  let span = null
  for (let i = 0; i < raw.length; i++) {
    if (/[A-Za-z0-9_-]/.test(raw[i])) continue
    if (span && i === span[1]) span[1] = i + 1
    else if (span) fail('invalid unquoted key', LETTERS_LIST, base + span[0], base + span[1])
    else span = [i, i + 1]
  }
  if (span) fail('invalid unquoted key', LETTERS_LIST, base + span[0], base + span[1])
  return raw
}

function decodeKey(text, ev) {
  const raw = text.slice(ev.s, ev.e)
  switch (ev.enc) {
    case 'lit':
      return decodeLiteral(raw, ev.s)
    case 'basic':
      return decodeBasic(raw, ev.s)
    case 'mllit':
      return failBare('keys cannot be multi-line literal strings, expected basic string, literal string', ev.s, ev.e)
    case 'mlbasic':
      return failBare('keys cannot be multi-line basic strings, expected basic string, literal string', ev.s, ev.e)
    default:
      return decodeUnquotedKey(raw, ev.s)
  }
}

// decode_unquoted_scalar: returns { kind, text } with kind string/bool/datetime/float/integer.
function decodeUnquoted(raw, base) {
  const invalid = () => {
    if (raw.endsWith("'''")) fail('missing opening quote', "`'''`", base)
    if (raw.endsWith('"""')) fail('missing opening quote', '`"""`', base)
    if (raw.endsWith("'")) fail('missing opening quote', "`'`", base)
    if (raw.endsWith('"')) fail('missing opening quote', '`"`', base)
    fail('string values must be quoted', 'literal string', base, base + raw.length)
  }
  const symbol = (sym, kind, value) => {
    if (raw !== sym) {
      if (raw.includes(' ')) invalid()
      fail(kind === 'bool' ? 'invalid boolean' : 'invalid float', `\`${sym}\``, base, base + raw.length)
    }
    return { kind, text: sym, value }
  }
  if (raw === '') return invalid()
  const first = raw[0]
  if (!/[0-9]/.test(first) && raw.includes(' ')) return invalid()
  if (first === '+' || first === '-') return signPrefix(raw.slice(1), 1)
  if (first === '_' || /[1-9]/.test(first)) return dateFloatInt(raw, 0)
  if (first === '0') return zeroPrefix(raw, 0, false)
  if (first === '.') return floatBody(raw, 0)
  if (first === 't' || first === 'T') return symbol('true', 'bool', true)
  if (first === 'f' || first === 'F') return symbol('false', 'bool', false)
  if (first === 'i' || first === 'I') return symbol('inf', 'float')
  if (first === 'n' || first === 'N') return symbol('nan', 'float')
  return invalid()

  function signPrefix(value, offset) {
    while (value[0] === '+' || value[0] === '-') {
      fail('redundant numeric sign', 'nothing', base + offset, base + offset + 1)
    }
    if (value === '') return invalid()
    const c = value[0]
    if (c === '_' || /[1-9]/.test(c)) return dateFloatInt(value, offset)
    if (c === '0') return zeroPrefix(value, offset, true)
    if (c === '.') return floatBody(raw, 0)
    if (c === 'i' || c === 'I' || c === 'n' || c === 'N') {
      const sym = c === 'i' || c === 'I' ? 'inf' : 'nan'
      if (value !== sym) fail('invalid float', `\`${sym}\``, base + offset, base + offset + value.length)
      return { kind: 'float', text: raw }
    }
    return invalid()
  }

  function zeroPrefix(value, offset, signed) {
    if (value.length === 1) return numberText(raw, 0, 'integer', 10)
    const r = value[1]
    const radixes = { x: 16, o: 8, b: 2, d: 10 }
    const radix = radixes[r.toLowerCase()]
    if (!radix || !'xXoObBdD'.includes(r)) return dateFloatInt(value, offset)
    if (value.includes(' ')) return invalid()
    if (signed) fail('integers with a radix cannot be signed', 'nothing', base, base + 1)
    if (r === 'd' || r === 'D') fail('redundant integer number prefix', 'nothing', base, base + 2)
    if (r !== r.toLowerCase()) fail('radix must be lowercase', `\`0${r.toLowerCase()}\``, base + offset, base + offset + 2)
    let digits = value.slice(2)
    const digitsStart = offset + 2
    if (digits[0] === '+' || digits[0] === '-') {
      const pos = raw.search(/[+-]/)
      fail('unexpected sign', 'nothing', base + pos, base + pos + 1)
    }
    const valid = { 16: /[0-9A-Fa-f]/, 8: /[0-7]/, 2: /[01]/ }[radix]
    for (let k = 0; k < digits.length; k++) {
      if (!valid.test(digits[k]) && digits[k] !== '_') {
        const name = { 16: 'hexadecimal', 8: 'octal', 2: 'binary' }[radix]
        throw new ParseError(`invalid ${name} number`, [base + digitsStart + k, base + digitsStart + k])
      }
    }
    digits = digits
    return numberText(raw, digitsStart, 'integer', radix)
  }

  function dateFloatInt(value, offset) {
    const m = /^[0-9]*/.exec(value)[0]
    if (m.length === value.length) {
      if (value.startsWith('0')) fail('unexpected leading zero', 'nothing', base + offset, base + offset + 1)
      return numberText(raw, 0, 'integer', 10)
    }
    const rest = value.slice(m.length)
    if (rest.startsWith('-') || rest.startsWith(':')) return { kind: 'datetime', text: raw }
    if (rest.includes(' ')) return invalid()
    if (/[.eE]/.test(rest)) {
      ensureFloat(value, offset)
      return numberText(raw, 0, 'float', 10)
    }
    if (rest.startsWith('_')) {
      if (value.startsWith('0')) fail('unexpected leading zero', 'nothing', base + offset, base + offset + 1)
      return numberText(raw, 0, 'integer', 10)
    }
    return invalid()
  }

  function floatBody(stream) {
    ensureFloat(stream, 0)
    return numberText(raw, 0, 'float', 10)
  }

  function ensureFloat(value, offset) {
    let k = 0
    const decUint = (zeroPrefix, description) => {
      const start = k
      let digits = 0
      while (k < value.length && (/[0-9]/.test(value[k]) || value[k] === '_')) {
        if (value[k] !== '_') digits++
        k++
      }
      if (digits === 0) fail(description, 'digits', base + offset + start)
      if (digits > 1 && value[start] === '0' && !zeroPrefix) fail('unexpected leading zero', 'nothing', base + offset + start, base + offset + start + 1)
    }
    decUint(false, 'invalid mantissa')
    if (value[k] === '.') {
      k++
      decUint(true, 'invalid fraction')
    }
    if (value[k] === 'e' || value[k] === 'E') {
      k++
      if (value[k] === '+' || value[k] === '-') k++
      decUint(true, 'invalid exponent')
    }
    if (k < value.length) fail('invalid float', 'nothing', base + offset + k, base + raw.length)
  }

  // decode_float_or_integer: underscores between digits only; returns the digits without underscores.
  function numberText(full, start, kind, radix) {
    const stream = full.slice(start)
    const isDigit = (ch) => (kind === 'float' ? /[0-9]/ : /[0-9a-fA-F]/).test(ch ?? '')
    let out = ''
    let k = 0
    while (k < stream.length) {
      const sep = stream.indexOf('_', k)
      const partEnd = sep < 0 ? stream.length : sep
      out += stream.slice(k, partEnd)
      if (sep < 0) break
      let bad = false
      if (partEnd > k) {
        if (!isDigit(stream[partEnd - 1])) bad = true
      } else if (k === 0) bad = true
      if (sep + 1 < stream.length) {
        if (!isDigit(stream[sep + 1])) bad = true
      } else bad = true
      if (bad) fail('`_` may only go between digits', 'nothing', base + start + sep, base + start + sep + 1)
      k = sep + 1
    }
    return { kind, text: out, radix }
  }
}

// toml_datetime's `Datetime::from_str`: null when valid, else its error text.
function datetimeError(input) {
  const tokens = []
  for (let k = 0; k < input.length;) {
    const c = input[k]
    if (/[0-9]/.test(c)) {
      let e = k
      while (e < input.length && /[0-9]/.test(input[e])) e++
      tokens.push({ kind: 'digits', raw: input.slice(k, e) })
      k = e
      continue
    }
    const single = { '-': 'dash', ':': 'colon', T: 't', t: 't', ' ': 'space', Z: 'z', z: 'z', '+': 'plus', '.': 'dot' }[c]
    if (single) {
      tokens.push({ kind: single, raw: c })
      k++
    } else {
      tokens.push({ kind: 'unknown', raw: input.slice(k) })
      break
    }
  }
  let i = 0
  const next = () => tokens[i++]
  const peek = () => tokens[i]
  const err = (what, expected) => `invalid ${what ?? 'datetime'}${expected ? `, expected ${expected}` : ''}`
  const expect = (kind, what, expected) => {
    const tok = next()
    return tok && tok.kind === kind ? [tok, null] : [null, err(what, expected)]
  }
  let hasDate = false
  let hasTime = false
  let [first, problem] = expect('digits', null, 'year or hour')
  if (problem) return problem
  const sep = next()
  if (!sep) return err(null, '`-` (YYYY-MM) or `:` (HH:MM)')
  if (sep.kind === 'dash') {
    let month, day
    ;[month, problem] = expect('digits', 'date', 'month')
    if (problem) return problem
    ;[, problem] = expect('dash', 'date', '`-` (MM-DD)')
    if (problem) return problem
    ;[day, problem] = expect('digits', 'date', 'day')
    if (problem) return problem
    if (first.raw.length !== 4) return err('date', 'a four-digit year (YYYY)')
    if (month.raw.length !== 2) return err('date', 'a two-digit month (MM)')
    if (day.raw.length !== 2) return err('date', 'a two-digit day (DD)')
    const y = Number(first.raw)
    const m = Number(month.raw)
    const d = Number(day.raw)
    if (m < 1 || m > 12) return err('date', 'month between 01 and 12')
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
    const max = m === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31
    if (d < 1 || d > max) return err('date', `day between 01 and ${max}`)
    hasDate = true
  } else if (sep.kind === 'colon') {
    i = 0
  } else {
    return err(null, '`-` (YYYY-MM) or `:` (HH:MM)')
  }
  let partialTime = !hasDate
  if (hasDate) {
    const t = next()
    if (t && (t.kind === 't' || t.kind === 'space')) partialTime = true
    else if (t) return err('date-time', '`T` between date and time')
  }
  if (partialTime) {
    let hour, minute, second = null, nano = null
    ;[hour, problem] = expect('digits', 'time', 'hour')
    if (problem) return problem
    ;[, problem] = expect('colon', 'time', '`:` (HH:MM)')
    if (problem) return problem
    ;[minute, problem] = expect('digits', 'time', 'minute')
    if (problem) return problem
    if (peek()?.kind === 'colon') {
      next()
      ;[second, problem] = expect('digits', 'time', 'second')
      if (problem) return problem
    }
    if (second && peek()?.kind === 'dot') {
      next()
      ;[nano, problem] = expect('digits', 'time', 'nanosecond')
      if (problem) return problem
    }
    if (hour.raw.length !== 2) return err('time', 'a two-digit hour (HH)')
    if (minute.raw.length !== 2) return err('time', 'a two-digit minute (MM)')
    if (second && second.raw.length !== 2) return err('time', 'a two-digit second (SS)')
    if (Number(hour.raw) > 23) return err('time', 'hour between 00 and 23')
    if (Number(minute.raw) > 59) return err('time', 'minute between 00 and 59')
    if (second && Number(second.raw) > 60) return err('time', 'second between 00 and 60')
    hasTime = true
  }
  if (hasDate && hasTime) {
    const t = next()
    if (t && (t.kind === 'plus' || t.kind === 'dash')) {
      let hours, minutes
      ;[hours, problem] = expect('digits', 'offset', 'hour')
      if (problem) return problem
      ;[, problem] = expect('colon', 'offset', '`:` (HH:MM)')
      if (problem) return problem
      ;[minutes, problem] = expect('digits', 'offset', 'minute')
      if (problem) return problem
      if (hours.raw.length !== 2) return err('offset', 'a two-digit hour (HH)')
      if (minutes.raw.length !== 2) return err('offset', 'a two-digit minute (MM)')
      if (Number(hours.raw) > 23) return err('offset', 'hours between 00 and 23')
      if (Number(minutes.raw) > 59) return err('offset', 'minutes between 00 and 59')
    } else if (t && t.kind !== 'z') {
      return err('offset', '`Z`, +OFFSET, -OFFSET')
    }
  }
  if (i < tokens.length) return err(null, null)
  return null
}
const U64_MAX = 2n ** 64n - 1n
const I64_MIN = -(2n ** 63n)
const I128_MAX = 2n ** 127n - 1n

function scalarNode(text, ev) {
  const raw = text.slice(ev.s, ev.e)
  const span = [ev.s, ev.e]
  switch (ev.enc) {
    case 'lit':
      return { type: 'string', value: decodeLiteral(raw, ev.s), span }
    case 'basic':
      return { type: 'string', value: decodeBasic(raw, ev.s), span }
    case 'mllit':
      return { type: 'string', value: decodeMlLiteral(raw, ev.s), span }
    case 'mlbasic':
      return { type: 'string', value: decodeMlBasic(raw, ev.s), span }
    default:
      break
  }
  const d = decodeUnquoted(raw, ev.s)
  if (d.kind === 'bool') return { type: 'bool', value: d.value, span }
  if (d.kind === 'datetime') {
    const problem = datetimeError(d.text)
    if (problem) failBare(problem, ev.s, ev.e)
    return { type: 'datetime', value: d.text, span }
  }
  if (d.kind === 'float') {
    const body = d.text.replace(/^[+-]/, '')
    let value
    if (body === 'inf') value = Infinity
    else if (body === 'nan') value = NaN
    else value = Number(body)
    if (d.text.startsWith('-')) value = -value
    const node = { type: 'float', value, span }
    if (!Number.isFinite(value) && body !== 'inf' && body !== 'nan') node.error = 'floating-point number overflowed'
    return node
  }
  if (d.text === '' || d.text === '+' || d.text === '-') return { type: 'integer', value: 0n, span, error: 'integer number overflowed' }
  const negative = d.text.startsWith('-')
  const digits = d.text.replace(/^[+-]/, '')
  const prefix = { 16: '0x', 8: '0o', 2: '0b', 10: '' }[d.radix]
  let value = BigInt(prefix + digits)
  if (negative) value = -value
  const node = { type: 'integer', value, span }
  if (value > I128_MAX || value < -I128_MAX - 1n) node.error = 'integer number overflowed'
  else if (value > U64_MAX || value < I64_MIN) node.i128 = true
  return node
}

// --- document builder (toml crate de::parser) --------------------------------------------------

function newTable(span, flags = {}) {
  return { type: 'table', entries: [], index: new Map(), keySpans: new Map(), implicit: false, dotted: false, inline: false, span, ...flags }
}

function tableGet(t, name) {
  return t.index.get(name)
}

function tableInsert(t, key, node) {
  t.entries.push([key.name, node])
  t.index.set(key.name, node)
  t.keySpans.set(key.name, key.span)
}

function tableRemove(t, name) {
  const node = t.index.get(name)
  if (node === undefined) return undefined
  t.entries = t.entries.filter(([k]) => k !== name)
  t.index.delete(name)
  const span = t.keySpans.get(name)
  t.keySpans.delete(name)
  return { node, span }
}

function typeStr(node) {
  return { string: 'string', integer: 'integer', float: 'float', bool: 'boolean', datetime: 'datetime', array: 'array', table: 'table' }[node.type]
}

class DocumentBuilder {
  constructor(text, events) {
    this.text = text
    this.events = events
    this.i = 0
  }

  next() {
    return this.i < this.events.length ? this.events[this.i++] : undefined
  }

  first(offset = 0) {
    return this.events[this.i + offset]
  }

  moreKey() {
    const a = this.first()?.k
    const b = this.first(1)?.k
    return a === 'keySep' || (a === 'ws' && b === 'keySep')
  }

  onKey(ev) {
    const path = []
    let key = null
    let current = ev
    const close = () => {
      if (!current) return
      const name = decodeKey(this.text, current)
      if (key) path.push(key)
      key = { name, span: [current.s, current.e] }
      current = null
    }
    if (this.moreKey()) {
      for (let e = this.next(); e; e = this.next()) {
        if (e.k === 'key') {
          current = e
          if (!this.moreKey()) break
        } else if (e.k === 'keySep') close()
      }
    }
    close()
    // toml's key limit: a dotted key or table header of more than 80 parts is an error without a position.
    if (path.length >= 80) throw new ParseError('recursion limit', null)
    return { path, key }
  }

  value() {
    const ev = this.next()
    if (ev?.k === 'itOpen') return this.onInlineTable(ev)
    if (ev?.k === 'arrOpen') return this.onArray(ev)
    if (ev?.k === 'scalar') return scalarNode(this.text, ev)
    return { type: 'integer', value: 0n, span: [0, 0] }
  }

  onArray(open) {
    const items = []
    let current = null
    let end = open.e
    for (let ev = this.next(); ev; ev = this.next()) {
      end = ev.e
      if (ev.k === 'itOpen') current = this.onInlineTable(ev)
      else if (ev.k === 'arrOpen') current = this.onArray(ev)
      else if (ev.k === 'scalar') current = scalarNode(this.text, ev)
      else if (ev.k === 'sep') {
        if (current) items.push(current)
        current = null
      } else if (ev.k === 'arrClose') {
        if (current) items.push(current)
        break
      } else if (!['ws', 'comment', 'nl', 'error'].includes(ev.k)) break
    }
    return { type: 'array', items, aot: false, span: [open.s, end] }
  }

  onInlineTable(open) {
    const result = newTable([open.s, open.e], { inline: true })
    let currentKey = null
    let currentValue = null
    const finishValue = () => {
      if (currentKey && currentValue) {
        const { path, key } = currentKey
        const table = this.descendInline(result, path)
        if (table.dotted === (path.length === 0)) failBare('duplicate key', key.span[0], key.span[1])
        if (table.index.has(key.name)) failBare('duplicate key', key.span[0], key.span[1])
        tableInsert(table, key, currentValue)
      }
      currentKey = null
      currentValue = null
    }
    for (let ev = this.next(); ev; ev = this.next()) {
      result.span = [open.s, ev.e]
      if (ev.k === 'key') {
        const { path, key } = this.onKey(ev)
        if (key) currentKey = { path, key }
      } else if (ev.k === 'itOpen') currentValue = this.onInlineTable(ev)
      else if (ev.k === 'arrOpen') currentValue = this.onArray(ev)
      else if (ev.k === 'scalar') currentValue = scalarNode(this.text, ev)
      else if (ev.k === 'sep') finishValue()
      else if (ev.k === 'itClose') {
        finishValue()
        break
      } else if (['stdOpen', 'aotOpen', 'stdClose', 'arrClose', 'aotClose', 'keySep'].includes(ev.k)) break
    }
    return result
  }

  descendInline(table, path) {
    for (const key of path) {
      const existing = tableGet(table, key.name)
      if (existing === undefined) {
        const child = newTable(key.span, { implicit: true, dotted: true, inline: true })
        tableInsert(table, key, child)
        table = child
      } else if (existing.type === 'table') {
        if (!existing.implicit) failBare('duplicate key', key.span[0], key.span[1])
        table = existing
      } else {
        failBare(`cannot extend value of type ${typeStr(existing)} with a dotted key`, key.span[0], key.span[1])
      }
    }
    return table
  }

  descend(table, path, dotted) {
    for (const key of path) {
      const existing = tableGet(table, key.name)
      if (existing === undefined) {
        const child = newTable(key.span, { implicit: true, dotted })
        tableInsert(table, key, child)
        table = child
      } else if (existing.type === 'array') {
        if (!existing.aot) failBare('cannot extend value of type array with a dotted key', key.span[0], key.span[1])
        table = existing.items[existing.items.length - 1]
      } else if (existing.type === 'table') {
        if (existing.inline) failBare('cannot extend value of type inline table with a dotted key', key.span[0], key.span[1])
        if (dotted && existing.implicit) existing.dotted = true
        if (dotted && !existing.implicit) failBare('duplicate key', key.span[0], key.span[1])
        table = existing
      } else {
        failBare(`cannot extend value of type ${typeStr(existing)} with a dotted key`, key.span[0], key.span[1])
      }
    }
    return table
  }

  build() {
    this.root = newTable([0, 0])
    this.current = newTable([0, 0])
    this.header = null
    for (let ev = this.next(); ev; ev = this.next()) {
      if (ev.k === 'stdOpen' || ev.k === 'aotOpen') {
        this.finishTable()
        const header = this.onTable(ev)
        this.startTable(header)
      } else if (ev.k === 'key') {
        const { path, key } = this.onKey(ev)
        if (!key) break
        let sep = this.next()
        if (sep?.k === 'ws') sep = this.next()
        if (sep?.k !== 'kv') break
        if (this.first()?.k === 'ws') this.next()
        const value = this.value()
        this.captureKeyValue(path, key, value)
      }
    }
    this.finishTable()
    return this.root
  }

  onTable(open) {
    const isArray = open.k === 'aotOpen'
    let path = []
    let key = null
    let span = [open.s, open.e]
    for (let ev = this.next(); ev; ev = this.next()) {
      if (ev.k === 'stdClose' || ev.k === 'aotClose') {
        span = [open.s, ev.e]
        break
      }
      if (ev.k === 'key') ({ path, key } = this.onKey(ev))
    }
    return { path, key, span, isArray }
  }

  captureKeyValue(path, key, value) {
    const dotted = path.length > 0
    const parent = this.descend(this.current, path, dotted)
    if (dotted && !parent.implicit) failBare('duplicate key', key.span[0], key.span[1])
    if (parent.index.has(key.name)) failBare('duplicate key', key.span[0], key.span[1])
    tableInsert(parent, key, value)
  }

  finishTable() {
    const previous = this.current
    this.current = newTable([0, 0])
    const header = this.header
    this.header = null
    if (!header) {
      this.root = previous
      return
    }
    if (!header.key) return
    previous.span = header.span
    const parent = this.descend(this.root, header.path, false)
    const key = header.key
    if (header.isArray) {
      let entry = tableGet(parent, key.name)
      if (entry === undefined) {
        entry = { type: 'array', items: [], aot: true, span: header.span }
        tableInsert(parent, key, entry)
      }
      if (entry.type !== 'array' || !entry.aot) failBare('duplicate key', key.span[0], key.span[1])
      entry.items.push(previous)
    } else {
      tableInsert(parent, key, previous)
    }
  }

  startTable(header) {
    if (!header.isArray && header.key) {
      const parent = this.descend(this.root, header.path, false)
      const old = tableRemove(parent, header.key.name)
      if (old) {
        if (old.node.type === 'table' && old.node.implicit && !old.node.dotted) this.current = old.node
        else failBare('duplicate key', header.key.span[0], header.key.span[1])
      }
    }
    this.current.implicit = false
    this.current.dotted = false
    this.header = header
  }
}

function parseDocument(text) {
  const parser = new EventParser(text, lex(text))
  parser.document()
  parser.eof()
  return new DocumentBuilder(text, parser.events).build()
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// The toml crate's translate_position on the UTF-8 bytes: the column counts characters up to and including
// the byte at the error start, or is a byte offset when that byte begins a multi-byte character.
function translatePosition(text, index) {
  const input = Buffer.from(text, 'utf8')
  const at = index <= text.length ? Buffer.byteLength(text.slice(0, index)) : input.length + index - text.length
  if (input.length === 0) return [0, at]
  const safe = Math.min(at, input.length - 1)
  const offset = at - safe
  const lineStart = safe === 0 ? 0 : input.lastIndexOf(0x0a, safe - 1) + 1
  let line = 0
  for (let i = 0; i < lineStart; i++) if (input[i] === 0x0a) line++
  const lineBytes = input.subarray(lineStart, safe + 1)
  const column = isUtf8(lineBytes) ? [...strictUtf8.decode(lineBytes)].length - 1 : safe - lineStart
  return [line, column + offset]
}

function renderTomlError(text, message, span) {
  if (!span) return `${message}\n`
  const [line, column] = translatePosition(text, span[0])
  const lineNum = line + 1
  const gutter = ' '.repeat(String(lineNum).length + 1)
  const content = text.split('\n')[line]
  const highlight = Math.min(Buffer.byteLength(text.slice(span[0], span[1])), Math.max(0, Buffer.byteLength(content) - column))
  return `TOML parse error at line ${lineNum}, column ${column + 1}\n` +
    `${gutter}|\n` +
    `${lineNum} | ${content}\n` +
    `${gutter}|${' '.repeat(column + 1)}^${'^'.repeat(Math.max(0, highlight - 1))}\n` +
    `${message}\n`
}

export function parseToml(text, schema) {
  try {
    return decode(schema, parseDocument(text), 'toml')
  } catch (e) {
    if (e instanceof ParseError || e instanceof DecodeError) throw new FormatError(renderTomlError(text, e.message, e.span))
    throw e
  }
}

// ---------------------------------------------------------------------------------------------
// Writing

function stringMetrics(s) {
  const m = { maxSingle: 0, maxDouble: 0, escapeCodes: false, escape: false, newline: false }
  let single = 0
  let double = 0
  for (const byte of Buffer.from(s, 'utf8')) {
    single = byte === 0x27 ? single + 1 : 0
    double = byte === 0x22 ? double + 1 : 0
    m.maxSingle = Math.max(m.maxSingle, single)
    m.maxDouble = Math.max(m.maxDouble, double)
    if (byte === 0x5c) m.escape = true
    else if (byte === 0x0a) m.newline = true
    else if (byte !== 0x09 && (byte <= 0x1f || byte === 0x7f)) m.escapeCodes = true
  }
  return m
}

function escapeBasic(s, multiline) {
  let out = ''
  let quotes = 0
  for (const ch of s) {
    const code = ch.codePointAt(0)
    if (ch === '"') {
      quotes++
      out += multiline && quotes <= 2 ? '"' : '\\"'
      if (!(multiline && quotes <= 2)) quotes = 0
      continue
    }
    quotes = 0
    if (ch === '\b') out += '\\b'
    else if (ch === '\t') out += '\\t'
    else if (ch === '\n') out += multiline ? '\n' : '\\n'
    else if (ch === '\f') out += '\\f'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\\') out += '\\\\'
    else if (code <= 0x1f || code === 0x7f) out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`
    else out += ch
  }
  return out
}

function prettyString(s) {
  const m = stringMetrics(s)
  if (!m.escapeCodes && !m.escape && m.maxDouble === 0 && !m.newline) return `"${escapeBasic(s, false)}"`
  if (!m.escapeCodes && m.maxSingle === 0 && !m.newline) return `'${s}'`
  const nl = m.newline ? '\n' : ''
  if (!m.escapeCodes && !m.escape && m.maxDouble <= 2) return `"""${nl}${escapeBasic(s, true)}"""`
  if (!m.escapeCodes && m.maxSingle <= 2) return `'''${nl}${s}'''`
  return m.newline ? `"""${nl}${escapeBasic(s, true)}"""` : `"${escapeBasic(s, false)}"`
}

function prettyKey(k) {
  if (/^[A-Za-z0-9_-]+$/.test(k)) return k
  const m = stringMetrics(k)
  const singleQuotes = k.includes("'")
  const doubleQuotes = k.includes('"')
  const codes = m.escapeCodes || k.includes('\n')
  if (!codes && !m.escape && !doubleQuotes) return `"${escapeBasic(k, false)}"`
  if (!codes && !singleQuotes) return `'${k}'`
  return `"${escapeBasic(k, false)}"`
}

function basicKey(k) {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : `"${escapeBasic(k, false)}"`
}

function unwrap(schema) {
  return schema.kind === 'option' ? schema.inner : schema
}

function isTableLike(schema) {
  const s = unwrap(schema)
  return s.kind === 'struct' || s.kind === 'map'
}

function floatText(value, single) {
  if (Number.isNaN(value)) return Object.is(Math.sign(value), -1) ? '-nan' : 'nan'
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf'
  return decimalFloat(value, single)
}

function writer(pretty) {
  const str = pretty ? prettyString : (s) => `"${escapeBasic(s, false)}"`
  const keyText = pretty ? prettyKey : basicKey

  function valueText(schema, value) {
    if (schema.kind === 'option') {
      if (value === null || value === undefined) throw new FormatError('unsupported None value')
      return valueText(schema.inner, value)
    }
    switch (schema.kind) {
      case 'bool':
        return String(value)
      case 'string':
        return str(value)
      case 'f32':
        return floatText(value, true)
      case 'f64':
        return floatText(value, false)
      case 'vec': {
        const items = value.map((item) => valueText(schema.item, item))
        if (!pretty) return `[${items.join(', ')}]`
        if (items.length === 0) return '[]'
        if (items.length === 1) return `[${items[0]}]`
        return `[\n${items.map((item) => `    ${item},\n`).join('')}]`
      }
      case 'map':
      case 'struct': {
        const parts = []
        for (const [key, field, fieldValue] of entriesOf(schema, value)) {
          if (field.kind === 'option' && (fieldValue === null || fieldValue === undefined)) continue
          parts.push(`${keyText(key)} = ${valueText(field, fieldValue)}`)
        }
        return parts.length ? `{ ${parts.join(', ')} }` : '{}'
      }
      default:
        return String(value)
    }
  }

  return function serialize(value, schema) {
    const reason = mismatch(schema, value)
    if (reason) throw new FormatError(reason)
    if (!isTableLike(schema)) throw new FormatError('unsupported rust type')
    // `blank`: basic-toml puts a blank line before a header only when the parent table already wrote a field
    // (or, in an array of tables, before every element after the first).
    const tables = []
    const walk = (keys, tableSchema, tableValue, array, blank) => {
      const entry = { keys, array, blank, body: '', hasChildren: false }
      tables.push(entry)
      let sawTable = false
      let wroteField = false
      for (const [key, field, fieldValue] of entriesOf(unwrap(tableSchema), tableValue)) {
        if (field.kind === 'option' && (fieldValue === null || fieldValue === undefined)) continue
        const inner = unwrap(field)
        if (isTableLike(inner)) {
          entry.hasChildren = true
          sawTable = true
          walk([...keys, keyText(key)], inner, fieldValue, false, wroteField)
        } else if (inner.kind === 'vec' && isTableLike(inner.item) && fieldValue.length > 0 &&
                   fieldValue.every((item) => item !== null && item !== undefined)) {
          entry.hasChildren = true
          sawTable = true
          fieldValue.forEach((item, i) => walk([...keys, keyText(key)], unwrap(inner.item), item, true, i > 0 || wroteField))
        } else {
          if (!pretty && sawTable) throw new FormatError('values must be emitted before tables')
          entry.body += `${keyText(key)} = ${valueText(inner, fieldValue)}\n`
        }
        wroteField = true
      }
    }
    walk([], schema, value, false, false)
    const parts = []
    for (const entry of tables) {
      if (entry.keys.length === 0) {
        if (entry.body) parts.push(entry.body)
        continue
      }
      if (!(entry.array || entry.body || !entry.hasChildren)) continue
      const header = entry.array ? `[[${entry.keys.join('.')}]]` : `[${entry.keys.join('.')}]`
      parts.push(pretty ? `${header}\n${entry.body}` : `${entry.blank ? '\n' : ''}${header}\n${entry.body}`)
    }
    return parts.join(pretty ? '\n' : '')
  }
}

export const serializeToml = writer(true)
export const serializeBasicToml = writer(false)
