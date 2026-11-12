// Reading for confy/ron: a port of ron 0.12's Parser (parse.rs) and Deserializer (de/mod.rs, de/id.rs),
// driven by serde's derive rules for the schema, so values, error texts and spans match the crate.
// Spans are reported like `ron::error::SpannedError`: `line:col` of the cursor before the last advance and
// of the current cursor, counted in characters.

import { isUtf8 } from 'node:buffer'

import { FormatError } from '../errors.js'
import { integerValue, sortedKeys } from '../schema.js'
import { rustDebugChar, rustDebugString } from '../debug.js'
import { isXidContinue, isXidStart } from './xid.js'

class RonError {
  constructor(message, kind = null, extra = {}) {
    this.message = message
    this.kind = kind
    Object.assign(this, extra)
  }
}

const isIdentFirstChar = (c) => c === '_' || isXidStart(c)
const isIdentRawChar = (c) => c === '.' || c === '+' || c === '-' || isXidContinue(c)
const isIntChar = (c) => /^[0-9A-Fa-f_]$/.test(c)
const isFloatChar = (c) => /^[0-9eE.+\-_]$/.test(c)
const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\x0B', '\x0C', '\u0085', '\u200E', '\u200F', '\u2028', '\u2029'])
const isWhitespace = (c) => WHITESPACE.has(c)

function identifierText(name) {
  const chars = [...name]
  if (chars.length === 0 || !chars.every(isIdentRawChar)) return `${rustDebugString(name)}_[invalid identifier]`
  if (!isIdentFirstChar(chars[0]) || !chars.slice(1).every(isXidContinue)) return `\`r#${name}\``
  return `\`${name}\``
}

const E = {
  eof: () => new RonError('Unexpected end of RON', 'Eof'),
  expectedArray: () => new RonError('Expected opening `[`'),
  expectedArrayEnd: () => new RonError('Expected closing `]`'),
  expectedAttribute: () => new RonError('Expected an `#![enable(...)]` attribute'),
  expectedAttributeEnd: () => new RonError('Expected closing `)]` after the enable attribute'),
  expectedBoolean: () => new RonError('Expected boolean'),
  expectedComma: () => new RonError('Expected comma'),
  expectedChar: () => new RonError('Expected char'),
  expectedByteLiteral: () => new RonError('Expected byte literal'),
  expectedFloat: () => new RonError('Expected float'),
  floatUnderscore: () => new RonError('Unexpected underscore in float'),
  expectedInteger: () => new RonError('Expected integer'),
  expectedOption: () => new RonError('Expected option'),
  expectedClosingParen: () => new RonError('Expected closing `)`'),
  expectedMap: () => new RonError('Expected opening `{`'),
  expectedMapColon: () => new RonError('Expected colon'),
  expectedMapEnd: () => new RonError('Expected closing `}`'),
  expectedStructLike: () => new RonError('Expected opening `(`', 'ExpectedStructLike'),
  expectedNamedStructLike: (name) => new RonError(name === ''
    ? 'Expected only opening `(`, no name, for un-nameable struct'
    : `Expected opening \`(\` for struct ${identifierText(name)}`),
  expectedDifferentStructName: (expected, found) =>
    new RonError(`Expected struct ${identifierText(expected)} but found ${identifierText(found)}`),
  expectedString: () => new RonError('Expected string', 'ExpectedString'),
  expectedByteString: () => new RonError('Expected byte string'),
  expectedStringEnd: () => new RonError('Expected end of string', 'ExpectedStringEnd'),
  expectedIdentifier: () => new RonError('Expected identifier'),
  exceededRecursionLimit: () => new RonError(
    'Exceeded recursion limit, try increasing `ron::Options::recursion_limit` and using `serde_stacker` to protect against a stack overflow'),
  invalidEscape: (text) => new RonError(text),
  integerOutOfBounds: () => new RonError('Integer is out of bounds'),
  invalidIntegerDigit: (digit, base) =>
    new RonError(`Invalid digit ${rustDebugChar(digit)} for base ${base} integers`, 'InvalidIntegerDigit'),
  noSuchExtension: (name) => new RonError(`No RON extension named ${identifierText(name)}`),
  unclosedBlockComment: () => new RonError('Unclosed block comment'),
  underscoreAtBeginning: () => new RonError('Unexpected leading underscore in a number', 'UnderscoreAtBeginning'),
  unexpectedChar: (c) => new RonError(`Unexpected char ${rustDebugChar(c)}`),
  trailingCharacters: () => new RonError('Non-whitespace trailing characters'),
  invalidValueForType: (expected, found) => new RonError(`Expected ${expected} but found ${found} instead`),
  missingStructField: (field) => new RonError(null, 'MissingStructField', { field, outer: null }),
  duplicateStructField: (field) => new RonError(null, 'DuplicateStructField', { field, outer: null }),
  suggestRawIdentifier: (ident) => new RonError(
    `Found invalid std identifier ${rustDebugString(ident)}, try the raw identifier \`r#${ident}\` instead`,
    'SuggestRawIdentifier', { ident }),
  expectedStructName: (name) =>
    new RonError(`Expected the explicit struct name ${identifierText(name)}, but none was found`),
}

