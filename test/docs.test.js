// The documentation examples of the original src/lib.rs (rustdoc `no_run` examples), ported as runnable tests.
// Each one performs the example's calls through the package API in the current user's configuration directory
// and removes the file it created afterwards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { ConfigStrategy, changeConfigStrategy, getConfigurationFilePath, load, store, t } from 'confy'

// Runs one example and removes the application's configuration directory it wrote to.
function inAppDir(appName, example) {
  try {
    example()
  } finally {
    fs.rmSync(path.dirname(getConfigurationFilePath(appName, null)), { recursive: true, force: true })
    changeConfigStrategy(ConfigStrategy.App)
  }
}

test('doc_crate_example', () => {
  // `MyConfig` with `Default` giving version 0 and an empty api_key, loaded with `confy::load("my-app-name", None)`.
  const MyConfig = t.struct('MyConfig', { version: t.u8(), api_key: t.string() })
  inAppDir('my-app-name', () => {
    const cfg = load('my-app-name', null, MyConfig)
    assert.deepEqual(cfg, { version: 0, api_key: '' })
    assert.equal(fs.readFileSync(getConfigurationFilePath('my-app-name', null), 'utf8'), 'version = 0\napi_key = ""\n')
  })
})

test('doc_change_config_strategy', () => {
  // `change_config_strategy(ConfigStrategy::Native)`, then `confy::load("my-app-name", None)` of an empty struct.
  const MyConfig = t.struct('MyConfig', {})
  inAppDir('my-app-name', () => {
    changeConfigStrategy(ConfigStrategy.Native)
    const cfg = load('my-app-name', null, MyConfig)
    assert.deepEqual(cfg, {})
    assert.ok(fs.existsSync(getConfigurationFilePath('my-app-name', null)))
  })
})

test('doc_load', () => {
  // `let cfg: MyConfig = confy::load("my-app-name", None)?;` with an empty struct.
  const MyConfig = t.struct('MyConfig', {})
  inAppDir('my-app-name', () => {
    assert.deepEqual(load('my-app-name', null, MyConfig), {})
    assert.equal(fs.readFileSync(getConfigurationFilePath('my-app-name', null), 'utf8'), '')
  })
})

test('doc_store', () => {
  // `confy::store("my-app-name", None, MyConf {})?;`
  const MyConf = t.struct('MyConf', {})
  inAppDir('my-app-name', () => {
    store('my-app-name', null, {}, MyConf)
    assert.equal(fs.readFileSync(getConfigurationFilePath('my-app-name', null), 'utf8'), '')
  })
})
