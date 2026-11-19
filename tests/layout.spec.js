import {test,expect} from '@playwright/test';
const url=process.env.UI_URL||'http://127.0.0.1:4274';
test('settings stay out of the workspace and keyboard focus returns',async({page})=>{
 await page.goto(url);const gear=page.getByRole('button',{name:'Settings',exact:true});
 await expect(page.getByLabel('Opening reference')).toBeHidden();
 await gear.focus();await page.keyboard.press('Enter');await expect(page.getByRole('dialog',{name:'Settings'})).toBeVisible();
 await page.keyboard.press('Escape');await expect(gear).toBeFocused();
 await gear.click();await page.getByLabel('Opening reference').selectOption('none');await page.getByRole('button',{name:'Save settings'}).click();
 await expect(gear).toBeFocused();await page.reload();await gear.click();await expect(page.getByLabel('Opening reference')).toHaveValue('none');
});
test('mobile bottom navigation is reachable and the workspace fits at 320 px',async({page})=>{
 await page.setViewportSize({width:320,height:720});await page.goto(url);
 const nav=page.getByRole('navigation',{name:'Workspaces'});await expect(nav).toBeVisible();
 expect(await nav.evaluate(el=>Math.abs(innerHeight-el.getBoundingClientRect().bottom))).toBeLessThan(2);
 for(const name of ['Backsolve','Browse','Memorize','Export']){
  const tab=nav.getByRole('button',{name,exact:true});const rect=await tab.boundingBox();expect(rect.width).toBeGreaterThanOrEqual(44);expect(rect.height).toBeGreaterThanOrEqual(44);
  await tab.click();await expect(tab).toHaveAttribute('aria-current','page');expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
 }
});
