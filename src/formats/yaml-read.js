// Reading for confy/yaml: a port of serde_yaml 0.9 over unsafe-libyaml (the reader's character check, the
// scanner, the event parser and serde_yaml's loader and DeserializerFromEvents), driven by serde's derive rules
// for the schema, so values and error texts (problem, context, marks and value paths) match the crate.
// Marks are libyaml's: byte index, 0-based line and column (columns count characters).

import { FormatError } from '../errors.js'
import { integerRange, integerValue, sortedKeys } from '../schema.js'
import { rustDisplayFloat } from '../numbers.js'
import { rustDebugString } from '../debug.js'

// ---------------------------------------------------------------------------------------------
// Errors

class LibyamlError {
  constructor({ problem, problemMark = null, offset = 0, context = null, contextMark = null }) {
    Object.assign(this, { problem, problemMark, offset, context, contextMark })
  }
}

// serde_yaml's ErrorImpl kinds that this port can produce.
class YamlError {
  constructor(kind, message = null, mark = null) {
    this.kind = kind
    this.message = message
    this.mark = mark
    this.pos = null
  }
}

const markIsSet = (m) => m && (m.line !== 0 || m.column !== 0)
const markText = (m) => (markIsSet(m) ? `line ${m.line + 1} column ${m.column + 1}` : `position ${m.index}`)

function libyamlText(e) {
  let out = e.problem
  if (markIsSet(e.problemMark)) out += ` at ${markText(e.problemMark)}`
  else if (e.offset !== 0) out += ` at position ${e.offset}`
  if (e.context !== null) {
    out += `, ${e.context}`
    const pm = e.problemMark ?? { line: 0, column: 0 }
    if (markIsSet(e.contextMark) && (e.contextMark.line !== pm.line || e.contextMark.column !== pm.column)) {
      out += ` at ${markText(e.contextMark)}`
    }
  }
  return out
}

function errorText(e) {
  if (e instanceof LibyamlError) return libyamlText(e)
  let text
  let mark = e.mark
  switch (e.kind) {
    case 'message':
      text = e.pos && e.pos.path !== '.' ? `${e.pos.path}: ${e.message}` : e.message
      mark = e.pos ? e.pos.mark : null
      break
    case 'eof':
      text = 'EOF while parsing a value'
      break
    case 'more':
      text = 'deserializing from YAML containing more than one document is not supported'
      break
    case 'recursion':
      text = 'recursion limit exceeded'
      break
    case 'repetition':
      text = 'repetition limit exceeded'
      break
    case 'unknownAnchor':
      text = 'unknown anchor'
      break
    default:
      throw new Error(`unknown serde_yaml error kind ${e.kind}`)
  }
  if (markIsSet(mark)) text += ` at ${markText(mark)}`
  return text
}

const custom = (message) => new YamlError('message', message)

function pathText(path) {
  const parent = (p) => (p.kind === 'root' ? '' : `${pathText(p)}.`)
  switch (path.kind) {
    case 'root':
      return '.'
    case 'seq':
      return `${pathText(path.parent)}[${path.index}]`
    case 'map':
      return `${parent(path.parent)}${path.key}`
    case 'alias':
      return pathText(path.parent)
    default:
      return `${parent(path.parent)}?`
  }
}

function fixMark(err, mark, path) {
  if (err instanceof YamlError && err.kind === 'message' && err.pos === null) err.pos = { mark, path: pathText(path) }
  return err
}

// ---------------------------------------------------------------------------------------------
// Scanner (unsafe-libyaml scanner.rs)

const copyMark = (m) => ({ index: m.index, line: m.line, column: m.column })
const ch = (s) => s.charCodeAt(0)
const URI_CHARS = new Set([...';/?:@&=+$.%!~*\'()'].map(ch))

class Scanner {
  constructor(bytes) {
    this.b = bytes
    this.len = bytes.length
    this.pos = 0
    this.mark = { index: 0, line: 0, column: 0 }
    this.tokens = []
    this.tokensParsed = 0
    this.tokenAvailable = false
    this.simpleKeys = []
    this.indents = []
    this.indent = 0
    this.flowLevel = 0
    this.simpleKeyAllowed = false
    this.streamStartProduced = false
    this.streamEndProduced = false
  }

  at(k = 0) {
    const i = this.pos + k
    return i < this.len ? this.b[i] : 0
  }

  check(c, k = 0) {
    return this.at(k) === ch(c)
  }

  isZ(k = 0) {
    return this.pos + k >= this.len
  }

  isBlank(k = 0) {
    const a = this.at(k)
    return a === 32 || a === 9
  }

  isBreak(k = 0) {
    const a = this.at(k)
    return a === 13 || a === 10 || (a === 0xc2 && this.at(k + 1) === 0x85) ||
      (a === 0xe2 && this.at(k + 1) === 0x80 && (this.at(k + 2) === 0xa8 || this.at(k + 2) === 0xa9))
  }

  isBreakz(k = 0) {
    return this.isBreak(k) || this.isZ(k)
  }

  isBlankz(k = 0) {
    return this.isBlank(k) || this.isBreakz(k)
  }

  isAlpha(k = 0) {
    const a = this.at(k)
    return (a >= 48 && a <= 57) || (a >= 65 && a <= 90) || (a >= 97 && a <= 122) || a === 95 || a === 45
  }

  isDigit(k = 0) {
    const a = this.at(k)
    return a >= 48 && a <= 57
  }

  isHex(k = 0) {
    const a = this.at(k)
    return (a >= 48 && a <= 57) || (a >= 65 && a <= 70) || (a >= 97 && a <= 102)
  }

  asHex(k = 0) {
    const a = this.at(k)
    if (a >= 65 && a <= 70) return a - 55
    if (a >= 97 && a <= 102) return a - 87
    return a - 48
  }

  width() {
    const a = this.at()
    if ((a & 0x80) === 0) return 1
    if ((a & 0xe0) === 0xc0) return 2
    if ((a & 0xf0) === 0xe0) return 3
    if ((a & 0xf8) === 0xf0) return 4
    return 0
  }

  skip() {
    const w = this.width()
    this.pos += w
    this.mark.index += w
    this.mark.column++
  }

  skipLine() {
    if (this.check('\r') && this.check('\n', 1)) {
      this.pos += 2
      this.mark.index += 2
      this.mark.column = 0
      this.mark.line++
    } else if (this.isBreak()) {
      const w = this.width()
      this.pos += w
      this.mark.index += w
      this.mark.column = 0
      this.mark.line++
    }
  }

  read(string) {
    const w = this.width()
    for (let k = 0; k < w; k++) string.push(this.b[this.pos + k])
    this.pos += w
    this.mark.index += w
    this.mark.column++
  }

  readLine(string) {
    let n = 0
    if (this.check('\r') && this.check('\n', 1)) {
      string.push(10)
      n = 2
    } else if (this.check('\r') || this.check('\n')) {
      string.push(10)
      n = 1
    } else if (this.at() === 0xc2 && this.at(1) === 0x85) {
      string.push(10)
      n = 2
    } else if (this.at() === 0xe2 && this.at(1) === 0x80 && (this.at(2) === 0xa8 || this.at(2) === 0xa9)) {
      string.push(this.at(), this.at(1), this.at(2))
      n = 3
    } else {
      return
    }
    this.pos += n
    this.mark.index += n
    this.mark.column = 0
    this.mark.line++
  }

  error(context, contextMark, problem) {
    return new LibyamlError({ problem, problemMark: copyMark(this.mark), context, contextMark: copyMark(contextMark) })
  }

  fetchMoreTokens() {
    for (;;) {
      let need = false
      if (this.tokens.length === 0) need = true
      else {
        this.staleSimpleKeys()
        for (const key of this.simpleKeys) {
          if (key.possible && key.tokenNumber === this.tokensParsed) {
            need = true
            break
          }
        }
      }
      if (!need) break
      this.fetchNextToken()
    }
    this.tokenAvailable = true
  }

