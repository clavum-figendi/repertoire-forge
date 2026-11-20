import { Miniflare } from 'miniflare';
import { readFile,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const mf=new Miniflare({modules:[{type:'ESModule',path:'worker.js',contents:await readFile('dist/worker.js','utf8')},{type:'CompiledWasm',path:'stockfish.wasm',contents:await readFile('dist/stockfish.wasm')}],compatibilityDate:'2026-07-30',durableObjects:{JOBS:{className:'BacksolveJob',useSQLite:true}}});
try{
 const post=(url,data,token)=>mf.dispatchFetch('http://localhost'+url,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});
 const response=await post('/jobs',{platform:'lichess',username:'DrNykterstein',maxGames:1,timeControls:['blitz'],settings:{maxPly:2,depth:14,nodes:5000}});assert.equal(response.status,201);const job=await response.json();const timings=[];let state;
 for(let i=0;i<12;i++){const start=performance.now(),r=await post('/jobs/'+job.id+'/step',{},job.token);assert.equal(r.status,200,await r.clone().text());state=await r.json();timings.push(Math.round(performance.now()-start));if(state.status==='done')break;}
 assert.equal(state.status,'done');assert.equal(state.gamesProcessed,1);
 const result=await (await mf.dispatchFetch('http://localhost/jobs/'+job.id+'/result',{headers:{Authorization:'Bearer '+job.token}})).json();assert.equal(result.format,'repertoire-forge');assert.ok(result.cards.length);
 const evidence={source:'live public Lichess HTTP, real Stockfish inside SQLite DO/workerd',provider:'DrNykterstein',status:state.status,games:state.gamesProcessed,cards:result.cards.length,engineMemoryBytes:state.engineMemoryBytes,evaluations:state.evaluations,stepWallMilliseconds:timings,analyses:Object.values(result.graph.nodes).filter(n=>n.analysis).map(n=>({fen:n.fen,...n.analysis}))};
 await writeFile('LIVE-SMOKE.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
}finally{await mf.dispose();}
