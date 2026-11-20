import fs from 'node:fs';
import assert from 'node:assert/strict';
import {Chess} from 'chess.js';
import {DEFAULT_CLOUD_URL} from '../../src/cloud-client.js';
import {importPgn,backsolve,positionKey,DEFAULT_SETTINGS} from '../../src/core.js';
// Execute trusted repository source only; archive/network strings are never evaluated.
// Execute the exact current web restore graph/settings validators, not copies.
const main=fs.readFileSync(new URL('../../src/main.js',import.meta.url),'utf8');
const graphCode=main.slice(main.indexOf('function validateGraph('), main.indexOf('async function restore('));
const settingsCode=main.slice(main.indexOf('function boundedSettings('),main.indexOf('function bind('));
const validateGraph=new Function('Chess','positionKey',`${graphCode};return validateGraph;`)(Chess,positionKey);
const boundedSettings=new Function('DEFAULT_SETTINGS','MAIA_RATING','DEFAULT_CLOUD_URL',`${settingsCode};return boundedSettings;`)(DEFAULT_SETTINGS,1500,DEFAULT_CLOUD_URL);
const results=[];
for(const name of ['fixture','lichess-live','chesscom-live']){
 const data=JSON.parse(fs.readFileSync(new URL(`../artifacts/${name}.json`,import.meta.url),'utf8'));
 assert.equal(data.format,'repertoire-forge');assert.equal(data.version,1);
 validateGraph(structuredClone(data.graph));boundedSettings(data.settings);
 const ids=new Set();for(const c of data.cards){assert.equal(c.id,positionKey(c.fen));assert(!ids.has(c.id));ids.add(c.id);for(const k of ['due','interval','ease','repetitions','lapses'])assert(Number.isFinite(c[k]));const chess=new Chess(c.fen);chess.move({from:c.uci.slice(0,2),to:c.uci.slice(2,4),promotion:c.uci[4]});}
 for(const line of data.graph.lines){const chess=new Chess(line.fen);for(const uci of line.moves)chess.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]});if(Number.isInteger(line.mistakePly)){assert.equal(line.moves.length,line.mistakePly+2);}}
 const pgn=fs.readFileSync(new URL(`../artifacts/${name}.pgn`,import.meta.url),'utf8');const roundtrip=importPgn(pgn,undefined,{strict:true});assert.equal(roundtrip.games,data.graph.games);
 const cache=new Map(fs.readFileSync(new URL(`../artifacts/${name}.cache.ndjson`,import.meta.url),'utf8').trim().split('\n').map(s=>{const c=JSON.parse(s);return [c.key,c.value]}));
 const source=name==='fixture'?fs.readFileSync(new URL('fixture.pgn',import.meta.url),'utf8').split('[Event "Short filtered"]')[0]:fs.readFileSync(new URL(`../artifacts/${name}.archive.pgn`,import.meta.url),'utf8');
 const graph=importPgn(source,undefined,{strict:true,maxStoredPlies:data.settings.maxPly});const expected=await backsolve(graph,{settings:data.settings,evaluate:async fen=>{assert(cache.has(positionKey(fen)));return cache.get(positionKey(fen));}});
 assert.deepEqual(data.graph.lines.map(l=>[l.moves,l.mistakePly]),expected.graph.lines.map(l=>[l.moves,l.mistakePly]));
 assert.deepEqual(data.cards.map(c=>[c.id,c.uci]).sort(),expected.cards.map(c=>[c.id,c.uci]).sort());
 results.push({name,games:data.graph.games,positions:Object.keys(data.graph.nodes).length,cards:data.cards.length,stats:data.native,restoreValidators:'passed',legalPgnRoundtrip:'passed',jsCoreBacksolveParity:'passed'});
}
console.log(JSON.stringify({verified:true,results},null,2));
