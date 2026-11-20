import test from 'node:test';import assert from 'node:assert/strict';
import {importPgn} from '../src/core.js';import {appendArchiveBatch} from '../src/archive-workspace.js';
test('capacity stop retains completed games from the same batch for backsolving',()=>{
 const graph=importPgn('1. d4 d5 *');
 const huge=Array(514).fill('Nf3 Nf6 Ng1 Ng8').join(' ');
 const result=appendArchiveBatch(graph,'1. e4 e5 *\n\n'+huge+' *');
 assert.equal(result.stopped,true);assert.equal(graph.games,2);
 assert.ok(graph.nodes[graph.root].edges.some(e=>e.uci==='e2e4'));
 assert.equal(graph.lines.length,2);
});
