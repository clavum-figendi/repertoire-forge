import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeUpload } from '../deploy-multipart.mjs';
test('multipart contains binary Wasm, exact module names and SQLite migration metadata',async()=>{
 const base='https://raw.githubusercontent.com/clavum-figendi/repertoire-forge/'+'a'.repeat(40)+'/cloud/dist';
 const fetchImpl=async url=>new Response(await readFile(new URL('../dist/'+url.split('/').at(-1),import.meta.url)));
 const form=await makeUpload(base,{fetchImpl});const metadata=JSON.parse(await form.get('metadata').text());assert.equal(metadata.main_module,'worker.js');assert.equal(metadata.migrations.steps[0].new_sqlite_classes[0],'BacksolveJob');assert.equal(form.get('worker.js').type,'application/javascript+module');assert.equal(form.get('stockfish.wasm').type,'application/wasm');assert.ok(WebAssembly.validate(await form.get('stockfish.wasm').arrayBuffer()));
 const update=await makeUpload(base,{fetchImpl,existing:true});assert.equal(JSON.parse(await update.get('metadata').text()).migrations,undefined);
 await assert.rejects(makeUpload(base.replace('a'.repeat(40),'main')),/immutable/);
});
