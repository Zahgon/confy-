// Port of the subset of the `etcetera` crate that confy uses: computing the
// per-application *config directory* for the `App` (XDG) and `Native`
// (Apple / Unix / Windows) strategies.
//
// confy only ever calls `config_dir()`, so that is all this module reproduces.
// The exact path shapes are pinned by confy's own tests, e.g. on macOS:
//   App    -> {home}/.config/{app}
//   Native -> {home}/Library/Preferences/{tld}.{app}
// and on Linux/Windows as asserted in `src/lib.rs`'s `test_store_path_*`.

import os from 'node:os'
import path from 'node:path'

// etcetera lower-cases names and turns spaces into hyphens.
function unixyName(appName) {
  return appName.toLowerCase().replace(/ /g, '-')
}

// etcetera's `AppStrategyArgs::bundle_id`: "{tld}.{author.}{app_name}" with an
// empty author collapsing to nothing, then lower-cased with spaces -> hyphens.
function bundleId(tld, author, appName) {
  const authorPart = author ? `${author}.` : ''
  return `${tld}.${authorPart}${appName}`.toLowerCase().replace(/ /g, '-')
}

// `app_strategy::Xdg` — respects $XDG_CONFIG_HOME when it is an absolute path,
// otherwise falls back to ~/.config, then appends the unixy app name.
function xdgConfigDir(args) {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config')
  return path.join(base, unixyName(args.appName))
}

// `app_strategy::Apple` — ~/Library/Preferences/{bundle_id}.
function appleConfigDir(args) {
  return path.join(
    os.homedir(),
    'Library',
    'Preferences',
    bundleId(args.tld, args.author, args.appName),
  )
}

// `app_strategy::Unix` — the native (non-XDG) unix strategy: ~/.config/{app}.
function unixConfigDir(args) {
  return path.join(os.homedir(), '.config', unixyName(args.appName))
}

// `app_strategy::Windows` — {RoamingAppData}\{author?}\{app}\config.
function windowsConfigDir(args) {
  const roaming =
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const parts = [roaming]
  if (args.author) parts.push(args.author)
  parts.push(args.appName, 'config')
  return path.join(...parts)
}

/**
 * Resolve the config directory for a strategy on the current platform,
 * mirroring `choose_app_strategy` / `choose_native_strategy` + the
 * `InternalStrategy::config_dir` match in confy.
 *
 * `platform` defaults to the host's `process.platform`; it is a parameter so the
 * three OS branches — which are otherwise unreachable on any single host — can be
 * driven deterministically. The value shapes are still pinned to the current
 * host's home directory and env, so this exercises the branch selection, not a
 * cross-platform path fiction.
 *
 * @param {'App'|'Native'} strategy
 * @param {{tld: string, author: string, appName: string}} args
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function configDir(strategy, args, platform = process.platform) {
  if (strategy === 'Native') {
    if (platform === 'win32') return windowsConfigDir(args)
    if (platform === 'darwin') return appleConfigDir(args)
    return unixConfigDir(args)
  }
  // App / XDG strategy: Windows uses the Windows layout, everything else XDG.
  if (platform === 'win32') return windowsConfigDir(args)
  return xdgConfigDir(args)
}