  fetchNextToken() {
    if (!this.streamStartProduced) {
      this.fetchStreamStart()
      return
    }
    this.scanToNextToken()
    this.staleSimpleKeys()
    this.unrollIndent(this.mark.column)
    if (this.isZ()) return this.fetchStreamEnd()
    const col0 = this.mark.column === 0
    if (col0 && this.check('%')) return this.fetchDirective()
    if (col0 && this.check('-') && this.check('-', 1) && this.check('-', 2) && this.isBlankz(3)) {
      return this.fetchDocumentIndicator('DOCUMENT_START')
    }
    if (col0 && this.check('.') && this.check('.', 1) && this.check('.', 2) && this.isBlankz(3)) {
      return this.fetchDocumentIndicator('DOCUMENT_END')
    }
    if (this.check('[')) return this.fetchFlowCollectionStart('FLOW_SEQUENCE_START')
    if (this.check('{')) return this.fetchFlowCollectionStart('FLOW_MAPPING_START')
    if (this.check(']')) return this.fetchFlowCollectionEnd('FLOW_SEQUENCE_END')
    if (this.check('}')) return this.fetchFlowCollectionEnd('FLOW_MAPPING_END')
    if (this.check(',')) return this.fetchFlowEntry()
    if (this.check('-') && this.isBlankz(1)) return this.fetchBlockEntry()
    if (this.check('?') && (this.flowLevel !== 0 || this.isBlankz(1))) return this.fetchKey()
    if (this.check(':') && (this.flowLevel !== 0 || this.isBlankz(1))) return this.fetchValue()
    if (this.check('*')) return this.fetchAnchor('ALIAS')
    if (this.check('&')) return this.fetchAnchor('ANCHOR')
    if (this.check('!')) return this.fetchTag()
    if (this.check('|') && this.flowLevel === 0) return this.fetchBlockScalar(true)
    if (this.check('>') && this.flowLevel === 0) return this.fetchBlockScalar(false)
    if (this.check("'")) return this.fetchFlowScalar(true)
    if (this.check('"')) return this.fetchFlowScalar(false)
    const indicator = this.isBlankz() || [...'-?:,[]{}#&*!|>\'"%@`'].some((c) => this.check(c))
    if (!indicator || (this.check('-') && !this.isBlank(1)) ||
        (this.flowLevel === 0 && (this.check('?') || this.check(':')) && !this.isBlankz(1))) {
      return this.fetchPlainScalar()
    }
    throw this.error('while scanning for the next token', this.mark, 'found character that cannot start any token')
  }

  staleSimpleKeys() {
    for (const key of this.simpleKeys) {
      if (key.possible && (key.mark.line < this.mark.line || key.mark.index + 1024 < this.mark.index)) {
        if (key.required) throw this.error('while scanning a simple key', key.mark, "could not find expected ':'")
        key.possible = false
      }
    }
  }

  saveSimpleKey() {
    const required = this.flowLevel === 0 && this.indent === this.mark.column
    if (this.simpleKeyAllowed) {
      const key = { possible: true, required, tokenNumber: this.tokensParsed + this.tokens.length, mark: copyMark(this.mark) }
      this.removeSimpleKey()
      this.simpleKeys[this.simpleKeys.length - 1] = key
    }
  }

  removeSimpleKey() {
    const key = this.simpleKeys[this.simpleKeys.length - 1]
    if (key.possible && key.required) throw this.error('while scanning a simple key', key.mark, "could not find expected ':'")
    key.possible = false
  }

  increaseFlowLevel() {
    this.simpleKeys.push({ possible: false, required: false, tokenNumber: 0, mark: { index: 0, line: 0, column: 0 } })
    this.flowLevel++
  }

  decreaseFlowLevel() {
    if (this.flowLevel !== 0) {
      this.flowLevel--
      this.simpleKeys.pop()
    }
  }

  rollIndent(column, number, type, mark) {
    if (this.flowLevel !== 0) return
    if (this.indent < column) {
      this.indents.push(this.indent)
      this.indent = column
      const token = { type, start: copyMark(mark), end: copyMark(mark) }
      if (number === -1) this.tokens.push(token)
      else this.tokens.splice(number - this.tokensParsed, 0, token)
    }
  }

  unrollIndent(column) {
    if (this.flowLevel !== 0) return
    while (this.indent > column) {
      this.tokens.push({ type: 'BLOCK_END', start: copyMark(this.mark), end: copyMark(this.mark) })
      this.indent = this.indents.pop()
    }
  }

  simpleToken(type) {
    const start = copyMark(this.mark)
    this.skip()
    this.tokens.push({ type, start, end: copyMark(this.mark) })
  }

  fetchStreamStart() {
    this.indent = -1
    this.simpleKeys.push({ possible: false, required: false, tokenNumber: 0, mark: { index: 0, line: 0, column: 0 } })
    this.simpleKeyAllowed = true
    this.streamStartProduced = true
    this.tokens.push({ type: 'STREAM_START', start: copyMark(this.mark), end: copyMark(this.mark) })
  }

  fetchStreamEnd() {
    if (this.mark.column !== 0) {
      this.mark.column = 0
      this.mark.line++
    }
    this.unrollIndent(-1)
    this.removeSimpleKey()
    this.simpleKeyAllowed = false
    this.tokens.push({ type: 'STREAM_END', start: copyMark(this.mark), end: copyMark(this.mark) })
  }

  fetchDirective() {
    this.unrollIndent(-1)
    this.removeSimpleKey()
    this.simpleKeyAllowed = false
    this.tokens.push(this.scanDirective())
  }

  fetchDocumentIndicator(type) {
    this.unrollIndent(-1)
    this.removeSimpleKey()
    this.simpleKeyAllowed = false
    const start = copyMark(this.mark)
    this.skip()
    this.skip()
    this.skip()
    this.tokens.push({ type, start, end: copyMark(this.mark) })
  }

  fetchFlowCollectionStart(type) {
    this.saveSimpleKey()
    this.increaseFlowLevel()
    this.simpleKeyAllowed = true
    this.simpleToken(type)
  }

  fetchFlowCollectionEnd(type) {
    this.removeSimpleKey()
    this.decreaseFlowLevel()
    this.simpleKeyAllowed = false
    this.simpleToken(type)
  }

  fetchFlowEntry() {
    this.removeSimpleKey()
    this.simpleKeyAllowed = true
    this.simpleToken('FLOW_ENTRY')
  }

  fetchBlockEntry() {
    if (this.flowLevel === 0) {
      if (!this.simpleKeyAllowed) {
        throw new LibyamlError({ problem: 'block sequence entries are not allowed in this context', problemMark: copyMark(this.mark) })
      }
      this.rollIndent(this.mark.column, -1, 'BLOCK_SEQUENCE_START', this.mark)
    }
    this.removeSimpleKey()
    this.simpleKeyAllowed = true
    this.simpleToken('BLOCK_ENTRY')
  }

  fetchKey() {
    if (this.flowLevel === 0) {
      if (!this.simpleKeyAllowed) {
        throw new LibyamlError({ problem: 'mapping keys are not allowed in this context', problemMark: copyMark(this.mark) })
      }
      this.rollIndent(this.mark.column, -1, 'BLOCK_MAPPING_START', this.mark)
    }
    this.removeSimpleKey()
    this.simpleKeyAllowed = this.flowLevel === 0
    this.simpleToken('KEY')
  }

  fetchValue() {
    const key = this.simpleKeys[this.simpleKeys.length - 1]
    if (key.possible) {
      this.tokens.splice(key.tokenNumber - this.tokensParsed, 0, { type: 'KEY', start: copyMark(key.mark), end: copyMark(key.mark) })
      this.rollIndent(key.mark.column, key.tokenNumber, 'BLOCK_MAPPING_START', key.mark)
      key.possible = false
      this.simpleKeyAllowed = false
    } else {
      if (this.flowLevel === 0) {
        if (!this.simpleKeyAllowed) {
          throw new LibyamlError({ problem: 'mapping values are not allowed in this context', problemMark: copyMark(this.mark) })
        }
        this.rollIndent(this.mark.column, -1, 'BLOCK_MAPPING_START', this.mark)
      }
      this.simpleKeyAllowed = this.flowLevel === 0
    }
    this.simpleToken('VALUE')
  }

  fetchAnchor(type) {
    this.saveSimpleKey()
    this.simpleKeyAllowed = false
    this.tokens.push(this.scanAnchor(type))
  }

  fetchTag() {
    this.saveSimpleKey()
    this.simpleKeyAllowed = false
    this.tokens.push(this.scanTag())
  }

  fetchBlockScalar(literal) {
    this.removeSimpleKey()
    this.simpleKeyAllowed = true
    this.tokens.push(this.scanBlockScalar(literal))
  }

  fetchFlowScalar(single) {
    this.saveSimpleKey()
    this.simpleKeyAllowed = false
    this.tokens.push(this.scanFlowScalar(single))
  }

  fetchPlainScalar() {
    this.saveSimpleKey()
    this.simpleKeyAllowed = false
    this.tokens.push(this.scanPlainScalar())
  }

  scanToNextToken() {
    for (;;) {
      if (this.mark.column === 0 && this.at() === 0xef && this.at(1) === 0xbb && this.at(2) === 0xbf) this.skip()
      while (this.check(' ') || ((this.flowLevel !== 0 || !this.simpleKeyAllowed) && this.check('\t'))) this.skip()
      if (this.check('#')) while (!this.isBreakz()) this.skip()
      if (!this.isBreak()) break
      this.skipLine()
      if (this.flowLevel === 0) this.simpleKeyAllowed = true
    }
  }

