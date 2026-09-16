import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readCsvText } from './csv.js';

test('parses valid recipients and removes duplicates', async () => {
  const result = await readCsvText('email,name\na@example.com,A\nbad,B\na@example.com,C\nc@example.com,D\n');
  assert.equal(result.total, 4);
  assert.equal(result.valid, 2);
  assert.equal(result.invalid, 1);
  assert.equal(result.duplicates, 1);
  assert.deepEqual(result.recipients.map((r) => r.email), ['a@example.com', 'c@example.com']);
});

test('rejects csv without email column', async () => {
  await assert.rejects(() => readCsvText('name\nA\n'), /missing required column/i);
});
