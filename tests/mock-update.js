// Representative recursive flag merge, including Foundry's -= deletion convention.
// This is a test double, not Foundry's implementation.
export function mergePatch(target,patch) {
  for(const [key,value] of Object.entries(patch)) {
    if(key.startsWith('-=')) {delete target[key.slice(2)];continue;}
    if(value&&typeof value==='object'&&!Array.isArray(value)) {
      if(!target[key]||typeof target[key]!=='object'||Array.isArray(target[key]))target[key]={};
      mergePatch(target[key],value);
    }else target[key]=structuredClone(value);
  }
  return target;
}
export function applyDocumentUpdate(document,data) {
  for(const [key,value] of Object.entries(data)) {
    const parts=key.split('.'),last=parts.pop();let target=document;
    for(const part of parts)target=target[part]??={};
    mergePatch(target,{[last]:value});
  }
}