  scanDirective() {
    const start = copyMark(this.mark)
    this.skip()
    const name = this.scanDirectiveName(start)
    let token
    if (name === 'YAML') {
      const [major, minor] = this.scanVersionDirectiveValue(start)
      token = { type: 'VERSION_DIRECTIVE', start, end: copyMark(this.mark), major, minor }
    } else if (name === 'TAG') {
      const [handle, prefix] = this.scanTagDirectiveValue(start)
      token = { type: 'TAG_DIRECTIVE', start, end: copyMark(this.mark), handle, prefix }
    } else {
      throw this.error('while scanning a directive', start, 'found unknown directive name')
    }
    while (this.isBlank()) this.skip()
    if (this.check('#')) while (!this.isBreakz()) this.skip()
    if (!this.isBreakz()) throw this.error('while scanning a directive', start, 'did not find expected comment or line break')
    if (this.isBreak()) this.skipLine()
    return token
  }

  scanDirectiveName(start) {
    const string = []
    while (this.isAlpha()) this.read(string)
    if (string.length === 0) throw this.error('while scanning a directive', start, 'could not find expected directive name')
    if (!this.isBlankz()) throw this.error('while scanning a directive', start, 'found unexpected non-alphabetical character')
    return Buffer.from(string).toString('utf8')
  }

  scanVersionDirectiveValue(start) {
    while (this.isBlank()) this.skip()
    const major = this.scanVersionDirectiveNumber(start)
    if (!this.check('.')) throw this.error('while scanning a %YAML directive', start, "did not find expected digit or '.' character")
    this.skip()
    return [major, this.scanVersionDirectiveNumber(start)]
  }

  scanVersionDirectiveNumber(start) {
    let value = 0
    let length = 0
    while (this.isDigit()) {
      length++
      if (length > 9) throw this.error('while scanning a %YAML directive', start, 'found extremely long version number')
      value = value * 10 + (this.at() - 48)
      this.skip()
    }
    if (length === 0) throw this.error('while scanning a %YAML directive', start, 'did not find expected version number')
    return value
  }

  scanTagDirectiveValue(start) {
    while (this.isBlank()) this.skip()
    const handle = this.scanTagHandle(true, start)
    if (!this.isBlank()) throw this.error('while scanning a %TAG directive', start, 'did not find expected whitespace')
    while (this.isBlank()) this.skip()
    const prefix = this.scanTagUri(true, true, null, start)
    if (!this.isBlankz()) throw this.error('while scanning a %TAG directive', start, 'did not find expected whitespace or line break')
    return [handle, prefix]
  }

  scanAnchor(type) {
    const string = []
    const start = copyMark(this.mark)
    this.skip()
    let length = 0
    while (this.isAlpha()) {
      this.read(string)
      length++
    }
    const end = copyMark(this.mark)
    if (length === 0 || !(this.isBlankz() || [...'?:,]}%@`'].some((c) => this.check(c)))) {
      throw this.error(type === 'ANCHOR' ? 'while scanning an anchor' : 'while scanning an alias', start,
        'did not find expected alphabetic or numeric character')
    }
    return { type, start, end, value: Buffer.from(string).toString('utf8') }
  }

  scanTag() {
    const start = copyMark(this.mark)
    let handle
    let suffix
    if (this.check('<', 1)) {
      handle = []
      this.skip()
      this.skip()
      suffix = this.scanTagUri(true, false, null, start)
      if (!this.check('>')) throw this.error('while scanning a tag', start, "did not find the expected '>'")
      this.skip()
    } else {
      handle = this.scanTagHandle(false, start)
      if (handle[0] === ch('!') && handle.length > 1 && handle[handle.length - 1] === ch('!')) {
        suffix = this.scanTagUri(false, false, null, start)
      } else {
        suffix = this.scanTagUri(false, false, handle, start)
        handle = [ch('!')]
        if (suffix.length === 0) [handle, suffix] = [suffix, handle]
      }
    }
    if (!this.isBlankz() && (this.flowLevel === 0 || !this.check(','))) {
      throw this.error('while scanning a tag', start, 'did not find expected whitespace or line break')
    }
    return { type: 'TAG', start, end: copyMark(this.mark), handle, suffix }
  }

  scanTagHandle(directive, start) {
    if (!this.check('!')) {
      throw this.error(directive ? 'while scanning a tag directive' : 'while scanning a tag', start, "did not find expected '!'")
    }
    const string = []
    this.read(string)
    while (this.isAlpha()) this.read(string)
    if (this.check('!')) this.read(string)
    else if (directive && !(string.length === 1 && string[0] === ch('!'))) {
      throw this.error('while parsing a tag directive', start, "did not find expected '!'")
    }
    return string
  }

  scanTagUri(uriChar, directive, head, start) {
    let length = head ? head.length : 0
    const string = head && head.length > 1 ? head.slice(1) : []
    for (;;) {
      const a = this.at()
      const ok = this.isAlpha() || URI_CHARS.has(a) ||
        (uriChar && (a === ch(',') || a === ch('[') || a === ch(']')))
      if (!ok) break
      if (this.check('%')) this.scanUriEscapes(directive, start, string)
      else this.read(string)
      length++
    }
    if (length === 0) {
      throw this.error(directive ? 'while parsing a %TAG directive' : 'while parsing a tag', start, 'did not find expected tag URI')
    }
    return string
  }

  scanUriEscapes(directive, start, string) {
    const context = directive ? 'while parsing a %TAG directive' : 'while parsing a tag'
    let width = 0
    do {
      if (!(this.check('%') && this.isHex(1) && this.isHex(2))) throw this.error(context, start, 'did not find URI escaped octet')
      const octet = (this.asHex(1) << 4) + this.asHex(2)
      if (width === 0) {
        width = (octet & 0x80) === 0 ? 1 : (octet & 0xe0) === 0xc0 ? 2 : (octet & 0xf0) === 0xe0 ? 3 : (octet & 0xf8) === 0xf0 ? 4 : 0
        if (width === 0) throw this.error(context, start, 'found an incorrect leading UTF-8 octet')
      } else if ((octet & 0xc0) !== 0x80) {
        throw this.error(context, start, 'found an incorrect trailing UTF-8 octet')
      }
      string.push(octet)
      this.skip()
      this.skip()
      this.skip()
      width--
    } while (width !== 0)
  }

  scanBlockScalar(literal) {
    const start = copyMark(this.mark)
    this.skip()
    let chomping = 0
    let increment = 0
    const zeroIndicator = () => this.error('while scanning a block scalar', start, 'found an indentation indicator equal to 0')
    if (this.check('+') || this.check('-')) {
      chomping = this.check('+') ? 1 : -1
      this.skip()
      if (this.isDigit()) {
        if (this.check('0')) throw zeroIndicator()
        increment = this.at() - 48
        this.skip()
      }
    } else if (this.isDigit()) {
      if (this.check('0')) throw zeroIndicator()
      increment = this.at() - 48
      this.skip()
      if (this.check('+') || this.check('-')) {
        chomping = this.check('+') ? 1 : -1
        this.skip()
      }
    }
    while (this.isBlank()) this.skip()
    if (this.check('#')) while (!this.isBreakz()) this.skip()
    if (!this.isBreakz()) throw this.error('while scanning a block scalar', start, 'did not find expected comment or line break')
    if (this.isBreak()) this.skipLine()
    const state = { indent: 0, end: copyMark(this.mark) }
    if (increment !== 0) state.indent = this.indent >= 0 ? this.indent + increment : increment
    let string = []
    let leadingBreak = []
    let trailingBreaks = []
    this.scanBlockScalarBreaks(state, trailingBreaks, start)
    let leadingBlank = false
    while (this.mark.column === state.indent && !this.isZ()) {
      const trailingBlank = this.isBlank()
      if (!literal && leadingBreak[0] === 10 && !leadingBlank && !trailingBlank) {
        if (trailingBreaks.length === 0) string.push(32)
        leadingBreak = []
      } else {
        string = string.concat(leadingBreak)
        leadingBreak = []
      }
      string = string.concat(trailingBreaks)
      trailingBreaks = []
      leadingBlank = this.isBlank()
      while (!this.isBreakz()) this.read(string)
      this.readLine(leadingBreak)
      this.scanBlockScalarBreaks(state, trailingBreaks, start)
    }
    if (chomping !== -1) string = string.concat(leadingBreak)
    if (chomping === 1) string = string.concat(trailingBreaks)
    return { type: 'SCALAR', start, end: state.end, value: string, style: literal ? 'Literal' : 'Folded' }
  }

