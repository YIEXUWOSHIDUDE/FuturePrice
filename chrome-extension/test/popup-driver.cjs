// Only for isolated test Chromium. Native first-grant interaction is tested separately.
exports.openPopup=async function(context,worker,tabId){
 await worker.evaluate(id=>chrome.tabs.update(id,{active:true}),tabId);
 await worker.evaluate(()=>chrome.action.openPopup());
 const cdp=await context.browser().newBrowserCDPSession();let target;
 for(let i=0;i<30&&!target;i++){target=(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.url.endsWith('/popup.html'));if(!target)await new Promise(r=>setTimeout(r,100));}
 if(!target)throw Error('popup target missing');
 const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});let count=0;const pending=new Map();
 cdp.on('Target.receivedMessageFromTarget',event=>{const m=JSON.parse(event.message),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
 return async expression=>{const id=++count;const result=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('popup evaluation timed out'));},10000);pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r)},reject:e=>{clearTimeout(timer);reject(e)}});});await cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true,userGesture:true}})});const r=await result;if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
};
