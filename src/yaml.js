// confy with serde_yaml 0.9.
import { createConfy } from './core.js'
import { parseYaml, serializeYaml } from './formats/yaml.js'

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
  extension: 'yml',
  parse: parseYaml,
  serialize: serializeYaml,
  badData: 'BadYamlData',
  serializeError: 'SerializeYamlError',
})

export { ConfyError } from './errors.js'
export { ConfigStrategy, changeConfigStrategy } from './strategy.js'
export { t } from './schema.js'
