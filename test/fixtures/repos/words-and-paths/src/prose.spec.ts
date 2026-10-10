// Sentences that mention an ID, and the values in them that still count.
it('drops temperature for gpt-fixture-retired', () => {
  expect(() => check('gpt-fixture-3')).toThrow('Model gpt-fixture-retired is not supported');
});
export const recorded = '{"id": "chatcmpl-1", "model": "gpt-fixture-retired", "choices": []}';
export const command = 'python eval.py --model gpt-fixture-retired --temperature 0';
