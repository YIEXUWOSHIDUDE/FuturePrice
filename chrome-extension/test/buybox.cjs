/* Independent synthetic product structures, arbitrary non-shopping hostname.
 * Isolated browser: route fulfills the test URL locally; no account or live network.
 * Test copy pregrants origin; production permissions remain unchanged.
 */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),work=fs.mkdtempSync(path.join(os.tmpdir(),'fp-amazon-')),stage=path.join(work,'extension');
 fs.cpSync(root,stage,{recursive:true});const manifest=JSON.parse(fs.readFileSync(stage+'/manifest.json'));manifest.host_permissions=['https://shop.example.test/*'];fs.writeFileSync(stage+'/manifest.json',JSON.stringify(manifest));
 const context=await chromium.launchPersistentContext(path.join(work,'profile'),{channel:'chromium',headless:true,viewport:{width:1280,height:1100},args:[`--disable-extensions-except=${stage}`,`--load-extension=${stage}`]});
 try{
 const sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 await context.route('**/*',route=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(__dirname,'fixtures/buybox.html'),'utf8')}):route.abort());
 const page=await context.newPage();await page.goto('https://shop.example.test/catalog');
 await sw.evaluate(async()=>{await chrome.storage.local.set({sites:{'https://shop.example.test/*':true},milli:1500});const [tab]=await chrome.tabs.query({url:'https://shop.example.test/*'});await chrome.scripting.executeScript({target:{tabId:tab.id},files:['lib/rules.js','content.js']});});
 const cdp=await context.newCDPSession(page);
 async function labels(){return require('./badges.cjs').labels(cdp);}
 async function check(name,expected){await page.waitForTimeout(600);const actual=await labels();console.log(name,actual);assert.deepEqual(actual,expected.sort(),name);}
 await check('separate purchase column with duplicate selected offer',['10年≈$749']);
 const originalBuy=await page.locator('.buy').innerHTML();
 await page.locator('#offer-options').evaluate(el=>el.style.display='none');
 await page.locator('#current').evaluate(el=>el.textContent='Now $469.99');
 await check('current-price label and amount in a single text node',['10年≈$705']);
 await page.locator('#current').evaluate(el=>el.parentElement.parentElement.insertAdjacentHTML('afterend','<span class="sr">You save $1,530.00</span><div style="display:inline-flex"><span class="sr">was $1,999.99</span><span style="text-decoration:line-through">$1,999.99</span><button>Price info</button></div><div id="save-row" style="display:flex"><span>You save</span><span>$1,530.00</span></div>'));
 await check('sale main price with savings and crossed original',['10年≈$705']);
 await page.locator('.buy').evaluate(el=>el.insertAdjacentHTML('beforeend','<fieldset id="shipping-options"><legend>Delivery options</legend><label><input type="radio" name="fulfillment" checked><div><div role="img" style="width:32px;height:32px">Truck</div><div>Shipping</div><div>Arrives October 21</div><div><div>$99.00</div></div></div></label><label><input type="radio" name="fulfillment">Pickup unavailable</label></fieldset>'));
 await check('shipping radio is a fee, not a product',['10年≈$705']);
 await page.locator('.buy').evaluate((el,html)=>el.innerHTML=html,originalBuy);
 await page.waitForTimeout(800);

 await page.locator('#current').evaluate(el=>el.textContent='$499.00');
 await page.locator('#offer-options').evaluate(el=>el.style.display='');
 await page.locator('#offer-options').evaluate(el=>el.insertAdjacentHTML('beforeend','<label><input type="radio" name="condition"><span>Open Box</span><b>$399.00</b></label>'));
 await check('unselected alternative does not displace current main price',['10年≈$749']);
 await page.locator('#current').evaluate(el=>el.textContent='$399.00');
 await page.locator('#selected-amount').evaluate(el=>el.textContent='$399.00');
 await check('main price refresh',['10年≈$599']);
 await page.locator('#offer-options').evaluate(el=>el.insertAdjacentHTML('beforeend','<div><label><input type="radio" name="condition"><span>Refurbished</span></label><b>$299.00</b></div>'));
 await check('unselected radio price outside its label',['10年≈$599']);
 await page.locator('#current').evaluate(el=>el.remove());
 await page.locator('#offer-options').evaluate(el=>el.innerHTML='<div><label><input type="radio" name="condition" id="choice-a" checked>New</label><b>$399.00</b></div><div><label><input type="radio" name="condition" id="choice-b">Refurbished</label><b>$299.00</b></div>');
 await check('selected offer is the only displayed payable price',['10年≈$599']);
 await page.locator('#choice-b').check();
 await check('radio change without changing text updates reminder',['10年≈$449']);
 await page.locator('#offer-options').evaluate(el=>el.remove());
 await page.locator('.buy').evaluate(el=>el.insertAdjacentHTML('afterbegin','<div id="compact-wrap" style="width:206px;overflow:hidden"><div id="compact-row" style="display:flex;flex-wrap:nowrap;gap:4px;width:206px"><span style="font-size:30px">$499.00</span><button>Price history</button></div></div>'));
 await check('narrow non-wrapping price and control row',['10年≈$749']);
 const box=await page.locator('#compact-row').boundingBox();
 const rendered=await require('./badges.cjs').badges(cdp);
 assert.ok(rendered[0].y>=box.y+box.height-1,'reminder must be BELOW horizontal price/control row');
 assert.ok(rendered[0].right<=box.x+box.width+1,'reminder cannot overflow narrow buy box');
 console.log('PASS split-column purchase structure');
 }finally{await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
