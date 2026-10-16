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
 await context.route('**/*',route=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(__dirname,'fixtures/rendered-prices.html'),'utf8')}):route.abort());
 const page=await context.newPage();await page.goto('https://shop.example.test/catalog');
 await sw.evaluate(async()=>{await chrome.storage.local.set({sites:{'https://shop.example.test/*':true},milli:1500});const [tab]=await chrome.tabs.query({url:'https://shop.example.test/*'});await chrome.scripting.executeScript({target:{tabId:tab.id},files:['lib/rules.js','content.js']});});
 const cdp=await context.newCDPSession(page);
 async function labels(){return require('./badges.cjs').labels(cdp);}
 async function check(name,expected){await page.waitForTimeout(600);const actual=await labels();console.log(name,actual);assert.deepEqual(actual,expected.sort(),name);}
 await check('CSS generated currencies and accessible duplicated split prices',['10年≈6','10年≈2','10年≈$27','10年≈$57']);
 await page.locator('#css-list .money').first().evaluate(e=>e.textContent='5.00');
 await check('generated currency price updates',['10年≈8','10年≈2','10年≈$27','10年≈$57']);
 await page.locator('#split-card .whole').evaluate(e=>e.textContent='27');
 await page.locator('#split-card .sr').evaluate(e=>e.textContent='$27.99');
 await check('split price update',['10年≈8','10年≈2','10年≈$42','10年≈$57']);
 await page.locator('#split-card .split').evaluate(el=>{let inner=el;for(let i=0;i<18;i++){const wrap=document.createElement('div');inner.replaceWith(wrap);wrap.append(inner);inner=wrap;}});
 await check('neutral price wrappers do not hide product evidence',['10年≈8','10年≈2','10年≈$42','10年≈$57']);
 await page.locator('body').evaluate(el=>el.insertAdjacentHTML('afterbegin','<article data-product-card id="floating-card" style="position:relative;display:flex;flex-direction:column;align-items:center;width:104px;height:104px;overflow:hidden"><div role="img" style="width:104px;height:104px;flex:none">Product</div><div id="floating-price" style="position:absolute;bottom:0;left:50%;transform:translateX(-50%);margin-top:8px">¥20.00</div></article>'));
 await check('bottom-positioned price',['10年≈30','10年≈8','10年≈2','10年≈$42','10年≈$57']);
 const floating=await page.locator('#floating-price').boundingBox();
 const card=await page.locator('#floating-card').boundingBox();
 const hint=(await require('./badges.cjs').badges(cdp)).find(b=>b.text.includes('30'));
 assert.ok(hint && hint.y>=floating.y+floating.height,'floating price reminder must be below its price');
 assert.ok(hint.bottom<=card.y+card.height+1,'floating price reminder must fit in the card');
 await sw.evaluate(async()=>{const [tab]=await chrome.tabs.query({url:'https://shop.example.test/*'});await chrome.tabs.sendMessage(tab.id,{type:'fp:stop'});});
 assert.equal(await page.locator('#floating-price').evaluate(el=>el.style.position),'absolute','disabling restores merchant positioning');
 assert.equal(await page.locator('#floating-price').evaluate(el=>el.style.transform),'translateX(-50%)','disabling restores centering transform');
 console.log('PASS rendered currency and split-price structures');
 }finally{await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
