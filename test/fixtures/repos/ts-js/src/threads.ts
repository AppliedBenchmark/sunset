import { path } from './internal/utils/path';

export function retrieve(client: Client, threadID: string) {
  return client.get(path`/threads/${threadID}`, { headers: { 'OpenAI-Beta': 'assistants=v2' } });
}

// Migrate away from gpt-fixture-retired before it's gone.
export const DEFAULT_MODEL = 'gpt-fixture-3';
