module.exports=async(page,selector,value)=>{
  const select=page.locator(selector),index=await select.evaluate((el,value)=>[...el.options].findIndex(o=>o.value===value),value);
  if(index<0)throw new Error('Missing option '+value);
  await select.locator('..').locator('.select-trigger').click();
  await select.locator('..').locator(`.select-option[data-index="${index}"]`).click();
};
