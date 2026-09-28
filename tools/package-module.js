import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {zipSync,unzipSync} from 'fflate';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=relative=>fs.readFileSync(path.join(root,relative));
const manifest=JSON.parse(read('module.json'));
const pkg=JSON.parse(read('package.json'));
const repository='https://github.com/chrisgodfrey/mapgen';
const expectedDownload=`${repository}/releases/download/v${manifest.version}/mapgen.zip`;
if(manifest.id!=='mapgen'||manifest.title!=='MapGen'||manifest.version!==pkg.version
  ||manifest.download!==expectedDownload||manifest.url!==repository)
  throw new Error('Module identity, version or download URL does not match the release.');

function runtimeFiles(directory) {
  return fs.readdirSync(path.join(root,directory),{withFileTypes:true}).flatMap(entry=>{
    if(entry.isSymbolicLink())throw new Error('Release inputs must not contain symbolic links.');
    const relative=path.join(directory,entry.name);
    return entry.isDirectory()?runtimeFiles(relative):[relative];
  });
}

const files=['module.json','README.md',...['scripts','styles','templates','docs'].flatMap(runtimeFiles)].sort();
const payload=Object.fromEntries(files.map(file=>[file.split(path.sep).join('/'),read(file)]));
for(const required of [...manifest.esmodules,...manifest.styles,'templates/mapgen.hbs','docs/scene-format.md'])
  if(!Object.hasOwn(payload,required))throw new Error(`Missing runtime file: ${required}`);

const output=path.join(root,'dist');
fs.mkdirSync(output,{recursive:true});
const archive=path.join(output,'mapgen.zip');
fs.writeFileSync(archive,zipSync(payload,{level:9,mtime:new Date(1980,0,1)}));
const unpacked=unzipSync(fs.readFileSync(archive));
const expected=Object.keys(payload).sort(),actual=Object.keys(unpacked).sort();
if(JSON.stringify(expected)!==JSON.stringify(actual))throw new Error('Release archive file list differs from source.');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const name of expected)
  if(hash(payload[name])!==hash(unpacked[name]))throw new Error(`Release bytes differ from source: ${name}`);
fs.copyFileSync(path.join(root,'module.json'),path.join(output,'module.json'));
console.log(`Verified ${files.length} files for MapGen ${manifest.version}.`);
console.log(`Archive: ${archive}`);
console.log(`Download: ${expectedDownload}`);
