// The simplest example of how to use confy.
import fs from 'node:fs'
import path from 'node:path'
import * as confy from 'confy'

const { t } = confy

const ConfyConfig = t.struct('ConfyConfig', { name: t.string(), comfy: t.bool(), foo: t.i64() })

const file = confy.getConfigurationFilePath('confy_simple_app', null)
// The Rust example's `Default` for ConfyConfig, written only when there is no configuration yet.
if (!fs.existsSync(file)) confy.store('confy_simple_app', null, { name: 'Unknown', comfy: true, foo: 42 }, ConfyConfig)
const cfg = confy.load('confy_simple_app', null, ConfyConfig)
console.log('The configuration file path is:', file)
console.log('The configuration is:')
console.log(cfg)
console.log('The wrote toml file content is:')
console.log(fs.readFileSync(file, 'utf8'))
confy.store('confy_simple_app', null, { ...cfg, name: 'Test' }, ConfyConfig)
console.log('The updated toml file content is:')
console.log(fs.readFileSync(file, 'utf8'))
fs.rmSync(path.dirname(file), { recursive: true, force: true })
