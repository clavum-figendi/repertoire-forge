import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { importPgn, positionKey, backsolve, exportPgn, addMove, reviewCard } from '../src/core.js';
const keyAfter = (...moves) => { const c = new Chess(); for (const m of moves) c.move(m); return positionKey(c.fen()); };
test('imports RAV, duplicate frequencies, transpositions and malformed games visibly', () => {
  const pgn = '[White "A"]\n\n1. Nf3 (1. d4 d5 2. Nf3) d5 2. d4 *';
  const graph = importPgn(pgn + '\n\n' + pgn + '\n\n[White "bad"]\n\n1. e4 e5 2. Qh9 *');
  assert.equal(graph.games, 2);
  assert.equal(graph.nodes[graph.root].edges.find(e => e.san === 'Nf3').count, 2);
  assert.equal(graph.nodes[keyAfter('Nf3','d5','d4')].visits, 2);
  assert.equal(keyAfter('Nf3','d5','d4'), keyAfter('d4','d5','Nf3'));
  assert.equal(graph.warnings.length, 1);
});
const neutral = async fen => ({bestMove: new Chess(fen).moves({verbose:true}).map(m=>m.from+m.to+(m.promotion||''))[0] || null, scoreCp:0, depth:14, source:'stockfish'});
test('first error uses child score and retains only immediate generated refutation', async () => {
  const input = importPgn('1. e4 c5 2. Nf3 d6 *');
  const snapshot = JSON.stringify(input);
  const calls = [];
  const result = await backsolve(input, { evaluate: async fen => {
    calls.push(positionKey(fen));
    const value = await neutral(fen);
    if(positionKey(fen) === input.root) value.bestMove='d2d4';
    if(positionKey(fen) === keyAfter('e4')) {value.scoreCp=30;value.bestMove='e7e5';}
    return value;
  }});
  assert.deepEqual(result.graph.lines[0].moves, ['e2e4','e7e5']);
  assert.equal(result.stats.mistakes, 1);
  assert.equal(result.cards.find(c=>c.id===keyAfter('e4')).uci,'e7e5');
  assert.ok(!calls.includes(keyAfter('e4','c5')));
  assert.equal(JSON.stringify(input),snapshot);
});
test('legal PGN RAV export roundtrips and manual edits clone', () => {
  const original = importPgn('1. e4 (1. d4 d5) e5 *');
  const edited = addMove(original, keyAfter('e4'), 'c7c5');
  assert.equal(original.nodes[keyAfter('e4')].edges.length,1);
  assert.ok(edited.nodes[keyAfter('e4')].edges.find(e=>e.uci==='c7c5').manual);
  assert.throws(()=>addMove(original,original.root,'e2e5'));
  const text = exportPgn(edited);
  assert.match(text,/\(/);
  const roundtrip = importPgn(text);
  assert.deepEqual(roundtrip.warnings,[]);
  assert.equal(roundtrip.nodes[keyAfter('e4')].edges.length,2);
  assert.equal(roundtrip.nodes[roundtrip.root].edges.length,2);
});
test('initial FEN black-to-move export and schedule grades are pure', () => {
  const fen = '4k3/8/8/8/8/8/8/4K3 b - - 0 27';
  const g = importPgn(`[SetUp "1"]\n[FEN "${fen}"]\n\n27... Kd7 *`);
  assert.equal(g.nodes[g.root].fen,fen);
  const pgn = exportPgn(g);
  assert.match(pgn,/27\.\.\. Kd7/);
  assert.equal(importPgn(pgn).root,g.root);
  const card = {id:'x',due:0,interval:0,repetitions:0,ease:2.5,lapses:0};
  const grades = ['again','hard','good','easy'].map(grade=>reviewCard(card,grade,1000));
  assert.equal(card.repetitions,0);
  assert.equal(grades[0].lapses,1);
  assert.ok(grades.every(c=>c.due>1000));
  assert.ok(grades[3].due>grades[2].due && grades[2].due>grades[1].due);
  assert.throws(()=>reviewCard(card,'bogus'));
});
test('multiple headerless RAV games remain separate and nested alternatives are legal', () => {
  const g = importPgn('1. e4 (1. d4 d5 (1... Nf6) 2. c4) e5 *\n1. c4 e5 *');
  assert.equal(g.games,2);
  assert.equal(g.warnings.length,0);
  assert.equal(g.lines.length,4);
});
test('mate-zero and stalemate are recognized without fabricating engine scores', async () => {
  const mate = importPgn('1. f3 e5 2. g4 Qh4# *');
  const evaluate = async fen => {
    const chess = new Chess(fen);
    if(chess.isCheckmate()) return {bestMove:null,scoreCp:0,mate:0,depth:14,source:'stockfish'};
    const result = await neutral(fen);
    if(positionKey(fen)===keyAfter('f3','e5')) { result.scoreCp=0; result.bestMove='e2e4'; }
    if(positionKey(fen)===keyAfter('f3','e5','g4')) {result.mate=1; result.bestMove='d8h4';}
    return result;
  };
  const r = await backsolve(mate,{evaluate});
  assert.equal(r.stats.mistakes,1);
  assert.equal(r.graph.lines[0].moves.at(-1),'d8h4');
  assert.ok(!r.cards.some(c=>new Chess(c.fen).isCheckmate()));
});
test('cancellation rejects before and after engine await; theory failures are not out-of-theory', async () => {
  const g=importPgn('1. e4 *'), before=new AbortController(); before.abort();
  await assert.rejects(backsolve(g,{evaluate:neutral,signal:before.signal}), {name:'AbortError'});
  const during=new AbortController();
  await assert.rejects(backsolve(g,{signal:during.signal,evaluate:async fen=>{during.abort();return neutral(fen);}}),{name:'AbortError'});
  await assert.rejects(backsolve(g,{evaluate:neutral,theory:async()=>{throw new Error('HTTP 429');}}),/HTTP 429/);
  await assert.rejects(backsolve(g,{evaluate:neutral,theory:async()=>null}),/Invalid theory/);
});
test('theory skips only high-sample low mover loss, with correct black POV', async () => {
  const g = importPgn('1. e4 e5 2. Nf3 *');
  let calls=0;
  const theory = async fen=> {
    const c = new Chess(fen), legal=c.moves({verbose:true});
    return {white:60,draws:0,black:40,moves:legal.map(m=>({uci:m.from+m.to+(m.promotion||''),white:60,draws:0,black:40})),source:'fixture'};
  };
  const skipped=await backsolve(g,{evaluate:async fen=>{calls++;return neutral(fen);},theory});
  assert.equal(calls,0);assert.equal(skipped.cards.length,0);assert.equal(skipped.stats.theorySkipped,3);
  const black = importPgn('[White "Other"]\n[Black "Me"]\n\n1. e4 e5 *');
  const result = await backsolve(black,{settings:{username:'me'},evaluate:neutral,theory:async fen=>{
    const d=await theory(fen);
    if(new Chess(fen).turn()==='b') d.moves=d.moves.map(m=>({...m,white:90,black:10}));
    return d;
  }});
  assert.equal(result.stats.theorySkipped,1);
  assert.ok(result.cards.length>0 && result.cards.every(c=>new Chess(c.fen).turn()==='b'));
});
test('transposition caching does not leak descendants past a path-specific cutoff', async () => {
  const g=importPgn('1. Nf3 d5 2. d4 Nf6 3. c4 *\n1. d4 d5 2. Nf3 Nf6 3. g3 *');
  const calls=new Map();
  const r=await backsolve(g,{evaluate:async fen=>{
    const k=positionKey(fen); calls.set(k,(calls.get(k)||0)+1);
    const e=await neutral(fen);
    if(k===keyAfter('Nf3')) e.scoreCp=-30;
    if(k===keyAfter('Nf3','d5')) {e.scoreCp=30;e.bestMove='g2g3';}
    if(k===keyAfter('Nf3','d5','d4')) e.bestMove='g8f6';
    return e;
  }});
  assert.equal(r.graph.lines[0].moves.length,4);
  assert.equal(r.graph.lines[1].moves.length,5);
  assert.ok([...calls.values()].every(n=>n===1));
  const roundtrip=importPgn(exportPgn(r.graph));
  assert.ok(roundtrip.lines.every(l=>l.moves[0]!=='g1f3'||l.moves.length===4));
  assert.equal(new Set(r.cards.map(c=>c.id)).size,r.cards.length);
});
test('cycle guards, max ply, duplicate games and side filters bound work', async () => {
  const g=importPgn('[White "Me"]\n[Black "Other"]\n\n1. Nf3 Nf6 2. Ng1 Ng8 3. e4 *');
  const r=await backsolve(g,{evaluate:neutral,settings:{username:'ME',trainSide:'white'}});
  assert.equal(r.graph.lines[0].moves.length,4);
  assert.ok(r.cards.every(c=>new Chess(c.fen).turn()==='w'));
  const limited=await backsolve(g,{evaluate:neutral,settings:{maxPly:2}});
  assert.equal(limited.graph.lines[0].moves.length,2);
  const dup=importPgn('1. e4 e5 *\n1. e4 e5 *');
  assert.equal(dup.games,2);
  const d=await backsolve(dup,{evaluate:neutral});
  assert.equal(d.stats.analyzed,3);
});
test('mainline order survives RAV export', () => {
  const pgn=exportPgn(importPgn('1. e4 (1. d4 d5) e5 *'));
  const chess = new Chess(); chess.loadPgn(pgn);
  assert.deepEqual(chess.history(),['e4','e5']);
});
test('cancellation interrupts an unresolved evaluator instead of hanging', async () => {
  const controller=new AbortController();
  const job=backsolve(importPgn('1. e4 *'),{signal:controller.signal,evaluate:()=>new Promise(()=>{})});
  controller.abort();
  const result=await Promise.race([job.then(()=> 'resolved',e=>e.name),new Promise(resolve=>setTimeout(()=>resolve('hung'),30))]);
  assert.equal(result,'AbortError');
});
test('evaluation requires legal UCI, theory small samples do not skip and input is bounded', async () => {
  const graph=importPgn('1. e4 *');
  await assert.rejects(backsolve(graph,{evaluate:async fen=>({...await neutral(fen),bestMove:'Na3'})}),/UCI/);
  let calls=0;
  const result=await backsolve(graph,{evaluate:async fen=>{calls++;return neutral(fen);},theory:async()=>({white:1,draws:0,black:0,moves:[{uci:'e2e4',white:1,draws:0,black:0}]})});
  assert.equal(result.stats.theorySkipped,0);assert.equal(calls,2);
  assert.throws(()=>importPgn(' '.repeat(20_000_001)),/limit/);
});
test('25cp default is a quarter pawn and score inversion is black-side correct', async () => {
  for(const [cp,expected] of [[24,0],[25,0],[26,1]]) {
    const g=importPgn('[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/8/4K3 b - - 0 1"]\n\n1... Kd7 2. Kd2 *');
    const r=await backsolve(g,{evaluate:async fen=>{
      const e=await neutral(fen);
      if(new Chess(fen).turn()==='w') e.scoreCp=cp;
      else e.scoreCp=0;
      return e;
    }});
    assert.equal(r.stats.mistakes,expected);
  }
});
test('stalemate terminal makes no refutation and invalid games never partially merge', async () => {
  const g=importPgn('[SetUp "1"]\n[FEN "k7/2Q5/2K5/8/8/8/8/8 w - - 0 1"]\n\n1. Qb6 *');
  const r=await backsolve(g,{evaluate:neutral});
  assert.equal(r.graph.lines[0].moves.length,1);
  assert.ok(new Chess(r.graph.nodes[r.graph.nodes[r.graph.root].edges[0].to].fen).isStalemate());
  assert.ok(r.cards.every(c=>!new Chess(c.fen).isStalemate()));
  const base=importPgn('1. d4 *'),snapshot=JSON.stringify(base);
  const merged=importPgn('[Event "bad"]\n\n1. e4 e5 2. Qh9 *',base);
  assert.equal(merged.games,1);
  assert.equal(merged.nodes[merged.root].edges.length,1);
  assert.equal(JSON.stringify(base),snapshot);
});
test('manual moves require UCI and cancellation in progress is honored', async () => {
  const graph=importPgn('1. e4 *');
  assert.throws(()=>addMove(graph,graph.root,'d4'),/UCI/);
  const controller=new AbortController();
  await assert.rejects(backsolve(graph,{evaluate:neutral,signal:controller.signal,onProgress:()=>controller.abort()}),{name:'AbortError'});
});
