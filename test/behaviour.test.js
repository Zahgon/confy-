// Behaviour the brief states beyond the original tests: wide integers, f32 rounding, root paths,
// XDG_CONFIG_HOME with the Native strategy, map key order, invalid UTF-8, io::Error texts and the
// variants of open and write failures.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ConfigStrategy, changeConfigStrategy, getConfigurationFilePath, loadOrElse, loadPath, storePath, t } from 'confy'

const Example = t.struct('ExampleConfig', { name: t.string(), count: t.usize() })

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confy-behaviour-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('integers outside the safe range round-trip as BigInt', () => {
  const Wide = t.struct('Wide', { high: t.i64(), low: t.i64(), size: t.u64() })
  const value = { high: 9223372036854775807n, low: -9223372036854775808n, size: 9007199254740993n }
  withDir((dir) => {
    const p = path.join(dir, 'wide.toml')
    storePath(p, value, Wide)
    assert.deepEqual(loadPath(p, Wide), value)
  })
})

test('f32 values decode to the nearest f32', () => {
  const Single = t.struct('Single', { value: t.f32() })
  withDir((dir) => {
    const p = path.join(dir, 'single.toml')
    fs.writeFileSync(p, 'value = 0.1\n')
    assert.equal(loadPath(p, Single).value, Math.fround(0.1))
  })
})

test('the empty path is a root or prefix', () => {
  const Example = t.struct('ExampleConfig', { name: t.string(), count: t.usize() })
  assert.throws(() => storePath('', { name: '', count: 0 }, Example), (err) => {
    assert.equal(err.kind, 'BadConfigDirectory')
    assert.equal(err.message, 'Bad configuration directory: "" is a root or prefix')
    return true
  })
})

test('the Native strategy follows XDG_CONFIG_HOME on Linux', { skip: process.platform !== 'linux' }, () => {
  withDir((dir) => {
    const saved = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = dir
    try {
      changeConfigStrategy(ConfigStrategy.Native)
      assert.equal(getConfigurationFilePath('Example App', 'cfg'), path.join(dir, 'example-app', 'cfg.toml'))
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = saved
      changeConfigStrategy(ConfigStrategy.App)
    }
  })
})

test('map keys are written in sorted order', () => {
  const Tagged = t.struct('Tagged', { env: t.map(t.u32()) })
  withDir((dir) => {
    const p = path.join(dir, 'tagged.toml')
    storePath(p, { env: { b: 1, a: 2, Z: 3 } }, Tagged)
    const keys = fs.readFileSync(p, 'utf8').split('\n').filter((line) => line.includes(' = ')).map((line) => line.split(' = ')[0])
    assert.deepEqual(keys, ['Z', 'a', 'b'])
  })
})

test('map keys are ordered by their UTF-8 bytes', () => {
  const Tagged = t.struct('Tagged', { env: t.map(t.u32()) })
  withDir((dir) => {
    const p = path.join(dir, 'tagged.toml')
    storePath(p, { env: { '\u{1F600}': 1, '\uE000': 2 } }, Tagged)
    assert.equal(fs.readFileSync(p, 'utf8'), '[env]\n"\uE000" = 2\n"\u{1F600}" = 1\n')
  })
})

test('a file that is not valid UTF-8 is a read error', () => {
  withDir((dir) => {
    const p = path.join(dir, 'bad.toml')
    fs.writeFileSync(p, Buffer.from('name = "\xff"\ncount = 1\n', 'latin1'))
    assert.throws(() => loadPath(p, Example), (err) => {
      assert.equal(err.kind, 'ReadConfigurationFileError')
      assert.equal(err.source.message, 'stream did not contain valid UTF-8')
      return true
    })
  })
})

test('reading a directory fails with the io::Error text', { skip: process.platform !== 'linux' }, () => {
  withDir((dir) => {
    assert.throws(() => loadPath(dir, Example), (err) => {
      assert.equal(err.kind, 'ReadConfigurationFileError')
      assert.equal(err.source.message, 'Is a directory (os error 21)')
      return true
    })
  })
})

test('loadOrElse does not call op when the file cannot be opened', { skip: process.platform !== 'linux' }, () => {
  withDir((dir) => {
    const file = path.join(dir, 'file')
    fs.writeFileSync(file, '')
    let calls = 0
    const op = () => {
      calls++
      return { name: 'x', count: 1 }
    }
    assert.throws(() => loadOrElse(path.join(file, 'c.toml'), Example, op), (err) => {
      assert.equal(err.kind, 'GeneralLoadError')
      return true
    })
    assert.equal(calls, 0)
  })
})

test('a failing write is a WriteConfigurationFileError', { skip: process.platform !== 'linux' }, () => {
  assert.throws(() => storePath('/dev/full', { name: 'x', count: 1 }, Example), (err) => {
    assert.equal(err.kind, 'WriteConfigurationFileError')
    assert.equal(err.source.message, 'No space left on device (os error 28)')
    return true
  })
})
