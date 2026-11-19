import {test,expect} from '@playwright/test';
import {importPgn,DEFAULT_SETTINGS} from '../src/core.js';
const url=process.env.UI_URL||'http://127.0.0.1:4274';
async function setup(page,g,cards=[]){
 await page.goto(url);page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'Export',exact:true}).click();
 await page.locator('#restore-file').setInputFiles({name:'drill.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({format:'repertoire-forge',version:1,graph:g,cards,settings:DEFAULT_SETTINGS}))});
 await expect(page.getByRole('status')).toContainText('Backup restored');
}
const tap=(page,sq)=>page.locator(`[data-square="${sq}"]`).click();

test('play ends when the opponent refutes a recorded mistake',async({page})=>{
 const g=importPgn('1. e4 e5 *');g.lines[0].mistakePly=0;await setup(page,g);
 await page.getByRole('button',{name:'Play',exact:true}).click();await page.getByRole('button',{name:'Start drill'}).click();
 await tap(page,'e2');await tap(page,'e4');await expect(page.locator('#drill-status')).toContainText('Your move was refuted');
 await expect(page.getByRole('button',{name:'e5 black pawn',exact:true})).toBeVisible();
});

test('Black drill auto-replies and ends after the player finds the refutation',async({page})=>{
 const g=importPgn('1. e4 e5 *');g.lines[0].mistakePly=0;await setup(page,g);
 await page.getByRole('button',{name:'Play',exact:true}).click();await page.getByLabel('Play as').selectOption('b');await page.getByRole('button',{name:'Start drill'}).click();
 await expect(page.locator('#board .square').first()).toHaveAttribute('data-square','h1');
 await tap(page,'e7');await tap(page,'e5');await expect(page.locator('#drill-status')).toContainText('You found the refutation');
});

test('recall rotates automatically when the next card changes sides',async({page})=>{
 const g=importPgn('1. e4 e5 *');const root=g.nodes[g.root],black=g.nodes[root.edges[0].to];
 const card=(n,uci,san,due)=>({id:n.key,fen:n.fen,uci,san,source:'stockfish',due,interval:0,repetitions:0,ease:2.5,lapses:0});
 await setup(page,g,[card(root,'e2e4','e4',1),card(black,'e7e5','e5',2)]);
 await page.getByRole('button',{name:'Memorize',exact:true}).click();
 await expect(page.locator('#board .square').first()).toHaveAttribute('data-square','a8');
 await tap(page,'e2');await tap(page,'e4');await page.getByRole('button',{name:'Good',exact:true}).click();
 await expect(page.locator('#board .square').first()).toHaveAttribute('data-square','h1');
});