function codeText(err) {
  if (err.kind === 'MissingStructField' || err.kind === 'DuplicateStructField') {
    const what = err.kind === 'MissingStructField' ? 'missing' : 'duplicate'
    return `Unexpected ${what} field named ${identifierText(err.field)}${err.outer ? ` in ${identifierText(err.outer)}` : ''}`
  }
  return err.message
}

function structErrorName(err, name) {
  if (err instanceof RonError && (err.kind === 'MissingStructField' || err.kind === 'DuplicateStructField') && err.outer === null) {
    err.outer = name
  }
  return err
}

const INT_RANGES = {
  i8: [-(2n ** 7n), 2n ** 7n - 1n], i16: [-(2n ** 15n), 2n ** 15n - 1n], i32: [-(2n ** 31n), 2n ** 31n - 1n],
  i64: [-(2n ** 63n), 2n ** 63n - 1n], u8: [0n, 2n ** 8n - 1n], u16: [0n, 2n ** 16n - 1n],
  u32: [0n, 2n ** 32n - 1n], u64: [0n, 2n ** 64n - 1n],
}
const SUFFIXES = ['i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64']

function integerExpected(kind) {
  return `an ${kind.slice(1)}-bit ${kind[0] === 'u' ? 'un' : ''}signed integer`
}

// Rust's `str::parse::<f64>` grammar for the characters ron collects.
function rustFloat(text) {
  if (!/^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(text) &&
      !/^[+-]?(inf|NaN)$/.test(text)) return null
  const body = text.replace(/^\+/, '')
  if (/inf$/.test(body)) return body.startsWith('-') ? -Infinity : Infinity
  if (/NaN$/.test(body)) return NaN
  return Number(body)
}

class Parser {
  constructor(src) {
    this.src = src
    this.cursor = 0
    this.prev = 0
    this.exts = new Set()
  }

  rest() {
    return this.src.slice(this.cursor)
  }

  advance(n) {
    this.prev = this.cursor
    this.cursor += n
  }

  peekChar() {
    const c = this.src.codePointAt(this.cursor)
    return c === undefined ? null : String.fromCodePoint(c)
  }

  peekCharOrEof() {
    const c = this.peekChar()
    if (c === null) throw E.eof()
    return c
  }

  nextChar() {
    const c = this.peekCharOrEof()
    this.cursor += c.length
    return c
  }

  skipNextChar() {
    if (this.peekChar() !== null) this.nextChar()
  }

  checkChar(c) {
    return this.src.startsWith(c, this.cursor)
  }

  checkStr(s) {
    return this.src.startsWith(s, this.cursor)
  }

  consumeStr(s) {
    if (!this.checkStr(s)) return false
    this.advance(s.length)
    return true
  }

  consumeChar(c) {
    return this.consumeStr(c)
  }

  expectChar(c, error) {
    if (!this.consumeChar(c)) throw error
  }

  whileFromLen(from, cond) {
    let i = this.cursor + from
    while (i < this.src.length) {
      const c = String.fromCodePoint(this.src.codePointAt(i))
      if (!cond(c)) break
      i += c.length
    }
    return i - this.cursor - from
  }

  whileLen(cond) {
    return this.whileFromLen(0, cond)
  }

  checkIdentOtherChar(index) {
    const c = this.src.codePointAt(this.cursor + index)
    return c !== undefined && isXidContinue(String.fromCodePoint(c))
  }

  checkIdent(ident) {
    return this.checkStr(ident) && !this.checkIdentOtherChar(ident.length)
  }

  consumeIdent(ident) {
    if (!this.checkIdent(ident)) return false
    this.advance(ident.length)
    return true
  }

  isNumberStart(c) {
    return /^[0-9+\-.b]$/.test(c) && (c !== 'b' || this.checkStr("b'"))
  }

