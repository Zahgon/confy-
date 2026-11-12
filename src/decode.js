// Typed decoding of a parsed document against a schema, with serde's error texts
// ("missing field `count`", "invalid type: string \"5\", expected usize", ...).
// Parsers produce nodes { type, value, span }: tables carry `entries` ([key, node] in document order),
// arrays carry `items`, RON options are `some` / `none` nodes.

import { integerRange, integerValue, isInteger, sortedKeys } from './schema.js'
import { rustDisplayFloat } from './numbers.js'
import { rustDebugString } from './debug.js'

export class DecodeError extends Error {
  constructor(message, span) {
    super(message)
    this.name = 'DecodeError'
    this.span = span
  }
}


function floatText(value) {
  const text = rustDisplayFloat(value)
  return /[.eEni]/.test(text) ? text : `${text}.0`
}

function unexpected(node) {
  switch (node.type) {
    case 'string':
      return `string ${rustDebugString(node.value)}`
    case 'integer':
      return node.i128 ? `integer \`${node.value}\` as i128` : `integer \`${node.value}\``
    case 'float':
      return `floating point \`${floatText(node.value)}\``
    case 'bool':
      return `boolean \`${node.value}\``
    case 'array':
      return 'sequence'
    case 'null':
      return 'unit value'
    case 'some':
    case 'none':
      return 'Option value'
    default:
      return 'map'
  }
}

export function expecting(schema) {
  switch (schema.kind) {
    case 'bool':
      return 'a boolean'
    case 'string':
      return 'a string'
    case 'option':
      return 'option'
    case 'vec':
      return 'a sequence'
    case 'map':
      return 'a map'
    case 'struct':
      return `struct ${schema.name}`
    default:
      return schema.kind
  }
}

function invalidType(node, schema) {
  return new DecodeError(`invalid type: ${unexpected(node)}, expected ${expecting(schema)}`, node.span)
}

export function decode(schema, node, format) {
  if (node.error) throw new DecodeError(node.error, node.span)
  if (schema.kind === 'option') {
    if (format === 'ron') {
      if (node.type === 'none') return null
      if (node.type === 'some') return decode(schema.inner, node.value, format)
      throw invalidType(node, schema)
    }
    if (node.type === 'null') return null
    return decode(schema.inner, node, format)
  }
  if (node.type === 'some' || node.type === 'none') throw invalidType(node, schema)
  switch (schema.kind) {
    case 'bool':
      if (node.type !== 'bool') throw invalidType(node, schema)
      return node.value
    case 'string':
      if (node.type !== 'string') throw invalidType(node, schema)
      return node.value
    case 'f32':
    case 'f64': {
      let value
      if (node.type === 'float') value = node.value
      else if (node.type === 'integer') value = Number(node.value)
      else throw invalidType(node, schema)
      return schema.kind === 'f32' ? Math.fround(value) : value
    }
    case 'vec':
      if (node.type !== 'array') throw invalidType(node, schema)
      return node.items.map((item) => decode(schema.item, item, format))
    case 'map': {
      if (node.type !== 'table') throw invalidType(node, schema)
      const values = new Map()
      for (const [key, child] of node.entries) values.set(key, decode(schema.value, child, format))
      // Own data properties, so keys such as `__proto__` stay map entries.
      return Object.fromEntries(sortedKeys([...values.keys()]).map((key) => [key, values.get(key)]))
    }
    case 'struct':
      return decodeStruct(schema, node, format)
    default:
      if (!isInteger(schema)) throw new Error(`unknown schema kind ${schema.kind}`)
      if (node.type !== 'integer' || node.i128) throw invalidType(node, schema)
      {
        const [lo, hi] = integerRange(schema.kind)
        if (node.value < lo || node.value > hi) {
          throw new DecodeError(`invalid value: integer \`${node.value}\`, expected ${schema.kind}`, node.span)
        }
        return integerValue(node.value)
      }
  }
}

function decodeStruct(schema, node, format) {
  if (node.type !== 'table') throw invalidType(node, schema)
  const found = new Map()
  // The toml crate keeps tables in a BTreeMap, so fields are visited in key order.
  const entries = format === 'toml' ? sortedKeys(node.entries.map(([k]) => k)).map((k) => [k, node.entries.find(([e]) => e === k)[1]]) : node.entries
  for (const [key, child] of entries) {
    if (!Object.hasOwn(schema.fields, key)) continue
    if (found.has(key)) throw new DecodeError(`duplicate field \`${key}\``, child.span)
    found.set(key, decode(schema.fields[key], child, format))
  }
  const out = {}
  for (const [name, field] of Object.entries(schema.fields)) {
    if (found.has(name)) out[name] = found.get(name)
    else if (field.kind === 'option') out[name] = null
    else throw new DecodeError(`missing field \`${name}\``, node.span)
  }
  return out
}
