const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function harness(){
 const listeners={},store={},origins=new Set(),scripts=new Map(),tabs=[{id:1,url:'https://shop.example.test/item'}];
 let request,resolveGrant,injected=0,failInjection=false;
 const event=n=>({addListener:fn=>listeners[n]=fn});
 const clone=x=>JSON.parse(JSON.stringify(x));
 const chrome={runtime:{id:'test',onMessage:event('message'),onStartup:event('startup'),onInstalled:event('installed')},
 storage:{local:{get:async defaults=>({...defaults,...clone(store)}),set:async data=>Object.assign(store,clone(data))}},
 permissions:{contains:async p=>p.origins.every(x=>origins.has(x)),request:p=>{request=clone(p);return new Promise(r=>resolveGrant=r)},remove:async p=>{p.origins.forEach(x=>origins.delete(x));return true},onRemoved:event('removed')},
 scripting:{getRegisteredContentScripts:async o=>[...scripts.values()].filter(x=>!o?.ids||o.ids.includes(x.id)),registerContentScripts:async ss=>ss.forEach(s=>scripts.set(s.id,clone(s))),unregisterContentScripts:async o=>o.ids.forEach(id=>scripts.delete(id)),executeScript:async()=>{if(failInjection)throw Error('injection failed');injected++;}},
 tabs:{get:async id=>tabs.find(t=>t.id===id),query:async()=>tabs,sendMessage:async()=>({running:true,labeled:1})}};
 const ctx=vm.createContext({chrome,self:{},console,setTimeout,clearTimeout,URL});ctx.importScripts=()=>{vm.runInContext(fs.readFileSync(root+'/lib/rules.js','utf8'),ctx);ctx.self.FPRules=ctx.FPRules;};vm.runInContext(fs.readFileSync(process.env.FP_BACKGROUND_SOURCE||root+'/background.js','utf8'),ctx);
 const sender={id:'test'};
 const message=(msg,s=sender)=>new Promise(resolve=>{const accepted=listeners.message(msg,s,resolve);if(!accepted)resolve(undefined)});
 return {store,origins,scripts,tabs,listeners,message,get injected(){return injected},get request(){return request},set failInjection(x){failInjection=x},grant:yes=>{if(yes)request.origins.forEach(x=>origins.add(x));resolveGrant(yes)},drain:()=>new Promise(r=>setTimeout(r,10))};
}
const msg={type:'popup:request-enable',tabId:1,url:'https://shop.example.test/item'};
test('first grant completes authorization registration and injection in background',async()=>{const h=harness();await h.drain();let reply;assert.equal(h.listeners.message(msg,{id:'test'},r=>reply=r),true);assert.deepEqual(h.request,{origins:['https://shop.example.test/*']});h.grant(true);await h.drain();assert.equal(h.store.sites['https://shop.example.test/*'],true);assert.equal(h.scripts.size,1);assert.equal(h.injected,1);assert.equal(reply.ok,true);});
test('permission denial never enables',async()=>{const h=harness();await h.drain();const result=h.message(msg);h.grant(false);assert.equal((await result).ok,false);assert.equal(h.injected,0);assert.equal(h.scripts.size,0);assert.deepEqual(h.store.sites||{},{});});
test('content script cannot request a permission',async()=>{const h=harness();assert.equal(await h.message(msg,{id:'test',tab:{id:1}}),undefined);assert.equal(h.request,undefined);});
test('navigation during prompt cannot enable old or new origin',async()=>{const h=harness();await h.drain();const result=h.message(msg);h.tabs[0].url='https://other.example.test/';h.grant(true);assert.equal((await result).ok,false);assert.equal(h.injected,0);assert.equal(h.scripts.size,0);});
test('injection failure rolls back enabled state and permission',async()=>{const h=harness();await h.drain();h.failInjection=true;const result=h.message(msg);h.grant(true);assert.equal((await result).ok,false);assert.deepEqual(h.store.sites,{});assert.equal(h.origins.size,0);assert.equal(h.scripts.size,0);});
test('external revoke cleans enabled site and registration',async()=>{const h=harness();await h.drain();const result=h.message(msg);h.grant(true);assert.equal((await result).ok,true);h.origins.clear();h.listeners.removed({origins:['https://shop.example.test/*']});await h.drain();assert.deepEqual(h.store.sites,{});assert.equal(h.scripts.size,0);});
