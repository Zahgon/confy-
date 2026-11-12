// The confy API, built once per configuration format. Each entry point (confy, confy/basic-toml,
// confy/yaml, confy/ron) is one format, like the Rust crate's mutually exclusive cargo features.

import fs from 'node:fs'
import path from 'node:path'

import { ConfyError } from './errors.js'
import { defaultValue } from './schema.js'
import { configDir, HomeDirError, pushPath } from './strategy.js'
import { rustDebugString } from './debug.js'
import { ioError } from './io-error.js'

// std::path::Path::parent on Unix: undefined for "" and for a bare root ("/", "//", "/.", ...).
function rustParent(filePath) {
  const absolute = filePath.startsWith('/')
  const parts = filePath.split('/').filter((part, i) => part !== '' && (part !== '.' || i === 0))
  if (parts.length === 0) return undefined
  const parentParts = parts.slice(0, -1)
  if (absolute) return `/${parentParts.join('/')}`
  return parentParts.join('/')
}

// Path::is_dir: false when the metadata cannot be read (missing path, symlink loop, no permission).
// existsSync reports every such failure as false, so statSync only runs on a path that resolves.
function isDir(dir) {
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory()
}

// std::fs::create_dir_all: an existing directory (or a link to one) is accepted, a missing parent is created
// first, and any other mkdir failure is the error.
function mkdirAll(dir) {
  if (dir === '') return
  try {
    fs.mkdirSync(dir)
    return
  } catch (e) {
    if (e.code !== 'ENOENT') {
      if (isDir(dir)) return
      throw e
    }
  }
  const parent = rustParent(dir)
  if (parent === undefined) throw new Error('failed to create whole tree')
  mkdirAll(parent)
  try {
    fs.mkdirSync(dir)
  } catch (e) {
    if (!isDir(dir)) throw e
  }
}

function createDirAll(dir) {
  try {
    mkdirAll(dir)
  } catch (e) {
    throw ConfyError.of('DirectoryCreationFailed', ioError(e))
  }
}

// read_to_string keeps a leading byte order mark; each format decides what it means.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// File::open then read_to_string: { notFound } or { text }; other open failures are GeneralLoadError.
function readConfig(filePath) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
  } catch (e) {
    if (e.code === 'ENOENT') return { notFound: true }
    throw ConfyError.of('GeneralLoadError', ioError(e))
  }
  try {
    return { text: utf8.decode(fs.readFileSync(fd)) }
  } catch (e) {
    throw ConfyError.of('ReadConfigurationFileError', ioError(e))
  } finally {
    fs.closeSync(fd)
  }
}

function requireSchema(schema) {
  if (!schema || typeof schema.kind !== 'string') throw new TypeError('a schema built with `t` is required')
}

/**
 * Builds the API of one entry point around a configuration format.
 *
 * @param {{ extension: string, parse: Function, serialize: Function, badData: string, serializeError: string }} format
 *   The codec, the file extension and the ConfyError kinds of its decoding and serialization failures.
 */
