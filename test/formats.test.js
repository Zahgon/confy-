// Format entry points: file extensions, output text and error variants per format.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as toml from 'confy'
import * as basicToml from 'confy/basic-toml'
import * as yaml from 'confy/yaml'
import * as ron from 'confy/ron'

const { t } = toml
const Server = t.struct('Server', { host: t.string(), port: t.u16() })
const Config = t.struct('Config', {
  name: t.string(),
  ratio: t.f64(),
  tags: t.vec(t.string()),
  owner: t.option(t.string()),
  servers: t.vec(Server),
})
const value = { name: 'demo', ratio: 1, tags: ['a', 'b'], owner: null, servers: [{ host: 'h', port: 1 }] }

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confy-formats-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const cases = [
  ['toml', toml, 'toml', 'name = "demo"\nratio = 1.0\ntags = [\n    "a",\n    "b",\n]\n\n[[servers]]\nhost = "h"\nport = 1\n', 'BadTomlData'],
  ['basic-toml', basicToml, 'toml', 'name = "demo"\nratio = 1.0\ntags = ["a", "b"]\n\n[[servers]]\nhost = "h"\nport = 1\n', 'BadTomlData'],
  ['yaml', yaml, 'yml', 'name: demo\nratio: 1.0\ntags:\n- a\n- b\nowner: null\nservers:\n- host: h\n  port: 1\n', 'BadYamlData'],
  ['ron', ron, 'ron', '(\n    name: "demo",\n    ratio: 1.0,\n    tags: [\n        "a",\n        "b",\n    ],\n    owner: None,\n    servers: [\n        (\n            host: "h",\n            port: 1,\n        ),\n    ],\n)', 'BadRonData'],
]

for (const [label, confy, extension, text, badData] of cases) {
  test(`${label} writes and reads its own format`, () => {
    assert.equal(confy.EXTENSION, extension)
    withDir((dir) => {
      const p = path.join(dir, `config.${extension}`)
      confy.storePath(p, value, Config)
      assert.equal(fs.readFileSync(p, 'utf8'), text)
      assert.deepEqual(confy.loadPath(p, Config), value)
    })
  })

  test(`${label} reports malformed files as ${badData}`, () => {
    withDir((dir) => {
      const p = path.join(dir, `config.${extension}`)
      fs.writeFileSync(p, 'name = = [')
      assert.throws(() => confy.loadPath(p, Config), { kind: badData })
    })
  })
}

test('toml parse errors carry the toml crate rendering', () => {
  withDir((dir) => {
    const p = path.join(dir, 'config.toml')
    fs.writeFileSync(p, 'name = "x"\nname = "y"\n')
    assert.throws(() => toml.loadPath(p, Config), (err) => {
      assert.equal(err.source.message, 'TOML parse error at line 2, column 1\n  |\n2 | name = "y"\n  | ^^^^\nduplicate key\n')
      return true
    })
  })
})

test('a missing field is a typed decoding error', () => {
  withDir((dir) => {
    const p = path.join(dir, 'config.toml')
    fs.writeFileSync(p, 'name = "x"\n')
    assert.throws(() => toml.loadPath(p, Config), (err) => {
      assert.equal(err.kind, 'BadTomlData')
      assert.match(err.source.message, /missing field `ratio`\n$/)
      return true
    })
  })
})
