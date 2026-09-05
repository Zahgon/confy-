// Zero-boilerplate configuration management — JavaScript port of the `confy`
// Rust crate (default `toml_conf` feature). See src/lib.rs upstream.
//
// confy figures out the OS-specific config path, then reads/writes a config
// object mirrored to a TOML file. If no config file exists yet, a default one
// is created so callers can always assume a configuration is present.
//
// Rust relies on the `Default` trait to synthesize a fresh config; JavaScript
// has no such trait, so `load`/`loadPath` accept an explicit default value or
// factory. It defaults to `{}` (an empty table) when omitted.

import fs from 'node:fs'
import path from 'node:path'

import { ConfyError } from './errors.js'
import { configDir } from './strategy.js'
import { toTomlString, fromTomlString } from './toml.js'

const EXTENSION = 'toml'

/**
 * Which strategy confy uses to place the config file, mirroring
 * `etcetera`'s strategies.
 *
 * - `App`: the default, traditional XDG strategy (XDG directories).
 * - `Native`: host-native locations, mainly for GUI apps.
 */
export const ConfigStrategy = Object.freeze({
  App: 'App',
  Native: 'Native',
})

// `lazy_static! { static ref STRATEGY: Mutex<ConfigStrategy> = App }`
let currentStrategy = ConfigStrategy.App

/**
 * Change the strategy used to place the config file (XDG vs. native).
 * The default is {@link ConfigStrategy.App}.
 *
 * @param {'App'|'Native'} strategy
 */
export function changeConfigStrategy(strategy) {
  if (strategy !== ConfigStrategy.App && strategy !== ConfigStrategy.Native) {
    throw new TypeError(`unknown config strategy: ${String(strategy)}`)
  }
  currentStrategy = strategy
}

// Resolve either a default value or a factory `() => value` into a value,
// falling back to an empty table (confy's stand-in for `T::default()`).
function resolveDefault(def) {
  if (typeof def === 'function') return def()
  return def === undefined ? {} : def
}

// Parse a config string into an object (BadTomlData on failure), the shared
// body of `load_path` / `load_or_else`'s successful-open branch.
function parseConfig(cfgString) {
  try {
    return fromTomlString(cfgString)
  } catch (e) {
    throw ConfyError.badTomlData(e)
  }
}

