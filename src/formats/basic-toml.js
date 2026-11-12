// Reading for confy/basic-toml: a port of the basic-toml 0.1 tokenizer and deserializer (tokens.rs, de.rs),
// driven by serde's derive rules for the schema, so values and error texts match the crate exactly.
// Positions are UTF-8 byte offsets, like the crate's.

import { FormatError } from '../errors.js'
import { integerRange, integerValue, isInteger, sortedKeys } from '../schema.js'
import { rustDisplayFloat } from '../numbers.js'
import { rustDebugString } from '../debug.js'
import { expecting } from '../decode.js'

class DeError {
  constructor(at, message) {
    this.at = at
    this.message = message
    this.key = []
  }
}

const custom = (message) => new DeError(null, message)

function escapeDefault(ch) {
  const code = ch.codePointAt(0)
  const named = { '\t': '\\t', '\r': '\\r', '\n': '\\n', "'": "\\'", '"': '\\"', '\\': '\\\\' }
  if (named[ch]) return named[ch]
  if (code >= 0x20 && code <= 0x7e) return ch
  return `\\u{${code.toString(16)}}`
}

const DESCRIBE = {
  Keylike: 'an identifier', Equals: 'an equals', Period: 'a period', Comment: 'a comment', Newline: 'a newline',
  Whitespace: 'whitespace', Comma: 'a comma', RightBrace: 'a right brace', LeftBrace: 'a left brace',
  RightBracket: 'a right bracket', LeftBracket: 'a left bracket', Colon: 'a colon', Plus: 'a plus',
}

function describe(token) {
  if (token.t === 'String') return token.multiline ? 'a multiline string' : 'a string'
  return DESCRIBE[token.t]
}

const isKeylike = (ch) => /^[A-Za-z0-9_-]$/.test(ch)
const isStringChar = (ch) => ch === '\t' || (ch >= ' ' && ch !== '\x7f')

class Tokenizer {
  constructor(src, pos = 0) {
    this.src = src
    this.pos = pos
  }

  static create(src) {
    const t = new Tokenizer(src)
    t.eatc('\ufeff')
    return t
  }

  clone() {
    return new Tokenizer(this.src, this.pos)
  }

  // CrlfFold: "\r\n" reads as one '\n' at the '\r' offset.
  one() {
    const cps = this.src.cps
    if (this.pos >= cps.length) return null
    const { i, c } = cps[this.pos++]
    if (c === '\r' && this.pos < cps.length && cps[this.pos].c === '\n') {
      this.pos++
      return { i, c: '\n' }
    }
    return { i, c }
  }

  peekOne() {
    const saved = this.pos
    const r = this.one()
    this.pos = saved
    return r
  }

  eatc(ch) {
    const r = this.peekOne()
    if (r && r.c === ch) {
      this.one()
      return true
    }
    return false
  }

  current() {
    const r = this.peekOne()
    return r ? r.i : this.src.len
  }

  slice(start, end) {
    return this.src.buf.toString('utf8', start, end)
  }

  stepSpan(start) {
    return { start, end: this.current() }
  }

  next() {
    const r = this.one()
    if (!r) return null
    const { i: start, c } = r
    let token
    switch (c) {
      case '\n': token = { t: 'Newline' }; break
      case ' ':
      case '\t':
        while (this.eatc(' ') || this.eatc('\t'));
        token = { t: 'Whitespace' }
        break
      case '#': this.commentToken(); token = { t: 'Comment' }; break
      case '=': token = { t: 'Equals' }; break
      case '.': token = { t: 'Period' }; break
      case ',': token = { t: 'Comma' }; break
      case ':': token = { t: 'Colon' }; break
      case '+': token = { t: 'Plus' }; break
      case '{': token = { t: 'LeftBrace' }; break
      case '}': token = { t: 'RightBrace' }; break
      case '[': token = { t: 'LeftBracket' }; break
      case ']': token = { t: 'RightBracket' }; break
      case "'": token = this.readString("'", start, false); break
      case '"': token = this.readString('"', start, true); break
      default:
        if (!isKeylike(c)) throw new DeError(start, `unexpected character found: \`${escapeDefault(c)}\``)
        for (let p = this.peekOne(); p && isKeylike(p.c); p = this.peekOne()) this.one()
        token = { t: 'Keylike', value: this.slice(start, this.current()), off: start }
    }
    return { span: this.stepSpan(start), token }
  }

