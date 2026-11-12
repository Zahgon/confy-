// Config directory resolution, the part of the `etcetera` crate (0.11) confy uses: `choose_app_strategy`
// and `choose_native_strategy` with top-level domain "rs", an empty author and the app name.

import os from 'node:os'
import path from 'node:path'
import { rustLowercase } from './lowercase.js'

/**
 * Where configuration files are placed. `App` (the default) is the XDG layout on Linux and macOS; `Native`
 * is the operating system's own layout, which differs from `App` only on macOS (`~/Library/Preferences`).
 * Both are the same on Windows.
 */
export const ConfigStrategy = Object.freeze({ App: 'App', Native: 'Native' })

let current = ConfigStrategy.App

/**
 * Changes the strategy used by every entry point; call it before loading or storing.
 *
 * @param {'App' | 'Native'} strategy
 * @throws {TypeError} For any other value.
 */
export function changeConfigStrategy(strategy) {
  if (strategy !== ConfigStrategy.App && strategy !== ConfigStrategy.Native) {
    throw new TypeError(`unknown config strategy: ${String(strategy)}`)
  }
  current = strategy
}

export class HomeDirError extends Error {
  constructor(options) {
    super('could not locate home directory', options)
    this.name = 'HomeDirError'
  }
}

// Rust's std::env::home_dir: a non-empty $HOME, else the passwd entry of the current user.
function homeDir() {
  const home = process.env.HOME
  if (home) return home
  let entry
  try {
    entry = os.userInfo().homedir
  } catch (e) {
    // No passwd entry for the current user: Rust's home_dir returns None, which confy reports as BadConfigDirectory.
    if (e?.code !== 'ENOENT' && e?.code !== 'ERR_SYSTEM_ERROR') throw e
    throw new HomeDirError({ cause: e })
  }
  if (entry) return entry
  throw new HomeDirError()
}

// etcetera's "unixy" app name: lower case, spaces turned into hyphens.
function unixyName(appName) {
  return rustLowercase(appName).replace(/ /g, '-')
}

/**
 * Rust's `PathBuf::push` on Unix: nothing is normalised, a separator is added only when `base` is non-empty and
 * does not end with one, and an absolute `part` replaces `base`.
 *
 * @param {string} base
 * @param {string} part
 * @returns {string}
 */
export function pushPath(base, part) {
  if (part.startsWith('/')) return part
  return base && !base.endsWith('/') ? `${base}/${part}` : base + part
}

// etcetera's bundle id: "rs", the (empty) author and the app name with spaces turned into hyphens, case kept.
function bundleId(appName) {
  return ['rs', appName.replace(/ /g, '-')].filter(Boolean).join('.')
}

function xdgConfigDir(home, appName) {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && path.isAbsolute(xdg) ? xdg : pushPath(home, '.config/')
  return pushPath(base, unixyName(appName))
}

function windowsConfigDir(home, appName) {
  return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), appName, 'config')
}

// Both strategies are the XDG layout on Linux and other Unix systems; they differ on macOS and Windows.
export function configDir(appName, strategy = current, platform = process.platform) {
  const home = homeDir()
  if (platform === 'win32') return windowsConfigDir(home, appName)
  if (platform === 'darwin' && strategy === ConfigStrategy.Native) {
    return pushPath(pushPath(home, 'Library/Preferences/'), bundleId(appName))
  }
  return xdgConfigDir(home, appName)
}
