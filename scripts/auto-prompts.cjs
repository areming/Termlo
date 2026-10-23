// Only for isolated integration fixtures: production code never auto-accepts prompts.
module.exports=async page=>{
  const install=()=>{
    const observe=()=>{new MutationObserver(()=>{const prompt=document.querySelector('#app-prompt-dialog[open]');prompt?.querySelector('[data-response="1"]')?.click();}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});};
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',observe,{once:true});else observe();
  };
  await page.addInitScript(install);await page.evaluate(install);
};