  peek() {
    return this.clone().next()
  }

  eatSpanned(type) {
    const p = this.peek()
    if (!p || p.token.t !== type) return null
    this.next()
    return p.span
  }

  eat(type) {
    return this.eatSpanned(type) !== null
  }

  expectSpanned(type) {
    const current = this.current()
    const n = this.next()
    if (!n) throw new DeError(this.src.len, `expected ${DESCRIBE[type]}, found eof`)
    if (n.token.t !== type) throw new DeError(current, `expected ${DESCRIBE[type]}, found ${describe(n.token)}`)
    return n.span
  }

  tableKey() {
    const current = this.current()
    const n = this.next()
    if (!n) throw new DeError(this.src.len, 'expected a table key, found eof')
    const { span, token } = n
    if (token.t === 'Keylike') return { span, key: token.value }
    if (token.t === 'String') {
      if (token.multiline) throw new DeError(span.start, 'multiline strings are not allowed for key')
      const nl = token.src.indexOf('\n')
      if (nl !== -1) throw new DeError(span.start + Buffer.byteLength(token.src.slice(0, nl)), 'found newline in table key')
      return { span, key: token.val }
    }
    throw new DeError(current, `expected a table key, found ${describe(token)}`)
  }

  eatWhitespace() {
    while (this.eatc(' ') || this.eatc('\t'));
  }

  eatComment() {
    if (!this.eatc('#')) return false
    this.commentToken()
    this.eatNewlineOrEof()
    return true
  }

  eatNewlineOrEof() {
    const current = this.current()
    const n = this.next()
    if (n && n.token.t !== 'Newline') throw new DeError(current, `expected newline, found ${describe(n.token)}`)
  }

  skipToNewline() {
    for (let r = this.one(); r && r.c !== '\n'; r = this.one());
  }

  commentToken() {
    for (let p = this.peekOne(); p; p = this.peekOne()) {
      if (p.c !== '\t' && p.c < ' ') break
      this.one()
    }
  }

  readString(delim, start, basic) {
    let multiline = false
    if (this.eatc(delim)) {
      if (this.eatc(delim)) multiline = true
      else return { t: 'String', src: this.slice(start, start + 2), val: '', multiline: false }
    }
    let val = ''
    let n = 0
    for (;;) {
      n++
      const r = this.one()
      if (!r) throw new DeError(start, 'unterminated string')
      const { i, c } = r
      if (c === '\n') {
        if (!multiline) throw new DeError(i, 'newline in string found')
        if (n === 1) val = ''
        else val += '\n'
      } else if (c === delim) {
        if (multiline) {
          if (!this.eatc(delim)) {
            val += delim
            continue
          }
          if (!this.eatc(delim)) {
            val += delim + delim
            continue
          }
          if (this.eatc(delim)) val += delim
          if (this.eatc(delim)) val += delim
        }
        return { t: 'String', src: this.slice(start, this.current()), val, multiline }
      } else if (basic && c === '\\') {
        val += this.escape(start, multiline)
      } else if (isStringChar(c)) {
        val += c
      } else {
        throw new DeError(i, `invalid character in string: \`${escapeDefault(c)}\``)
      }
    }
  }

