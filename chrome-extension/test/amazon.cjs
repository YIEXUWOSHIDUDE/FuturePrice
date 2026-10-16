/* Synthetic fixture using public price markup observed on Amazon.com, 2026-10-16.
 * Isolated browser: route fulfills the Amazon URL locally; no account or live network.
 * Test copy pregrants origin; production permissions remain unchanged.
 */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),work=fs.mkdtempSync(path.join(os.tmpdir(),'fp-amazon-')),stage=path.join(work,'extension');
 fs.cpSync(root,stage,{recursive:true});const manifest=JSON.parse(fs.readFileSync(stage+'/manifest.json'));manifest.host_permissions=['https://www.amazon.com/*'];fs.writeFileSync(stage+'/manifest.json',JSON.stringify(manifest));
 const context=await chromium.launchPersistentContext(path.join(work,'profile'),{channel:'chromium',headless:true,viewport:{width:1280,height:1100},args:[`--disable-extensions-except=${stage}`,`--load-extension=${stage}`]});
 try{
 const sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 await context.route('**/*',route=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(__dirname,'fixtures/amazon.html'),'utf8')}):route.abort());
 const page=await context.newPage();await page.goto('https://www.amazon.com/dp/B07FXSZ49R');
 await sw.evaluate(async()=>{await chrome.storage.local.set({sites:{'https://www.amazon.com/*':true},milli:1500});const [tab]=await chrome.tabs.query({url:'https://www.amazon.com/*'});await chrome.scripting.executeScript({target:{tabId:tab.id},files:['lib/rules.js','content.js']});});
 const cdp=await context.newCDPSession(page);
 async function labels(){return require('./badges.cjs').labels(cdp);}
 async function check(name,expected){await page.waitForTimeout(600);const actual=await labels();console.log(name,actual);assert.deepEqual(actual,expected.sort(),name);}
 await check('main plus two products; no sidebar/unit/promo/estimate/subscription/coupon',['10年≈$6','10年≈$7','10年≈$2']);
 // Check the new presentation, not only the unchanged money calculation.
 const initialBadges=await require('./badges.cjs').badges(cdp);
 for(const badge of initialBadges){
   assert.match(badge.text,/^不买，\s*10年后\s*≈\s*\$/);
   assert.equal(badge.background,'rgb(255, 240, 217)');
   assert(parseFloat(badge.amountFont)>=18,'amount must be readable');
   assert(Number(badge.amountWeight)>=700,'amount must be bold');
   assert(!['fixed','absolute'].includes(badge.hostPosition),'badge must occupy normal flow');
 }
 const mainBadge=initialBadges.find(b=>b.text.endsWith('$6'));
 const unit=await page.locator('#centerCol .pricePerUnit').boundingBox();
 assert(mainBadge.y>=unit.y+unit.height,'keep main price and unit price above reminder');
 await page.waitForTimeout(1200);
 assert.deepEqual(await labels(),['10年≈$2','10年≈$6','10年≈$7'],'own labels must not feed back into detection');
 // A compact auto-height product card is allowed to grow for the extra line.
 await page.locator('.product').evaluateAll(els=>els.forEach(el=>{el.style.width='160px';el.style.height='auto';el.style.boxSizing='border-box';}));
 await page.waitForTimeout(700);
 for(const badge of (await require('./badges.cjs').badges(cdp)).filter(b=>!b.text.endsWith('$6'))){
   const card=await page.locator(badge.text.endsWith('$7')?'#info-B07Y45LLLJ':'#info-B000P72UZG').boundingBox();
   const button=await page.locator(badge.text.endsWith('$7')?'#info-B07Y45LLLJ button':'#info-B000P72UZG button').boundingBox();
   assert(badge.x>=card.x&&badge.right<=card.x+card.width,'no overflow on 160px cards');
   assert(badge.bottom<=button.y,'reminder does not overlap button');
 }
 // Merchant carousel snapshots its height before our extra line arrives.
 await page.locator('#products').evaluate(el=>{
   const clip=document.createElement('div');clip.id='fixed-viewport';
   clip.style.cssText='overflow:hidden;min-height:5px !important;height:'+(el.getBoundingClientRect().height-48)+'px';
   el.before(clip);clip.append(el);
 });
 await page.waitForTimeout(800);
 const clipping=await page.locator('#fixed-viewport').evaluate(el=>({bottom:el.getBoundingClientRect().bottom,
   contentBottom:el.firstElementChild.getBoundingClientRect().bottom,minHeight:el.style.minHeight}));
 assert(clipping.bottom>=clipping.contentBottom-1,'fixed carousel must not clip product text or controls');
 console.log('PASS fixed-height carousel expansion',clipping);
 await page.screenshot({path:path.join(process.env.FP_TEST_OUTPUT||work,'chrome-amazon-style-030.png'),fullPage:true});
 await page.locator('#main-price .a-price-whole').evaluate(el=>el.firstChild.textContent='5');
 await check('split price mutation',['10年≈$9','10年≈$7','10年≈$2']);
 await page.locator('#info-B07Y45LLLJ').evaluate(el=>el.remove());
 await check('removed card',['10年≈$9','10年≈$2']);
 await page.locator('#main-price').evaluate(el=>el.style.display='none');
 await check('hidden main',['10年≈$2']);
 await sw.evaluate(()=>chrome.storage.local.set({sites:{}}));await page.waitForTimeout(500);
 assert.equal(await page.locator('futureprice-hint').count(),0);
 const restored=await page.locator('#fixed-viewport').evaluate(el=>({value:el.style.minHeight,priority:el.style.getPropertyPriority('min-height')}));
 assert.deepEqual(restored,{value:'5px',priority:'important'},'restore merchant min-height on disable');
 console.log('PASS Amazon synthetic DOM regression');
 }finally{await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
