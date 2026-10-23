module.exports=async function hostAction(page,card,label='连接终端'){await card.locator('.host-more').click();await page.getByRole('menuitem',{name:label,exact:true}).click();};