  skipWs() {
    if (this.cursor >= this.src.length) return
    for (;;) {
      this.advance(this.whileLen(isWhitespace))
      const comment = this.skipComment()
      if (comment === null) break
      if (comment === 'unclosed') return
    }
  }

  skipComment() {
    if (!this.consumeChar('/')) return null
    const c = this.nextChar()
    if (c === '/') {
      this.advance(this.whileLen((ch) => ch !== '\n'))
      return this.cursor >= this.src.length ? 'unclosed' : 'closed'
    }
    if (c === '*') {
      let level = 1
      while (level > 0) {
        const bytes = this.whileLen((ch) => ch !== '/' && ch !== '*')
        if (this.cursor >= this.src.length) throw E.unclosedBlockComment()
        this.advance(bytes)
        if (this.consumeStr('/*')) level++
        else if (this.consumeStr('*/')) level--
        else if (this.peekChar() === null) throw E.unclosedBlockComment()
        else this.nextChar()
      }
      return 'block'
    }
    throw E.unexpectedChar(c)
  }

  comma() {
    this.skipWs()
    if (!this.consumeChar(',')) return false
    this.skipWs()
    return true
  }

  consumeAll(parts) {
    let all = true
    for (const part of parts) {
      if (this.consumeStr(part)) this.skipWs()
      else all = false
    }
    return all
  }

  attribute() {
    if (!this.checkChar('#')) return null
    if (!this.consumeAll(['#', '!', '['])) throw E.expectedAttribute()
    this.skipWs()
    if (this.consumeIdent('enable')) {
      this.skipWs()
      if (!this.consumeStr('(')) throw E.expectedAttribute()
      this.skipWs()
      const extensions = this.extensionList()
      this.skipWs()
      if (this.consumeAll([')', ']'])) return extensions
      throw E.expectedAttributeEnd()
    }
    if (this.consumeIdent('type') || this.consumeIdent('schema')) {
      this.skipWs()
      if (!this.consumeStr('=')) throw E.expectedAttribute()
      this.skipWs()
      this.string()
      this.skipWs()
      if (this.consumeStr(']')) return []
      throw E.expectedAttributeEnd()
    }
    throw E.expectedAttribute()
  }

  extensionList() {
    const names = ['unwrap_newtypes', 'implicit_some', 'unwrap_variant_newtypes', 'explicit_struct_names']
    const out = []
    for (;;) {
      const ident = this.identifier()
      if (!names.includes(ident)) throw E.noSuchExtension(ident)
      out.push(ident)
      const comma = this.comma()
      if (!comma && this.checkIdentOtherChar(0)) throw E.expectedComma()
      if (!comma || !this.checkIdentOtherChar(0)) break
    }
    return out
  }

  skipIdentifier() {
    for (const prefix of ['b"', "b'", 'br#', 'br"', 'r"', 'r#"', 'r##']) if (this.checkStr(prefix)) return null
    if (this.checkStr('r#')) {
      const len = this.whileFromLen(2, isIdentRawChar)
      if (len > 0) {
        const ident = this.src.slice(this.cursor + 2, this.cursor + 2 + len)
        this.advance(2 + len)
        return ident
      }
      return null
    }
    const c = this.peekChar()
    if (c !== null && isIdentFirstChar(c)) {
      const len = c.length + this.whileFromLen(c.length, isXidContinue)
      const ident = this.src.slice(this.cursor, this.cursor + len)
      this.advance(len)
      return ident
    }
    return null
  }

  identifier() {
    const first = this.peekCharOrEof()
    if (!isIdentFirstChar(first)) {
      if (isIdentRawChar(first)) throw E.suggestRawIdentifier(this.rest().slice(0, this.whileLen(isIdentRawChar)))
      throw E.expectedIdentifier()
    }
    for (const prefix of ['b"', "b'", 'br#', 'br"', 'r"', 'r#"', 'r##']) if (this.checkStr(prefix)) throw E.expectedIdentifier()
    let length
    if (this.checkStr('r#')) {
      const backup = this.cursor
      this.advance(2)
      const c = this.peekChar()
      if (c === null || !isIdentRawChar(c)) {
        this.cursor = backup
        throw E.expectedIdentifier()
      }
      length = this.whileLen(isIdentRawChar)
    } else {
      const std = first === 'r' ? this.whileLen(isXidContinue) : first.length + this.whileFromLen(first.length, isXidContinue)
      const raw = this.whileLen(isIdentRawChar)
      if (raw > std) throw E.suggestRawIdentifier(this.rest().slice(0, raw))
      length = std
    }
    const ident = this.rest().slice(0, length)
    this.advance(length)
    return ident
  }

