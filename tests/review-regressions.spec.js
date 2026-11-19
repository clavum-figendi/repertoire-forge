import {test,expect} from '@playwright/test';
import fs from 'node:fs/promises';
const base=process.env.UI_URL||'http://127.0.0.1:4274';
test('disconnected setup roots are selectable and manual source edits persist',async({page})=>{
 await page.goto(base);await page.getByRole('button',{name:'Load sample',exact:true}).click();
 await page.getByLabel('PGN notation').fill('[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/8/4K3 w - - 0 1"]\n\n1. Kd2 *');await page.getByRole('button',{name:'Import PGN',exact:true}).click();
 await page.getByRole('button',{name:'Browse',exact:true}).click();await page.locator('#root-select').selectOption({index:1});await expect(page.getByRole('button',{name:'e1 white king',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'d2 empty',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'e1 white king',exact:true}).click();await page.getByRole('button',{name:'f2 empty',exact:true}).click();await page.getByRole('button',{name:'Export',exact:true}).click();const event=page.waitForEvent('download');await page.getByRole('button',{name:'Download JSON backup',exact:true}).click();const d=await event;const backup=JSON.parse(await fs.readFile(await d.path(),'utf8'));expect(backup.sourceGraph.lines.some(l=>l.moves.includes('e1f2'))).toBe(true);
});
test('insufficient material setup is evaluated without contract failure',async({page})=>{
 await page.goto(base);await page.getByLabel('PGN notation').fill('[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/8/4K3 w - - 0 1"]\n\n1. Kd2 *');await page.getByRole('button',{name:'Import PGN',exact:true}).click();await page.getByRole('button',{name:'Settings',exact:true}).click();await page.locator('[name="depth"]').fill('4');await page.getByRole('button',{name:'Save settings',exact:true}).click();await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByLabel('Opening reference').selectOption('none');await page.getByRole('button',{name:'Save settings',exact:true}).click();await page.locator('[data-action="backsolve"]').click();await expect(page.locator('#progress')).toContainText('Complete',{timeout:60000});
});