export function createConfy(format) {
  const parse = (text, schema) => {
    try {
      return format.parse(text, schema)
    } catch (e) {
      throw ConfyError.of(format.badData, e)
    }
  }

  /**
   * Gets the configuration file path used by `load` and `store`, for example to show it to the user:
   * `<config dir>/<app name>/<configName or "default-config">.<EXTENSION>` (see the README for the config dir).
   *
   * @param {string} appName
   * @param {string | null | undefined} configName
   * @returns {string}
   * @throws {ConfyError} `BadConfigDirectory` when no home directory can be found.
   */
  function getConfigurationFilePath(appName, configName) {
    const name = configName ?? 'default-config'
    let dir
    try {
      dir = configDir(appName)
    } catch (e) {
      if (!(e instanceof HomeDirError)) throw e
      // BadConfigDirectory is the one variant without a source (the Rust variant carries only its text), so the
      // lookup failure stays reachable as its cause.
      throw ConfyError.badConfigDirectory(`could not determine home directory path: ${e.message}`, e)
    }
    const file = `${name}.${format.extension}`
    return process.platform === 'win32' ? path.join(dir, file) : pushPath(dir, file)
  }

  function doStore(filePath, value, schema, mode) {
    requireSchema(schema)
    const parent = rustParent(filePath)
    if (parent === undefined) {
      throw ConfyError.badConfigDirectory(`${rustDebugString(filePath)} is a root or prefix`)
    }
    createDirAll(parent)
    // Serialize before opening, so a value that cannot be written leaves an existing file untouched.
    let text
    try {
      text = format.serialize(value, schema)
    } catch (e) {
      throw ConfyError.of(format.serializeError, e)
    }
    let fd
    try {
      fd = fs.openSync(filePath, 'w')
    } catch (e) {
      throw ConfyError.of('OpenConfigurationFileError', ioError(e))
    }
    try {
      if (mode !== undefined) {
        try {
          fs.fchmodSync(fd, mode)
        } catch (e) {
          throw ConfyError.of('SetPermissionsFileError', ioError(e))
        }
      }
      try {
        fs.writeFileSync(fd, text)
      } catch (e) {
        throw ConfyError.of('WriteConfigurationFileError', ioError(e))
      }
    } finally {
      fs.closeSync(fd)
    }
  }

  /**
   * Saves a configuration at a path, creating the missing parent directories. The value is serialized before
   * the file is opened, so a value that does not match the schema leaves an existing file untouched.
   *
   * @param {string} filePath
   * @param {unknown} value
   * @param {object} schema A schema built with `t`.
   * @throws {ConfyError} `BadConfigDirectory` for a path without a parent, `DirectoryCreationFailed`, the
   *   format's `Serialize...Error`, `OpenConfigurationFileError` or `WriteConfigurationFileError`.
   */
  function storePath(filePath, value, schema) {
    doStore(filePath, value, schema, undefined)
  }

  /**
   * `storePath` that also gives the file a mode (for example `0o600`) before writing it.
   *
   * @param {string} filePath
   * @param {unknown} value
   * @param {object} schema A schema built with `t`.
   * @param {number} mode
   * @throws {ConfyError} As `storePath`, and `SetPermissionsFileError`.
   */
  function storePathPerms(filePath, value, schema, mode) {
    doStore(filePath, value, schema, mode)
  }

  /**
   * Saves a configuration at the application's configuration file path, updating it or creating it.
   * Storing first is also the way to start with values other than the schema's default.
   *
   * @param {string} appName
   * @param {string | null | undefined} configName `"default-config"` when null or undefined.
   * @param {unknown} value
   * @param {object} schema A schema built with `t`.
   * @throws {ConfyError} As `getConfigurationFilePath` and `storePath`.
   */
  function store(appName, configName, value, schema) {
    storePath(getConfigurationFilePath(appName, configName), value, schema)
  }

  /**
   * `store` that also gives the file a mode (for example `0o600`).
   *
   * @param {string} appName
   * @param {string | null | undefined} configName
   * @param {unknown} value
   * @param {object} schema A schema built with `t`.
   * @param {number} mode
   * @throws {ConfyError} As `store`, and `SetPermissionsFileError`.
   */
  function storePerms(appName, configName, value, schema, mode) {
    storePathPerms(getConfigurationFilePath(appName, configName), value, schema, mode)
  }

  /**
   * Loads a configuration from a path. When the file does not exist, the schema's default value is stored
   * there (creating the parent directories) and returned.
   *
   * @param {string} filePath
   * @param {object} schema A schema built with `t`.
   * @returns {unknown} The decoded value.
   * @throws {ConfyError} `GeneralLoadError` when the file cannot be opened, `ReadConfigurationFileError` when it
   *   cannot be read or is not UTF-8, the format's `Bad...Data` when it does not decode, or an error of `storePath`.
   */
  function loadPath(filePath, schema) {
    requireSchema(schema)
    const read = readConfig(filePath)
    if (read.notFound) {
      const parent = rustParent(filePath)
      if (parent !== undefined) createDirAll(parent)
      const value = defaultValue(schema)
      storePath(filePath, value, schema)
      return value
    }
    return parse(read.text, schema)
  }

  /**
   * Loads an application's configuration from its configuration file path; a missing file is created with
   * the schema's default value.
   *
   * @param {string} appName
   * @param {string | null | undefined} configName `"default-config"` when null or undefined.
   * @param {object} schema A schema built with `t`.
   * @returns {unknown} The decoded value.
   * @throws {ConfyError} As `getConfigurationFilePath` and `loadPath`.
   */
  function load(appName, configName, schema) {
    return loadPath(getConfigurationFilePath(appName, configName), schema)
  }

  /**
   * Loads a configuration from a path, or stores and returns `op()` when the file does not exist, cannot be
   * read or does not decode.
   *
   * @param {string} filePath
   * @param {object} schema A schema built with `t`.
   * @param {() => unknown} op Called at most once.
   * @returns {unknown}
   * @throws {ConfyError} `GeneralLoadError` when the file exists but cannot be opened (`op` is not called), or
   *   an error of `storePath` while storing `op()`'s value.
   */
  function loadOrElse(filePath, schema, op) {
    requireSchema(schema)
    const fallback = () => {
      const value = op()
      const parent = rustParent(filePath)
      if (parent !== undefined) createDirAll(parent)
      storePath(filePath, value, schema)
      return value
    }
    let fd
    try {
      fd = fs.openSync(filePath, 'r')
    } catch (e) {
      if (e.code === 'ENOENT') return fallback()
      throw ConfyError.of('GeneralLoadError', ioError(e))
    }
    let value
    let failed = false
    try {
      value = format.parse(utf8.decode(fs.readFileSync(fd)), schema)
    } catch {
      // load_from_file().or_else(|_| load_value()): any read or parse failure falls back to `op`.
      failed = true
    } finally {
      fs.closeSync(fd)
    }
    return failed ? fallback() : value
  }

  return Object.freeze({
    /** The file extension of this format's configuration files (`toml`, `yml` or `ron`). */
    EXTENSION: format.extension,
    load,
    loadPath,
    loadOrElse,
    store,
    storePerms,
    storePath,
    storePathPerms,
    getConfigurationFilePath,
  })
}
