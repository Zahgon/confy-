// Schemas stand in for the Rust types confy is generic over: they give field order, numeric widths,
// optional fields and the `Default` value used when no configuration file exists yet.

const INTEGERS = {
  i8: [-(2n ** 7n), 2n ** 7n - 1n],
  i16: [-(2n ** 15n), 2n ** 15n - 1n],
  i32: [-(2n ** 31n), 2n ** 31n - 1n],
  i64: [-(2n ** 63n), 2n ** 63n - 1n],
  isize: [-(2n ** 63n), 2n ** 63n - 1n],
  u8: [0n, 2n ** 8n - 1n],
  u16: [0n, 2n ** 16n - 1n],
  u32: [0n, 2n ** 32n - 1n],
  u64: [0n, 2n ** 64n - 1n],
  usize: [0n, 2n ** 64n - 1n],
}

const scalar = (kind) => () => Object.freeze({ kind })

/**
 * Schema builders, one per Rust type: `bool`, `string`, `i8` to `i64`, `isize`, `u8` to `u64`, `usize`, `f32`,
 * `f64`, `option(inner)` (`Option`, `null` for `None`), `vec(item)` (`Vec`), `map(value)`
 * (`BTreeMap<String, _>`, keys written in UTF-8 byte order) and `struct(name, { field: schema, ... })` (fields
 * in that order). Integers come back as a Number when safe and as a BigInt otherwise.
 */
export const t = Object.freeze({
  bool: scalar('bool'),
  string: scalar('string'),
  f32: scalar('f32'),
  f64: scalar('f64'),
  ...Object.fromEntries(Object.keys(INTEGERS).map((kind) => [kind, scalar(kind)])),
  option: (inner) => Object.freeze({ kind: 'option', inner }),
  vec: (item) => Object.freeze({ kind: 'vec', item }),
  map: (value) => Object.freeze({ kind: 'map', value }),
  struct: (name, fields) => Object.freeze({ kind: 'struct', name, fields: Object.freeze({ ...fields }) }),
})

export function integerRange(kind) {
  return INTEGERS[kind]
}

export function isInteger(schema) {
  return schema.kind in INTEGERS
}

// Integers wider than 32 bits come back as a Number when safe, otherwise as a BigInt.
export function integerValue(big) {
  const n = Number(big)
  return Number.isSafeInteger(n) ? n : big
}

export function defaultValue(schema) {
  switch (schema.kind) {
    case 'bool':
      return false
    case 'string':
      return ''
    case 'option':
      return null
    case 'vec':
      return []
    case 'map':
      return {}
    case 'struct': {
      const out = {}
      for (const [name, field] of Object.entries(schema.fields)) out[name] = defaultValue(field)
      return out
    }
    default:
      return 0
  }
}

// Checks a value against its schema before serialization; returns a reason string or null.
export function mismatch(schema, value, where = 'value') {
  switch (schema.kind) {
    case 'bool':
      return typeof value === 'boolean' ? null : `${where}: expected a boolean`
    case 'string':
      return typeof value === 'string' ? null : `${where}: expected a string`
    case 'f32':
    case 'f64':
      return typeof value === 'number' ? null : `${where}: expected a number`
    case 'option':
      return value === null || value === undefined ? null : mismatch(schema.inner, value, where)
    case 'vec':
      if (!Array.isArray(value)) return `${where}: expected an array`
      for (let i = 0; i < value.length; i++) {
        const reason = mismatch(schema.item, value[i], `${where}[${i}]`)
        if (reason) return reason
      }
      return null
    case 'map':
    case 'struct': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${where}: expected an object`
      const entries = schema.kind === 'map'
        ? Object.keys(value).map((k) => [k, schema.value])
        : Object.entries(schema.fields)
      for (const [key, field] of entries) {
        const reason = mismatch(field, value[key], `${where}.${key}`)
        if (reason) return reason
      }
      return null
    }
    default: {
      const big = typeof value === 'bigint' ? value : Number.isInteger(value) ? BigInt(value) : null
      if (big === null) return `${where}: expected an integer`
      const [lo, hi] = INTEGERS[schema.kind]
      return big < lo || big > hi ? `${where}: integer out of range for ${schema.kind}` : null
    }
  }
}

// Field entries of a struct value in schema order, or of a map value in sorted key order (Rust BTreeMap).
export function entriesOf(schema, value) {
  if (schema.kind === 'struct') return Object.keys(schema.fields).map((k) => [k, schema.fields[k], value[k]])
  return sortedKeys(Object.keys(value)).map((k) => [k, schema.value, value[k]])
}

export function sortedKeys(keys) {
  const bytes = (s) => Buffer.from(s, 'utf8')
  return [...keys].sort((a, b) => Buffer.compare(bytes(a), bytes(b)))
}