  scanBlockScalarBreaks(state, breaks, start) {
    let maxIndent = 0
    state.end = copyMark(this.mark)
    for (;;) {
      while ((state.indent === 0 || this.mark.column < state.indent) && this.check(' ')) this.skip()
      if (this.mark.column > maxIndent) maxIndent = this.mark.column
      if ((state.indent === 0 || this.mark.column < state.indent) && this.check('\t')) {
        throw this.error('while scanning a block scalar', start, 'found a tab character where an indentation space is expected')
      }
      if (!this.isBreak()) break
      this.readLine(breaks)
      state.end = copyMark(this.mark)
    }
    if (state.indent === 0) {
      state.indent = maxIndent
      if (state.indent < this.indent + 1) state.indent = this.indent + 1
      if (state.indent < 1) state.indent = 1
    }
  }

  isDocumentIndicator() {
    return this.mark.column === 0 &&
      ((this.check('-') && this.check('-', 1) && this.check('-', 2)) || (this.check('.') && this.check('.', 1) && this.check('.', 2))) &&
      this.isBlankz(3)
  }

  scanFlowScalar(single) {
    const start = copyMark(this.mark)
    this.skip()
    let string = []
    let leadingBreak = []
    let trailingBreaks = []
    let whitespaces = []
    const quote = single ? "'" : '"'
    const simpleEscapes = {
      '0': [0], a: [7], b: [8], t: [9], '\t': [9], n: [10], v: [11], f: [12], r: [13], e: [27], ' ': [32],
      '"': [34], '/': [47], '\\': [92], N: [0xc2, 0x85], _: [0xc2, 0xa0], L: [0xe2, 0x80, 0xa8], P: [0xe2, 0x80, 0xa9],
    }
    for (;;) {
      if (this.isDocumentIndicator()) throw this.error('while scanning a quoted scalar', start, 'found unexpected document indicator')
      if (this.isZ()) throw this.error('while scanning a quoted scalar', start, 'found unexpected end of stream')
      let leadingBlanks = false
      while (!this.isBlankz()) {
        if (single && this.check("'") && this.check("'", 1)) {
          string.push(39)
          this.skip()
          this.skip()
          continue
        }
        if (this.check(quote)) break
        if (!single && this.check('\\') && this.isBreak(1)) {
          this.skip()
          this.skipLine()
          leadingBlanks = true
          break
        }
        if (!single && this.check('\\')) {
          const next = String.fromCharCode(this.at(1))
          let codeLength = 0
          if (Object.hasOwn(simpleEscapes, next)) string = string.concat(simpleEscapes[next])
          else if (next === 'x') codeLength = 2
          else if (next === 'u') codeLength = 4
          else if (next === 'U') codeLength = 8
          else throw this.error('while parsing a quoted scalar', start, 'found unknown escape character')
          this.skip()
          this.skip()
          if (codeLength !== 0) {
            let value = 0
            for (let k = 0; k < codeLength; k++) {
              if (!this.isHex(k)) throw this.error('while parsing a quoted scalar', start, 'did not find expected hexadecimal number')
              value = value * 16 + this.asHex(k)
            }
            if ((value >= 0xd800 && value <= 0xdfff) || value > 0x10ffff) {
              throw this.error('while parsing a quoted scalar', start, 'found invalid Unicode character escape code')
            }
            string = string.concat([...Buffer.from(String.fromCodePoint(value), 'utf8')])
            for (let k = 0; k < codeLength; k++) this.skip()
          }
          continue
        }
        this.read(string)
      }
      if (this.check(quote)) break
      while (this.isBlank() || this.isBreak()) {
        if (this.isBlank()) {
          if (!leadingBlanks) this.read(whitespaces)
          else this.skip()
        } else if (!leadingBlanks) {
          whitespaces = []
          this.readLine(leadingBreak)
          leadingBlanks = true
        } else {
          this.readLine(trailingBreaks)
        }
      }
      if (leadingBlanks) {
        if (leadingBreak[0] === 10) {
          if (trailingBreaks.length === 0) string.push(32)
          else {
            string = string.concat(trailingBreaks)
            trailingBreaks = []
          }
          leadingBreak = []
        } else {
          string = string.concat(leadingBreak, trailingBreaks)
          leadingBreak = []
          trailingBreaks = []
        }
      } else {
        string = string.concat(whitespaces)
        whitespaces = []
      }
    }
    this.skip()
    return { type: 'SCALAR', start, end: copyMark(this.mark), value: string, style: single ? 'SingleQuoted' : 'DoubleQuoted' }
  }

  scanPlainScalar() {
    let string = []
    let leadingBreak = []
    let trailingBreaks = []
    let whitespaces = []
    let leadingBlanks = false
    const indent = this.indent + 1
    let end = copyMark(this.mark)
    const start = copyMark(this.mark)
    for (;;) {
      if (this.isDocumentIndicator()) break
      if (this.check('#')) break
      while (!this.isBlankz()) {
        if (this.flowLevel !== 0 && this.check(':') && [...',?[]{}'].some((c) => this.check(c, 1))) {
          throw this.error('while scanning a plain scalar', start, "found unexpected ':'")
        }
        if ((this.check(':') && this.isBlankz(1)) ||
            (this.flowLevel !== 0 && [...',[]{}'].some((c) => this.check(c)))) break
        if (leadingBlanks || whitespaces.length !== 0) {
          if (leadingBlanks) {
            if (leadingBreak[0] === 10) {
              if (trailingBreaks.length === 0) string.push(32)
              else {
                string = string.concat(trailingBreaks)
                trailingBreaks = []
              }
              leadingBreak = []
            } else {
              string = string.concat(leadingBreak, trailingBreaks)
              leadingBreak = []
              trailingBreaks = []
            }
            leadingBlanks = false
          } else {
            string = string.concat(whitespaces)
            whitespaces = []
          }
        }
        this.read(string)
        end = copyMark(this.mark)
      }
      if (!(this.isBlank() || this.isBreak())) break
      while (this.isBlank() || this.isBreak()) {
        if (this.isBlank()) {
          if (leadingBlanks && this.mark.column < indent && this.check('\t')) {
            throw this.error('while scanning a plain scalar', start, 'found a tab character that violates indentation')
          }
          if (!leadingBlanks) this.read(whitespaces)
          else this.skip()
        } else if (!leadingBlanks) {
          whitespaces = []
          this.readLine(leadingBreak)
          leadingBlanks = true
        } else {
          this.readLine(trailingBreaks)
        }
      }
      if (this.flowLevel === 0 && this.mark.column < indent) break
    }
    if (leadingBlanks) this.simpleKeyAllowed = true
    return { type: 'SCALAR', start, end, value: string, style: 'Plain' }
  }
}

// ---------------------------------------------------------------------------------------------
// Parser (unsafe-libyaml parser.rs)

class Parser {
  constructor(bytes) {
    this.scanner = new Scanner(bytes)
    this.state = 'STREAM_START'
    this.states = []
    this.marks = []
    this.tagDirectives = []
    this.error = null
    this.done = false
  }

  peekToken() {
    const s = this.scanner
    if (!s.tokenAvailable) s.fetchMoreTokens()
    return s.tokens[0]
  }

  skipToken() {
    const s = this.scanner
    s.tokenAvailable = false
    s.tokensParsed++
    s.streamEndProduced = s.tokens[0].type === 'STREAM_END'
    s.tokens.shift()
  }

  next() {
    if (this.error) throw this.error
    try {
      return this.stateMachine()
    } catch (e) {
      if (e instanceof LibyamlError) this.error = e
      throw e
    }
  }

  parserError(problem, problemMark, context = null, contextMark = null) {
    return new LibyamlError({ problem, problemMark: copyMark(problemMark), context, contextMark: contextMark && copyMark(contextMark) })
  }

