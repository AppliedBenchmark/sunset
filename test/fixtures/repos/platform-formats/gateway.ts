import { generateText } from 'ai';

// The AI SDK sends a `<vendor>/<id>` string to the Vercel AI Gateway.
await generateText({ model: 'openai/gpt-fixture-retired', prompt: 'Hi' });
await generateText({ model: 'google/gemini-fixture-1.0-flash', prompt: 'Hi' });
