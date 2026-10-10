const model = process.env.MODEL!;
await openai.chat.completions.create({ model, messages });
await openai.chat.completions.create({ model: config.model, messages });
await openai.chat.completions.create({ model: `${family}-mini`, messages });
interface Options { model: string; deployment?: string }
const pick = useLatest ? model : fallback;