  escape(start, multi) {
    const r = this.one()
    if (!r) throw new DeError(start, 'unterminated string')
    const { i, c } = r
    const simple = { '"': '"', '\\': '\\', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
    if (c in simple) return simple[c]
    if (c === 'u' || c === 'U') return this.hex(start, i, c === 'u' ? 4 : 8)
    if (multi && (c === ' ' || c === '\t' || c === '\n')) {
      if (c !== '\n') {
        for (let p = this.peekOne(); p; p = this.peekOne()) {
          if (p.c === ' ' || p.c === '\t') this.one()
          else if (p.c === '\n') {
            this.one()
            break
          } else throw new DeError(i, `invalid escape character in string: \`${escapeDefault(c)}\``)
        }
      }
      for (let p = this.peekOne(); p && (p.c === ' ' || p.c === '\t' || p.c === '\n'); p = this.peekOne()) this.one()
      return ''
    }
    throw new DeError(i, `invalid escape character in string: \`${escapeDefault(c)}\``)
  }

  hex(start, i, len) {
    let buf = ''
    for (let k = 0; k < len; k++) {
      const r = this.one()
      if (!r) throw new DeError(start, 'unterminated string')
      if (!/^[0-9A-Fa-f]$/.test(r.c)) throw new DeError(r.i, `invalid hex escape character in string: \`${escapeDefault(r.c)}\``)
      buf += r.c
    }
    const value = parseInt(buf, 16)
    if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) throw new DeError(i, `invalid escape value: \`${value}\``)
    return String.fromCodePoint(value)
  }
}

const I64_MIN = -(2n ** 63n)
const I64_MAX = 2n ** 63n - 1n

class Parser {
  constructor(src) {
    this.src = src
    this.tokens = Tokenizer.create(src)
  }

  error(at, message) {
    return new DeError(at, message)
  }

  tables() {
    const tables = []
    let cur = { at: 0, header: [], values: null, array: false }
    for (let line = this.line(); line; line = this.line()) {
      if (line.kind === 'table') {
        if (cur.header.length || cur.values) tables.push(cur)
        cur = { at: line.at, header: [], values: [], array: line.array }
        for (let part = line.header.next(); part; part = line.header.next()) cur.header.push(part)
      } else {
        cur.values ??= []
        this.addDottedKey(line.key, line.value, cur.values)
      }
    }
    if (cur.header.length || cur.values) tables.push(cur)
    return tables
  }

  line() {
    for (;;) {
      this.tokens.eatWhitespace()
      if (this.tokens.eatComment()) continue
      if (this.tokens.eat('Newline')) continue
      break
    }
    const p = this.tokens.peek()
    if (!p) return null
    return p.token.t === 'LeftBracket' ? this.tableHeader() : this.keyValue()
  }

  tableHeader() {
    const at = this.tokens.current()
    this.tokens.expectSpanned('LeftBracket')
    const array = this.tokens.eat('LeftBracket')
    const header = new Header(this.tokens.clone(), array)
    this.tokens.skipToNewline()
    return { kind: 'table', at, header, array }
  }

  keyValue() {
    const key = this.dottedKey()
    this.tokens.eatWhitespace()
    this.tokens.expectSpanned('Equals')
    this.tokens.eatWhitespace()
    const value = this.value()
    this.tokens.eatWhitespace()
    if (!this.tokens.eatComment()) this.tokens.eatNewlineOrEof()
    return { kind: 'kv', key, value }
  }

  value() {
    const at = this.tokens.current()
    const n = this.tokens.next()
    if (!n) throw this.error(this.src.len, 'unexpected eof encountered')
    const { span, token } = n
    switch (token.t) {
      case 'String': return { e: 'string', v: token.val, start: span.start }
      case 'Keylike':
        if (token.value === 'true' || token.value === 'false') return { e: 'bool', v: token.value === 'true', start: span.start }
        return this.parseKeylike(at, span, token)
      case 'Plus': return this.numberLeadingPlus(span)
      case 'LeftBrace': return { e: 'inline', v: this.inlineTable(), start: span.start }
      case 'LeftBracket': return { e: 'array', v: this.array(), start: span.start }
      default: throw this.error(at, `expected a value, found ${describe(token)}`)
    }
  }