  stateMachine() {
    switch (this.state) {
      case 'STREAM_START': return this.parseStreamStart()
      case 'IMPLICIT_DOCUMENT_START': return this.parseDocumentStart(true)
      case 'DOCUMENT_START': return this.parseDocumentStart(false)
      case 'DOCUMENT_CONTENT': return this.parseDocumentContent()
      case 'DOCUMENT_END': return this.parseDocumentEnd()
      case 'BLOCK_NODE': return this.parseNode(true, false)
      case 'BLOCK_NODE_OR_INDENTLESS_SEQUENCE': return this.parseNode(true, true)
      case 'FLOW_NODE': return this.parseNode(false, false)
      case 'BLOCK_SEQUENCE_FIRST_ENTRY': return this.parseBlockSequenceEntry(true)
      case 'BLOCK_SEQUENCE_ENTRY': return this.parseBlockSequenceEntry(false)
      case 'INDENTLESS_SEQUENCE_ENTRY': return this.parseIndentlessSequenceEntry()
      case 'BLOCK_MAPPING_FIRST_KEY': return this.parseBlockMappingKey(true)
      case 'BLOCK_MAPPING_KEY': return this.parseBlockMappingKey(false)
      case 'BLOCK_MAPPING_VALUE': return this.parseBlockMappingValue()
      case 'FLOW_SEQUENCE_FIRST_ENTRY': return this.parseFlowSequenceEntry(true)
      case 'FLOW_SEQUENCE_ENTRY': return this.parseFlowSequenceEntry(false)
      case 'FLOW_SEQUENCE_ENTRY_MAPPING_KEY': return this.parseFlowSequenceEntryMappingKey()
      case 'FLOW_SEQUENCE_ENTRY_MAPPING_VALUE': return this.parseFlowSequenceEntryMappingValue()
      case 'FLOW_SEQUENCE_ENTRY_MAPPING_END': return this.parseFlowSequenceEntryMappingEnd()
      case 'FLOW_MAPPING_FIRST_KEY': return this.parseFlowMappingKey(true)
      case 'FLOW_MAPPING_KEY': return this.parseFlowMappingKey(false)
      case 'FLOW_MAPPING_VALUE': return this.parseFlowMappingValue(false)
      case 'FLOW_MAPPING_EMPTY_VALUE': return this.parseFlowMappingValue(true)
      default: throw new Error(`unknown libyaml parser state ${this.state}`)
    }
  }

  parseStreamStart() {
    const token = this.peekToken()
    if (token.type !== 'STREAM_START') throw this.parserError('did not find expected <stream-start>', token.start)
    this.state = 'IMPLICIT_DOCUMENT_START'
    this.skipToken()
    return { type: 'StreamStart', start: token.start }
  }

  parseDocumentStart(implicit) {
    let token = this.peekToken()
    if (!implicit) {
      while (token.type === 'DOCUMENT_END') {
        this.skipToken()
        token = this.peekToken()
      }
    }
    if (implicit && !['VERSION_DIRECTIVE', 'TAG_DIRECTIVE', 'DOCUMENT_START', 'STREAM_END'].includes(token.type)) {
      this.processDirectives()
      this.states.push('DOCUMENT_END')
      this.state = 'BLOCK_NODE'
      return { type: 'DocumentStart', start: token.start }
    }
    if (token.type !== 'STREAM_END') {
      const start = token.start
      this.processDirectives()
      token = this.peekToken()
      if (token.type !== 'DOCUMENT_START') throw this.parserError('did not find expected <document start>', token.start)
      this.states.push('DOCUMENT_END')
      this.state = 'DOCUMENT_CONTENT'
      this.skipToken()
      return { type: 'DocumentStart', start }
    }
    this.state = 'END'
    this.skipToken()
    return { type: 'StreamEnd', start: token.start }
  }

  parseDocumentContent() {
    const token = this.peekToken()
    if (['VERSION_DIRECTIVE', 'TAG_DIRECTIVE', 'DOCUMENT_START', 'DOCUMENT_END', 'STREAM_END'].includes(token.type)) {
      this.state = this.states.pop()
      return emptyScalar(token.start)
    }
    return this.parseNode(true, false)
  }

  parseDocumentEnd() {
    const token = this.peekToken()
    const start = token.start
    if (token.type === 'DOCUMENT_END') this.skipToken()
    this.tagDirectives = []
    this.state = 'DOCUMENT_START'
    return { type: 'DocumentEnd', start }
  }

  parseNode(block, indentlessSequence) {
    let token = this.peekToken()
    if (token.type === 'ALIAS') {
      this.state = this.states.pop()
      this.skipToken()
      return { type: 'Alias', start: token.start, anchor: token.value }
    }
    let anchor = null
    let tagHandle = null
    let tagSuffix = null
    let tagMark = { index: 0, line: 0, column: 0 }
    let start = token.start
    if (token.type === 'ANCHOR') {
      anchor = token.value
      start = token.start
      this.skipToken()
      token = this.peekToken()
      if (token.type === 'TAG') {
        tagHandle = token.handle
        tagSuffix = token.suffix
        tagMark = token.start
        this.skipToken()
        token = this.peekToken()
      }
    } else if (token.type === 'TAG') {
      tagHandle = token.handle
      tagSuffix = token.suffix
      tagMark = token.start
      start = tagMark
      this.skipToken()
      token = this.peekToken()
      if (token.type === 'ANCHOR') {
        anchor = token.value
        this.skipToken()
        token = this.peekToken()
      }
    }
    let tag = null
    if (tagHandle !== null) {
      if (tagHandle.length === 0) tag = tagSuffix
      else {
        const handle = Buffer.from(tagHandle).toString('latin1')
        const directive = this.tagDirectives.find((d) => d.handle === handle)
        if (!directive) throw this.parserError('found undefined tag handle', tagMark, 'while parsing a node', start)
        tag = [...Buffer.from(directive.prefix, 'latin1'), ...tagSuffix]
      }
    }
    const tagText = tag === null ? null : Buffer.from(tag).toString('utf8')
    if (indentlessSequence && token.type === 'BLOCK_ENTRY') {
      this.state = 'INDENTLESS_SEQUENCE_ENTRY'
      return { type: 'SequenceStart', start, anchor, tag: tagText }
    }
    if (token.type === 'SCALAR') {
      this.state = this.states.pop()
      this.skipToken()
      return { type: 'Scalar', start, anchor, tag: tagText, value: token.value, style: token.style }
    }
    if (token.type === 'FLOW_SEQUENCE_START') {
      this.state = 'FLOW_SEQUENCE_FIRST_ENTRY'
      return { type: 'SequenceStart', start, anchor, tag: tagText }
    }
    if (token.type === 'FLOW_MAPPING_START') {
      this.state = 'FLOW_MAPPING_FIRST_KEY'
      return { type: 'MappingStart', start, anchor, tag: tagText }
    }
    if (block && token.type === 'BLOCK_SEQUENCE_START') {
      this.state = 'BLOCK_SEQUENCE_FIRST_ENTRY'
      return { type: 'SequenceStart', start, anchor, tag: tagText }
    }
    if (block && token.type === 'BLOCK_MAPPING_START') {
      this.state = 'BLOCK_MAPPING_FIRST_KEY'
      return { type: 'MappingStart', start, anchor, tag: tagText }
    }
    if (anchor !== null || tag !== null) {
      this.state = this.states.pop()
      return { type: 'Scalar', start, anchor, tag: tagText, value: [], style: 'Plain' }
    }
    throw this.parserError('did not find expected node content', token.start,
      block ? 'while parsing a block node' : 'while parsing a flow node', start)
  }

  parseBlockSequenceEntry(first) {
    if (first) {
      this.marks.push(this.peekToken().start)
      this.skipToken()
    }
    let token = this.peekToken()
    if (token.type === 'BLOCK_ENTRY') {
      const mark = token.end
      this.skipToken()
      token = this.peekToken()
      if (token.type !== 'BLOCK_ENTRY' && token.type !== 'BLOCK_END') {
        this.states.push('BLOCK_SEQUENCE_ENTRY')
        return this.parseNode(true, false)
      }
      this.state = 'BLOCK_SEQUENCE_ENTRY'
      return emptyScalar(mark)
    }
    if (token.type === 'BLOCK_END') {
      this.state = this.states.pop()
      this.marks.pop()
      this.skipToken()
      return { type: 'SequenceEnd', start: token.start }
    }
    throw this.parserError("did not find expected '-' indicator", token.start, 'while parsing a block collection', this.marks.pop())
  }

  parseIndentlessSequenceEntry() {
    let token = this.peekToken()
    if (token.type === 'BLOCK_ENTRY') {
      const mark = token.end
      this.skipToken()
      token = this.peekToken()
      if (!['BLOCK_ENTRY', 'KEY', 'VALUE', 'BLOCK_END'].includes(token.type)) {
        this.states.push('INDENTLESS_SEQUENCE_ENTRY')
        return this.parseNode(true, false)
      }
      this.state = 'INDENTLESS_SEQUENCE_ENTRY'
      return emptyScalar(mark)
    }
    this.state = this.states.pop()
    return { type: 'SequenceEnd', start: token.start }
  }

  parseBlockMappingKey(first) {
    if (first) {
      this.marks.push(this.peekToken().start)
      this.skipToken()
    }
    let token = this.peekToken()
    if (token.type === 'KEY') {
      const mark = token.end
      this.skipToken()
      token = this.peekToken()
      if (!['KEY', 'VALUE', 'BLOCK_END'].includes(token.type)) {
        this.states.push('BLOCK_MAPPING_VALUE')
        return this.parseNode(true, true)
      }
      this.state = 'BLOCK_MAPPING_VALUE'
      return emptyScalar(mark)
    }
    if (token.type === 'BLOCK_END') {
      this.state = this.states.pop()
      this.marks.pop()
      this.skipToken()
      return { type: 'MappingEnd', start: token.start }
    }
    throw this.parserError('did not find expected key', token.start, 'while parsing a block mapping', this.marks.pop())
  }

