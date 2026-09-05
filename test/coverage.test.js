// Coverage for the reachable-but-unexercised surface the ported Rust suite
// (test/confy.test.js) never touches: the OS-path (app-name) entry points
// load/store/storePerms, every ConfyError variant factory, the TOML array /
// nested-table parse paths, and the macOS / Windows / Unix strategy branches
// driven through configDir's platform seam.
//
// These are not new behaviours — they are the same functions the Rust crate
// ships, exercised so the migrated suite covers what the original relied on.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ConfyError,
  ConfigStrategy,
  changeConfigStrategy,
  load,
  store,
  storePerms,
  getConfigurationFilePath,
  toTomlString,
  fromTomlString,
} from '../src/index.js'
import { configDir } from '../src/strategy.js'

// ---- ConfyError variants -----------------------------------------------------
// Each factory mirrors a `#[error("...")]` arm; assert the kind, Display text
// and wrapped source survive the port.

test('ConfyError variant factories carry kind, message and source', () => {
  const cause = new Error('boom')
  const cases = [
    ['badTomlData', 'BadTomlData', 'Bad TOML data'],
    ['directoryCreationFailed', 'DirectoryCreationFailed', 'Failed to create directory'],
    ['generalLoadError', 'GeneralLoadError', 'Failed to load configuration file'],
    ['serializeTomlError', 'SerializeTomlError', 'Failed to serialize configuration data into TOML'],
    ['writeConfigurationFileError', 'WriteConfigurationFileError', 'Failed to write configuration file'],
    ['readConfigurationFileError', 'ReadConfigurationFileError', 'Failed to read configuration file'],
    ['openConfigurationFileError', 'OpenConfigurationFileError', 'Failed to open configuration file'],
    ['setPermissionsFileError', 'SetPermissionsFileError', 'Failed to set configuration file permissions'],
  ]
  for (const [factory, kind, message] of cases) {
    const err = ConfyError[factory](cause)
    assert.ok(err instanceof ConfyError)
    assert.equal(err.kind, kind)
    assert.equal(err.message, message)
    assert.equal(err.source, cause)
  }

  // badConfigDirectory interpolates its detail and carries no source.
  const bad = ConfyError.badConfigDirectory('"/" is a root or prefix')
  assert.equal(bad.kind, 'BadConfigDirectory')
  assert.equal(bad.message, 'Bad configuration directory: "/" is a root or prefix')
  assert.equal(bad.source, undefined)
})

// ---- App-name entry points (load / store / storePerms) -----------------------
// These resolve an OS path, then delegate. Point HOME/XDG at a temp dir so the
// real filesystem is untouched, and drive the full round trip.

test('load creates a default, store overwrites, storePerms sets the mode', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'confy-home-'))
  const savedHome = process.env.HOME
  const savedXdg = process.env.XDG_CONFIG_HOME
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = path.join(home, '.config')
  try {
    changeConfigStrategy(ConfigStrategy.App)
    const appName = 'confy-cov-app'

    // First load with no file: the default factory result is persisted.
    const created = load(appName, null, () => ({ name: '', count: 0 }))
    assert.deepEqual(created, { name: '', count: 0 })

    const filePath = getConfigurationFilePath(appName, null)
    assert.ok(fs.existsSync(filePath), 'default config file was written')

    // store overwrites; a subsequent load reads it back.
    store(appName, null, { name: 'Test', count: 42 })
    const reloaded = load(appName, null, () => ({ name: '', count: 0 }))
    assert.deepEqual(reloaded, { name: 'Test', count: 42 })

    // storePerms writes and applies a mode (unix only for the mode assertion).
    storePerms(appName, 'perms-config', { name: 'S', count: 1 }, 0o600)
    const permsPath = getConfigurationFilePath(appName, 'perms-config')
    assert.ok(fs.existsSync(permsPath))
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(permsPath).mode & 0o777, 0o600)
    }
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = savedXdg
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// ---- TOML arrays and nested tables ------------------------------------------
// parseArrayValue / splitTopLevel / tableAt are only reached by array values and
// [table] headers, which the ported suite's flat configs never produce.

test('TOML round-trips arrays and nested tables', () => {
  const cfg = {
    name: 'root',
    count: 3,
    tags: ['a', 'b', 'c'],
    nested: [1, 2, [3, 4]],
    section: { host: 'localhost', port: 8080, deep: { on: true } },
  }
  const text = toTomlString(cfg)
  const parsed = fromTomlString(text)
  assert.deepEqual(parsed, cfg)
})

test('fromTomlString parses arrays with quoted commas and empty arrays', () => {
  const text = [
    'items = ["a, b", "c"]',
    'empty = []',
    '',
    '[t]',
    'x = 1',
  ].join('\n')
  const parsed = fromTomlString(text)
  assert.deepEqual(parsed, { items: ['a, b', 'c'], empty: [], t: { x: 1 } })
})

test('tableAt rejects a scalar re-opened as a table', () => {
  // `x` is a scalar, then `[x]` tries to descend into it — the not-a-table guard.
  const text = ['x = 1', '[x]', 'y = 2'].join('\n')
  assert.throws(() => fromTomlString(text), /is not a table/)
})

// ---- Strategy platform branches ---------------------------------------------
// configDir's platform seam lets each OS branch run on any host. Shapes are
// pinned to the host's home/env, so this checks branch selection, not a
// cross-platform path fiction.

test('configDir selects the Apple/Windows/Unix native branches by platform', () => {
  const savedXdg = process.env.XDG_CONFIG_HOME
  const savedAppData = process.env.APPDATA
  delete process.env.XDG_CONFIG_HOME
  delete process.env.APPDATA
  try {
    const args = { tld: 'rs', author: '', appName: 'example-app' }
    const home = os.homedir()

    // Native branches.
    assert.equal(
      configDir('Native', args, 'darwin'),
      path.join(home, 'Library', 'Preferences', 'rs.example-app'),
    )
    assert.equal(
      configDir('Native', args, 'linux'),
      path.join(home, '.config', 'example-app'),
    )
    assert.equal(
      configDir('Native', args, 'win32'),
      path.join(home, 'AppData', 'Roaming', 'example-app', 'config'),
    )

    // App branch: XDG everywhere but Windows.
    assert.equal(
      configDir('App', args, 'linux'),
      path.join(home, '.config', 'example-app'),
    )
    assert.equal(
      configDir('App', args, 'win32'),
      path.join(home, 'AppData', 'Roaming', 'example-app', 'config'),
    )
  } finally {
    if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg
    if (savedAppData !== undefined) process.env.APPDATA = savedAppData
  }
})

test('configDir uses an absolute XDG_CONFIG_HOME and the APPDATA override', () => {
  const savedXdg = process.env.XDG_CONFIG_HOME
  const savedAppData = process.env.APPDATA
  try {
    const args = { tld: 'rs', author: '', appName: 'example-app' }

    process.env.XDG_CONFIG_HOME = '/custom/xdg'
    assert.equal(configDir('App', args, 'linux'), path.join('/custom/xdg', 'example-app'))

    process.env.APPDATA = path.join('C:', 'Roaming')
    assert.equal(
      configDir('App', args, 'win32'),
      path.join('C:', 'Roaming', 'example-app', 'config'),
    )
  } finally {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = savedXdg
    if (savedAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = savedAppData
  }
})
