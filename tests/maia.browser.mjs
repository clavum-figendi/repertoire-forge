import { chromium } from '@playwright/test';
import { build, preview } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// Own temporary build and port: never overwrite the application's shared dist.
const outDir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'maia-browser-'));
let server;
let browser;
try {
  await build({ base: './', build: { outDir, emptyOutDir: true, rollupOptions: { input: 'tests/maia-harness.html' } } });
  server = await preview({ base: './', build: { outDir }, preview: { port: 5197, strictPort: true, host: '127.0.0.1' } });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  const requests = [];
  const errors = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:5197/tests/maia-harness.html');
  await page.waitForFunction(() => window.maiaHarness);
  assert.equal(requests.filter((url) => /onnx|\.wasm|maia-worker/.test(url)).length, 0, 'No model/runtime download before opt-in');
  const results = await page.evaluate(async () => {
    const { predictMaia, Chess } = window.maiaHarness;
    const fens = [
      'r1b2rk1/2q1bppp/p2p1n2/np2p3/3PP3/5N1P/PPBN1PP1/R1BQR1K1 w - - 0 13',
      'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
      '8/P6k/8/8/8/8/6Kp/8 b - - 0 1',
      '8/P6k/8/8/8/8/6Kp/8 w - - 0 1',
      'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
      'r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1',
      '7k/8/8/3pP3/8/8/8/K7 w - d6 0 1',
    ];
    const predictions = [];
    for (const fen of fens) {
      const start = performance.now();
      const moves = await predictMaia(fen);
      const legal = new Chess(fen).moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion || '')).sort();
      predictions.push({ fen, milliseconds: performance.now() - start, moves, legal });
    }
    return predictions;
  });
  for (const { moves, legal } of results) {
    assert.deepEqual(moves.map((m) => m.uci).sort(), legal);
    assert.ok(Math.abs(moves.reduce((sum, m) => sum + m.probability, 0) - 1) < 1e-6);
    assert.ok(moves.every((m, i) => Number.isFinite(m.probability) && m.probability >= 0 && (!i || moves[i - 1].probability >= m.probability)));
  }
  // Upstream PyTorch example: Nf1 ~0.66, not a fabricated uniform policy.
  assert.equal(results[0].moves[0].uci, 'd2f1');
  assert.ok(results[0].moves[0].probability > 0.60 && results[0].moves[0].probability < 0.72);
  const cancellation = await page.evaluate(async () => {
    const { predictMaia, Chess } = window.maiaHarness;
    const controller = new AbortController();
    const prediction = predictMaia(new Chess().fen(), { signal: controller.signal });
    controller.abort();
    try { await prediction; return 'not aborted'; } catch (error) { return error.name; }
  });
  assert.equal(cancellation, 'AbortError');
  assert.deepEqual(errors, []);
  assert.equal(requests.filter((url) => url.endsWith('maia_rapid.onnx')).length, 1, 'One model load for repeated inference');
  assert.ok(requests.every((url) => url.startsWith('http://127.0.0.1:5197/')), 'Only same-origin network');
  // Cancellation terminates the last caller's worker. Recreate it, expose an
  // honest HTTP failure, then prove retry works in the same module instance.
  await page.route('**/maia_rapid.onnx', (route) => route.fulfill({ status: 503, body: 'unavailable' }));
  const downloadFailure = await page.evaluate(async () => {
    try { await window.maiaHarness.predictMaia(new window.maiaHarness.Chess().fen()); }
    catch (error) { return error.message; }
  });
  assert.match(downloadFailure, /HTTP 503/);
  await page.unroute('**/maia_rapid.onnx');
  const retry = await page.evaluate(async () => (await window.maiaHarness.predictMaia(new window.maiaHarness.Chess().fen())).length);
  assert.equal(retry, 20);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: browser.version(), crossOriginIsolated: await page.evaluate(() => crossOriginIsolated), lazy: true, cancellation, downloadFailure, retry, errors, requests, results: results.map(({ fen, milliseconds, moves }) => ({ fen, milliseconds, count: moves.length, top: moves.slice(0, 3) })) }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server ? server.httpServer.close(resolve) : resolve());
  await rm(outDir, { recursive: true, force: true });
}