  consumeStructName(name) {
    if (this.checkIdent('')) {
      if (this.exts.has('explicit_struct_names')) throw E.expectedStructName(name)
      return false
    }
    let found
    try {
      found = this.identifier()
    } catch (e) {
      if (e instanceof RonError && e.kind === 'SuggestRawIdentifier' && e.ident === name) throw e
      if (e instanceof RonError) throw E.expectedNamedStructLike(name)
      throw e
    }
    if (name === '') throw E.expectedNamedStructLike(name)
    if (found !== name) throw E.expectedDifferentStructName(name, found)
    return true
  }

  bool() {
    if (this.consumeIdent('true')) return true
    if (this.consumeIdent('false')) return false
    throw E.expectedBoolean()
  }

  decodeHex(c) {
    if (!/^[0-9a-fA-F]$/.test(c)) throw E.invalidEscape('Non-hex digit found')
    return parseInt(c, 16)
  }

  // Returns [value, bounds-kind] for integer kind `kind` (i8..u64) or for ron's ParsedInteger ('any').
  parseIntegerDigits(s, base, sign, kind) {
    const [lo, hi] = INT_RANGES[kind]
    let acc = 0n
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (c === '_') continue
      if (acc * BigInt(base) < lo || acc * BigInt(base) > hi) {
        this.advance(s.length)
        throw E.integerOutOfBounds()
      }
      acc *= BigInt(base)
      const digit = this.decodeHex(c)
      if (digit >= base) {
        this.advance(i)
        throw E.invalidIntegerDigit(c, base)
      }
      const next = sign > 0 ? acc + BigInt(digit) : acc - BigInt(digit)
      if (next < lo || next > hi) {
        this.advance(s.length)
        throw E.integerOutOfBounds()
      }
      acc = next
    }
    this.advance(s.length)
    return acc
  }

  parseIntegerAs(sign, base, kind) {
    const num = this.whileLen(isIntChar)
    if (num === 0) throw E.expectedInteger()
    if (this.checkChar('_')) throw E.underscoreAtBeginning()
    return this.parseIntegerDigits(this.rest().slice(0, num), base, sign, kind)
  }

  // ParsedInteger::parse: i64 for negative numbers, u64 otherwise.
  parseIntegerAny(sign, base) {
    return this.parseIntegerAs(sign, base, sign < 0 ? 'i64' : 'u64')
  }

  // `kind` is the requested integer type, or 'any' for ron's ParsedInteger.
  integer(kind) {
    const backup = this.rest()
    const parseAs = (sign, base) => (kind === 'any' ? this.parseIntegerAny(sign, base) : this.parseIntegerAs(sign, base, kind))
    let negative = false
    const first = this.peekCharOrEof()
    if (first === '+') this.skipNextChar()
    else if (first === '-') {
      this.skipNextChar()
      negative = true
    } else if (first === 'b' && this.consumeStr("b'")) {
      let byte
      const c = this.nextChar()
      if (c === '\\') {
        const escaped = this.parseEscape('binary', true)
        if (typeof escaped !== 'number') throw E.invalidEscape('Unexpected Unicode escape in byte literal')
        byte = escaped
      } else if (c.codePointAt(0) < 0x80) byte = c.codePointAt(0)
      else throw E.expectedByteLiteral()
      if (!this.consumeChar("'")) throw E.expectedByteLiteral()
      const ron = backup.slice(0, backup.length - this.rest().length)
      if (kind !== 'any' && kind !== 'u8') throw E.invalidValueForType(integerExpected(kind), ron)
      return BigInt(byte)
    }
    const sign = negative ? -1 : 1
    let base = 10
    if (this.consumeStr('0b')) base = 2
    else if (this.consumeStr('0o')) base = 8
    else if (this.consumeStr('0x')) base = 16

    const num = this.whileLen(isIntChar)
    const after = this.rest().slice(num)
    if (after.startsWith('i') || after.startsWith('u')) {
      const intCursor = this.cursor
      this.advance(num)
      const suffix = SUFFIXES.find((s) => this.consumeIdent(s))
      if (suffix) {
        const suffixRest = this.rest()
        this.cursor = intCursor
        let result
        try {
          result = this.parseIntegerAs(sign, base, suffix)
        } catch (e) {
          // ron skips the suffix before reporting every integer error except these two.
          if (e instanceof RonError && e.kind !== 'UnderscoreAtBeginning' && e.kind !== 'InvalidIntegerDigit') this.skipIdentifier()
          throw e
        }
        this.skipIdentifier()
        const ron = backup.slice(0, backup.length - suffixRest.length)
        if (kind !== 'any' && suffix !== kind) throw E.invalidValueForType(integerExpected(kind), ron)
        return result
      }
      this.cursor = intCursor
    }
    return parseAs(sign, base)
  }

  nextBytesIsFloat() {
    const c = this.peekChar()
    if (c === null) return false
    const skip = c === '+' || c === '-' ? 1 : 0
    const raw = this.whileFromLen(skip, isFloatChar)
    const dots = this.rest().slice(skip).indexOf('..')
    const validFloat = dots === -1 ? raw : Math.min(dots, raw)
    const validInt = this.whileFromLen(skip, isIntChar)
    return validFloat > validInt
  }

  // `kind` is 'f32', 'f64' or 'any' (ron's ParsedFloat); returns a Number.
  float(kind) {
    const parse = (text) => {
      const v = rustFloat(text)
      if (v === null) throw E.expectedFloat()
      return kind === 'f32' ? Math.fround(v) : v
    }
    const fromParsed = (bits, value, ron) => {
      if (kind !== 'any' && kind !== `f${bits}`) {
        throw E.invalidValueForType(`a ${kind.slice(1)}-bit floating point number`, ron)
      }
      return value
    }
    for (const literal of ['inf', '+inf', '-inf', 'NaN', '+NaN', '-NaN']) {
      if (this.consumeIdent(literal)) return parse(literal)
      if (this.checkStr(literal)) {
        const rest = this.rest().slice(literal.length)
        for (const bits of [32, 64]) {
          const suffix = `f${bits}`
          if (rest.startsWith(suffix)) {
            const post = rest.codePointAt(suffix.length)
            if (post === undefined || !isXidContinue(String.fromCodePoint(post))) {
              const ron = this.rest().slice(0, literal.length + suffix.length)
              this.advance(literal.length + suffix.length)
              return fromParsed(bits, rustFloat(literal), ron)
            }
          }
        }
      }
    }
    const raw = this.whileLen(isFloatChar)
    const dots = this.rest().slice(0, raw).indexOf('..')
    const num = dots === -1 ? raw : dots
    if (num === 0) throw E.expectedFloat()
    if (this.checkChar('_')) throw E.underscoreAtBeginning()
    let f = ''
    let allowUnderscore = false
    const text = this.rest().slice(0, num)
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (c === '_') {
        if (allowUnderscore) continue
        this.advance(i)
        throw E.floatUnderscore()
      }
      if (/[0-9eE]/.test(c)) allowUnderscore = true
      else if (c === '.') allowUnderscore = false
      f += c
    }
    if (this.rest().slice(num).startsWith('f')) {
      const backupCursor = this.cursor
      this.advance(num)
      for (const bits of [32, 64]) {
        if (this.consumeIdent(`f${bits}`)) {
          const v = rustFloat(f)
          if (v === null) {
            this.cursor = backupCursor
            throw E.expectedFloat()
          }
          return fromParsed(bits, bits === 32 ? Math.fround(v) : v, this.src.slice(backupCursor, this.cursor))
        }
      }
      this.cursor = backupCursor
    }
    const value = parse(f)
    this.advance(num)
    return value
  }

  anyNumber() {
    for (const ident of ['inf', 'inff32', 'inff64', 'NaN', 'NaNf32', 'NaNf64']) {
      if (this.consumeIdent(ident)) return
    }
    if (this.nextBytesIsFloat()) {
      this.float('any')
      return
    }
    const backup = this.cursor
    let integerError
    let integerCursor
    try {
      this.integer('any')
      return
    } catch (e) {
      if (!(e instanceof RonError)) throw e
      integerError = e
      integerCursor = this.cursor
    }
    this.cursor = backup
    try {
      this.float('any')
    } catch (e) {
      if (!(e instanceof RonError)) throw e
      // ron reports the integer error when neither form parses.
      this.cursor = integerCursor
      throw integerError
    }
    if (this.cursor >= integerCursor) return
    this.cursor = integerCursor
    throw integerError
  }

  decodeAsciiEscape() {
    let n = 0
    for (let k = 0; k < 2; k++) n = (n << 4) | this.decodeHex(this.nextChar())
    return n
  }

  // Returns a number (a byte) for binary escapes, otherwise a string (one character).
  parseEscape(encoding, isChar) {
    const c = this.nextChar()
    const simple = { "'": "'", '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t', 0: '\0' }
    if (c in simple) return encoding === 'binary' ? simple[c].charCodeAt(0) : simple[c]
    if (c === 'x') {
      const b = this.decodeAsciiEscape()
      if (encoding === 'binary') return b
      if (b < 0x80) return String.fromCharCode(b)
      const notValid = () => E.invalidEscape('Not a valid byte-escaped Unicode character')
      if (isChar) throw notValid()
      const bytes = [b]
      for (let i = 1; i < 4; i++) {
        if (!this.consumeStr('\\x')) throw notValid()
        bytes.push(this.decodeAsciiEscape())
        const sequence = Uint8Array.from(bytes)
        if (isUtf8(sequence)) {
          const text = new TextDecoder('utf-8').decode(sequence)
          if (text.length) return String.fromCodePoint(text.codePointAt(0))
        }
      }
      throw notValid()
    }
    if (c === 'u') {
      this.expectChar('{', E.invalidEscape('Missing { in Unicode escape'))
      let value = 0
      let digits = 0
      while (digits < 6) {
        const d = this.peekCharOrEof()
        if (d === '}') break
        this.skipNextChar()
        digits++
        value = value * 16 + this.decodeHex(d)
      }
      if (digits === 0) throw E.invalidEscape('Expected 1-6 digits, got 0 digits in Unicode escape')
      this.expectChar('}', E.invalidEscape('No } at the end of Unicode escape'))
      if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) throw E.invalidEscape('Not a valid Unicode-escaped character')
      const ch = String.fromCodePoint(value)
      return encoding === 'binary' ? ch : ch
    }
    throw E.invalidEscape('Unknown escape character')
  }

  escapedString(encoding) {
    let rest = this.rest()
    let end = rest.indexOf('"')
    if (end === -1) throw E.expectedStringEnd()
    let escape = rest.slice(0, end).indexOf('\\')
    if (escape === -1) {
      const value = rest.slice(0, end)
      this.advance(end + 1)
      return value
    }
    let out = rest.slice(0, escape)
    let i = escape
    for (;;) {
      this.advance(i + 1)
      const ch = this.parseEscape(encoding, false)
      out += typeof ch === 'number' ? String.fromCharCode(ch) : ch
      rest = this.rest()
      end = rest.indexOf('"')
      if (end === -1) throw E.expectedStringEnd()
      escape = rest.slice(0, end).indexOf('\\')
      if (escape !== -1) {
        out += rest.slice(0, escape)
        i = escape
      } else {
        out += rest.slice(0, end)
        this.advance(end + 1)
        return out
      }
    }
  }

  rawString() {
    const hashes = this.whileLen((c) => c === '#')
    this.advance(hashes)
    this.expectChar('"', E.expectedString())
    const ending = `"${'#'.repeat(hashes)}`
    const i = this.rest().indexOf(ending)
    if (i === -1) throw E.expectedStringEnd()
    const value = this.rest().slice(0, i)
    this.advance(i + hashes + 1)
    return value
  }

  string() {
    if (this.consumeChar('"')) return this.escapedString('utf8')
    if (this.consumeChar('r')) return this.rawString()
    throw E.expectedString()
  }

  byteStringNoBase64() {
    if (this.consumeStr('b"')) return this.escapedString('binary')
    if (this.consumeStr('br')) {
      try {
        return this.rawString()
      } catch (e) {
        if (e instanceof RonError && e.kind === 'ExpectedString') throw E.expectedByteString()
        throw e
      }
    }
    throw E.expectedByteString()
  }

  char() {
    this.expectChar("'", E.expectedChar())
    const c = this.nextChar()
    if (c === '\\') this.parseEscape('utf8', true)
    this.expectChar("'", E.expectedChar())
  }

  // check_struct_type with NewtypeMode::NoParensMeanUnit and TupleMode::ImpreciseTupleOrNewtype.
  checkStructType() {
    const backup = this.cursor
    const inner = () => {
      if (!this.consumeChar('(')) return 'Unit'
      this.skipWs()
      if (this.checkChar(')')) return 'EmptyTuple'
      if (this.skipIdentifier() !== null) {
        this.skipWs()
        const c = this.peekChar()
        if (c === ':') return 'Named'
        if (c === ',') {
          this.skipNextChar()
          this.skipWs()
          return this.checkChar(')') ? 'NewtypeTuple' : 'NonNewtypeTuple'
        }
        if (c === ')') return 'NewtypeTuple'
      }
      return 'AnyTuple'
    }
    const result = inner()
    this.cursor = backup
    return result
  }
}

