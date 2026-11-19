import test from 'node:test';
import assert from 'node:assert/strict';
import {importPgn} from '../src/core.js';
import {startDrill, advanceDrill, drillChoices, boardFlipped} from '../src/drill.js';

test('a drill follows actual lines and distinguishes exhaustion from deviation',()=>{
 const g=importPgn('1. Nf3 d5 2. d4 Nf6 *\n\n1. d4 Nf6 2. Nf3 d5 3. g3 *');
 let d=startDrill(g,'w');
 assert.equal(advanceDrill(d,'e2e4').outcome,'off-book');
 for(const m of ['g1f3','d7d5','d2d4','g8f6']) d=advanceDrill(d,m);
 assert.equal(d.outcome,'exhausted');
 assert.deepEqual(drillChoices(d),[]);
});

test('the recorded reply refutes either side and stops immediately',()=>{
 const g=importPgn('1. e4 e5 *');g.lines[0].mistakePly=0;
 for(const [side,outcome] of [['w','refuted'],['b','refutation']]){
  let d=advanceDrill(startDrill(g,side),'e2e4');
  assert.equal(d.outcome,null);
  assert.deepEqual(drillChoices(d),[{uci:'e7e5',weight:1,refutation:true}]);
  assert.equal(advanceDrill(d,'e7e5').outcome,outcome);
  assert.equal(advanceDrill(d,'c7c5').outcome,'missed-refutation');
 }
});

test('general line cannot mask a path-specific forced refutation',()=>{
 const g=importPgn('1. e4 e5 *\n\n1. e4 c5 2. Nf3 *');g.lines[0].mistakePly=0;
 const d=advanceDrill(startDrill(g,'w'),'e2e4');
 assert.deepEqual(drillChoices(d).map(m=>m.uci),['e7e5']);
});

test('a prior analysis annotation beyond the end does not create a refutation',()=>{
 const g=importPgn('1. e4 *');g.lines[0].mistakePly=0;
 assert.equal(advanceDrill(startDrill(g,'w'),'e2e4').outcome,'exhausted');
});

test('card and session orientation follow the player without changing browse preference',()=>{
 assert.equal(boardFlipped('Memorize','b',false,null),true);
 assert.equal(boardFlipped('Memorize','w',true,null),false);
 assert.equal(boardFlipped('Memorize',null,true,null),true);
 assert.equal(boardFlipped('Browse','b',false,null),false);
 assert.equal(boardFlipped('Play','w',false,'b'),true);
});
