// Read closed-shadow UI through CDP in the isolated test browser only.
async function badges(client) {
  const {root}=await client.send('DOM.getDocument',{depth:-1,pierce:true});
  const nodes=[];
  function walk(n){
    const attrs=n.attributes||[]; const i=attrs.indexOf('class');
    if(i>=0 && attrs[i+1].split(/\s+/).includes('badge')) nodes.push(n);
    for(const k of ['children','shadowRoots']) for(const child of n[k]||[]) walk(child);
  }
  walk(root);
  const out=[];
  for(const node of nodes){
    const {object}=await client.send('DOM.resolveNode',{backendNodeId:node.backendNodeId});
    const {result}=await client.send('Runtime.callFunctionOn',{objectId:object.objectId,returnByValue:true,functionDeclaration:`function(){
      const r=this.getBoundingClientRect(), s=getComputedStyle(this), host=this.getRootNode().host;
      const amount=this.querySelector('strong,.amount,.amt'); const a=amount&&getComputedStyle(amount);
      return {text:this.textContent,visible:s.visibility!=='hidden'&&s.display!=='none'&&r.width>0&&r.height>0,
        x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right,
        background:s.backgroundColor,font:s.fontSize,amountFont:a&&a.fontSize,amountWeight:a&&a.fontWeight,
        hostDisplay:getComputedStyle(host).display,hostPosition:getComputedStyle(host).position};
    }`});
    await client.send('Runtime.releaseObject',{objectId:object.objectId});
    if(result.value?.visible) out.push(result.value);
  }
  return out;
}
async function labels(client){return (await badges(client)).map(b=>b.text.replace(/^不买，\s*10年后\s*≈\s*/, '10年≈').replace('10年≈¥','10年≈')).sort();}
module.exports={badges,labels};