  parseBlockMappingValue() {
    let token = this.peekToken()
    if (token.type === 'VALUE') {
      const mark = token.end
      this.skipToken()
      token = this.peekToken()
      if (!['KEY', 'VALUE', 'BLOCK_END'].includes(token.type)) {
        this.states.push('BLOCK_MAPPING_KEY')
        return this.parseNode(true, true)
      }
      this.state = 'BLOCK_MAPPING_KEY'
      return emptyScalar(mark)
    }
    this.state = 'BLOCK_MAPPING_KEY'
    return emptyScalar(token.start)
  }

  parseFlowSequenceEntry(first) {
    if (first) {
      this.marks.push(this.peekToken().start)
      this.skipToken()
    }
    let token = this.peekToken()
    if (token.type !== 'FLOW_SEQUENCE_END') {
      if (!first) {
        if (token.type === 'FLOW_ENTRY') {
          this.skipToken()
          token = this.peekToken()
        } else {
          throw this.parserError("did not find expected ',' or ']'", token.start, 'while parsing a flow sequence', this.marks.pop())
        }
      }
      if (token.type === 'KEY') {
        this.state = 'FLOW_SEQUENCE_ENTRY_MAPPING_KEY'
        this.skipToken()
        return { type: 'MappingStart', start: token.start, anchor: null, tag: null }
      }
      if (token.type !== 'FLOW_SEQUENCE_END') {
        this.states.push('FLOW_SEQUENCE_ENTRY')
        return this.parseNode(false, false)
      }
    }
    this.state = this.states.pop()
    this.marks.pop()
    this.skipToken()
    return { type: 'SequenceEnd', start: token.start }
  }

  parseFlowSequenceEntryMappingKey() {
    const token = this.peekToken()
    if (!['VALUE', 'FLOW_ENTRY', 'FLOW_SEQUENCE_END'].includes(token.type)) {
      this.states.push('FLOW_SEQUENCE_ENTRY_MAPPING_VALUE')
      return this.parseNode(false, false)
    }
    const mark = token.end
    this.skipToken()
    this.state = 'FLOW_SEQUENCE_ENTRY_MAPPING_VALUE'
    return emptyScalar(mark)
  }

  parseFlowSequenceEntryMappingValue() {
    let token = this.peekToken()
    if (token.type === 'VALUE') {
      this.skipToken()
      token = this.peekToken()
      if (token.type !== 'FLOW_ENTRY' && token.type !== 'FLOW_SEQUENCE_END') {
        this.states.push('FLOW_SEQUENCE_ENTRY_MAPPING_END')
        return this.parseNode(false, false)
      }
    }
    this.state = 'FLOW_SEQUENCE_ENTRY_MAPPING_END'
    return emptyScalar(token.start)
  }

  parseFlowSequenceEntryMappingEnd() {
    const token = this.peekToken()
    this.state = 'FLOW_SEQUENCE_ENTRY'
    return { type: 'MappingEnd', start: token.start }
  }

  parseFlowMappingKey(first) {
    if (first) {
      this.marks.push(this.peekToken().start)
      this.skipToken()
    }
    let token = this.peekToken()
    if (token.type !== 'FLOW_MAPPING_END') {
      if (!first) {
        if (token.type === 'FLOW_ENTRY') {
          this.skipToken()
          token = this.peekToken()
        } else {
          throw this.parserError("did not find expected ',' or '}'", token.start, 'while parsing a flow mapping', this.marks.pop())
        }
      }
      if (token.type === 'KEY') {
        this.skipToken()
        token = this.peekToken()
        if (!['VALUE', 'FLOW_ENTRY', 'FLOW_MAPPING_END'].includes(token.type)) {
          this.states.push('FLOW_MAPPING_VALUE')
          return this.parseNode(false, false)
        }
        this.state = 'FLOW_MAPPING_VALUE'
        return emptyScalar(token.start)
      }
      if (token.type !== 'FLOW_MAPPING_END') {
        this.states.push('FLOW_MAPPING_EMPTY_VALUE')
        return this.parseNode(false, false)
      }
    }
    this.state = this.states.pop()
    this.marks.pop()
    this.skipToken()
    return { type: 'MappingEnd', start: token.start }
  }

  parseFlowMappingValue(empty) {
    let token = this.peekToken()
    if (empty) {
      this.state = 'FLOW_MAPPING_KEY'
      return emptyScalar(token.start)
    }
    if (token.type === 'VALUE') {
      this.skipToken()
      token = this.peekToken()
      if (token.type !== 'FLOW_ENTRY' && token.type !== 'FLOW_MAPPING_END') {
        this.states.push('FLOW_MAPPING_KEY')
        return this.parseNode(false, false)
      }
    }
    this.state = 'FLOW_MAPPING_KEY'
    return emptyScalar(token.start)
  }

  processDirectives() {
    let version = false
    let token = this.peekToken()
    while (token.type === 'VERSION_DIRECTIVE' || token.type === 'TAG_DIRECTIVE') {
      if (token.type === 'VERSION_DIRECTIVE') {
        if (version) throw this.parserError('found duplicate %YAML directive', token.start)
        if (token.major !== 1 || (token.minor !== 1 && token.minor !== 2)) {
          throw this.parserError('found incompatible YAML document', token.start)
        }
        version = true
      } else {
        this.appendTagDirective(Buffer.from(token.handle).toString('latin1'), Buffer.from(token.prefix).toString('latin1'), false, token.start)
      }
      this.skipToken()
      token = this.peekToken()
    }
    this.appendTagDirective('!', '!', true, token.start)
    this.appendTagDirective('!!', 'tag:yaml.org,2002:', true, token.start)
  }

  appendTagDirective(handle, prefix, allowDuplicates, mark) {
    if (this.tagDirectives.some((d) => d.handle === handle)) {
      if (allowDuplicates) return
      throw this.parserError('found duplicate %TAG directive', mark)
    }
    this.tagDirectives.push({ handle, prefix })
  }
}

function emptyScalar(mark) {
  return { type: 'Scalar', start: mark, anchor: null, tag: null, value: [], style: 'Plain' }
}