  parseKeylike(at, span, token) {
    const key = token.value
    if (key === 'inf' || key === 'nan' || key[0] === '-' || /[0-9]/.test(key[0])) return this.number(span, { s: key, off: token.off })
    throw this.error(at, 'invalid TOML value, did you mean to use a quoted string?')
  }

  number(span, str) {
    const { s } = str
    const sub = (k) => ({ s: s.slice(k), off: str.off + k })
    const integer = (radix, k) => ({ e: 'integer', v: this.integer(sub(k), radix), start: span.start })
    if (s.startsWith('0x')) return integer(16, 2)
    if (s.startsWith('0o')) return integer(8, 2)
    if (s.startsWith('0b')) return integer(2, 2)
    if (s.includes('e') || s.includes('E')) return { e: 'float', v: this.float(str, null), start: span.start }
    if (this.tokens.eat('Period')) {
      const at = this.tokens.current()
      const n = this.tokens.next()
      if (n && n.token.t === 'Keylike') {
        return { e: 'float', v: this.float(str, { s: n.token.value, off: n.token.off }), start: n.span.start }
      }
      throw this.error(at, 'invalid number')
    }
    if (s === 'inf') return { e: 'float', v: Infinity, start: span.start }
    if (s === '-inf') return { e: 'float', v: -Infinity, start: span.start }
    if (s === 'nan') return { e: 'float', v: NaN, start: span.start }
    if (s === '-nan') return { e: 'float', v: NaN, start: span.start }
    return integer(10, 0)
  }

  numberLeadingPlus(span) {
    const at = this.tokens.current()
    const n = this.tokens.next()
    if (n && n.token.t === 'Keylike') return this.number({ start: span.start, end: n.span.end }, { s: n.token.value, off: n.token.off })
    throw this.error(at, 'invalid number')
  }

  integer(str, radix) {
    const [prefix, suffix] = this.parseInteger(str, radix === 10, radix !== 10, radix)
    if (suffix.s !== '') throw this.error(str.off, 'invalid number')
    const digits = prefix.s.replace(/_/g, '').replace(/^\++/, '')
    const negative = digits.startsWith('-')
    const body = negative ? digits.slice(1) : digits
    if (body === '' || /[+-]/.test(body)) throw this.error(str.off, 'invalid number')
    let value = 0n
    for (const d of body) value = value * BigInt(radix) + BigInt(parseInt(d, radix))
    if (negative) value = -value
    if (value < I64_MIN || value > I64_MAX) throw this.error(str.off, 'invalid number')
    return value
  }

