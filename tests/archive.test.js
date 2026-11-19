import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGames } from '../src/services.js';

function splitBatch(text) { assert.equal(typeof text,'string'); return text.split(/\n\n(?=\[Event )/); }
function stream(text, size = 19) {
  const data = new TextEncoder().encode(text); let at = 0;
  return new Response(new ReadableStream({pull(controller) {
    if (at >= data.length) return controller.close();
    controller.enqueue(data.slice(at, at += size));
  }}));
}
function game(id, moves = 'e4 e5 Nf3 Nc6 Bb5', extra = {}) {
  id=id.padEnd(8,'0').slice(0,8);
  return {id, variant:'standard', speed:'blitz', status:'resign', moves,
    pgn:`[Event "Test"]\n[Site "https://lichess.org/${id}"]\n[Result "1-0"]\n\n${moves} 1-0`, ...extra};
}
async function mockFetch(fn, work) {
  const old = globalThis.fetch; globalThis.fetch = fn;
  try { return await work(); } finally { globalThis.fetch = old; }
}
const pgn = '[Event "Live Chess"]\n[Site "Chess.com"]\n[Link "https://www.chess.com/game/live/123"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 1-0';
function cc(extra = {}) { return {rules:'chess',time_class:'blitz',url:'https://www.chess.com/game/live/123',start_time:1700000000,end_time:1700000300,pgn,...extra}; }
test('Chess.com streams each month sequentially, filters standard finished live games and retains link identity', async () => {
  const root = 'https://api.chess.com/pub/player/tester/games/', calls = [], batches = [], progress = [];
  const months = [root+'2023/10', root+'2023/11'];
  await mockFetch(async input => {
    const url = String(input); calls.push(url);
    if(url.endsWith('/archives')) return stream(JSON.stringify({archives:months}));
    if(url.endsWith('/11')) return stream(JSON.stringify({games:[cc({time_class:'daily'}),cc({rules:'chess960'}),cc({pgn:pgn.replaceAll('1-0','*')}),cc({pgn:pgn.replace('3. Bb5 ', '')}),cc()]}), 7);
    return stream(JSON.stringify({games:[cc({url:'https://www.chess.com/game/live/456',pgn:pgn.replaceAll('123','456')})]}), 7);
  }, async()=>{
    assert.deepEqual(await fetchGames('chesscom','Tester',{maxGames:Infinity,minMoves:2,timeControls:['blitz'],onBatch:async x=>batches.push(...splitBatch(x)),onProgress:p=>progress.push(p)}),{matched:2,scanned:6});
  });
  assert.deepEqual(calls,[root+'archives',months[1],months[0]]);
  assert.equal(batches.length,2);
  assert.match(batches[0],/\[Site "https:\/\/www.chess.com\/game\/live\/123"\]/);
  assert.match(batches[0],/\[Link "https:\/\/www.chess.com\/game\/live\/123"\]/);
  assert.equal(progress.filter(p=>p.stage==='month').length,2);
});
test('Lichess export errors are not silently reported as an empty success', async()=>{
  const progress=[];
  await mockFetch(async()=>stream('{"error":"No such user"}\n'),async()=>{
    await assert.rejects(fetchGames('lichess','nobody',{onBatch:async()=>{},onProgress:p=>progress.push(p)}),/No such user/);
  });
  assert.equal(progress.at(-1).stage,'error');
});
test('Lichess falls back to PGN ply count when moves is absent',async()=>{
  await mockFetch(async()=>stream(JSON.stringify(game('abcdefgh',undefined,{moves:undefined,pgn:pgn.replace('Chess.com','https://lichess.org/abcdefgh')}))),async()=>{
    const batches=[];
    assert.deepEqual(await fetchGames('lichess','tester',{minMoves:2,onBatch:async b=>batches.push(...splitBatch(b))}),{matched:1,scanned:1});
    assert.equal(batches.length,1);
  });
});
test('all mode exceeds 10,000 games in bounded awaited batches without reading ahead', async()=>{
  const total=10007; let generated=0, delivered=0, maxBatch=0, cancelled=false;
  const encoder=new TextEncoder();
  await mockFetch(async()=>new Response(new ReadableStream({
    pull(controller){
      if(generated===total){controller.close();return;}
      const rows=[];
      for(let n=0;n<10&&generated<total;n++,generated++)rows.push(JSON.stringify(game('g'+generated)));
      controller.enqueue(encoder.encode(rows.join('\n')+'\n'));
    },cancel(){cancelled=true;}
  })),async()=>{
    const summary=await fetchGames('lichess','tester',{maxGames:Infinity,onBatch:async batch=>{
      assert.ok(generated-delivered <= 55,'network consumer must pause behind callback');
      await new Promise(resolve=>setTimeout(resolve,0));
      const games=splitBatch(batch); delivered+=games.length;maxBatch=Math.max(maxBatch,games.length);
    }});
    assert.deepEqual(summary,{matched:total,scanned:total});
  });
  assert.equal(delivered,total);assert.equal(maxBatch,25);
});
test('abort interrupts a stalled Response body and reports cancellation',async()=>{
  const controller=new AbortController();let cancelled=false;const progress=[];
  await mockFetch(async()=>new Response(new ReadableStream({cancel(){cancelled=true;}})),async()=>{
    const pending=fetchGames('lichess','tester',{signal:controller.signal,onBatch:async()=>{},onProgress:p=>progress.push(p)});
    setTimeout(()=>controller.abort(),5);
    await assert.rejects(pending,{name:'AbortError'});
  });
  assert.equal(cancelled,true);assert.equal(progress.at(-1).stage,'cancelled');
});
test('callback failure cancels provider consumption and does not claim completion',async()=>{
  let cancelled=false; const progress=[];
  await mockFetch(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(Array.from({length:30},(_,i)=>JSON.stringify(game('g'+i))).join('\n')+'\n'));},cancel(){cancelled=true;}})),async()=>{
    await assert.rejects(fetchGames('lichess','tester',{onBatch:async()=>{throw new Error('Database full');},onProgress:p=>progress.push(p)}),/Database full/);
  });
  assert.equal(cancelled,true);assert.equal(progress.at(-1).stage,'error');
});
test('legacy caller receives PGN string and empty streaming selection returns a zero summary',async()=>{
  await mockFetch(async()=>stream(JSON.stringify(game('abcdefgh'))),async()=>{
    assert.match(await fetchGames('lichess','tester'),/https:\/\/lichess.org\/abcdefgh/);
  });
  await mockFetch(async()=>stream(''),async()=>{
    assert.deepEqual(await fetchGames('lichess','tester',{onBatch:async()=>assert.fail('no empty batches')}),{matched:0,scanned:0});
  });
});
test('Chess.com dates prune months, rapid remains rapid, daily never becomes classical',async()=>{
  const root='https://api.chess.com/pub/player/tester/games/',calls=[];
  await mockFetch(async input=>{
    const url=String(input);calls.push(url);
    if(url.endsWith('archives'))return stream(JSON.stringify({archives:[root+'2022/01',root+'2023/11',root+'2024/01']}));
    return stream(JSON.stringify({games:[cc({time_class:'daily'}),cc({time_class:'rapid',time_control:'3600'}),cc({time_class:'blitz',start_time:1698796800}),cc({time_class:'classical'})]}));
  },async()=>{
    const batches=[];
    const summary=await fetchGames('chesscom','tester',{since:1700000000000,until:'2023-11-30T23:59:59Z',timeControls:['classical'],onBatch:async batch=>batches.push(...splitBatch(batch))});
    assert.deepEqual(summary,{matched:1,scanned:4});assert.equal(batches.length,1);
  });
  assert.deepEqual(calls,[root+'archives',root+'2023/11']);
});
test('invalid options and untrusted monthly archive URLs reject before importing',async()=>{
  for(const options of [{maxGames:0},{maxGames:NaN},{minMoves:-1},{timeControls:['daily']},{timeControls:[]},{since:'nonsense'},{since:20,until:10}])await assert.rejects(fetchGames('lichess','tester',options));
  let calls=0;
  await mockFetch(async()=>{calls++;return stream('{"archives":["https://evil.example/games/2023/11"]}');},async()=>{
    await assert.rejects(fetchGames('chesscom','tester',{onBatch:async()=>{}}),/archive URL/);
  });assert.equal(calls,1);
});
test('HTTP failures, malformed NDJSON and truncated monthly JSON reject honestly',async()=>{
  for (const status of [404,429,503]) await mockFetch(async()=>new Response('',{status}),async()=>{
    await assert.rejects(fetchGames('lichess','tester'),new RegExp(`HTTP ${status}`));
  });
  await mockFetch(async()=>stream('{"id":'),async()=>{await assert.rejects(fetchGames('lichess','tester'),SyntaxError);});
  await mockFetch(async input=>String(input).endsWith('archives')?stream('{"archives":["https://api.chess.com/pub/player/tester/games/2023/11"]}'):stream('{"games":['),async()=>{
    await assert.rejects(fetchGames('chesscom','tester'),/Truncated/);
  });
});
test('Lichess canonicalizes Site to its 8-character game ID while retaining other headers',async()=>{
  await mockFetch(async()=>stream(JSON.stringify(game('abcdefgh',undefined,{pgn:pgn.replace('Chess.com','https://lichess.org/game/abcdefgh')}))),async()=>{
    const result=await fetchGames('lichess','tester');
    assert.match(result,/\[Site "https:\/\/lichess.org\/abcdefgh"\]/);
    assert.match(result,/\[Event "Live Chess"\]/);
  });
});
test('game safety limit measures UTF-8 bytes, not just JavaScript characters',async()=>{
  const huge=game('abcdefgh',undefined,{pgn:'é'.repeat(1100000)});
  await mockFetch(async()=>stream(JSON.stringify(huge),65536),async()=>{
    await assert.rejects(fetchGames('lichess','tester',{onBatch:async()=>{}}),/2 MiB/);
  });
});
test('Lichess filters length before max and streams PGNs with preserved IDs', async () => {
  let url; const batches = [], progress = [];
  const games = [game('short','e4 e5 Nf3 Nc6'), game('variant',undefined,{variant:'chess960'}), game('playing',undefined,{status:'started'}), game('yes')];
  await mockFetch(async input => {url=new URL(input);return stream(games.map(g=>JSON.stringify(g)).join('\n'));}, async()=>{
    const result = await fetchGames('lichess','tester',{maxGames:1,minMoves:2,timeControls:['blitz'],onProgress:p=>progress.push(p),onBatch:async batch=>batches.push(...splitBatch(batch))});
    assert.deepEqual(result,{matched:1,scanned:4});
  });
  assert.equal(url.searchParams.has('max'),false);
  assert.equal(url.searchParams.get('perfType'),'blitz');
  assert.equal(url.searchParams.get('ongoing'),'false');
  assert.match(batches[0],/https:\/\/lichess.org\/yes/);
  assert.equal(progress.at(-1).stage,'complete');
});
