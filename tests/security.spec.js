import {test,expect} from '@playwright/test';
import {importPgn,DEFAULT_SETTINGS} from '../src/core.js';
const base=process.env.UI_URL||'http://127.0.0.1:4274';
const payload='<img src=x onerror="window.__xss=1">';
async function restore(page,backup){
 await page.getByRole('button',{name:'Export',exact:true}).click();
 await page.locator('#restore-file').setInputFiles({name:'x.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
}
test('restored theory/analysis metadata cannot inject markup, before or after reload',async({page})=>{
 const graph=importPgn('1. e4 e5 *');
 graph.nodes[graph.root].theory={userBook:true,total:payload,moves:[{san:payload,uci:'e2e4',count:payload}]};
 graph.nodes[graph.root].analysis={depth:payload,scoreCp:payload,bestMove:'e2e4'};
 await page.goto(base);page.on('dialog',d=>d.accept());
 await restore(page,{format:'repertoire-forge',version:1,graph,sourceGraph:graph,cards:[],settings:DEFAULT_SETTINGS,source:payload});
 await expect(page.getByTestId('graph-summary')).toContainText('1 game');
 for(const w of ['Browse','Backsolve'])await page.getByRole('button',{name:w,exact:true}).click();
 await page.reload();
 for(const w of ['Browse','Backsolve'])await page.getByRole('button',{name:w,exact:true}).click();
 expect(await page.evaluate(()=>window.__xss)).toBeUndefined();
 expect(await page.locator('img[src="x"]').count()).toBe(0);
});
test('restored settings with markup are rejected',async({page})=>{
 const graph=importPgn('1. e4 *');
 await page.goto(base);page.on('dialog',d=>d.accept());
 await restore(page,{format:'repertoire-forge',version:1,graph,cards:[],settings:{...DEFAULT_SETTINGS,mistakeCp:payload}});
 await expect(page.getByRole('alert')).toContainText('Restore failed');
 expect(await page.evaluate(()=>window.__xss)).toBeUndefined();
});
