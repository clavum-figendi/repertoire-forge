import { readFile,writeFile,mkdir,copyFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const engine='../public/engine/stockfish-17.1-lite-single-03e3232';
await mkdir('generated',{recursive:true}); await mkdir('dist',{recursive:true});
const original=await readFile(engine+'.js','utf8');
const start=original.indexOf('function t(){function e(e){')+'function t(){'.length;
const end=original.indexOf('var Te;Te=');
if(start<12||end<start) throw Error('Upstream engine wrapper changed');
let factory=original.slice(start,end).replace(/require\("(?:fs|path)"\)/g,'null');
if(/\beval\s*\(|new\s+Function\b/.test(factory)) throw Error('Dynamic code generation forbidden: audit upstream build');
await writeFile('generated/stockfish.js',original.slice(0,original.indexOf('!function'))+'\nvar Te;\n'+factory+'\nexport default e;\n');
await build({entryPoints:['src/worker.js'],bundle:true,format:'esm',platform:'neutral',target:'es2022',outfile:'dist/worker.js',external:['./stockfish.wasm','cloudflare:workers'],alias:{'chess.js':new URL('./node_modules/chess.js/dist/esm/chess.js',import.meta.url).pathname},define:{global:'undefined',process:'undefined'},minify:true,legalComments:'inline'});
const js=await readFile('dist/worker.js','utf8');
if(/\beval\s*\(|new\s+Function\b/.test(js)) throw Error('Bundle contains dynamic code generation');
// The browser build reserves all 128 MiB before JS heap. Bound the module
// itself to 64 MiB (including 16 MiB hash); fail closed if upstream changes.
const originalWasm=await readFile(engine+'.wasm');
let position=8, memoryStart=-1, memoryEnd=-1;
function uleb(){let value=0,shift=0,byte;do{byte=originalWasm[position++];value|=(byte&127)<<shift;shift+=7;}while(byte&128);return value;}
while(position<originalWasm.length){const sectionStart=position,id=originalWasm[position++],length=uleb(),payload=position;if(id===5){const expected=Buffer.from([1,1,128,16,128,128,2]);if(!originalWasm.subarray(payload,payload+length).equals(expected))throw Error('Upstream Wasm memory layout changed');memoryStart=sectionStart;memoryEnd=payload+length;break;}position+=length;}
if(memoryStart<0)throw Error('Missing Wasm memory section');
const wasm=Buffer.concat([originalWasm.subarray(0,memoryStart),Buffer.from([5,6,1,1,128,8,128,8]),originalWasm.subarray(memoryEnd)]);
if(!WebAssembly.validate(wasm))throw Error('Invalid bounded Wasm');
await writeFile('dist/stockfish.wasm',wasm);
await copyFile('metadata.json','dist/metadata.json');
await copyFile('../public/engine/Copying.txt','dist/COPYING-Stockfish.txt');
await copyFile('../public/engine/AUTHORS','dist/AUTHORS-Stockfish.txt');
const manifest={};for(const name of ['worker.js','stockfish.wasm','metadata.json']){const data=await readFile('dist/'+name);manifest[name]={bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};}await writeFile('dist/manifest.json',JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({jsBytes:Buffer.byteLength(js),wasmBytes:(await readFile('dist/stockfish.wasm')).length,gzipBytes:gzipSync(js).length+gzipSync(await readFile('dist/stockfish.wasm')).length}));
