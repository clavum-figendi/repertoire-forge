import test from 'node:test';
import assert from 'node:assert/strict';
import {importPgn} from '../src/core.js';

test('archive import does not count a game ID twice, even in a later batch',()=>{
 const game='[Site "https://lichess.org/aBcDe123"]\n\n1. e4 e5 *';
 const a=importPgn(game,undefined,{deduplicate:true});
 const b=importPgn(game,a,{deduplicate:true});
 assert.equal(b.games,1);assert.equal(b.nodes[b.root].edges[0].count,1);
 assert.equal(b.lines[0].gameId,'https://lichess.org/aBcDe123');
});

test('archive graph stores only the chosen opening plies, and supports private staged mutation',()=>{
 const g=importPgn('1. d4 d5 *');
 const a=importPgn('1. e4 e5 2. Nf3 Nc6 *',g,{maxStoredPlies:2,mutate:true});
 assert.equal(g,a);assert.deepEqual(a.lines[1].moves,['e2e4','e7e5']);
});
