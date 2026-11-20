// Deploy the prebuilt binary multipart using a locally supplied account-scoped token.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const account='45f1679a19a096da595dc830ac3e53a5';
const script='repertoire-forge-cloud';
const root=`/accounts/${account}/workers`;
const lookup=`${root}/scripts/${script}`;
export async function publish({request,dist=new URL('./dist/',import.meta.url),confirmedFree=false}) {
 if(!confirmedFree)throw Error('Confirm the dedicated account is on Workers Free in the dashboard before deployment.');
 const read=name=>readFile(new URL(name,dist));
 const manifest=JSON.parse(await read('manifest.json'));
 const files={};
 for(const name of ['metadata.json','worker.js','stockfish.wasm']){
  const bytes=await read(name),expected=manifest[name];
  if(bytes.length!==expected.bytes||createHash('sha256').update(bytes).digest('hex')!==expected.sha256)throw Error(`Artifact mismatch: ${name}`);
  files[name]=bytes;
 }
 const {subdomain}=await request('GET',`${root}/subdomain`);
 if(subdomain!=='clavum-figendi')throw Error('Unexpected dedicated account subdomain.');
 const existing=await request('GET',`${lookup}/settings`,undefined,{allowNotFound:true});
 const metadata=JSON.parse(files['metadata.json']);
 if(existing) {
  if(!existing.bindings?.some(b=>b.type==='durable_object_namespace'&&b.name==='JOBS'&&b.class_name==='BacksolveJob'))throw Error('Existing script has unexpected bindings.');
  delete metadata.migrations;
 }
 const form=new FormData();
 form.set('metadata',new Blob([JSON.stringify(metadata)],{type:'application/json'}));
 form.set('worker.js',new Blob([files['worker.js']],{type:'application/javascript+module'}),'worker.js');
 form.set('stockfish.wasm',new Blob([files['stockfish.wasm']],{type:'application/wasm'}),'stockfish.wasm');
 await request('PUT',lookup,form);
 const settings=await request('GET',`${lookup}/settings`);
 if(!settings.bindings?.some(b=>b.name==='JOBS'&&b.class_name==='BacksolveJob'))throw Error('Durable Object binding not verified after upload.');
 await request('POST',`${lookup}/subdomain`,{enabled:true,previews_enabled:false});
 const route=await request('GET',`${lookup}/subdomain`);
 if(route.enabled!==true)throw Error('workers.dev route was not enabled.');
 return `https://${script}.${subdomain}.workers.dev`;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const token=process.env.CLOUDFLARE_API_TOKEN;
  if(!token)throw Error('Set CLOUDFLARE_API_TOKEN out of band.');
  const request=async(method,path,body,{allowNotFound=false}={})=>{
   const headers={Authorization:`Bearer ${token}`};
   if(body&&!(body instanceof FormData)){headers['Content-Type']='application/json';body=JSON.stringify(body);}
   const r=await fetch(`https://api.cloudflare.com/client/v4${path}`,{method,headers,body,signal:AbortSignal.timeout(60000),redirect:'error'});
   const data=await r.json();
   if(allowNotFound&&r.status===404&&data.errors?.some(e=>e.code===10007))return null;
   if(!r.ok||!data.success)throw Error(`${method} ${path}: HTTP ${r.status} (${data.errors?.map(e=>e.code).join(', ')||'unknown'})`);
   return data.result;
  };
  console.log(await publish({request,confirmedFree:process.argv.includes('--confirmed-workers-free')}));
 }catch(e){console.error(e.message);process.exitCode=1;}
}
