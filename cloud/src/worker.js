import { DurableObject } from 'cloudflare:workers';
import { createEngine } from './engine.js';
import { importPgn, backsolve, positionKey, DEFAULT_SETTINGS } from '../../src/core.js';
const MAX_BODY=256*1024, MAX_QUEUE=25, WRITE_BUDGET=20000;
const ORIGINS=new Set(['https://clavum-figendi.github.io','http://localhost:5173','http://127.0.0.1:5173','http://localhost:4173','http://127.0.0.1:4173','http://localhost:4274','http://127.0.0.1:4274']);
let engine, engineBusy=false;
class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
const fail=(status,message)=>{throw new HttpError(status,message);};
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
async function boundedText(stream,max=MAX_BODY){
 if(!stream)return '';const reader=stream.getReader(),parts=[];let bytes=0;
 try {while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>max)fail(413,'Payload exceeds bounded step size');parts.push(value);}}finally{await reader.cancel();}
 const output=new Uint8Array(bytes);let offset=0;for(const p of parts){output.set(p,offset);offset+=p.length;}return new TextDecoder().decode(output);
}
async function body(request){try{return JSON.parse(await boundedText(request.body));}catch(e){if(e instanceof HttpError)throw e;fail(400,'Invalid JSON');}}
async function digest(value){return new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));}
async function tokenHash(value){return [...await digest(value)].map(n=>n.toString(16).padStart(2,'0')).join('');}
function options(input){
 if(!input||!['pgn','lichess'].includes(input.platform))fail(400,'platform must be pgn or lichess (Chess.com: upload PGN)');
 if(input.platform==='lichess'&&!/^[a-zA-Z0-9_-]{2,30}$/.test(input.username||''))fail(400,'Invalid Lichess username');
 const controls=input.timeControls??['bullet','blitz','rapid','classical'];if(!Array.isArray(controls)||!controls.length||controls.some(v=>!['bullet','blitz','rapid','classical'].includes(v)))fail(400,'Invalid timeControls');
 const minMoves=input.minMoves??0;if(!Number.isInteger(minMoves)||minMoves<0||minMoves>1024)fail(400,'Invalid minMoves');
 const s=input.settings??{};
 const since=input.since??null,until=input.until??Date.now(),maxGames=input.maxGames??null;
 if((since!==null&&(!Number.isSafeInteger(since)||since<0))||!Number.isSafeInteger(until)||until<0||(since!==null&&since>until))fail(400,'Invalid since/until millisecond window');
 if(maxGames!==null&&(!Number.isSafeInteger(maxGames)||maxGames<1))fail(400,'Invalid maxGames');
 const integer=(value,def,min,max)=>{if(value===undefined)return def;if(!Number.isInteger(value)||value<min||value>max)fail(400,`Setting must be integer in ${min}..${max}`);return value;};
 // Theory lookups are explicitly disabled in this bounded Free engine backend.
 if(s.trainSide!==undefined&&!['both','white','black'].includes(s.trainSide))fail(400,'Invalid trainSide');
 const mistakeCp=s.mistakeCp??25;if(!Number.isFinite(mistakeCp)||mistakeCp<1||mistakeCp>500)fail(400,'Invalid mistakeCp');
 return {platform:input.platform,username:input.username||'',minMoves,timeControls:controls,since,until,maxGames,settings:{depth:integer(s.depth,10,4,14),nodes:integer(s.nodes,2000,100,5000),maxPly:integer(s.maxPly,40,2,64),mistakeCp,theoryPlies:0,trainSide:s.trainSide||'both',username:input.username||''}};
}
function publicState(s){const {capHash,pending,...safe}=s;return {...safe,...(s.status==='capacity'?{status:'error',error:'Per-job Free write safety budget reached; export partial result or start another job window'}:{}),pending:!!pending,limits:{newEvaluationsPerStep:2,maxEngineNodes:s.settings.nodes,maxPly:s.settings.maxPly,uploadBytes:MAX_BODY,writeBudget:WRITE_BUDGET},engine:'stockfish-17.1-lite-single',theory:false};}
export class BacksolveJob extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.busy=false;ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS job (id INTEGER PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS queue (seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS evaluations (key TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS nodes (key TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cards (key TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS lines (seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);`);}
 get sql(){return this.ctx.storage.sql;}
 load(){const row=this.sql.exec('SELECT data FROM job WHERE id=1').toArray()[0];return row?JSON.parse(row.data):null;}
 save(s){this.sql.exec('INSERT OR REPLACE INTO job(id,data) VALUES(1,?)',JSON.stringify(s));}
 count(table){return this.sql.exec(`SELECT count(*) AS n FROM ${table}`).one().n;}
 async authorize(request,s){const token=/^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('Authorization')||'')?.[1];if(!token)fail(401,'Bearer job capability required');const actual=await tokenHash(token);let difference=0;for(let i=0;i<64;i++)difference|=actual.charCodeAt(i)^s.capHash.charCodeAt(i);if(difference)fail(401,'Invalid job capability');}
 async fetch(request){
  try {
   const url=new URL(request.url), action=url.pathname.split('/')[3]||'';
   if(url.pathname==='/jobs'&&request.method==='POST'){
    if(this.load())fail(409,'Job already exists');const input=options(await body(request));
    const capability=[...crypto.getRandomValues(new Uint8Array(32))].map(v=>v.toString(16).padStart(2,'0')).join('');
    const s={...input,id:url.searchParams.get('id'),capHash:await tokenHash(capability),status:'ready',createdAt:Date.now(),cursor:input.until,inputDone:false,gamesImported:0,gamesProcessed:0,evaluations:0,writes:1,pending:null};this.save(s);
    await this.ctx.storage.setAlarm(Date.now()+7*86400000);
    return json({...publicState(s),token:capability,capability},201);
   }
   let s=this.load();if(!s)fail(404,'Job not found');await this.authorize(request,s);
   if(request.method==='GET'&&!action)return json(publicState(s));
   if(request.method==='GET'&&action==='result')return url.searchParams.has('cursor') ? json(this.result(s,url)) : this.exportBackup(s);
   if(request.method==='DELETE'&&!action){if(this.busy)fail(409,'Step in progress; retry delete');await this.ctx.storage.deleteAll();await this.ctx.storage.deleteAlarm();this.sql.exec('CREATE TABLE IF NOT EXISTS job (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');return json({deleted:true});}
   if(request.method==='POST'&&action==='cancel'){if(this.busy)fail(409,'Step in progress; retry cancel');s.status='cancelled';this.save(s);return json(publicState(s));}
   if(request.method!=='POST'||!['step','pgn'].includes(action))fail(404,'Unknown route');
   if(this.busy)fail(409,'Step in progress');if(['cancelled','capacity'].includes(s.status))fail(409,'Job '+s.status);
   this.busy=true;
   try {
    if(action==='pgn')return await this.upload(request,s);
    if(s.status==='done')return json(publicState(s));
    const next=await this.step(s);return json(publicState(next));
   } finally {this.busy=false;}
  } catch(e){console.error(JSON.stringify({event:'job_request_error',message:e.message,status:e.status||500}));return json({error:e.message},e.status||500);}
 }
 async alarm(){await this.ctx.storage.deleteAll();this.sql.exec('CREATE TABLE IF NOT EXISTS job (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');}
 async upload(request,s){
  if(s.platform!=='pgn')fail(400,'Upload only applies to PGN jobs');const input=await body(request);
  if(typeof input.uploadId!=='string'||!/^[-\w]{1,100}$/.test(input.uploadId))fail(400,'Stable uploadId required');
  const id='upload:'+input.uploadId;if(this.sql.exec('SELECT id FROM seen WHERE id=?',id).toArray().length)return json(publicState(s));
  if(s.inputDone)fail(409,'Upload stream finalized');if(typeof input.pgn!=='string'||input.pgn.length>MAX_BODY)fail(400,'Invalid PGN');
  // Main-line archive windows only: reject expansion bombs and oversized games.
  if(/[()]/.test(input.pgn.replace(/\{[^}]*\}|;[^\n]*/g,'')))fail(400,'Upload main-line games without variations');
  const graph=importPgn(input.pgn,undefined,{maxStoredPlies:s.settings.maxPly,strict:true});
  if(!graph.games)fail(400,'No valid games');if(graph.games>MAX_QUEUE||this.count('queue')+graph.lines.length>MAX_QUEUE)fail(413,'Queue full; step before uploading more (25 games)');
  const lines=graph.lines.filter(line=>line.moves.length>2*s.minMoves);
  // minMoves filtering uses full main line for short configured maxPly windows.
  if(s.minMoves>0&&s.settings.maxPly<=2*s.minMoves)fail(400,'For uploaded PGN use maxPly > 2*minMoves');
  this.ctx.storage.transactionSync(()=>{for(const line of lines)this.sql.exec('INSERT INTO queue(data) VALUES(?)',JSON.stringify(line));this.sql.exec('INSERT INTO seen(id) VALUES(?)',id);s.inputDone=input.final===true;s.gamesImported+=lines.length;s.writes+=lines.length+2;this.save(s);});
  return json(publicState(s));
 }
 async fetchBatch(s){
  const url=new URL('https://lichess.org/api/games/user/'+encodeURIComponent(s.username));
  for(const [k,v] of Object.entries({max:5,until:s.cursor,sort:'dateDesc',perfType:s.timeControls.join(','),pgnInJson:true,moves:true,clocks:false,evals:false,opening:false,ongoing:false,finished:true}))url.searchParams.set(k,String(v));
  if(s.since!==null)url.searchParams.set('since',String(s.since));
  const response=await fetch(url,{headers:{Accept:'application/x-ndjson'},signal:AbortSignal.timeout(15000)});
  if(!response.ok){await response.body?.cancel();fail(response.status===429?429:502,'Lichess HTTP '+response.status+'; retry step later');}
  const text=await boundedText(response.body,MAX_BODY);let records;
  try {records=text.split('\n').filter(v=>v.trim()).map(v=>JSON.parse(v));}catch{fail(502,'Invalid Lichess NDJSON');}
  if(records.length>5)fail(502,'Lichess exceeded bounded page');let oldest=Infinity,added=0;
  const staged=[];
  for(const game of records){
   if(!Number.isFinite(game.createdAt)||typeof game.id!=='string')fail(502,'Missing Lichess cursor metadata');oldest=Math.min(oldest,game.createdAt);
   if(this.sql.exec('SELECT id FROM seen WHERE id=?',game.id).toArray().length)continue;
   if(game.createdAt>s.cursor||(s.since!==null&&game.createdAt<s.since))continue;
   if(game.variant!=='standard'||!['mate','resign','stalemate','timeout','draw','outoftime','cheat','variantEnd'].includes(game.status)||!s.timeControls.includes(game.speed))continue;
   if(typeof game.moves!=='string')fail(502,'Lichess omitted requested moves');
   if((game.moves||'').trim().split(/\s+/).filter(Boolean).length<=2*s.minMoves)continue;
   if(typeof game.pgn!=='string')fail(502,'Lichess omitted PGN');
   if(s.maxGames!==null&&s.gamesImported+added>=s.maxGames)continue;
   const graph=importPgn(game.pgn,undefined,{maxStoredPlies:s.settings.maxPly,strict:true});
   if(graph.lines.length!==1)fail(502,'Expected one main line per Lichess record');staged.push({id:game.id,line:graph.lines[0]});added++;
  }
  if(records.length===5&&oldest===s.cursor&&added===0)fail(409,'Lichess timestamp cursor stalled; no games silently skipped');
  this.ctx.storage.transactionSync(()=>{for(const {id,line} of staged){this.sql.exec('INSERT OR IGNORE INTO seen(id) VALUES(?)',id);this.sql.exec('INSERT INTO queue(data) VALUES(?)',JSON.stringify(line));}s.gamesImported+=added;s.writes+=2*added+1;s.inputDone=records.length<5||(s.maxGames!==null&&s.gamesImported>=s.maxGames);if(records.length)s.cursor=oldest;this.save(s);});
 }
 async step(s){
  if(s.writes>=WRITE_BUDGET-1000){s.status='capacity';this.save(s);return s;}
  if(!s.pending){
   const queued=this.sql.exec('SELECT seq,data FROM queue ORDER BY seq LIMIT 1').toArray()[0];
   if(queued){s.pending={seq:queued.seq,line:JSON.parse(queued.data)};this.save(s);return s;}
   if(s.inputDone){s.status='done';this.save(s);return s;}
   if(s.platform==='lichess')await this.fetchBatch(s);
   return this.load();
  }
  if(engineBusy)return {...s,retryAfterMs:500};engineBusy=true;
  try {
   engine ||= await createEngine();let newEvaluations=0;
   const line=s.pending.line;
   // Rebuild one bounded window, never the cumulative archive in core.js.
   const input={version:1,root:line.root,nodes:{[line.root]:{key:line.root,fen:line.fen,visits:1,edges:[]}},lines:[line],games:1,warnings:[]};
   let result;
   try {result=await backsolve(input,{settings:s.settings,evaluate:async fen=>{
    const key=positionKey(fen),cached=this.sql.exec('SELECT data FROM evaluations WHERE key=?',key).toArray()[0];if(cached)return JSON.parse(cached.data);
    if(newEvaluations>=2)throw new HttpError(202,'evaluation-boundary');
    const value=await engine.evaluate(fen,s.settings);newEvaluations++;s.engineMemoryBytes=engine.memoryBytes;
    this.sql.exec('INSERT OR REPLACE INTO evaluations(key,data) VALUES(?,?)',key,JSON.stringify(value));s.evaluations++;s.writes++;return value;
   }});} catch(e){if(e.status!==202)throw e;this.save(s);return s;}
   this.ctx.storage.transactionSync(()=>{
    for(const incoming of Object.values(result.graph.nodes)){
     const existing=this.sql.exec('SELECT data FROM nodes WHERE key=?',incoming.key).toArray()[0];let target=existing?JSON.parse(existing.data):incoming;
     if(existing){target.visits+=incoming.visits;target.analysis=incoming.analysis||target.analysis;for(const edge of incoming.edges){const previous=target.edges.find(e=>e.uci===edge.uci);if(previous)previous.count+=edge.count;else target.edges.push(edge);}}
     this.sql.exec('INSERT OR REPLACE INTO nodes(key,data) VALUES(?,?)',incoming.key,JSON.stringify(target));s.writes++;
    }
    for(const card of result.cards){this.sql.exec('INSERT OR IGNORE INTO cards(key,data) VALUES(?,?)',card.id,JSON.stringify(card));s.writes++;}
    for(const output of result.graph.lines){this.sql.exec('INSERT INTO lines(data) VALUES(?)',JSON.stringify({...output,game:s.gamesProcessed}));s.writes++;}
    this.sql.exec('DELETE FROM queue WHERE seq=?',s.pending.seq);s.root ||= result.graph.root;s.gamesProcessed++;s.pending=null;s.writes+=2;if(s.inputDone&&!this.count('queue'))s.status='done';
    this.save(s);
   });return s;
  } finally {engineBusy=false;}
 }
 exportBackup(s){
  if(this.busy)fail(409,'Step in progress; retry export');
  const meta={format:'repertoire-forge',version:1,createdAt:new Date().toISOString(),settings:{...DEFAULT_SETTINGS,...s.settings},book:null,status:s.status,partial:s.status!=='done',stats:{games:s.gamesProcessed,analyzed:s.evaluations,cards:this.count('cards'),nodes:this.count('nodes')}};
  const sql=this.sql;
  function* chunks(){
   yield JSON.stringify(meta).slice(0,-1)+',"graph":{"version":1,"root":'+JSON.stringify(s.root||importPgn('').root)+',"games":'+s.gamesProcessed+',"warnings":[],"nodes":{';
   let first=true;
   for(const row of sql.exec('SELECT key,data FROM nodes ORDER BY key')){yield (first?'':',')+JSON.stringify(row.key)+':'+row.data;first=false;}
   if(first){const blank=importPgn('');yield JSON.stringify(blank.root)+':'+JSON.stringify(blank.nodes[blank.root]);}
   yield '},"lines":[';first=true;
   for(const row of sql.exec('SELECT data FROM lines ORDER BY seq')){yield (first?'':',')+row.data;first=false;}
   yield ']},"cards":[';first=true;
   for(const row of sql.exec('SELECT data FROM cards ORDER BY key')){yield (first?'':',')+row.data;first=false;}
   yield ']}';
  }
  const iterator=chunks(),encoder=new TextEncoder();
  return new Response(new ReadableStream({pull(controller){let output='';for(let i=0;i<32;i++){const next=iterator.next();if(next.done){if(output)controller.enqueue(encoder.encode(output));controller.close();return;}output+=next.value;}controller.enqueue(encoder.encode(output));},cancel(){iterator.return();}}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
 }
 result(s,url){
  const cursor=Number(url.searchParams.get('cursor')||0),limit=50;
  if(!Number.isSafeInteger(cursor)||cursor<0||cursor>1000000)fail(400,'Invalid cursor');
  const rows=table=>this.sql.exec(`SELECT data FROM ${table} ORDER BY ${table==='lines'?'seq':'key'} LIMIT ? OFFSET ?`,limit+1,cursor).toArray();
  const nodes=rows('nodes'),cards=rows('cards'),lines=rows('lines');const more=[nodes,cards,lines].some(r=>r.length>limit);
  return {status:s.status,graph:{version:1,root:s.root||null,games:s.gamesProcessed,nodes:Object.fromEntries(nodes.slice(0,limit).map(row=>{const n=JSON.parse(row.data);return [n.key,n];})),lines:lines.slice(0,limit).map(row=>JSON.parse(row.data)),warnings:[]},cards:cards.slice(0,limit).map(row=>JSON.parse(row.data)),stats:{games:s.gamesProcessed,analyzed:s.evaluations,cards:this.count('cards'),nodes:this.count('nodes')},cursor,nextCursor:more?cursor+limit:null,partial:s.status!=='done',pagination:'Merge graph.nodes/cards by key and append lines; follow nextCursor'};
 }
}
export default {async fetch(request,env){
 const origin=request.headers.get('Origin');if(origin&&!ORIGINS.has(origin))return json({error:'Origin not allowed'},403);
 let response;const url=new URL(request.url);
 if(request.method==='OPTIONS')response=new Response(null,{status:204});
 else if(url.pathname==='/health'&&request.method==='GET')response=json({ok:true,backend:'sqlite-durable-object',engine:'stockfish-17.1-lite-single',resumable:true});
 else if(url.pathname==='/jobs'&&request.method==='POST'){
  const id=crypto.randomUUID();url.searchParams.set('id',id);response=await env.JOBS.getByName(id).fetch(new Request(url,request));
 }else {const match=/^\/jobs\/([0-9a-f-]{36})(?:\/(step|result|cancel|pgn))?$/.exec(url.pathname);response=match?await env.JOBS.getByName(match[1]).fetch(request):json({error:'Not found'},404);}
 const headers=new Headers(response.headers);headers.set('Vary','Origin');if(origin)headers.set('Access-Control-Allow-Origin',origin);headers.set('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS');headers.set('Access-Control-Allow-Headers','Content-Type, Authorization');headers.set('Cache-Control','no-store');return new Response(response.body,{status:response.status,headers});
}};
