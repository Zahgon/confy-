// ConfyError: one error class for every failure, mirroring the Rust `ConfyError` enum.
// `kind` is the variant name, `message` its Display text, `source` the underlying error (if any).

const MESSAGES = {
  BadTomlData: 'Bad TOML data',
  BadYamlData: 'Bad YAML data',
  BadRonData: 'Bad RON data',
  DirectoryCreationFailed: 'Failed to create directory',
  GeneralLoadError: 'Failed to load configuration file',
  SerializeTomlError: 'Failed to serialize configuration data into TOML',
  SerializeYamlError: 'Failed to serialize configuration data into YAML',
  SerializeRonError: 'Failed to serialize configuration data into RON',
  WriteConfigurationFileError: 'Failed to write configuration file',
  ReadConfigurationFileError: 'Failed to read configuration file',
  OpenConfigurationFileError: 'Failed to open configuration file',
  SetPermissionsFileError: 'Failed to set configuration file permissions',
}

/**
 * The errors confy can encounter.
 *
 * @property {'ConfyError'} name
 * @property {string} kind The variant: `BadTomlData`, `BadYamlData`, `BadRonData`, `DirectoryCreationFailed`,
 *   `GeneralLoadError`, `BadConfigDirectory`, `SerializeTomlError`, `SerializeYamlError`, `SerializeRonError`,
 *   `WriteConfigurationFileError`, `ReadConfigurationFileError`, `OpenConfigurationFileError` or
 *   `SetPermissionsFileError`.
 * @property {string} message The variant's text, for example `Failed to load configuration file`.
 * @property {Error} [source] The underlying error: the format's decoding or serialization error, or the
 *   file-system error with the Rust `std::io::Error` text. `BadConfigDirectory` has none.
 */
export class ConfyError extends Error {
  constructor(kind, message, source) {
    super(message)
    this.name = 'ConfyError'
    this.kind = kind
    if (source !== undefined) this.source = source
  }

  static of(kind, source) {
    return new ConfyError(kind, MESSAGES[kind], source)
  }

  static badConfigDirectory(detail) {
    return new ConfyError('BadConfigDirectory', `Bad configuration directory: ${detail}`)
  }
}

// The error a format codec raises; ConfyError wraps it as `source`.
export class FormatError extends Error {
  constructor(message) {
    super(message)
    this.name = 'FormatError'
  }
}
