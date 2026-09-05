// The simplest example of how to use confy — a JavaScript port of
// examples/simple.rs from the upstream crate.

import fs from 'node:fs'
import path from 'node:path'

import { load, store, getConfigurationFilePath } from '../src/index.js'

// Rust's `ConfyConfig` derives `Default`; JS has no such trait, so the defaults
// are passed explicitly as the last argument to `load`.
const defaultConfig = () => ({ name: 'Unknown', comfy: true, foo: 42 })

function main() {
  const cfg = load('confy_simple_app', null, defaultConfig)
  const file = getConfigurationFilePath('confy_simple_app', null)
  console.log(`The configuration file path is: ${JSON.stringify(file)}`)
  console.log('The configuration is:')
  console.log(cfg)
  console.log('The wrote toml file content is:')
  console.log(fs.readFileSync(file, 'utf8'))

  const updated = { ...cfg, name: 'Test' }
  store('confy_simple_app', null, updated)
  console.log('The updated toml file content is:')
  console.log(fs.readFileSync(file, 'utf8'))

  fs.rmSync(path.dirname(file), { recursive: true, force: true })
}

main()