class Deserializer {
  constructor(text) {
    this.p = new Parser(text)
    this.newtypeVariant = false
    this.recursionLimit = 128
  }

  // ron's guard_recursion!: `Options::default()` allows 128 nested levels.
  guard(read) {
    if (this.recursionLimit === 0) throw E.exceededRecursionLimit()
    this.recursionLimit--
    try {
      return read()
    } finally {
      this.recursionLimit++
    }
  }

  start() {
    const p = this.p
    p.skipWs()
    for (let ext = p.attribute(); ext !== null; ext = p.attribute()) {
      for (const name of ext) p.exts.add(name)
      p.skipWs()
    }
  }

  end() {
    this.p.skipWs()
    if (this.p.cursor < this.p.src.length) throw E.trailingCharacters()
  }

  // CommaSeparated::has_element
  hasElement(state, terminator) {
    this.p.skipWs()
    const more = !this.p.checkChar(terminator)
    if (state.hadComma) return more
    if (!more) return false
    throw E.expectedComma()
  }

  nextValue(state, read) {
    this.p.skipWs()
    if (!this.p.consumeChar(':')) throw E.expectedMapColon()
    this.p.skipWs()
    const value = this.guard(read)
    state.hadComma = this.p.comma()
    return value
  }

  deserialize(schema) {
    const p = this.p
    switch (schema.kind) {
      case 'option':
        return this.option(() => this.deserialize(schema.inner))
      case 'bool':
        return p.bool()
      case 'string':
        return p.string()
      case 'f32':
      case 'f64':
        return p.float(schema.kind)
      case 'vec':
        return this.seq(() => this.deserialize(schema.item))
      case 'map':
        return this.map(() => p.string(), () => this.deserialize(schema.value), true)
      case 'struct':
        return this.struct(schema)
      default: {
        const kind = schema.kind === 'usize' ? 'u64' : schema.kind === 'isize' ? 'i64' : schema.kind
        return integerValue(p.integer(kind))
      }
    }
  }

