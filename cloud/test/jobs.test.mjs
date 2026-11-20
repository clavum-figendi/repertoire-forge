import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { readFile,mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const pgn='[White "alice"]\n[Black "bob"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 Nc6 *';
async function runtime(persist,outboundService) {return new Miniflare({...(outboundService?{outboundService}:{}),modules:[{type:'ESModule',path:'worker.js',contents:await readFile(new URL('../dist/worker.js',import.meta.url),'utf8')},{type:'CompiledWasm',path:'stockfish.wasm',contents:await readFile(new URL('../dist/stockfish.wasm',import.meta.url))}],compatibilityDate:'2026-07-30',durableObjects:{JOBS:{className:'BacksolveJob',useSQLite:true}},durableObjectsPersist:persist});}
test('capability job uploads PGN, resumes across restart, evaluates real engine and deletes',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'forge-cloud-'));let mf=await runtime(directory);
 const call=(url,method='GET',data,cap)=>mf.dispatchFetch('http://localhost'+url,{method,headers:{'Content-Type':'application/json',...(cap?{Authorization:'Bearer '+cap}:{})},...(data?{body:JSON.stringify(data)}:{})});
 try {
  let r=await call('/jobs','POST',{platform:'pgn',settings:{maxPly:4,depth:6,nodes:1000,theoryPlies:0}});assert.equal(r.status,201);const job=await r.json(); assert.ok(job.capability);assert.equal(job.token,job.capability);const url='/jobs/'+job.id;
  assert.equal((await call(url)).status,401);
  assert.equal((await call(url+'/pgn','POST',{pgn,uploadId:'batch-1',final:true},job.capability)).status,200);
  assert.equal((await call(url+'/pgn','POST',{pgn,uploadId:'batch-1',final:true},job.capability)).status,200);
  r=await call(url+'/step','POST',{},job.capability);assert.equal(r.status,200);const first=await r.json();assert.equal(first.gamesImported,1);
  await mf.dispose();mf=await runtime(directory);
  let state;for(let i=0;i<20;i++){r=await call(url+'/step','POST',{},job.capability);assert.equal(r.status,200,await r.clone().text());state=await r.json();if(state.status==='done')break;}
  assert.equal(state.status,'done'); assert.equal(state.gamesProcessed,1);
  r=await call(url+'/result','GET',null,job.capability);const result=await r.json(); assert.equal(result.format,'repertoire-forge');assert.equal(result.version,1);assert.equal(result.graph.games,1);assert.ok(result.cards.length);assert.equal(Object.values(result.graph.nodes).find(n=>n.analysis)?.analysis.source,'stockfish');assert.equal(Object.values(result.graph.nodes).find(n=>n.analysis)?.analysis.scorePerspective,'side-to-move');assert.equal(result.graph.lines.length,1);
  assert.equal((await call(url,'DELETE',null,job.capability)).status,200);assert.equal((await call(url,'GET',null,job.capability)).status,404);
 } finally {await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
test('only published GitHub and local origins are allowed; malformed jobs rejected',async()=>{
 const mf=await runtime(false);try{
  assert.equal((await mf.dispatchFetch('http://localhost/health',{headers:{Origin:'https://evil.example'}})).status,403);
  const good=await mf.dispatchFetch('http://localhost/health',{headers:{Origin:'https://clavum-figendi.github.io'}});assert.equal(good.status,200);assert.equal(good.headers.get('Access-Control-Allow-Origin'),'https://clavum-figendi.github.io');
  assert.equal((await mf.dispatchFetch('http://localhost/jobs',{method:'POST',body:JSON.stringify({platform:'chesscom'})})).status,400);
 }finally {await mf.dispose();}
});
test('Lichess bounded cursor pages deduplicate boundary and merge results with real Stockfish',async()=>{
 const calls=[];const records=Array.from({length:7},(_,i)=>({id:'game'+i,createdAt:10000-i*100,variant:'standard',status:'resign',speed:'blitz',moves:'e4 e5 Nf3 Nc6',pgn}));
 const mf=await runtime(false,async request=>{const url=new URL(request.url);calls.push(url);assert.equal(url.hostname,'lichess.org');assert.equal(url.searchParams.get('max'),'5');const page=calls.length===1?records.slice(0,5):records.slice(4);return new Response(page.map(g=>JSON.stringify(g)).join('\n'),{headers:{'Content-Type':'application/x-ndjson'}});});
 const post=(url,data,token)=>mf.dispatchFetch('http://localhost'+url,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});
 try {
  const r=await post('/jobs',{platform:'lichess',username:'alice',settings:{maxPly:2,depth:4,nodes:100,theoryPlies:16}});assert.equal(r.status,201);const job=await r.json();let state;
  for(let i=0;i<40;i++){const before=performance.now();const response=await post('/jobs/'+job.id+'/step',{},job.token);assert.equal(response.status,200,await response.clone().text());state=await response.json();assert.ok(performance.now()-before<30000);if(state.status==='done')break;}
  assert.equal(state.status,'done');assert.equal(state.gamesImported,7);assert.equal(state.gamesProcessed,7);assert.equal(calls.length,2);assert.equal(calls[1].searchParams.get('until'),'9600');assert.ok(state.engineMemoryBytes<100*1024*1024,`Wasm memory ${state.engineMemoryBytes}`);
  const result=await (await mf.dispatchFetch('http://localhost/jobs/'+job.id+'/result',{headers:{Authorization:'Bearer '+job.token}})).json();assert.equal(result.graph.lines.length,7);assert.equal(result.graph.games,7);assert.ok(Object.values(result.graph.nodes).some(n=>n.edges.some(e=>e.count===7)));
  console.log(JSON.stringify({engineMemoryBytes:state.engineMemoryBytes,mergedGames:result.graph.games,evaluations:state.evaluations}));
 }finally{await mf.dispose();}
});
test('Lichess date window and matching maxGames constrain upstream and saved archive',async()=>{
 let seen;
 const mf=await runtime(false,async request=>{seen=new URL(request.url);const record={id:'abcdefgh',createdAt:1500,variant:'standard',status:'resign',speed:'blitz',moves:'e4 e5 Nf3 Nc6',pgn};return new Response(JSON.stringify(record)+'\n');});
 try {
  const created=await (await mf.dispatchFetch('http://localhost/jobs',{method:'POST',body:JSON.stringify({platform:'lichess',username:'alice',since:1000,until:2000,maxGames:1})})).json();
  const response=await mf.dispatchFetch('http://localhost/jobs/'+created.id+'/step',{method:'POST',headers:{Authorization:'Bearer '+created.token}});assert.equal(response.status,200);const state=await response.json();assert.equal(seen.searchParams.get('since'),'1000');assert.equal(seen.searchParams.get('until'),'2000');assert.equal(state.inputDone,true);assert.equal(state.gamesImported,1);
 }finally{await mf.dispose();}
});
test('cancel persists and rejects future steps; upload bounds and wrong bearer enforced',async()=>{
 const mf=await runtime(false);try{
  const created=await (await mf.dispatchFetch('http://localhost/jobs',{method:'POST',body:JSON.stringify({platform:'pgn'})})).json();const url='http://localhost/jobs/'+created.id;const headers={Authorization:'Bearer '+created.token};
  assert.equal((await mf.dispatchFetch(url,{headers:{Authorization:'Bearer '+'0'.repeat(64)}})).status,401);
  const cancelled=await mf.dispatchFetch(url+'/cancel',{method:'POST',headers});assert.equal((await cancelled.json()).status,'cancelled');assert.equal((await mf.dispatchFetch(url+'/step',{method:'POST',headers})).status,409);
  assert.equal((await mf.dispatchFetch(url,{headers})).status,200);
 }finally{await mf.dispose();}
});
