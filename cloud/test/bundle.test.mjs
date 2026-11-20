import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('deploy artifact statically imports Wasm and contains no eval/new Function',async()=>{const js=await readFile(new URL('../dist/worker.js',import.meta.url),'utf8');assert.match(js,/from[ "]+\.\/stockfish\.wasm/);assert.doesNotMatch(js,/\beval\s*\(|new\s+Function\b/);const bytes=await readFile(new URL('../dist/stockfish.wasm',import.meta.url));assert.equal(WebAssembly.validate(bytes),true);});
