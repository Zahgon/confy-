// Float text the way the Rust crates print it: shortest round-trip digits, either in plain decimal
// notation (Rust `Display`, used by toml, basic-toml and ron) or in ryu's notation (serde_yaml).

// Shortest digits and decimal exponent: value = 0.<digits> x 10^point.
function shortest(value, single) {
  let text
  if (single) {
    for (let p = 1; p <= 9; p++) {
      text = value.toPrecision(p)
      if (Math.fround(Number(text)) === value) break
    }
    text = Number(text).toExponential()
  } else {
    text = value.toExponential()
  }
  const [mantissa, exponent] = text.split('e')
  const digits = mantissa.replace('.', '')
  return { digits, point: Number(exponent) + 1 }
}

function nonFinite(value) {
  if (Number.isNaN(value)) return 'NaN'
  return value > 0 ? 'inf' : '-inf'
}

// Rust `{}` for f32/f64 with a forced fraction: 1.0, 0.0000001, 1000000000000000000000.0, -0.0.
export function decimalFloat(value, single = false) {
  if (!Number.isFinite(value)) return nonFinite(value)
  const sign = value < 0 || Object.is(value, -0) ? '-' : ''
  if (value === 0) return `${sign}0.0`
  const { digits, point } = shortest(Math.abs(value), single)
  let text
  if (point <= 0) text = `0.${'0'.repeat(-point)}${digits}`
  else if (point >= digits.length) text = `${digits}${'0'.repeat(point - digits.length)}.0`
  else text = `${digits.slice(0, point)}.${digits.slice(point)}`
  return sign + text
}

// Rust `{}` without the forced fraction (serde's "floating point `1.5`" message adds it back).
export function rustDisplayFloat(value) {
  const text = decimalFloat(value)
  return text.endsWith('.0') && Number.isFinite(value) ? text.slice(0, -2) : text
}

// ryu::Buffer::format_finite, as serde_yaml writes floats: 1e21, 1e-7, 1000000000000000.0, 1.5e-10.
export function ryuFloat(value, single = false) {
  const sign = value < 0 || Object.is(value, -0) ? '-' : ''
  if (value === 0) return `${sign}0.0`
  const { digits, point } = shortest(Math.abs(value), single)
  const length = digits.length
  const k = point - length
  let text
  if (k >= 0 && point <= 16) text = `${digits}${'0'.repeat(k)}.0`
  else if (point > 0 && point <= 16) text = `${digits.slice(0, point)}.${digits.slice(point)}`
  else if (point > -5 && point <= 0) text = `0.${'0'.repeat(-point)}${digits}`
  else if (length === 1) text = `${digits}e${point - 1}`
  else text = `${digits[0]}.${digits.slice(1)}e${point - 1}`
  return sign + text
}
