// Playwright's renderer predicate does not poll an async function's resolved value.
// Poll API responses on the Node side so tests cannot pass on a truthy Promise.
module.exports=async function waitForApi(page,predicate,arg,options={}) {
  const end=Date.now()+(options.timeout||30000);
  while(Date.now()<end){if(await page.evaluate(predicate,arg))return;await new Promise(resolve=>setTimeout(resolve,50));}
  throw new Error('Timed out waiting for desktop API condition: '+String(predicate));
};
