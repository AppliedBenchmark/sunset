import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';

// The AI SDK's providers take the model ID as a literal: it is checked where it's written.
await generateText({ model: openai('gpt-fixture-retired'), prompt });
await generateText({ model: anthropic('claude-fixture-opus-9'), prompt });
await generateText({ model: openai(process.env.MODEL ?? 'gpt-fixture-3'), prompt });
