import test from 'node:test';
import assert from 'node:assert/strict';
import {parseInfo, fetchGames, getTheory} from '../src/services.js';
test('UCI parsing preserves side-to-move score, depth and mate',()=>{assert.deepEqual(parseInfo('info depth 16 seldepth 22 score cp -38 nodes 1 pv e7e5 g1f3'),{depth:16,scoreCp:-38,pv:['e7e5','g1f3'],source:'stockfish'});const x=parseInfo('info depth 18 score mate -3 pv a1a2');assert.equal(x.mate,-3);assert.ok(x.scoreCp < -90000);assert.equal(parseInfo('info string test'),null);});
test('username import rejects URL injection before network',async()=>{await assert.rejects(fetchGames('lichess','a/b',{}),/username/i);await assert.rejects(fetchGames('unknown','abc',{}),/platform/i);});
test('theory source rejects unknown provider',async()=>{await assert.rejects(getTheory('x','injected'),/source/i);});