  option(inner) {
    const p = this.p
    if (p.consumeIdent('None')) return null
    if (p.consumeIdent('Some') && (p.skipWs(), p.consumeChar('('))) {
      p.skipWs()
      this.newtypeVariant = p.exts.has('unwrap_variant_newtypes')
      const value = this.guard(inner)
      this.newtypeVariant = false
      p.comma()
      if (p.consumeChar(')')) return value
      throw E.expectedClosingParen()
    }
    if (p.exts.has('implicit_some')) return this.guard(inner)
    throw E.expectedOption()
  }

  seq(element) {
    const p = this.p
    this.newtypeVariant = false
    if (!p.consumeChar('[')) throw E.expectedArray()
    const out = []
    const state = { hadComma: true }
    this.guard(() => {
      while (this.hasElement(state, ']')) {
        out.push(this.guard(element))
        state.hadComma = p.comma()
      }
    })
    p.skipWs()
    if (p.consumeChar(']')) return out
    throw E.expectedArrayEnd()
  }

  map(key, value, sorted) {
    const p = this.p
    this.newtypeVariant = false
    if (!p.consumeChar('{')) throw E.expectedMap()
    const values = new Map()
    const state = { hadComma: true }
    this.guard(() => {
      while (this.hasElement(state, '}')) {
        const k = this.guard(key)
        values.set(k, this.nextValue(state, value))
      }
    })
    p.skipWs()
    if (!p.consumeChar('}')) throw E.expectedMapEnd()
    if (!sorted) return undefined
    return Object.fromEntries(sortedKeys([...values.keys()]).map((k) => [k, values.get(k)]))
  }

