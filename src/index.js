// confy with the toml crate (TOML 1.1, pretty output), the default format.
import { createConfy } from './core.js'
import { parseToml, serializeToml } from './formats/toml.js'

export const {
  EXTENSION,
  load,
  loadPath,
  loadOrElse,
  store,
  storePerms,
  storePath,
  storePathPerms,
  getConfigurationFilePath,
} = createConfy({
  extension: 'toml',
  parse: parseToml,
  serialize: serializeToml,
  badData: 'BadTomlData',
  serializeError: 'SerializeTomlError',
})

export { ConfyError } from './errors.js'
export { ConfigStrategy, changeConfigStrategy } from './strategy.js'
export { t } from './schema.js'
