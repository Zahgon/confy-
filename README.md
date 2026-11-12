# confy

[![Discord](https://img.shields.io/badge/chat-Discord-informational)](https://discord.gg/dwq4Zme)

Zero-boilerplate configuration management for Node.js.

Focus on storing the right data, instead of worrying about how or where to store it.

```js
import * as confy from 'confy'

const { t } = confy
const MyConfig = t.struct('MyConfig', { version: t.u8(), apiKey: t.string() })

const cfg = confy.load('my-app-name', null, MyConfig)
console.log(cfg)
```

This package is the JavaScript port of the Rust crate `confy` 2.0.0. Files written by one can be read by the other.

## Schemas

Every load and store call takes a schema built with `t`. It plays the part of the Rust type: field order, numeric
widths, optional fields and the default value written when no file exists yet.

| Builder | Rust type | JavaScript value | Default |
| --- | --- | --- | --- |
| `t.bool()` | `bool` | boolean | `false` |
| `t.string()` | `String` | string | `''` |
| `t.i8()` ... `t.i64()`, `t.isize()`, `t.u8()` ... `t.u64()`, `t.usize()` | integers | Number, or BigInt outside the safe range | `0` |
| `t.f32()`, `t.f64()` | floats | Number (an `f32` is rounded to the nearest `f32`) | `0` |
| `t.option(s)` | `Option<_>` | `null` for `None` | `null` |
| `t.vec(s)` | `Vec<_>` | array | `[]` |
| `t.map(s)` | `BTreeMap<String, _>` | plain object, keys written in UTF-8 byte order | `{}` |
| `t.struct(name, { field: s, ... })` | a struct | plain object, fields in that order | each field's default |

A missing field, a wrong type or an integer out of range in a file is an error, like serde. Unknown keys are ignored.

## Formats

`confy` can be used with `TOML`, `YAML` or `RON` files. Each format is its own entry point with the same API, in
place of the Rust crate's feature flags; use one per application.

| Import | Format | File extension |
| --- | --- | --- |
| `confy` | TOML, written like the Rust `toml` crate's pretty printer | `toml` |
| `confy/basic-toml` | TOML, written like the Rust `basic-toml` crate (compact arrays) | `toml` |
| `confy/yaml` | YAML, like `serde_yaml` | `yml` |
| `confy/ron` | Rusty Object Notation, like `ron`'s pretty printer | `ron` |

## API

Each entry point exports the same functions. The JSDoc in `src/` has the details of each one.

- `load(appName, configName, schema)`: reads the configuration from `getConfigurationFilePath(appName, configName)`.
  A missing file is created with the schema's default value.
- `loadPath(path, schema)`: the same for any path.
- `loadOrElse(path, schema, op)`: like `loadPath`, but when the file is missing, cannot be read or does not decode,
  stores and returns `op()` instead.
- `store(appName, configName, value, schema)` and `storePath(path, value, schema)`: write the value, creating the
  missing parent directories. The value is serialized before the file is opened, so a value that does not match
  the schema leaves the existing file untouched.
- `storePerms(...)` and `storePathPerms(...)`: the same, with a file mode such as `0o600` as the last argument.
- `getConfigurationFilePath(appName, configName)`: where `load` and `store` keep the file, for example to show
  it to the user. `configName` defaults to `default-config`.
- `changeConfigStrategy(ConfigStrategy.App | ConfigStrategy.Native)`: see below.
- `ConfyError`, `ConfigStrategy`, `t` and `EXTENSION` (the format's file extension).

## Errors

Every failure is a `ConfyError` with `kind` (the Rust variant name, for example `BadTomlData` or
`DirectoryCreationFailed`), `message` (its text, for example `Bad TOML data`) and, except for
`BadConfigDirectory`, `source`: the format's error, with line and column, or the file-system error. To add context
for your users, wrap it: `throw new Error('could not read the settings', { cause: err })`.

## Config File Location

The configuration file is `<config dir>/<app dir>/<configName or default-config>.<EXTENSION>`. The strategy is
`ConfigStrategy.App` by default; change it with `changeConfigStrategy` before loading or storing.

| | `App` strategy | `Native` strategy |
| --- | --- | --- |
| Linux and other Unix systems | `$XDG_CONFIG_HOME/<app dir>` when `XDG_CONFIG_HOME` is an absolute path, otherwise `$HOME/.config/<app dir>` | same as `App` |
| macOS | same as Linux | `$HOME/Library/Preferences/rs.<App-Name>` |
| Windows | `%APPDATA%\<app name>\config` | same as `App` |

`<app dir>` is the app name in lower case with spaces turned into hyphens; `<App-Name>` keeps the case and turns
spaces into hyphens. The home directory is `$HOME` when it is set and not empty, otherwise the current user's
home from the system's user database. When there is none, `getConfigurationFilePath`, `load`, `store` and
`storePerms` fail with `BadConfigDirectory`.

## Development

`npm test` runs the test suite (the original crate's tests and its documentation examples), `npm run lint`
rejects syntax errors, unused variables, functions, classes and imports, and undefined names in every source
file, and `npm audit` checks the (empty) dependency tree.

## Changelog

### 2.0.0 (JavaScript)

* The package is a JavaScript port of the Rust crate `confy` 2.0.0 for Node.js 22: one entry point per format
  (`confy`, `confy/basic-toml`, `confy/yaml`, `confy/ron`) instead of feature flags, schemas built with `t`
  instead of serde types, and the same files, paths and error variants. It has no npm dependencies.

### History of the Rust crate

These are the breaking changes of the Rust crate before the port.

#### Version 2.0.0

In version `2.0.0` the crate moved from the [`ProjectDirs`](https://github.com/dirs-dev/directories-rs?tab=readme-ov-file#projectdirs) crate to [`etcetera`](https://docs.rs/etcetera/latest/etcetera/) allowing for both uses of `XDG` or the OS's Native paths.

* From then on the default was using `XDG` directories on macOS.

#### Version 0.6.0

This version bumped several dependencies which had changes in some of the default (de)serialization process:

* `serde_yaml` v0.8 -> v0.9: [v0.9 release notes](https://github.com/dtolnay/serde-yaml/releases/tag/0.9.0). There were several breaking changes to `v0.9.0` and are listed in this release tag. Especially cases where previously numbers were parsed and now return `String`. See the release notes for more details.
* `toml` v0.5 -> v0.8: [v0.8 CHANGELOG](https://github.com/toml-rs/toml/blob/main/crates/toml/CHANGELOG.md#compatibility-1). Breaking change to how tuple variants work in `toml`, from the notes: "Serialization and deserialization of tuple variants has changed from being an array to being a table with the key being the variant name and the value being the array".

#### Version 0.5.0

* The base functions `load` and `store` gained an optional parameter in the event multiple configurations are needed, or ones with different filename.
* The default configuration file was named "default-config" instead of using the application's name. Put the second argument of `load` and `store` to be the same of the first one to keep the previous configuration file.
* It became possible to save the configuration as `toml` or as `YAML`. The configuration's file name's extension depends on the format used.

#### Version 0.4.0

Starting with version 0.4.0 the configuration file was stored in the expected place for your system. See the [`directories`] crates for more information.
Before version 0.4.0, the configuration file was written in the current directory.

[`directories`]: https://crates.io/crates/directories

## License

This work is triple-licensed under MIT, MIT/X11, or the Apache 2.0 (or any later version).
You may choose any one of these three licenses if you use this work.

`SPDX-License-Identifier: MIT OR X11 OR Apache-2.0+`
