import {test,expect} from '@playwright/test';
const url=process.env.UI_URL||'http://127.0.0.1:4274';
test('Maia rating is selectable, persisted, and capped at the supported 2000+ bucket',async({page})=>{
 await page.goto(url);await page.getByRole('button',{name:'Settings',exact:true}).click();
 const elo=page.getByLabel('Maia Elo');await expect(elo).toHaveValue('2000');await elo.selectOption('1800');
 await page.getByRole('button',{name:'Save settings'}).click();await page.reload();
 await page.getByRole('button',{name:'Settings',exact:true}).click();await expect(page.getByLabel('Maia Elo')).toHaveValue('1800');
 await expect(page.getByRole('dialog',{name:'Settings'})).toContainText('not a dedicated grandmaster model');
});
