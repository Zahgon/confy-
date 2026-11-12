// confy with the basic-toml crate (compact arrays, basic strings).
import { createConfy } from './core.js'
import { parseBasicToml } from './formats/basic-toml.js'
import { serializeBasicToml } from './formats/toml.js'

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
  parse: parseBasicToml,
  serialize: serializeBasicToml,
  badData: 'BadTomlData',
  serializeError: 'SerializeTomlError',
})

export { ConfyError } from './errors.js'
export { ConfigStrategy, changeConfigStrategy } from './strategy.js'
export { t } from './schema.js'