  struct(schema) {
    const p = this.p
    if (!this.newtypeVariant) p.consumeStructName(schema.name)
    p.skipWs()
    return this.structAfterName(schema.name, (state) => {
      const found = new Map()
      while (this.hasElement(state, ')')) {
        const key = this.guard(() => p.identifier())
        if (!Object.hasOwn(schema.fields, key)) {
          this.nextValue(state, () => this.ignored())
          continue
        }
        if (found.has(key)) throw E.duplicateStructField(key)
        found.set(key, this.nextValue(state, () => this.deserialize(schema.fields[key])))
      }
      const out = {}
      for (const [name, field] of Object.entries(schema.fields)) {
        if (found.has(name)) out[name] = found.get(name)
        else if (field.kind === 'option') out[name] = null
        else throw E.missingStructField(name)
      }
      return out
    })
  }

  structAfterName(name, visitMap) {
    const p = this.p
    if (this.newtypeVariant || p.consumeChar('(')) {
      const oldNewtype = this.newtypeVariant
      this.newtypeVariant = false
      let value
      try {
        value = this.guard(() => visitMap({ hadComma: true }))
      } catch (e) {
        throw structErrorName(e, !oldNewtype && name !== '' ? name : null)
      }
      p.skipWs()
      if (oldNewtype || p.consumeChar(')')) return value
      throw E.expectedClosingParen()
    }
    if (name === '') throw E.expectedStructLike()
    throw E.expectedNamedStructLike(name)
  }

