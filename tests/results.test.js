import test from 'node:test';
import assert from 'node:assert/strict';
import {importPgn} from '../src/core.js';
test('user book WDL uses actual mainline results only, never RAV hypothetical results',()=>{
 const g=importPgn('[Result "1-0"]\n\n1. e4 (1. d4 d5) e5 1-0\n\n[Result "0-1"]\n\n1. e4 e5 0-1');
 const moves=g.nodes[g.root].edges;const e4=moves.find(e=>e.uci==='e2e4'),d4=moves.find(e=>e.uci==='d2d4');assert.equal(e4.white,1);assert.equal(e4.black,1);assert.equal(d4.white||0,0);assert.equal(d4.black||0,0);assert.equal(d4.count,1);
});
