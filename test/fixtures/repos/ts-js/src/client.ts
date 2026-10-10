import OpenAI from 'openai';

const client = new OpenAI();
export const MODEL = 'gpt-fixture-1-2099-01-10';
const PATTERN = /"gpt-fixture-retired"/; // a regex, not a string
const ratio = total / count / "gpt-fixture-3".length;

export async function ask(prompt: string, model: string = process.env.OPENAI_MODEL ?? 'gpt-fixture-3') {
  const res = await client.chat.completions.create({
    model: model,
    messages: [{ role: 'user', content: `${model},gpt-fixture-retired` }],
  });
  return res;
}

const nested = `outer ${`inner ${'gpt-fixture-2-2099-02-15'}`} tail`;
/* block comment: gpt-fixture-retired */
export const options = { model: process.env.MODEL, deployment: config.deployment };
