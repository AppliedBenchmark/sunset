// Finds, reads and validates `.sunset.yml`. Without an explicit path, the file is
// looked up in the scanned directory; a missing file there just means the defaults. A relative
// `registry:` path is resolved against the file's directory.
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { ConfigError, type ConfigFile, parseRegistryMode, validateConfig } from '../core/config.ts';
import { QUIET } from './yaml-options.ts';

export const CONFIG_FILE_NAMES = ['.sunset.yml', '.sunset.yaml'] as const;

export interface LoadedConfig {
  /** The file that was read, or null when there is none. */
  path: string | null;
  config: ConfigFile | null;
}

export async function loadConfigFile(root: string, explicit: string | null): Promise<LoadedConfig> {
  const candidates = explicit ? [explicit] : CONFIG_FILE_NAMES.map((name) => join(root, name));
  for (const path of candidates) {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!explicit && code === 'ENOENT') continue;
      throw new ConfigError(`can't read the config file ${path}: ${code ?? String(error)}`);
    }
    let data: unknown;
    try {
      data = parse(text, QUIET);
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
      throw new ConfigError(`${path} is not valid YAML: ${message}`);
    }
    const config = validateConfig(data, path);
    if (config.registry !== undefined) {
      const mode = parseRegistryMode(config.registry);
      if (mode.kind === 'file' && !isAbsolute(mode.path)) {
        config.registry = resolve(dirname(path), mode.path);
      }
    }
    return { path, config };
  }
  return { path: null, config: null };
}
