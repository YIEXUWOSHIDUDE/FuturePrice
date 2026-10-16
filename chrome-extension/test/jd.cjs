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
 await context.route('**/*',route=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(__dirname,'fixtures/jd-structure.html'),'utf8')}):route.abort());
 const page=await context.newPage();await page.goto('https://shop.example.test/catalog');
 await sw.evaluate(async()=>{await chrome.storage.local.set({sites:{'https://shop.example.test/*':true},milli:1500});const [tab]=await chrome.tabs.query({url:'https://shop.example.test/*'});await chrome.scripting.executeScript({target:{tabId:tab.id},files:['lib/rules.js','content.js']});});
 const cdp=await context.newCDPSession(page);
 async function labels(){return require('./badges.cjs').labels(cdp);}
 async function check(name,expected){await page.waitForTimeout(600);const actual=await labels();console.log(name,actual);assert.deepEqual(actual,expected.sort(),name);}
 await check('nonsemantic product title and clickable purchase controls',['10年≈9536']);
 await page.locator('#condition').evaluate(el=>el.textContent='国补领后价');
 await page.locator('.sticky').evaluate(el=>el.insertAdjacentHTML('beforeend','<div>已享受：限时立减20 <span>国家补贴｜领后减<span>￥1121.85</span></span> 单品立享8.5折</div><div>可再享：最高返317京豆</div>'));
 await page.locator('.options').evaluate(el=>el.insertAdjacentHTML('afterend','<div>白条分期 <span>￥2119.05 x 3期</span></div><div>优选服务 <span>599.00</span></div>'));
 await check('selected displayed price, not subsidy amount, installments or old price',['10年≈9536']);
 await page.locator('#amount').evaluate(el=>el.textContent='7000.00');
 await check('selected variant price change',['10年≈10500']);
 await page.locator('.controls').evaluate(el=>el.remove());
 await check('large title and image without purchase evidence is insufficient',[]);
 console.log('PASS nonsemantic commerce structure');
 }finally{await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
