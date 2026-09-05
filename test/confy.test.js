// Port of the `#[cfg(test)] mod tests` in confy's src/lib.rs.
//
// The Rust tests exercise load_path / load_or_else / store_path(_perms) plus the
// exact native/XDG path shapes and the atomic-write guarantee. JavaScript has no
// `Default` trait, so where Rust relies on `ExampleConfig::default()` we pass the
// equivalent value/factory explicitly.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ConfigStrategy,
  changeConfigStrategy,
  getConfigurationFilePath,
  loadPath,
  loadOrElse,
  storePath,
  storePathPerms,
} from '../src/index.js'

const EXTENSION = 'toml'

// serde's ExampleConfig { name: String, count: usize } with Default = {"", 0}.
const exampleDefault = () => ({ name: '', count: 0 })

// Run a test body with a temporary config path, mirroring `with_config_path`:
// {tmp}/example-app/example-config.toml, cleaned up afterwards.
function withConfigPath(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confy-test-'))
  const configPath = path.join(dir, 'example-app', 'example-config') + `.${EXTENSION}`
  try {
    fn(configPath)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('loadPath loads the default config when no file exists', () => {
  withConfigPath((p) => {
    const config = loadPath(p, exampleDefault)
    assert.deepEqual(config, exampleDefault())
  })
})

test('loadOrElse loads op() when missing, and on invalid content', () => {
  // No file yet -> op() result is used and persisted.
  withConfigPath((p) => {
    const theValue = () => ({ name: 'a', count: 5 })
    const config = loadOrElse(p, theValue)
    assert.deepEqual(config, theValue())
  })

  // Existing but invalid content -> falls back to op().
  withConfigPath((p) => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'some normal text')

    const theValue = () => ({ name: 'a', count: 5 })
    const config = loadOrElse(p, theValue)
    assert.deepEqual(config, theValue())
  })
})

test('storePath stores and round-trips a config', () => {
  withConfigPath((p) => {
    const config = { name: 'Test', count: 42 }
    storePath(p, config)
    const loaded = loadPath(p, exampleDefault)
    assert.deepEqual(loaded, config)
  })
})

test('Native strategy yields host-native config paths', () => {
  const savedXdg = process.env.XDG_CONFIG_HOME
  delete process.env.XDG_CONFIG_HOME
  try {
    changeConfigStrategy(ConfigStrategy.Native)
    const filePath = getConfigurationFilePath('example-app', 'example-config')
    const home = os.homedir()

    if (process.platform === 'darwin') {
      assert.equal(
        filePath,
        `${home}/Library/Preferences/rs.example-app/example-config.toml`,
      )
    } else if (process.platform === 'linux') {
      assert.equal(filePath, `${home}/.config/example-app/example-config.toml`)
    } else {
      assert.equal(
        filePath,
        path.join(
          process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
          'example-app',
          'config',
          'example-config.toml',
        ),
      )
    }
  } finally {
    changeConfigStrategy(ConfigStrategy.App)
    if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg
  }
})

test('switching Native -> App changes the config path back to XDG', () => {
  const savedXdg = process.env.XDG_CONFIG_HOME
  delete process.env.XDG_CONFIG_HOME
  try {
    changeConfigStrategy(ConfigStrategy.Native)
    const nativePath = getConfigurationFilePath('example-app', 'example-config')
    const home = os.homedir()

    if (process.platform === 'darwin') {
      assert.equal(
        nativePath,
        `${home}/Library/Preferences/rs.example-app/example-config.toml`,
      )
    } else if (process.platform === 'linux') {
      assert.equal(nativePath, `${home}/.config/example-app/example-config.toml`)
    }

    changeConfigStrategy(ConfigStrategy.App)
    const appPath = getConfigurationFilePath('example-app', 'example-config')

    if (process.platform === 'darwin' || process.platform === 'linux') {
      assert.equal(appPath, `${home}/.config/example-app/example-config.toml`)
    } else {
      assert.equal(
        appPath,
        path.join(
          process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
          'example-app',
          'config',
          'example-config.toml',
        ),
      )
    }
  } finally {
    changeConfigStrategy(ConfigStrategy.App)
    if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg
  }
})

test('storePathPerms writes with owner-only read/write (unix)', { skip: process.platform === 'win32' }, () => {
  withConfigPath((p) => {
    const config = { name: 'Secret', count: 16549 }
    storePathPerms(p, config, 0o600)
    const loaded = loadPath(p, exampleDefault)
    assert.deepEqual(loaded, config)

    const mode = fs.statSync(p).mode & 0o777
    assert.equal(mode, 0o600)
  })
})

test('storePathPerms can make a file read-only', () => {
  withConfigPath((p) => {
    const config = { name: 'Soon read-only', count: 27115 }
    storePath(p, config)

    const mode = fs.statSync(p).mode & 0o777
    const readonly = mode & ~0o222 // clear all write bits
    storePathPerms(p, config, readonly)

    const after = fs.statSync(p).mode
    assert.equal(after & 0o222, 0)
  })
})

test('storePath rejects a root path', () => {
  assert.throws(
    () => storePath(path.parse(process.cwd()).root, {}),
    /Bad configuration directory: .* is a root or prefix/,
  )
})

test('storePath does not overwrite the file when serialization fails', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'confy-atomic-'))
  const p = path.join(tmp, 'config.toml')
  const message = 'Hello world!'
  try {
    fs.writeFileSync(p, message)

    // A value that fails to serialize (functions are not representable in TOML).
    assert.throws(() => storePath(p, { bad: () => {} }))

    assert.equal(fs.readFileSync(p, 'utf8'), message)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('change struct name', () => {
  withConfigPath((p) => {
    storePath(p, exampleDefault())
    // In JS there is no struct identity; loading yields a plain object with the
    // same fields, which is the analogue of `AnotherExampleConfig`.
    const loaded = loadPath(p, exampleDefault)
    assert.deepEqual(loaded, exampleDefault())
  })
})
