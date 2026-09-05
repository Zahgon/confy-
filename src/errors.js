// Port of confy's `ConfyError` enum (src/lib.rs).
//
// Each variant carries the underlying I/O / (de)serialization error as `source`,
// mirroring `#[source]` in the Rust `thiserror` definition. `kind` identifies the
// variant so tests and callers can branch on it the way Rust would `match` the enum.

export class ConfyError extends Error {
  /**
   * @param {string} kind    variant name, e.g. "BadTomlData"
   * @param {string} message human-readable message (matches Rust `#[error("...")]`)
   * @param {unknown} [source] underlying error
   */
  constructor(kind, message, source) {
    super(message)
    this.name = 'ConfyError'
    this.kind = kind
    if (source !== undefined) this.source = source
  }

  // #[error("Bad TOML data")]
  static badTomlData(source) {
    return new ConfyError('BadTomlData', 'Bad TOML data', source)
  }

  // #[error("Failed to create directory")]
  static directoryCreationFailed(source) {
    return new ConfyError('DirectoryCreationFailed', 'Failed to create directory', source)
  }

  // #[error("Failed to load configuration file")]
  static generalLoadError(source) {
    return new ConfyError('GeneralLoadError', 'Failed to load configuration file', source)
  }

  // #[error("Bad configuration directory: {0}")]
  static badConfigDirectory(detail) {
    return new ConfyError('BadConfigDirectory', `Bad configuration directory: ${detail}`)
  }

  // #[error("Failed to serialize configuration data into TOML")]
  static serializeTomlError(source) {
    return new ConfyError(
      'SerializeTomlError',
      'Failed to serialize configuration data into TOML',
      source,
    )
  }

  // #[error("Failed to write configuration file")]
  static writeConfigurationFileError(source) {
    return new ConfyError('WriteConfigurationFileError', 'Failed to write configuration file', source)
  }

  // #[error("Failed to read configuration file")]
  static readConfigurationFileError(source) {
    return new ConfyError('ReadConfigurationFileError', 'Failed to read configuration file', source)
  }

  // #[error("Failed to open configuration file")]
  static openConfigurationFileError(source) {
    return new ConfyError('OpenConfigurationFileError', 'Failed to open configuration file', source)
  }

  // #[error("Failed to set configuration file permissions")]
  static setPermissionsFileError(source) {
    return new ConfyError('SetPermissionsFileError', 'Failed to set configuration file permissions', source)
  }
}