  parseInteger(str, allowSign, allowLeadingZeros, radix) {
    const { s, off } = str
    let first = true
    let firstZero = false
    let underscore = false
    let end = s.length
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      const at = off + i
      if (i === 0 && (c === '+' || c === '-') && allowSign) continue
      if (c === '0' && first) firstZero = true
      else if (/[0-9a-zA-Z]/.test(c) && parseInt(c, 36) < radix) {
        if (!first && firstZero && !allowLeadingZeros) throw this.error(at, 'invalid number')
        underscore = false
      } else if (c === '_' && first) throw this.error(at, 'invalid number')
      else if (c === '_' && !underscore) underscore = true
      else {
        end = i
        break
      }
      first = false
    }
    if (first || underscore) throw this.error(off, 'invalid number')
    return [{ s: s.slice(0, end), off }, { s: s.slice(end), off: off + end }]
  }

  float(str, afterDecimal) {
    const [integral, rest] = this.parseInteger(str, true, false, 10)
    let suffix = rest
    const start = integral.off
    let fraction = null
    if (afterDecimal) {
      if (suffix.s !== '') throw this.error(start, 'invalid number')
      const [a, b] = this.parseInteger(afterDecimal, false, true, 10)
      fraction = a
      suffix = b
    }
    let exponent = null
    if (suffix.s.startsWith('e') || suffix.s.startsWith('E')) {
      let a, b
      if (suffix.s.length === 1) {
        this.tokens.eat('Plus')
        const n = this.tokens.next()
        if (!n || n.token.t !== 'Keylike') throw this.error(start, 'invalid number')
        ;[a, b] = this.parseInteger({ s: n.token.value, off: n.token.off }, false, true, 10)
      } else {
        ;[a, b] = this.parseInteger({ s: suffix.s.slice(1), off: suffix.off + 1 }, true, true, 10)
      }
      if (b.s !== '') throw this.error(start, 'invalid number')
      exponent = a
    } else if (suffix.s !== '') {
      throw this.error(start, 'invalid number')
    }
    let number = integral.s.replace(/^\++/, '').replace(/_/g, '')
    if (fraction) number += `.${fraction.s.replace(/_/g, '')}`
    if (exponent) number += `E${exponent.s.replace(/_/g, '')}`
    const value = Number(number)
    if (!Number.isFinite(value)) throw this.error(start, 'invalid number')
    return value
  }

  inlineTable() {
    const ret = []
    this.tokens.eatWhitespace()
    if (this.tokens.eat('RightBrace')) return ret
    for (;;) {
      const key = this.dottedKey()
      this.tokens.eatWhitespace()
      this.tokens.expectSpanned('Equals')
      this.tokens.eatWhitespace()
      const value = this.value()
      this.addDottedKey(key, value, ret)
      this.tokens.eatWhitespace()
      if (this.tokens.eat('RightBrace')) return ret
      this.tokens.expectSpanned('Comma')
      this.tokens.eatWhitespace()
    }
  }

  array() {
    const ret = []
    const intermediate = () => {
      for (;;) {
        this.tokens.eatWhitespace()
        if (!this.tokens.eat('Newline') && !this.tokens.eatComment()) break
      }
    }
    for (;;) {
      intermediate()
      if (this.tokens.eat('RightBracket')) return ret
      ret.push(this.value())
      intermediate()
      if (!this.tokens.eat('Comma')) break
    }
    intermediate()
    this.tokens.expectSpanned('RightBracket')
    return ret
  }

  dottedKey() {
    const result = [this.tokens.tableKey()]
    this.tokens.eatWhitespace()
    while (this.tokens.eat('Period')) {
      this.tokens.eatWhitespace()
      result.push(this.tokens.tableKey())
      this.tokens.eatWhitespace()
    }
    return result
  }

  addDottedKey(parts, value, values) {
    const [key, ...rest] = parts
    if (rest.length === 0) {
      values.push({ span: key.span, key: key.key, value })
      return
    }
    const existing = values.find((pair) => pair.key === key.key)
    if (existing) {
      if (existing.value.e === 'dotted') return this.addDottedKey(rest, value, existing.value.v)
      throw this.error(existing.value.start, 'dotted key attempted to extend non-table type')
    }
    const table = { e: 'dotted', v: [], start: value.start }
    values.push({ span: key.span, key: key.key, value: table })
    this.addDottedKey(rest, value, table.v)
  }
}

class Header {
  constructor(tokens, array) {
    this.first = true
    this.array = array
    this.tokens = tokens
  }

