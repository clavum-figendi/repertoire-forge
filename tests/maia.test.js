import test from 'node:test';
import assert from 'node:assert/strict';
import { predictMaia } from '../src/maia.js';

test('Maia rejects malformed positions without starting a download', async () => {
  await assert.rejects(predictMaia('not a fen'), /fen/i);
});

test('Maia respects an already aborted request before starting a worker', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(predictMaia('8/8/8/8/8/8/4K3/7k w - - 0 1', { signal: controller.signal }), { name: 'AbortError' });
});

test('Maia returns no policy for a terminal position without loading the model', async () => {
  assert.deepEqual(await predictMaia('7k/6Q1/5K2/8/8/8/8/8 b - - 0 1'), []);
});

test('Maia reports unavailable browser workers honestly', async () => {
  await assert.rejects(predictMaia('8/8/8/8/8/8/4K3/7k w - - 0 1'), /browser.*worker/i);
});
