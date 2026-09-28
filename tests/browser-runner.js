// Isolated headless Chromium harness; no user browser profile or Foundry installation.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'test-output');fs.mkdirSync(out,{recursive:true});
const browser=process.env.MAPGEN_BROWSER||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
if(!fs.existsSync(browser))throw new Error('Set MAPGEN_BROWSER to a Chromium/Edge executable.');
let resolveResult;const complete=new Promise(r=>resolveResult=r);
const server=http.createServer(async(req,res)=>{
  try {
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(req.method==='POST'&&/^\/output\/[a-zA-Z0-9_.-]+$/.test(pathname)) {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);
      fs.writeFileSync(path.join(out,path.basename(pathname)),bytes);res.end('ok');
      if(pathname.endsWith('browser-results.json'))resolveResult(JSON.parse(bytes));return;
    }
    const relative=pathname.startsWith('/output/')?'test-output/'+pathname.slice(8):pathname.replace(/^\/modules\/mapgen\//,'/').slice(1);
    const file=path.resolve(root,relative||'tests/browser.html');
    if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
    const type={'.html':'text/html','.js':'text/javascript','.json':'application/json','.png':'image/png','.css':'text/css','.hbs':'text/plain'}[path.extname(file)]||'application/octet-stream';
    res.setHeader('Content-Type',type);res.end(fs.readFileSync(file));
  }catch(e){res.writeHead(404);res.end(String(e));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/tests/browser.html`;
if(process.argv.includes('--serve')) {
  console.log(`Isolated browser verification: ${url}`);
  await new Promise(()=>{});
}
const profile=fs.mkdtempSync(path.join(out,'edge-profile-'));
// Keep Chromium alive until the result POST; virtual-time screenshot mode can exit during native image decoding.
const child=spawn(browser,['--headless=new','--disable-gpu','--disable-extensions','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--window-size=1280,1800','--hide-scrollbars','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',url],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let stderr='';child.stderr.on('data',d=>stderr+=d);child.on('error',e=>resolveResult({error:e.message}));
const timer=setTimeout(()=>resolveResult({error:'Browser harness timed out. '+stderr.slice(-2000)}),120000);
const result=await complete;clearTimeout(timer);
if(child.exitCode===null) {
  child.kill();
  await new Promise(r=>child.once('exit',r));
}
server.close();
// Only remove the fresh profile allocated by this invocation, after its browser exits.
try {fs.rmSync(profile,{recursive:true,force:true,maxRetries:8,retryDelay:250});}
catch(error) {console.warn(`Could not remove owned browser profile ${profile}: ${error.message}`);}
console.log(JSON.stringify(result,null,2));process.exitCode=result.error?1:0;