// Read a file's full contents as a UTF-8 string, distinguishing "not found"
// (returns undefined) from other I/O failures (mapped by the caller).
function tryReadFile(filePath) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
  } catch (e) {
    if (e && e.code === 'ENOENT') return { notFound: true }
    throw ConfyError.generalLoadError(e)
  }
  try {
    const contents = fs.readFileSync(fd, 'utf8')
    return { contents }
  } catch (e) {
    throw ConfyError.readConfigurationFileError(e)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Load an application configuration from disk.
 *
 * A new configuration file is created with default values if none exists.
 *
 * @template T
 * @param {string} appName
 * @param {string|null} [configName]
 * @param {T|(() => T)} [defaultConfig] value/factory used when no file exists
 * @returns {T}
 */
export function load(appName, configName, defaultConfig) {
  const filePath = getConfigurationFilePath(appName, configName)
  return loadPath(filePath, defaultConfig)
}

/**
 * Load an application configuration from a specified path.
 *
 * A new configuration file is created with default values if none exists.
 *
 * @template T
 * @param {string} filePath
 * @param {T|(() => T)} [defaultConfig]
 * @returns {T}
 */
export function loadPath(filePath, defaultConfig) {
  const result = tryReadFile(filePath)
  if (result.notFound) {
    const parent = path.dirname(filePath)
    if (parent && parent !== filePath) {
      try {
        fs.mkdirSync(parent, { recursive: true })
      } catch (e) {
        throw ConfyError.directoryCreationFailed(e)
      }
    }
    const cfg = resolveDefault(defaultConfig)
    storePath(filePath, cfg)
    return cfg
  }
  return parseConfig(result.contents)
}

/**
 * Load a configuration from a path, creating it from `op`'s result if none
 * exists or the existing file content is incorrect (unreadable / unparsable).
 *
 * @template T
 * @param {string} filePath
 * @param {() => T} op factory producing the fallback configuration
 * @returns {T}
 */
export function loadOrElse(filePath, op) {
  const loadValue = () => {
    const cfg = op()
    const parent = path.dirname(filePath)
    if (parent && parent !== filePath) {
      try {
        fs.mkdirSync(parent, { recursive: true })
      } catch (e) {
        throw ConfyError.directoryCreationFailed(e)
      }
    }
    storePath(filePath, cfg)
    return cfg
  }

  let fd
  try {
    fd = fs.openSync(filePath, 'r')
  } catch (e) {
    if (e && e.code === 'ENOENT') return loadValue()
    throw ConfyError.generalLoadError(e)
  }

  let cfgString
  try {
    cfgString = fs.readFileSync(fd, 'utf8')
  } catch {
    // `load_from_file().or_else(|_| load_value())` — any read failure falls back.
    return loadValue()
  } finally {
    fs.closeSync(fd)
  }

  try {
    return fromTomlString(cfgString)
  } catch {
    return loadValue()
  }
}

/**
 * Save changes made to a configuration object.
 *
 * Updates the configuration with the provided values, creating a new one if
 * none exists. Can also be used to seed a config with values other than the
 * defaults.
 *
 * @param {string} appName
 * @param {string|null} configName
 * @param {unknown} cfg
 */
export function store(appName, configName, cfg) {
  const filePath = getConfigurationFilePath(appName, configName)
  return storePath(filePath, cfg)
}

/**
 * Like {@link store}, but also sets file permissions (a numeric mode, e.g.
 * `0o600`) on the written file.
 *
 * @param {string} appName
 * @param {string|null} configName
 * @param {unknown} cfg
 * @param {number} perms
 */
export function storePerms(appName, configName, cfg, perms) {
  const filePath = getConfigurationFilePath(appName, configName)
  return storePathPerms(filePath, cfg, perms)
}

/**
 * Save changes made to a configuration object at a specified path.
 *
 * @param {string} filePath
 * @param {unknown} cfg
 */
export function storePath(filePath, cfg) {
  return doStore(filePath, cfg, undefined)
}

/**
 * Like {@link storePath}, but also sets file permissions (numeric mode).
 *
 * @param {string} filePath
 * @param {unknown} cfg
 * @param {number} perms
 */
export function storePathPerms(filePath, cfg, perms) {
  return doStore(filePath, cfg, perms)
}

function doStore(filePath, cfg, perms) {
  // `path.parent()` is None for a root/prefix — reproduce that rejection.
  const configDirPath = path.dirname(filePath)
  if (!configDirPath || configDirPath === filePath) {
    throw ConfyError.badConfigDirectory(`${JSON.stringify(filePath)} is a root or prefix`)
  }

  try {
    fs.mkdirSync(configDirPath, { recursive: true })
  } catch (e) {
    throw ConfyError.directoryCreationFailed(e)
  }

  // Serialize *before* opening the file so a serialization failure leaves any
  // existing file untouched (see upstream `test_store_path_atomic`).
  let s
  try {
    s = toTomlString(cfg)
  } catch (e) {
    throw ConfyError.serializeTomlError(e)
  }

  let fd
  try {
    // write + create + truncate
    fd = fs.openSync(filePath, 'w')
  } catch (e) {
    throw ConfyError.openConfigurationFileError(e)
  }

  try {
    if (perms !== undefined) {
      try {
        fs.fchmodSync(fd, perms)
      } catch (e) {
        throw ConfyError.setPermissionsFileError(e)
      }
    }
    try {
      fs.writeSync(fd, Buffer.from(s, 'utf8'))
    } catch (e) {
      throw ConfyError.writeConfigurationFileError(e)
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Get the configuration file path used by {@link load} and {@link store}.
 *
 * Useful for showing the user where the configuration lives.
 *
 * @param {string} appName
 * @param {string|null} [configName]
 * @returns {string}
 */
export function getConfigurationFilePath(appName, configName) {
  const name = configName == null ? 'default-config' : configName
  const dir = configDir(currentStrategy, {
    tld: 'rs',
    author: '',
    appName,
  })
  return path.join(dir, `${name}.${EXTENSION}`)
}

export { ConfyError } from './errors.js'
export { toTomlString, fromTomlString, TomlError } from './toml.js'