  next() {
    this.tokens.eatWhitespace()
    if (this.first || this.tokens.eat('Period')) {
      this.first = false
      this.tokens.eatWhitespace()
      return this.tokens.tableKey()
    }
    this.tokens.expectSpanned('RightBracket')
    if (this.array) this.tokens.expectSpanned('RightBracket')
    this.tokens.eatWhitespace()
    if (!this.tokens.eatComment()) this.tokens.eatNewlineOrEof()
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// serde side: deserializers over the parsed tables and values, visitors per schema kind.

const DONE = Symbol('done')
const headerKey = (header) => JSON.stringify(header.map((part) => part.key))

function lowerBound(entries, value) {
  let lo = 0
  let hi = entries.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (entries[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

class MapVisitor {
  constructor(init) {
    Object.assign(this, { values: [], vi: 0, nextPair: null, keys: new Set() }, init)
  }

  child(init) {
    const { tables, indices, pindices, max } = this
    return new MapVisitor({ tables, indices, pindices, max, ...init })
  }

  deserializeAny(visitor) {
    return this.array ? visitor.visitSeq(this) : visitor.visitMap(this)
  }

  nextKey() {
    const { tables } = this
    if (this.curParent === this.max || this.cur === this.max) return null
    for (;;) {
      if (this.vi < this.values.length) {
        const pair = this.values[this.vi++]
        if (this.keys.has(pair.key)) throw new DeError(pair.span.start, `duplicate key: \`${pair.key}\``)
        this.keys.add(pair.key)
        this.nextPair = pair
        return pair.key
      }
      const entries = this.pindices.get(headerKey(tables[this.curParent].header.slice(0, this.depth)))
      let pos = null
      if (entries) {
        for (let k = lowerBound(entries, this.cur); k < entries.length; k++) {
          const i = entries[k]
          if (i < this.max && tables[i].values) {
            pos = i
            break
          }
        }
      }
      if (pos === null) return null
      this.cur = pos
      if (this.curParent !== pos) {
        const parent = tables[this.curParent].header
        const header = tables[pos].header
        if (headerKey(parent) === headerKey(header)) {
          throw new DeError(tables[pos].at, `redefinition of table \`${header.map((part) => part.key).join('.')}\``)
        }
        if (header.length < parent.length) this.curParent = pos
      }
      const table = tables[pos]
      if (this.depth !== table.header.length) {
        const { span, key } = table.header[this.depth]
        if (this.keys.has(key)) throw new DeError(span.start, `duplicate key: \`${key}\``)
        this.keys.add(key)
        return key
      }
      if (table.array) throw new DeError(table.at, 'table redefined as array')
      this.values = table.values
      this.vi = 0
      table.values = null
    }
  }

  nextValue(seed) {
    if (this.nextPair) {
      const pair = this.nextPair
      this.nextPair = null
      try {
        return seed(new ValueDeserializer(pair.value))
      } catch (e) {
        if (e instanceof DeError) e.key.unshift(pair.key)
        throw e
      }
    }
    const table = this.tables[this.cur]
    const array = table.array && this.depth === table.header.length - 1
    this.cur += 1
    try {
      return seed(this.child({ depth: this.depth + (array ? 0 : 1), curParent: this.cur - 1, cur: 0, array }))
    } catch (e) {
      if (e instanceof DeError) e.key.unshift(this.tables[this.cur - 1].header[this.depth].key)
      throw e
    }
  }

  nextElement(seed) {
    const { tables } = this
    if (this.curParent === this.max) return DONE
    const entries = this.indices.get(headerKey(tables[this.curParent].header))
    let next = this.max
    if (entries) {
      for (let k = lowerBound(entries, this.curParent + 1); k < entries.length; k++) {
        const i = entries[k]
        if (i < this.max && tables[i].array) {
          next = i
          break
        }
      }
    }
    const values = tables[this.curParent].values
    if (!values) throw new Error('Unable to read table values')
    tables[this.curParent].values = null
    const ret = seed(this.child({ values, depth: this.depth + 1, curParent: this.curParent, max: next, cur: 0, array: false }))
    this.curParent = next
    return ret
  }
}

class ValueDeserializer {
  constructor(value) {
    this.value = value
  }

  deserializeAny(visitor) {
    const { e, v, start } = this.value
    try {
      switch (e) {
        case 'integer': return visitor.visitI64(v)
        case 'bool': return visitor.visitBool(v)
        case 'float': return visitor.visitF64(v)
        case 'string': return visitor.visitStr(v)
        case 'array': {
          const seq = new SeqDeserializer(v)
          const ret = visitor.visitSeq(seq)
          seq.end()
          return ret
        }
        default:
          return visitor.visitMap(new InlineTableDeserializer(v))
      }
    } catch (err) {
      if (err instanceof DeError && err.at === null) err.at = start
      throw err
    }
  }
}

class SeqDeserializer {
  constructor(values) {
    this.values = values
    this.count = 0
  }

  nextElement(seed) {
    if (this.count >= this.values.length) return DONE
    return seed(new ValueDeserializer(this.values[this.count++]))
  }

  end() {
    const remaining = this.values.length - this.count
    if (remaining === 0) return
    const expected = this.count === 1 ? '1 element in sequence' : `${this.count} elements in sequence`
    throw custom(`invalid length ${this.count + remaining}, expected ${expected}`)
  }
}

class InlineTableDeserializer {
  constructor(pairs) {
    this.pairs = pairs
    this.i = 0
    this.pending = null
    this.keys = new Set()
  }

  nextKey() {
    if (this.i >= this.pairs.length) return null
    const pair = this.pairs[this.i++]
    this.pending = pair.value
    if (this.keys.has(pair.key)) throw new DeError(pair.span.start, `duplicate key: \`${pair.key}\``)
    this.keys.add(pair.key)
    return pair.key
  }

  nextValue(seed) {
    const value = this.pending
    this.pending = null
    return seed(new ValueDeserializer(value))
  }
}

function floatText(value) {
  const text = rustDisplayFloat(value)
  return Number.isFinite(value) && !text.includes('.') ? `${text}.0` : text
}

function invalidType(unexpected, schema) {
  return custom(`invalid type: ${unexpected}, expected ${expecting(schema)}`)
}

function visitorFor(schema) {
  const reject = {
    visitBool: (v) => { throw invalidType(`boolean \`${v}\``, schema) },
    visitI64: (v) => { throw invalidType(`integer \`${v}\``, schema) },
    visitF64: (v) => { throw invalidType(`floating point \`${floatText(v)}\``, schema) },
    visitStr: (v) => { throw invalidType(`string ${rustDebugString(v)}`, schema) },
    visitSeq: () => { throw invalidType('sequence', schema) },
    visitMap: () => { throw invalidType('map', schema) },
  }
  switch (schema.kind) {
    case 'bool':
      return { ...reject, visitBool: (v) => v }
    case 'string':
      return { ...reject, visitStr: (v) => v }
    case 'f32':
    case 'f64': {
      const cast = schema.kind === 'f32' ? Math.fround : (v) => v
      return { ...reject, visitI64: (v) => cast(Number(v)), visitF64: cast }
    }
    case 'vec':
      return {
        ...reject,
        visitSeq(seq) {
          const out = []
          for (let x = seq.nextElement(seedFor(schema.item)); x !== DONE; x = seq.nextElement(seedFor(schema.item))) out.push(x)
          return out
        },
      }
    case 'map':
      return {
        ...reject,
        visitMap(map) {
          const values = new Map()
          for (let key = map.nextKey(); key !== null; key = map.nextKey()) values.set(key, map.nextValue(seedFor(schema.value)))
          return Object.fromEntries(sortedKeys([...values.keys()]).map((k) => [k, values.get(k)]))
        },
      }
    case 'struct':
      return { ...reject, visitMap: (map) => structFromMap(schema, map), visitSeq: (seq) => structFromSeq(schema, seq) }
    default:
      if (!isInteger(schema)) throw new Error(`unknown schema kind ${schema.kind}`)
      return {
        ...reject,
        visitI64(v) {
          const [lo, hi] = integerRange(schema.kind)
          if (v < lo || v > hi) throw custom(`invalid value: integer \`${v}\`, expected ${schema.kind}`)
          return integerValue(v)
        },
      }
  }
}

const IGNORE = {
  visitBool: () => undefined,
  visitI64: () => undefined,
  visitF64: () => undefined,
  visitStr: () => undefined,
  visitSeq(seq) {
    while (seq.nextElement(ignore) !== DONE);
  },
  visitMap(map) {
    while (map.nextKey() !== null) map.nextValue(ignore)
  },
}

function ignore(de) {
  return de.deserializeAny(IGNORE)
}

function seedFor(schema) {
  if (schema.kind === 'option') return seedFor(schema.inner)
  return (de) => de.deserializeAny(visitorFor(schema))
}

function structFromMap(schema, map) {
  const found = new Map()
  for (let key = map.nextKey(); key !== null; key = map.nextKey()) {
    if (!Object.hasOwn(schema.fields, key)) {
      map.nextValue(ignore)
      continue
    }
    if (found.has(key)) throw custom(`duplicate field \`${key}\``)
    found.set(key, map.nextValue(seedFor(schema.fields[key])))
  }
  const out = {}
  for (const [name, field] of Object.entries(schema.fields)) {
    if (found.has(name)) out[name] = found.get(name)
    else if (field.kind === 'option') out[name] = null
    else throw custom(`missing field \`${name}\``)
  }
  return out
}

function structFromSeq(schema, seq) {
  const names = Object.keys(schema.fields)
  const expected = `struct ${schema.name} with ${names.length} element${names.length === 1 ? '' : 's'}`
  const out = {}
  names.forEach((name, i) => {
    const value = seq.nextElement(seedFor(schema.fields[name]))
    if (value === DONE) throw custom(`invalid length ${i}, expected ${expected}`)
    out[name] = value
  })
  return out
}

function toLineCol(buf, offset) {
  let cur = 0
  let line = 0
  for (let start = 0; start < buf.length; line++) {
    const nl = buf.indexOf(0x0a, start)
    const len = (nl === -1 ? buf.length : nl) - start
    if (cur + len + 1 > offset) return [line, offset - cur]
    cur += len + 1
    if (nl === -1) {
      line++
      break
    }
    start = nl + 1
  }
  return [line, 0]
}

function source(text) {
  const buf = Buffer.from(text, 'utf8')
  const cps = []
  let i = 0
  for (const c of text) {
    cps.push({ i, c })
    i += Buffer.byteLength(c)
  }
  return { buf, cps, len: buf.length }
}

export function parseBasicToml(text, schema) {
  const src = source(text)
  try {
    const tables = new Parser(src).tables()
    const indices = new Map()
    const pindices = new Map()
    tables.forEach((table, i) => {
      const keys = table.header.map((part) => part.key)
      const exact = JSON.stringify(keys)
      if (!indices.has(exact)) indices.set(exact, [])
      indices.get(exact).push(i)
      for (let len = 0; len <= keys.length; len++) {
        const prefix = JSON.stringify(keys.slice(0, len))
        if (!pindices.has(prefix)) pindices.set(prefix, [])
        pindices.get(prefix).push(i)
      }
    })
    const root = new MapVisitor({ tables, indices, pindices, max: tables.length, depth: 0, cur: 0, curParent: 0, array: false })
    try {
      return root.deserializeAny(visitorFor(schema.kind === 'option' ? schema.inner : schema))
    } catch (e) {
      if (e instanceof DeError && e.at === null && tables.length) e.at = tables[tables.length - 1].at
      throw e
    }
  } catch (e) {
    if (!(e instanceof DeError)) throw e
    let message = e.message
    if (e.key.length) message += ` for key \`${e.key.join('.')}\``
    if (e.at !== null) {
      const [line, col] = toLineCol(src.buf, e.at)
      message += ` at line ${line + 1} column ${col + 1}`
    }
    throw new FormatError(message, { cause: e })
  }
}
