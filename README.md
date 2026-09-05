# confy (JavaScript)

Zero-boilerplate configuration management — a JavaScript (ESM) port of the Rust
crate [confy](https://github.com/rust-cli/confy). Pure ESM, no runtime
dependencies, Node >= 18.

`confy` figures out the OS-specific configuration path for you, then reads and
writes a plain JavaScript object mirrored to a TOML file. If no config file
exists yet, a default one is created, so callers can always assume a
configuration is present.

```js
import { load, store } from 'confy';

// Loads {home}/.config/my-app-name/default-config.toml, creating it from the
// supplied default the first time.
const cfg = load('my-app-name', null, { version: 0, apiKey: '' });

cfg.apiKey = 'secret';
store('my-app-name', null, cfg);
```

## Default trait

Rust synthesises a fresh configuration through the `Default` trait, which has no
JavaScript equivalent. `load` / `loadPath` therefore take an explicit default
value or a `() => value` factory as their last argument; it defaults to `{}` (an
empty table) when omitted.

## Config file location

The port reproduces the `etcetera` crate's path logic that confy uses. The
default is the **App** (XDG) strategy; switch to the host-native layout with
`changeConfigStrategy(ConfigStrategy.Native)`.

| Strategy | Linux | macOS | Windows |
| --- | --- | --- | --- |
| App (default) | `$XDG_CONFIG_HOME/<app>` or `$HOME/.config/<app>` | `$HOME/.config/<app>` | `{RoamingAppData}\<app>\config` |
| Native | `$HOME/.config/<app>` | `$HOME/Library/Preferences/rs.<app>` | `{RoamingAppData}\<app>\config` |

## API

| Function | Purpose |
| --- | --- |
| `load(appName, configName?, default?)` | Load config from the OS path, creating a default if absent. |
| `loadPath(filePath, default?)` | Load from an explicit path. |
| `loadOrElse(filePath, op)` | Load from a path, falling back to `op()` on a missing or unparsable file. |
| `store(appName, configName?, cfg)` | Write config to the OS path. |
| `storePerms(appName, configName?, cfg, perms)` | `store` plus a numeric file mode. |
| `storePath(filePath, cfg)` | Write config to an explicit path. |
| `storePathPerms(filePath, cfg, perms)` | `storePath` plus a numeric file mode. |
| `getConfigurationFilePath(appName, configName?)` | The path `load` / `store` would use. |
| `changeConfigStrategy(strategy)` | Switch between `ConfigStrategy.App` and `ConfigStrategy.Native`. |

Also exported: `ConfyError`, `ConfigStrategy`, and `toTomlString` /
`fromTomlString` / `TomlError` for the bundled TOML codec.

## Test

```bash
npm test   # node --test test/*.test.js
```

## License

Triple-licensed under MIT, MIT/X11, or Apache-2.0 (or any later version), the
same as the original crate. `SPDX-License-Identifier: MIT OR X11 OR Apache-2.0+`
