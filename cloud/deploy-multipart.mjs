// Pure multipart builder: this file does not deploy or mutate external state.
// Run equivalent code in the connected Cloudflare sandbox with an immutable
// GitHub raw base URL ending /<40-character-commit>/cloud/dist.
export async function makeUpload(baseURL,{existing=false,fetchImpl=fetch}={}) {
 if(!/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[a-f0-9]{40}\/cloud\/dist$/.test(baseURL))throw Error('Pin deployment artifacts to a full immutable GitHub commit');
 const load=async name=>{const r=await fetchImpl(baseURL+'/'+name);if(!r.ok)throw Error(`Artifact ${name}: HTTP ${r.status}`);return r;};
 const [metadata,js,wasm]=await Promise.all([(await load('metadata.json')).json(),(await load('worker.js')).arrayBuffer(),(await load('stockfish.wasm')).arrayBuffer()]);
 if(existing)delete metadata.migrations;
 const form=new FormData();form.set('metadata',new Blob([JSON.stringify(metadata)],{type:'application/json'}));form.set('worker.js',new Blob([js],{type:'application/javascript+module'}),'worker.js');form.set('stockfish.wasm',new Blob([wasm],{type:'application/wasm'}),'stockfish.wasm');return form;
}
