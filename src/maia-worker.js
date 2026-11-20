import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import mjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import { createMaia } from '@indiefoundry/maia2-onnx';

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, self.location.href).href, mjs: new URL(mjsUrl, self.location.href).href };
const MODEL_HASH = '027ddb8c1a8b7235b6e51827cffe325f9cb95fd4523dce65a131547c034ccfc9';
// BASE_URL is replaced by Vite, including relative-base builds and subpaths.
const modelUrl = new URL(`${import.meta.env.BASE_URL}models/maia2/maia_rapid.onnx`, self.location.origin + self.location.pathname.replace(/\/assets\/[^/]*$/, '/')).href;
let modelPromise;

async function loadModel() {
  const response = await fetch(modelUrl);
  if (!response.ok) throw new Error(`Model download failed (HTTP ${response.status})`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== 93246338) throw new Error('Maia model size mismatch; file is missing or incomplete');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  if (hash !== MODEL_HASH) throw new Error('Maia model integrity check failed');
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  // CSSLab's original export names the policy head logits_maia; the npm
  // adapter's re-export calls it logits_move. Encoding/vocabulary are identical.
  return createMaia({
    Tensor: ort.Tensor,
    session: { async run(feeds) {
      const result = await session.run(feeds);
      return { logits_move: result.logits_maia, logits_value: result.logits_value };
    } },
  });
}

// Serialize inference; avoid overlapping session.run and extra memory spikes.
let queue = Promise.resolve();
self.onmessage = ({ data: { id, fen, rating = 2000 } }) => {
  queue = queue.then(async () => {
    try {
      if (!modelPromise) modelPromise = loadModel().catch((error) => { modelPromise = undefined; throw error; });
      const model = await modelPromise;
      if(!Number.isInteger(rating)||rating<1000||rating>2000||rating%100)throw new Error('Unsupported Maia rating');
      const prediction = await model.predict(fen, rating, rating);
      const moves = prediction.moves.map(({ uci, p }) => ({ uci, probability: p }));
      if (moves.some(({ probability }) => !Number.isFinite(probability) || probability < 0 || probability > 1)) {
        throw new Error('Maia returned invalid probabilities');
      }
      self.postMessage({ id, moves });
    } catch (error) {
      self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
};
