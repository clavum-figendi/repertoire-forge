import test from 'node:test';
import assert from 'node:assert/strict';
import {publish} from '../publish.mjs';

test('publishing requires an explicit Free-plan check before any request',async()=>{
 await assert.rejects(publish({request(){assert.fail('unexpected request');}}),/Workers Free/);
});

for(const existing of [false,true])test(`uploads verified Wasm and reads back ${existing?'existing':'new'} worker and route`,async()=>{
 const requests=[];
 const settings={bindings:[{type:'durable_object_namespace',name:'JOBS',class_name:'BacksolveJob'}]};
 const url=await publish({confirmedFree:true,request:async(method,path,body)=>{
  requests.push(method+' '+path.split('/').at(-1));
  if(method==='GET'&&requests.length===1)return {subdomain:'clavum-figendi'};
  if(path.endsWith('/settings'))return requests.length===2&&!existing?null:settings;
  if(method==='PUT'){
   const meta=JSON.parse(await body.get('metadata').text());
   assert.equal(!!meta.migrations,!existing);
   assert.equal(body.get('stockfish.wasm').type,'application/wasm');
   assert.equal(WebAssembly.validate(await body.get('stockfish.wasm').arrayBuffer()),true);
  }
  if(path.endsWith('/subdomain')){
   if(method==='POST')assert.deepEqual(body,{enabled:true,previews_enabled:false});
   else return {enabled:true};
  }
 }});
 assert.deepEqual(requests,['GET subdomain','GET settings','PUT repertoire-forge-cloud','GET settings','POST subdomain','GET subdomain']);
 assert.equal(url,'https://repertoire-forge-cloud.clavum-figendi.workers.dev');
});