  tuple() {
    const p = this.p
    if (this.newtypeVariant || p.consumeChar('(')) {
      const oldNewtype = this.newtypeVariant
      this.newtypeVariant = false
      const state = { hadComma: true }
      this.guard(() => {
        while (this.hasElement(state, ')')) {
          this.guard(() => this.ignored())
          state.hadComma = p.comma()
        }
      })
      p.skipWs()
      if (oldNewtype || p.consumeChar(')')) return
      throw E.expectedClosingParen()
    }
    throw E.expectedStructLike()
  }

  floatRangeOrValue() {
    const p = this.p
    if (p.consumeStr('..=')) {
      p.anyNumber()
    } else if (p.consumeStr('..')) {
      const c = p.peekChar()
      if (c !== null && p.isNumberStart(c)) p.anyNumber()
    }
  }

  anyStruct() {
    const type = this.p.checkStructType()
    if (type === 'Unit') return
    if (type === 'Named') {
      this.structAfterName('', (state) => {
        while (this.hasElement(state, ')')) {
          this.guard(() => this.p.identifier())
          this.nextValue(state, () => this.ignored())
        }
      })
      return
    }
    this.tuple()
  }

  // deserialize_any with serde's IgnoredAny visitor.
  ignored() {
    const p = this.p
    this.newtypeVariant = false
    if (p.consumeIdent('true') || p.consumeIdent('false')) return
    if (p.checkIdent('Some')) return this.option(() => this.ignored())
    if (p.consumeIdent('None') || p.consumeStr('()')) return
    for (const ident of ['inf', 'inff32', 'inff64', 'NaN', 'NaNf32', 'NaNf64']) {
      if (p.consumeIdent(ident)) return this.floatRangeOrValue()
    }
    if (p.skipIdentifier() !== null) {
      p.skipWs()
      return this.anyStruct()
    }
    const c = p.peekCharOrEof()
    if (c === '(') return this.anyStruct()
    if (c === '[') return this.seq(() => this.ignored())
    if (c === '{') return this.map(() => this.ignored(), () => this.ignored(), false)
    if (/^[0-9+\-.b]$/.test(c)) {
      if (p.checkChar('b') && !p.checkStr("b'")) {
        p.byteStringNoBase64()
        return
      }
      if (p.checkStr('..=')) {
        p.consumeStr('..=')
        p.anyNumber()
        return
      }
      if (p.checkStr('..')) {
        const after = p.src.codePointAt(p.cursor + 2)
        if (after !== undefined && p.isNumberStart(String.fromCodePoint(after))) {
          p.consumeStr('..')
          p.anyNumber()
          return
        }
        p.consumeStr('..')
        return
      }
      p.anyNumber()
      return this.floatRangeOrValue()
    }
    if (c === '"' || c === 'r') {
      p.string()
      return
    }
    if (c === "'") {
      p.char()
      return
    }
    throw E.unexpectedChar(c)
  }
}

function position(text, index) {
  const before = text.slice(0, index)
  const lastNl = before.lastIndexOf('\n')
  const line = 1 + (before.match(/\n/g)?.length ?? 0)
  const col = 1 + [...before.slice(lastNl + 1)].length
  return `${line}:${col}`
}

export function parseRon(text, schema) {
  const de = new Deserializer(text)
  try {
    de.start()
    const value = de.deserialize(schema)
    de.end()
    return value
  } catch (e) {
    if (!(e instanceof RonError)) throw e
    const start = position(text, de.p.prev)
    const end = position(text, de.p.cursor)
    throw new FormatError(`${start === end ? start : `${start}-${end}`}: ${codeText(e)}`, { cause: e })
  }
}
