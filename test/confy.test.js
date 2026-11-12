// The original crate's tests (src/lib.rs `mod tests`), ported under their Rust names.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ConfigStrategy,
  EXTENSION,
  changeConfigStrategy,
  getConfigurationFilePath,
  loadOrElse,
  loadPath,
  storePath,
  storePathPerms,
  t,
} from 'confy'

const ExampleConfig = t.struct('ExampleConfig', { name: t.string(), count: t.usize() })
const exampleDefault = () => ({ name: '', count: 0 })

// Run a test function with a temporary config path as fixture.
function withConfigPath(testFn) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'confy-test-'))
  const configPath = path.join(configDir, 'example-app', `example-config.${EXTENSION}`)
  try {
    testFn(configPath)
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true })
  }
}

function expectedNativePath() {
  const home = os.homedir()
  if (process.platform === 'darwin') return `${home}/Library/Preferences/rs.example-app/example-config.toml`
  if (process.platform === 'win32') return `${home}\\AppData\\Roaming\\example-app\\config\\example-config.toml`
  return `${home}/.config/example-app/example-config.toml`
}

function expectedAppPath() {
  const home = os.homedir()
  if (process.platform === 'win32') return `${home}\\AppData\\Roaming\\example-app\\config\\example-config.toml`
  return `${home}/.config/example-app/example-config.toml`
}

test('load_path_works', () => {
  withConfigPath((p) => {
    const config = loadPath(p, ExampleConfig)
    assert.deepEqual(config, exampleDefault())
    assert.equal(fs.readFileSync(p, 'utf8'), 'name = ""\ncount = 0\n')
  })
})

test('load_or_else_works', () => {
  const theValue = () => ({ name: 'a', count: 5 })
  withConfigPath((p) => {
    const config = loadOrElse(p, ExampleConfig, theValue)
    assert.deepEqual(config, theValue())
  })
  withConfigPath((p) => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'some normal text')
    const config = loadOrElse(p, ExampleConfig, theValue)
    assert.deepEqual(config, theValue())
  })
})

test('test_store_path', () => {
  withConfigPath((p) => {
    const config = { name: 'Test', count: 42 }
    storePath(p, config, ExampleConfig)
    assert.deepEqual(loadPath(p, ExampleConfig), config)
  })
})

test('test_store_path_native', () => {
  changeConfigStrategy(ConfigStrategy.Native)
  withConfigPath((p) => {
    const config = { name: 'Test', count: 42 }
    assert.equal(getConfigurationFilePath('example-app', 'example-config'), expectedNativePath())
    storePath(p, config, ExampleConfig)
    assert.deepEqual(loadPath(p, ExampleConfig), config)
  })
})

test('test_store_path_change', () => {
  changeConfigStrategy(ConfigStrategy.Native)
  withConfigPath((p) => {
    const config = { name: 'Test', count: 42 }
    assert.equal(getConfigurationFilePath('example-app', 'example-config'), expectedNativePath())
    changeConfigStrategy(ConfigStrategy.App)
    assert.equal(getConfigurationFilePath('example-app', 'example-config'), expectedAppPath())
    storePath(p, config, ExampleConfig)
    assert.deepEqual(loadPath(p, ExampleConfig), config)
  })
})

test('test_store_path_perms', { skip: process.platform === 'win32' }, () => {
  withConfigPath((p) => {
    const config = { name: 'Secret', count: 16549 }
    storePathPerms(p, config, ExampleConfig, 0o600)
    assert.equal(fs.statSync(p).mode & 0o777, 0o600)
    assert.deepEqual(loadPath(p, ExampleConfig), config)
  })
})

test('test_store_path_perms_readonly', () => {
  withConfigPath((p) => {
    const config = { name: 'Soon read-only', count: 27115 }
    storePath(p, config, ExampleConfig)
    const readonly = fs.statSync(p).mode & 0o777 & ~0o222
    storePathPerms(p, config, ExampleConfig, readonly)
    assert.equal(fs.statSync(p).mode & 0o222, 0)
  })
})

test('test_store_path_root_error', () => {
  assert.throws(() => storePath('/', exampleDefault(), ExampleConfig), (err) => {
    assert.equal(err.message, 'Bad configuration directory: "/" is a root or prefix')
    return true
  })
})

// Storing a value that cannot be serialized leaves the file on disk untouched.
test('test_store_path_atomic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confy-atomic-'))
  const p = path.join(dir, 'config.toml')
  const message = 'Hello world!'
  try {
    fs.writeFileSync(p, message)
    assert.throws(() => storePath(p, { name: 42, count: 'nope' }, ExampleConfig), { kind: 'SerializeTomlError' })
    assert.equal(fs.readFileSync(p, 'utf8'), message)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// loadPath decodes into a differently named struct with the same fields.
test('test_change_struct_name', () => {
  withConfigPath((p) => {
    const AnotherExampleConfig = t.struct('AnotherExampleConfig', { name: t.string(), count: t.usize() })
    storePath(p, exampleDefault(), ExampleConfig)
    assert.deepEqual(loadPath(p, AnotherExampleConfig), exampleDefault())
  })
})
