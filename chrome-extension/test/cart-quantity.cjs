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
 await context.route('**/*',route=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(__dirname,'fixtures/cart-quantity.html'),'utf8')}):route.abort());
 const page=await context.newPage();await page.goto('https://shop.example.test/catalog');
 await sw.evaluate(async()=>{await chrome.storage.local.set({sites:{'https://shop.example.test/*':true},milli:1500});const [tab]=await chrome.tabs.query({url:'https://shop.example.test/*'});await chrome.scripting.executeScript({target:{tabId:tab.id},files:['lib/rules.js','content.js']});});
 const cdp=await context.newCDPSession(page);
 async function labels(){return require('./badges.cjs').labels(cdp);}
 async function check(name,expected){await page.waitForTimeout(600);const actual=await labels();console.log(name,actual);assert.deepEqual(actual,expected.sort(),name);}
 await check('custom stepper quantity 2 uses payable 210, not unit 105',['10年≈$315','10年≈$21']);
 await page.locator('#quantity').evaluate(e=>e.textContent='3');
 await page.locator('#cart-subtotal').evaluate(e=>e.textContent='$329');
 await check('custom stepper quantity update',['10年≈$473','10年≈$21']);
 await page.locator('#price').evaluate(e=>e.textContent='$315');
 await check('already extended line amount is not multiplied again',['10年≈$473','10年≈$21']);
 await page.locator('#cart-subtotal').evaluate(e=>e.textContent='$300');
 await check('mismatched or discounted subtotal hides uncertain multi-quantity line',['10年≈$21']);
 await page.locator('#cart-subtotal').evaluate(e=>e.textContent='$329');
 await check('consistent subtotal restores the line',['10年≈$473','10年≈$21']);
 await page.locator('#row-b .price p').evaluate(e=>e.textContent='Unavailable');
 await check('unreadable other cart row prevents an incomplete sum',[]);
 await page.locator('#row-b .price p').evaluate(e=>e.textContent='$14');
 await page.locator('#row-b').evaluate(e=>e.remove());
 await page.locator('#cart-subtotal').evaluate(e=>e.textContent='$315');
 await check('removed item clears, remaining line stays correct',['10年≈$473']);
 console.log('PASS custom cart quantity');
 }finally{await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
