/* Independent synthetic product structures, arbitrary non-shopping hostname.
 * Isolated browser: route fulfills the Amazon URL locally; no account or live network.
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
 await context.route('**/*',route=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(__dirname,'fixtures/detail.html'),'utf8')}):route.abort());
 const page=await context.newPage();await page.goto('https://shop.example.test/catalog');
 await sw.evaluate(async()=>{await chrome.storage.local.set({sites:{'https://shop.example.test/*':true},milli:1500});const [tab]=await chrome.tabs.query({url:'https://shop.example.test/*'});await chrome.scripting.executeScript({target:{tabId:tab.id},files:['lib/rules.js','content.js']});});
 const cdp=await context.newCDPSession(page);
 async function labels(){return require('./badges.cjs').labels(cdp);}
 async function check(name,expected){await page.waitForTimeout(600);const actual=await labels();console.log(name,actual);assert.deepEqual(actual,expected.sort(),name);}
 await page.locator('h1').evaluate(el=>el.insertAdjacentHTML('afterend','<div hidden><h5>Return this item</h5></div><h3 style="display:none">Purchase options</h3>'));
 await check('long product detail main price must not be lost',['10年≈$899']);
 // Same detail with observed nested financing and conditional credit promotion structures.
 await page.locator('#offer').evaluate(el=>el.insertAdjacentHTML('beforeend',`
 <div class="monthly"><span><span><span><span>Or </span><span><span class="money"><span class="sr">$49.92</span><span aria-hidden="true"><span>$</span><span>49<span class="decimal">.</span></span><sup>92</sup></span></span></span></span><span>/mo (12 mo).</span></span></span><a href="#">Select from 2 plans</a></div>
 <a href="#credit"><div><span><strong>Thank you for being a Prime member. Get <span>$150</span> off: Pay <span><span>$449.00</span></span> <span style="text-decoration:line-through"><span>$599.00</span></span></strong> upon approval for Prime Visa.</span></div></a>`));
 await check('keep full main price; exclude nested monthly and conditional credit offer',['10年≈$899']);
 await page.locator('.desc').evaluate(el=>el.insertAdjacentHTML('beforeend',' Customer review: I bought accessories for <span>$100</span>.'));
 await check('description or review money is not a second product',['10年≈$899']);
 await page.locator('#whole').evaluate(el=>el.firstChild.textContent='649');
 await check('main price updates despite long detail and alternative offers',['10年≈$974']);
 await page.locator('#offer').evaluate(el=>el.remove());
 await check('no main price means no reminder',[]);
 console.log('PASS long product detail regression');
 }finally{await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
