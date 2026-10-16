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
 await context.route('**/*',route=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(__dirname,'fixtures/collapsible.html'),'utf8')}):route.abort());
 const page=await context.newPage();await page.goto('https://shop.example.test/catalog');
 await sw.evaluate(async()=>{await chrome.storage.local.set({sites:{'https://shop.example.test/*':true},milli:1500});const [tab]=await chrome.tabs.query({url:'https://shop.example.test/*'});await chrome.scripting.executeScript({target:{tabId:tab.id},files:['lib/rules.js','content.js']});});
 const cdp=await context.newCDPSession(page);
 async function labels(){return require('./badges.cjs').labels(cdp);}
 async function check(name,expected){await page.waitForTimeout(600);const actual=await labels();console.log(name,actual);assert.deepEqual(actual,expected.sort(),name);}
 await check('expanded recommendation visible',['10年≈$30']);
 const expanded = await page.locator('#panel').evaluate(e=>e.getBoundingClientRect().height);
 assert.ok(await page.locator('#panel').evaluate(e=>!!e.style.minHeight), 'fixture must exercise clipping correction');
 await page.locator('#fold').evaluate(e=>e.style.maxHeight='0px');
 await check('collapsed recommendations must not remain visible',[]);
 const collapsed = await page.locator('#panel').evaluate(e=>({height:e.getBoundingClientRect().height,min:e.style.minHeight}));
 assert.equal(collapsed.min,'');
 assert.ok(collapsed.height < expanded / 2, 'panel releases its height on collapse');
 await page.locator('#fold').evaluate(e=>e.style.maxHeight='60px');
 await check('reopening restores recommendation',['10年≈$30']);
 console.log('PASS collapsible recommendation respects merchant state');
 }finally{await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
