import test from 'node:test';
import assert from 'node:assert/strict';
import {predictMaia} from '../src/maia.js';
const fen='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
test('Maia rejects an unsupported rating instead of pretending to model grandmasters',async()=>{
 await assert.rejects(predictMaia(fen,{rating:2600}),/rating.*1000.*2000/i);
});
test('Maia transmits the selected supported rating to the worker',async()=>{
 const old=globalThis.Worker;let sent;
 globalThis.Worker=class {postMessage(m){sent=m;queueMicrotask(()=>this.onmessage({data:{id:m.id,moves:[{uci:'e2e4',probability:1}]}}));}terminate(){}};
 try{await predictMaia(fen,{rating:1900});assert.equal(sent.rating,1900);}finally{globalThis.Worker=old;}
});
