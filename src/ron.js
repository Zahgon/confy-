// confy with ron 0.12 with the default pretty config.
import { createConfy } from './core.js'
import { parseRon, serializeRon } from './formats/ron.js'

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
  extension: 'ron',
  parse: parseRon,
  serialize: serializeRon,
  badData: 'BadRonData',
  serializeError: 'SerializeRonError',
})

export { ConfyError } from './errors.js'
export { ConfigStrategy, changeConfigStrategy } from './strategy.js'
export { t } from './schema.js'