// unsafe-libyaml reader: the whole input is decoded before the first token, so a character outside YAML's
// printable set fails first, at its byte offset.
function readerCheck(text) {
  let offset = 0
  for (const c of text) {
    const v = c.codePointAt(0)
    const ok = v === 0x9 || v === 0xa || v === 0xd || (v >= 0x20 && v <= 0x7e) || v === 0x85 ||
      (v >= 0xa0 && v <= 0xd7ff) || (v >= 0xe000 && v <= 0xfffd) || (v >= 0x10000 && v <= 0x10ffff)
    if (!ok) return new LibyamlError({ problem: 'control characters are not allowed', offset })
    offset += Buffer.byteLength(c)
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// serde_yaml loader

class Loader {
  constructor(text) {
    this.parser = new Parser(Buffer.from(text, 'utf8'))
    this.readerError = readerCheck(text)
    this.count = 0
  }

  nextEvent() {
    if (this.readerError) throw this.readerError
    return this.parser.next()
  }

  nextDocument() {
    if (!this.parser) return null
    const first = this.count === 0
    this.count++
    const anchors = new Map()
    const doc = { events: [], error: null, aliases: new Map() }
    for (;;) {
      let event
      try {
        event = this.nextEvent()
      } catch (e) {
        if (!(e instanceof LibyamlError)) throw e
        // Like serde_yaml, the events read so far are deserialized first; parseYaml then throws doc.error.
        doc.error = e
        return doc
      }
      switch (event.type) {
        case 'StreamStart':
        case 'DocumentStart':
          continue
        case 'StreamEnd':
          this.parser = null
          if (!first) return null
          if (doc.events.length === 0) doc.events.push({ type: 'Void', start: event.start })
          return doc
        case 'DocumentEnd':
          return doc
        case 'Alias':
          if (!anchors.has(event.anchor)) {
            doc.error = new YamlError('unknownAnchor', null, event.start)
            return doc
          }
          doc.events.push({ type: 'Alias', start: event.start, id: anchors.get(event.anchor) })
          continue
        default:
          if (event.anchor !== null && event.anchor !== undefined) {
            const id = anchors.size
            anchors.set(event.anchor, id)
            doc.aliases.set(id, doc.events.length)
          }
          doc.events.push(event)
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// serde_yaml de.rs: DeserializerFromEvents and the serde visitors for confy's schemas

const TAG = {
  NULL: 'tag:yaml.org,2002:null',
  BOOL: 'tag:yaml.org,2002:bool',
  INT: 'tag:yaml.org,2002:int',
  FLOAT: 'tag:yaml.org,2002:float',
}
const DONE = Symbol('done')

function floatText(value) {
  const text = rustDisplayFloat(value)
  return Number.isFinite(value) && !text.includes('.') ? `${text}.0` : text
}

const scalarText = (event) => Buffer.from(event.value).toString('utf8')
const parseNull = (v) => v === 'null' || v === 'Null' || v === 'NULL' || v === '~'

function parseBool(v) {
  if (v === 'true' || v === 'True' || v === 'TRUE') return true
  if (v === 'false' || v === 'False' || v === 'FALSE') return false
  return null
}

const BITS = { u64: [0n, 2n ** 64n - 1n], i64: [-(2n ** 63n), 2n ** 63n - 1n], u128: [0n, 2n ** 128n - 1n], i128: [-(2n ** 127n), 2n ** 127n - 1n] }

// Rust `<int>::from_str_radix`.
function fromStrRadix(s, radix, kind) {
  const signed = kind[0] === 'i'
  let body = s
  let negative = false
  if (body.startsWith('+')) body = body.slice(1)
  else if (body.startsWith('-') && signed) {
    negative = true
    body = body.slice(1)
  }
  if (body === '') return null
  let value = 0n
  for (const c of body) {
    const d = /^[0-9a-zA-Z]$/.test(c) ? parseInt(c, 36) : 99
    if (d >= radix) return null
    value = value * BigInt(radix) + BigInt(d)
  }
  if (negative) value = -value
  const [lo, hi] = BITS[kind]
  return value < lo || value > hi ? null : value
}

function digitsButNotNumber(scalar) {
  const s = scalar.startsWith('-') || scalar.startsWith('+') ? scalar.slice(1) : scalar
  return s.length > 1 && s.startsWith('0') && /^[0-9]+$/.test(s.slice(1))
}

function parseUnsignedInt(scalar, kind) {
  const unpositive = scalar.startsWith('+') ? scalar.slice(1) : scalar
  for (const [prefix, radix] of [['0x', 16], ['0o', 8], ['0b', 2]]) {
    if (unpositive.startsWith(prefix)) {
      const rest = unpositive.slice(2)
      if (rest.startsWith('+') || rest.startsWith('-')) return null
      const v = fromStrRadix(rest, radix, kind)
      if (v !== null) return v
    }
  }
  if (unpositive.startsWith('+') || unpositive.startsWith('-')) return null
  if (digitsButNotNumber(scalar)) return null
  return fromStrRadix(unpositive, 10, kind)
}

function parseSignedInt(scalar, kind) {
  let unpositive = scalar
  if (scalar.startsWith('+')) {
    unpositive = scalar.slice(1)
    if (unpositive.startsWith('+') || unpositive.startsWith('-')) return null
  }
  for (const [prefix, radix] of [['0x', 16], ['0o', 8], ['0b', 2]]) {
    if (unpositive.startsWith(prefix)) {
      const rest = unpositive.slice(2)
      if (rest.startsWith('+') || rest.startsWith('-')) return null
      const v = fromStrRadix(rest, radix, kind)
      if (v !== null) return v
    }
    if (scalar.startsWith(`-${prefix}`)) {
      const v = fromStrRadix(`-${scalar.slice(3)}`, radix, kind)
      if (v !== null) return v
    }
  }
  if (digitsButNotNumber(scalar)) return null
  return fromStrRadix(unpositive, 10, kind)
}

function parseNegativeInt(scalar, kind) {
  for (const [prefix, radix] of [['-0x', 16], ['-0o', 8], ['-0b', 2]]) {
    if (scalar.startsWith(prefix)) {
      const v = fromStrRadix(`-${scalar.slice(3)}`, radix, kind)
      if (v !== null) return v
    }
  }
  if (digitsButNotNumber(scalar)) return null
  return fromStrRadix(scalar, 10, kind)
}

// Rust `str::parse::<f64>` (finite results only, as serde_yaml's parse_f64 keeps).
function parseF64(scalar) {
  let unpositive = scalar
  if (scalar.startsWith('+')) {
    unpositive = scalar.slice(1)
    if (unpositive.startsWith('+') || unpositive.startsWith('-')) return null
  }
  if (['.inf', '.Inf', '.INF'].includes(unpositive)) return Infinity
  if (['-.inf', '-.Inf', '-.INF'].includes(scalar)) return -Infinity
  if (['.nan', '.NaN', '.NAN'].includes(scalar)) return NaN
  if (!/^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(unpositive)) return null
  const v = Number(unpositive)
  return Number.isFinite(v) ? v : null
}

// What a serde visitor that accepts nothing is shown for an untagged plain scalar (visit_untagged_scalar).
function untaggedUnexpected(v) {
  if (v === '' || parseNull(v)) return 'unit value'
  const b = parseBool(v)
  if (b !== null) return `boolean \`${b}\``
  let n = parseUnsignedInt(v, 'u64')
  if (n !== null) return `integer \`${n}\``
  n = parseNegativeInt(v, 'i64')
  if (n !== null) return `integer \`${n}\``
  n = parseUnsignedInt(v, 'u128')
  if (n !== null) return `integer \`${n}\` as u128`
  n = parseNegativeInt(v, 'i128')
  if (n !== null) return `integer \`${n}\` as i128`
  if (!digitsButNotNumber(v)) {
    const f = parseF64(v)
    if (f !== null) return `floating point \`${floatText(f)}\``
  }
  return `string ${rustDebugString(v)}`
}

// serde_yaml's invalid_type(event, exp).
function invalidType(event, expected) {
  if (event.type === 'Scalar') {
    const v = scalarText(event)
    const tag = event.tag
    if (tag !== null) {
      if (tag === TAG.BOOL) {
        const b = parseBool(v)
        if (b === null) return custom(`invalid value: string ${rustDebugString(v)}, expected a boolean`)
        return custom(`invalid type: boolean \`${b}\`, expected ${expected}`)
      }
      if (tag === TAG.INT) {
        const u = parseUnsignedInt(v, 'u64') ?? parseNegativeInt(v, 'i64')
        if (u !== null) return custom(`invalid type: integer \`${u}\`, expected ${expected}`)
        const u128 = parseUnsignedInt(v, 'u128')
        if (u128 !== null) return custom(`invalid type: integer \`${u128}\` as u128, expected ${expected}`)
        const i128 = parseNegativeInt(v, 'i128')
        if (i128 !== null) return custom(`invalid type: integer \`${i128}\` as i128, expected ${expected}`)
        return custom(`invalid value: string ${rustDebugString(v)}, expected an integer`)
      }
      if (tag === TAG.FLOAT) {
        const f = parseF64(v)
        if (f === null) return custom(`invalid value: string ${rustDebugString(v)}, expected a float`)
        return custom(`invalid type: floating point \`${floatText(f)}\`, expected ${expected}`)
      }
      if (tag === TAG.NULL) {
        if (!parseNull(v)) return custom(`invalid value: string ${rustDebugString(v)}, expected null`)
        return custom(`invalid type: unit value, expected ${expected}`)
      }
      if (tag.startsWith('!') && event.style === 'Plain') return custom(`invalid type: ${untaggedUnexpected(v)}, expected ${expected}`)
    } else if (event.style === 'Plain') {
      return custom(`invalid type: ${untaggedUnexpected(v)}, expected ${expected}`)
    }
    return custom(`invalid type: string ${rustDebugString(v)}, expected ${expected}`)
  }
  if (event.type === 'SequenceStart') return custom(`invalid type: sequence, expected ${expected}`)
  if (event.type === 'MappingStart') return custom(`invalid type: map, expected ${expected}`)
  return new YamlError('eof')
}

function plainOrTaggedLiteral(expectedTag, event) {
  return event.style === 'Plain' || (event.style === 'Literal' && event.tag === expectedTag)
}

function expecting(schema) {
  switch (schema.kind) {
    case 'bool': return 'a boolean'
    case 'string': return 'a string'
    case 'vec': return 'a sequence'
    case 'map': return 'a map'
    case 'struct': return `struct ${schema.name}`
    default: return schema.kind
  }
}

class Deserializer {
  constructor(doc, pos, jumps, path, depth) {
    this.doc = doc
    this.pos = pos
    this.jumps = jumps
    this.path = path
    this.depth = depth
  }

  peek() {
    const event = this.doc.events[this.pos.v]
    if (!event) throw this.doc.error ?? new YamlError('eof')
    return event
  }

  next() {
    const event = this.peek()
    this.pos.v++
    return event
  }

  jump(id) {
    this.jumps.v++
    if (this.jumps.v > this.doc.events.length * 100) throw new YamlError('repetition')
    return new Deserializer(this.doc, { v: this.doc.aliases.get(id) }, this.jumps, { kind: 'alias', parent: this.path }, this.depth)
  }

  withMark(mark, fn) {
    try {
      return fn()
    } catch (e) {
      throw fixMark(e, mark, this.path)
    }
  }

  deserialize(schema) {
    switch (schema.kind) {
      case 'option':
        return this.option(schema.inner)
      case 'bool':
        return this.scalarOf(TAG.BOOL, schema, (v) => parseBool(v), (b) => b, (d) => d.deserialize(schema))
      case 'string':
        return this.str('a string')
      case 'f32':
      case 'f64':
        return this.scalarOf(TAG.FLOAT, schema, parseF64, (f) => (schema.kind === 'f32' ? Math.fround(f) : f), (d) => d.deserialize(schema))
      case 'vec':
        return this.seq(schema)
      case 'map':
      case 'struct':
        return this.map(schema)
      default: {
        const signed = schema.kind[0] === 'i'
        const parse = signed ? (v) => parseSignedInt(v, 'i64') : (v) => parseUnsignedInt(v, 'u64')
        return this.scalarOf(TAG.INT, schema, parse, (n) => {
          const [lo, hi] = integerRange(schema.kind)
          if (n < lo || n > hi) throw custom(`invalid value: integer \`${n}\`, expected ${schema.kind}`)
          return integerValue(n)
        }, (d) => d.deserialize(schema))
      }
    }
  }

  // deserialize_bool / deserialize_i64 / deserialize_u64 / deserialize_f64
  scalarOf(tag, schema, parse, visit, viaAlias) {
    const event = this.next()
    return this.withMark(event.start, () => {
      if (event.type === 'Alias') return viaAlias(this.jump(event.id))
      if (event.type === 'Scalar' && plainOrTaggedLiteral(tag, event)) {
        const parsed = parse(scalarText(event))
        if (parsed !== null) return visit(parsed)
      }
      throw invalidType(event, expecting(schema))
    })
  }

  str(expected) {
    const event = this.next()
    return this.withMark(event.start, () => {
      if (event.type === 'Scalar') return scalarText(event)
      if (event.type === 'Alias') return this.jump(event.id).str(expected)
      throw invalidType(event, expected)
    })
  }

  option(inner) {
    const event = this.peek()
    let isSome
    if (event.type === 'Alias') {
      this.pos.v++
      return this.jump(event.id).option(inner)
    }
    if (event.type === 'Scalar') {
      const v = scalarText(event)
      if (event.style !== 'Plain') isSome = true
      else if (event.tag !== null) {
        if (event.tag === TAG.NULL) {
          if (parseNull(v)) isSome = false
          else throw custom(`invalid value: string ${rustDebugString(v)}, expected null`)
        } else isSome = true
      } else isSome = v !== '' && !parseNull(v)
    } else {
      isSome = event.type === 'SequenceStart' || event.type === 'MappingStart'
    }
    if (isSome) return this.deserialize(inner)
    this.pos.v++
    return null
  }

  recursionCheck(mark, fn) {
    if (this.depth === 0) throw new YamlError('recursion', null, mark)
    this.depth--
    try {
      return fn()
    } finally {
      this.depth++
    }
  }

  isEmptyCollection(event) {
    return event.type === 'Void' || (event.type === 'Scalar' && event.value.length === 0 && event.style === 'Plain')
  }

  seq(schema) {
    const event = this.next()
    return this.withMark(event.start, () => {
      if (event.type === 'Alias') return this.jump(event.id).seq(schema)
      if (event.type === 'SequenceStart') {
        const [value, len] = this.recursionCheck(event.start, () => {
          const access = new SeqAccess(this, false, 0)
          const out = []
          for (let x = access.next((d) => d.deserialize(schema.item)); x !== DONE; x = access.next((d) => d.deserialize(schema.item))) out.push(x)
          return [out, access.len]
        })
        this.endSequence(len)
        return value
      }
      if (this.isEmptyCollection(event)) return []
      throw invalidType(event, expecting(schema))
    })
  }

  map(schema) {
    const event = this.next()
    return this.withMark(event.start, () => {
      if (event.type === 'Alias') return this.jump(event.id).map(schema)
      if (event.type === 'MappingStart') {
        const [value, len] = this.recursionCheck(event.start, () => {
          const access = new MapAccess(this, false, 0)
          return [visitMap(schema, access), access.len]
        })
        this.endMapping(len)
        return value
      }
      if (this.isEmptyCollection(event)) return visitMap(schema, new MapAccess(this, true, 0))
      throw invalidType(event, expecting(schema))
    })
  }

  endSequence(len) {
    const access = new SeqAccess(this, false, len)
    while (access.next((d) => d.ignore()) !== DONE);
    const event = this.next()
    if (event.type !== 'SequenceEnd' && event.type !== 'Void') throw new Error('expected a SequenceEnd event')
    if (access.len !== len) {
      throw custom(`invalid length ${access.len}, expected sequence of ${len} element${len === 1 ? '' : 's'}`)
    }
  }

  endMapping(len) {
    const access = new MapAccess(this, false, len)
    while (access.nextKey((d) => d.ignore()) !== DONE) access.nextValue((d) => d.ignore())
    const event = this.next()
    if (event.type !== 'MappingEnd' && event.type !== 'Void') throw new Error('expected a MappingEnd event')
    if (access.len !== len) {
      throw custom(`invalid length ${access.len}, expected map containing ${len} ${len === 1 ? 'entry' : 'entries'}`)
    }
  }

  ignore() {
    const stack = []
    for (;;) {
      const event = this.next()
      if (event.type === 'SequenceStart' || event.type === 'MappingStart') stack.push(event.type)
      else if (event.type === 'SequenceEnd' || event.type === 'MappingEnd') stack.pop()
      if (stack.length === 0) return undefined
    }
  }
}

class SeqAccess {
  constructor(de, empty, len) {
    Object.assign(this, { de, empty, len })
  }

  next(seed) {
    if (this.empty) return DONE
    const event = this.de.peek()
    if (event.type === 'SequenceEnd' || event.type === 'Void') return DONE
    const element = new Deserializer(this.de.doc, this.de.pos, this.de.jumps, { kind: 'seq', parent: this.de.path, index: this.len }, this.de.depth)
    this.len++
    return seed(element)
  }
}

class MapAccess {
  constructor(de, empty, len) {
    Object.assign(this, { de, empty, len, key: null })
  }

  nextKey(seed) {
    if (this.empty) return DONE
    const event = this.de.peek()
    if (event.type === 'MappingEnd' || event.type === 'Void') return DONE
    this.len++
    this.key = event.type === 'Scalar' ? scalarText(event) : null
    return seed(this.de)
  }

  nextValue(seed) {
    const path = this.key !== null ? { kind: 'map', parent: this.de.path, key: this.key } : { kind: 'unknown', parent: this.de.path }
    return seed(new Deserializer(this.de.doc, this.de.pos, this.de.jumps, path, this.de.depth))
  }
}

function visitMap(schema, access) {
  if (schema.kind === 'map') {
    const values = new Map()
    for (let key = access.nextKey((d) => d.str('a string')); key !== DONE; key = access.nextKey((d) => d.str('a string'))) {
      values.set(key, access.nextValue((d) => d.deserialize(schema.value)))
    }
    return Object.fromEntries(sortedKeys([...values.keys()]).map((k) => [k, values.get(k)]))
  }
  const found = new Map()
  for (let key = access.nextKey((d) => d.str('field identifier')); key !== DONE; key = access.nextKey((d) => d.str('field identifier'))) {
    if (!Object.hasOwn(schema.fields, key)) {
      access.nextValue((d) => d.ignore())
      continue
    }
    if (found.has(key)) throw custom(`duplicate field \`${key}\``)
    found.set(key, access.nextValue((d) => d.deserialize(schema.fields[key])))
  }
  const out = {}
  for (const [name, field] of Object.entries(schema.fields)) {
    if (found.has(name)) out[name] = found.get(name)
    else if (field.kind === 'option') out[name] = null
    else throw custom(`missing field \`${name}\``)
  }
  return out
}

export function parseYaml(text, schema) {
  try {
    const loader = new Loader(text)
    const doc = loader.nextDocument()
    if (doc === null) throw new YamlError('eof')
    const value = new Deserializer(doc, { v: 0 }, { v: 0 }, { kind: 'root' }, 128).deserialize(schema)
    if (doc.error) throw doc.error
    if (loader.nextDocument() !== null) throw new YamlError('more')
    return value
  } catch (e) {
    if (e instanceof LibyamlError || e instanceof YamlError) throw new FormatError(errorText(e), { cause: e })
    throw e
  }
}
