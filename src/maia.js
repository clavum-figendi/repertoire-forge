import { Chess } from 'chess.js';

// No model, runtime, worker, or network request is created until predictMaia.
export const MAIA_RATING = 1500;
export const MAIA_MODEL_BYTES = 93246338;
export const MAIA_RUNTIME_BYTES = 12361745;
export const MAIA_MODEL_SHA256 = '027ddb8c1a8b7235b6e51827cffe325f9cb95fd4523dce65a131547c034ccfc9';

let worker;
let nextId = 0;
const pending = new Map();
const abortError = () => new DOMException('Maia inference aborted', 'AbortError');

function failWorker(error) {
  worker?.terminate();
  worker = undefined;
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

function getWorker() {
  if (worker) return worker;
  if (typeof Worker === 'undefined') throw new Error('Maia requires browser Web Worker support');
  worker = new Worker(new URL('./maia-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(`Maia: ${data.error}`));
    else request.resolve(data.moves);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    failWorker(new Error(`Maia worker failed: ${event.message || 'unknown runtime error'}`));
  };
  worker.onmessageerror = () => failWorker(new Error('Maia worker returned an unreadable message'));
  return worker;
}

/** Legal move probabilities, not engine evaluations. Both players are rated 1500.
 * Aborting drops the result; if no other callers remain, terminate the worker
 * (including any in-progress download or WASM inference). A later call retries.
 */
export async function predictMaia(fen, { signal } = {}) {
  if (signal?.aborted) throw abortError();
  const board = new Chess(fen);
  if (!board.moves().length) return [];
  const activeWorker = getWorker();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      pending.delete(id);
      cleanup();
      reject(abortError());
      if (!pending.size) {
        activeWorker.terminate();
        if (worker === activeWorker) worker = undefined;
      }
    };
    // A failed/offline load must never leave an opt-in button stuck forever.
    const timer = setTimeout(() => failWorker(new Error('Maia timed out while loading or predicting; please retry')), 180000);
    pending.set(id, {
      resolve: (moves) => { cleanup(); resolve(moves); },
      reject: (error) => { cleanup(); reject(error); },
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    activeWorker.postMessage({ id, fen: board.fen() });
  });
}
