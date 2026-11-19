import { Chess } from 'chess.js';

const BASE = import.meta.env?.BASE_URL || './';
const ENGINE = 'engine/stockfish-17.1-lite-single-03e3232.js';
export function parseInfo(line) {
  const depth = /\bdepth (\d+)/.exec(line), score = /\bscore (cp|mate) (-?\d+)/.exec(line);
  if (!depth || !score || /\bmultipv ([2-9]|[1-9]\d+)/.test(line)) return null;
  const n = Number(score[2]);
  return { depth: Number(depth[1]), scoreCp: score[1] === 'cp' ? n : Math.sign(n || -1) * (100000 - Math.abs(n)), ...(score[1] === 'mate' ? {mate:n} : {}), pv: (/\bpv (.+)$/.exec(line)?.[1] || '').trim().split(/\s+/).filter(Boolean), source:'stockfish' };
}

export async function createEngine(onStatus = () => {}) {
  onStatus('Loading bundled Stockfish 17.1…');
  const worker = new Worker(new URL(BASE + ENGINE, globalThis.location.href));
  let closed = false, current = null, serial = Promise.resolve();
  const waiters = new Set();
  function waitFor(predicate, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {waiters.delete(handler); reject(new Error('Stockfish timed out. Reduce depth or reload the engine.'));}, timeout);
      function handler(line, error) { if (error || predicate(line)) {clearTimeout(timer); waiters.delete(handler); error ? reject(error) : resolve(line);} }
      waiters.add(handler);
    });
  }
  worker.onmessage = ({data}) => {
    for (const line of String(data).split('\n')) {
      if (current) { const info = parseInfo(line); if (info && !/\b(upperbound|lowerbound)\b/.test(line)) current.info = info; }
      for (const waiter of [...waiters]) waiter(line);
    }
  };
  function close() {
    closed = true; worker.terminate();
    for (const waiter of [...waiters]) waiter('', new Error('Stockfish closed or cancelled.'));
  }
  worker.onerror = e => { for (const waiter of [...waiters]) waiter('', new Error(e.message || 'Stockfish worker failed')); close(); };
  try {
    const ready = waitFor(line => line === 'uciok'); worker.postMessage('uci'); await ready;
    worker.postMessage('setoption name Hash value 32');
    const idle = waitFor(line => line === 'readyok'); worker.postMessage('isready'); await idle;
  } catch (e) { close(); throw e; }
  onStatus('Stockfish 17.1 · single-thread NNUE · ready');
  return {
    evaluate(fen, settings = {}) {
      const task = async () => {
        if (closed) throw new Error('Stockfish is closed');
        const chess = new Chess(fen);
        if (chess.isCheckmate()) return {bestMove:null, scoreCp:-100000,mate:0,depth:0,pv:[],source:'stockfish'};
        if (chess.isStalemate()) return {bestMove:null,scoreCp:0,depth:0,pv:[],source:'stockfish'};
        const depth = Math.max(1, Math.min(24, Math.round(Number(settings.depth) || 14)));
        current = {info:null};
        const done = waitFor(line => line.startsWith('bestmove '), 180000);
        worker.postMessage('position fen ' + fen);
        worker.postMessage('go depth ' + depth);
        try {
          const line = await done, info = current.info;
          if (!info) throw new Error('Stockfish returned no scored principal variation');
          const bestMove = line.split(/\s+/)[1];
          if (!chess.moves({verbose:true}).some(m => m.from+m.to+(m.promotion || '') === bestMove)) throw new Error('Engine returned an illegal move');
          return {...info,bestMove};
        } catch(e) { close(); throw e; } finally {current=null;}
      };
      const result = serial.then(task); serial = result.catch(() => {}); return result;
    },
    close,
  };
}

const theoryCache = new Map();
let theoryQueue = Promise.resolve(), lastTheory = 0;
async function boundedResponse(response, limit, signal) {
  if (!response.ok) throw new Error(`Public API returned HTTP ${response.status}${response.status === 429 ? ' (rate limited; please retry later)' : ''}`);
  const reader=response.body.getReader(); const chunks=[]; let size=0;
  try { while(true) {signal?.throwIfAborted(); const {done,value}=await reader.read(); if(done)break; size+=value.length; if(size>limit)throw new Error('Import exceeds size limit. Use a smaller PGN export.'); chunks.push(value);} }
  catch(e) {await reader.cancel();throw e;}
  const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return new TextDecoder().decode(result);
}
async function request(url, {signal,limit=30*1024*1024,accept='application/json'}={}) {
  const timed = AbortSignal.timeout(90000);
  const combined = signal ? AbortSignal.any([signal,timed]) : timed;
  return boundedResponse(await fetch(url,{signal:combined,headers:{Accept:accept}}),limit,combined);
}
export async function getTheory(fen, source = 'masters', signal) {
  if (!['masters','lichess'].includes(source)) throw new Error('Unknown theory source');
  new Chess(fen);
  const key=source+':'+fen.split(' ').slice(0,4).join(' ');
  if(theoryCache.has(key))return structuredClone(theoryCache.get(key));
  const task=async()=>{
    signal?.throwIfAborted();
    const delay=Math.max(0,1100-(Date.now()-lastTheory)); if(delay) await new Promise((resolve,reject)=>{const t=setTimeout(finish,delay);function finish(){signal?.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(t);reject(signal.reason);}signal?.addEventListener('abort',abort,{once:true});});
    if(theoryCache.has(key))return structuredClone(theoryCache.get(key));
    lastTheory=Date.now();
    const url=new URL('https://explorer.lichess.ovh/'+source);url.searchParams.set('fen',fen);url.searchParams.set('moves','30');url.searchParams.set('topGames','0');
    if(source==='lichess'){url.searchParams.set('ratings','2200,2500');url.searchParams.set('speeds','blitz,rapid,classical');url.searchParams.set('recentGames','0');}
    const data=JSON.parse(await request(url,{signal,limit:2*1024*1024}));
    if(!Array.isArray(data.moves) || !['white','draws','black'].every(k=>Number.isFinite(data[k])&&data[k]>=0))throw new Error('Invalid opening explorer response');
    const result={...data,source};theoryCache.set(key,result);return structuredClone(result);
  };
  const result=theoryQueue.then(task);theoryQueue=result.catch(()=>{});return result;
}
export { fetchArchive as fetchGames } from './archive.js';
