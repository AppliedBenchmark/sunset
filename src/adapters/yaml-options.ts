// YAML from the scanned repository (its config, a registry file it names) is parsed quietly: by
// default `yaml` reports warnings through process.emitWarning, which writes the source lines it
// quotes to stderr as they are, past `printable()`. Errors still throw.
export const QUIET = { logLevel: 'error' } as const;
