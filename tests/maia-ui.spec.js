import {test,expect} from '@playwright/test';
const url=process.env.UI_URL||'http://127.0.0.1:4274';
test('Maia is opt-in and displays real move probabilities',async({page})=>{
 test.setTimeout(120000);
 const modelRequests=[];page.on('request',r=>{if(r.url().includes('.onnx'))modelRequests.push(r.url());});
 await page.goto(url);await expect(page.getByRole('button',{name:'Maia predictions'})).toBeVisible();
 expect(modelRequests).toHaveLength(0);
 await page.getByRole('button',{name:'Maia predictions'}).click();
 const consent=page.getByRole('dialog',{name:'Maia predictions'});await expect(consent).toContainText('106 MB');
 expect(modelRequests).toHaveLength(0);
 await consent.getByRole('button',{name:'Load Maia'}).click();
 await expect(page.locator('#insight')).toContainText('Maia-2', {timeout:100000});
 await expect(page.locator('.maia-results li').first()).toContainText(/\d+\.\d%/);
 expect(modelRequests.length).toBeGreaterThanOrEqual(1);
});
