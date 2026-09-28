import {applyDocumentUpdate} from './mock-update.js';
import {BATTLEMAP_PROMPT, METADATA_PROMPT, battlemapPrompt} from '../scripts/generation-contract.js';
import {importBattlemap} from '../scripts/scene-import.js';
import {drawLightingPreview} from '../scripts/preview.js';
import {scaleLights} from '../scripts/lighting.js';

const results=[];
function assert(condition,message) {
  if(!condition)throw new Error(message);
  results.push(message);
}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const overlayCoordinates=app=>Array.from(app.element.querySelectorAll('[data-overlay] line[data-kind]'),
  line=>['x1','y1','x2','y2'].map(key=>Number(line.getAttribute(key)))).sort();
const output=async(name,body)=>{
  const response=await fetch(`/output/${name}`,{method:'POST',body});
  if(!response.ok)throw new Error(`Cannot save browser evidence: ${name}`);
};
const template=Handlebars.compile(await (await fetch('/templates/mapgen.hbs')).text());
const hooks=new Map(),notifications=[],uploads=[],scenes=new Map(),registeredSettings=[];
let confirmed=true;
const collection={
  get:id=>scenes.get(id),
  [Symbol.iterator]:()=>scenes.values(),
  viewed:null
};

class MockApplication {
  constructor() {
    this.element=document.querySelector('#wizard');
    this.renderHistory=[];
    const run=this.run.bind(this);
    this.run=(...args)=>{this.lastRun=run(...args);return this.lastRun;};
  }
  async render() {
    const context=await this._prepareContext();
    this.element.innerHTML=template(context);
    this.renderHistory.push({image:context.hasImage,project:context.hasProject,status:context.status,warnings:context.warningCount});
    for(const button of this.element.querySelectorAll('[data-action]'))button.addEventListener('click',event=>{
      const action=this.constructor.DEFAULT_OPTIONS.actions[button.dataset.action];
      this.actionDone=action.call(this,event,button);
    });
    this._onRender(context,{});
    return this;
  }
  _onRender() {}
  async close() {this.element.replaceChildren();return this;}
}

function makeDocument(data) {
  const doc={
    ...structuredClone(data),id:data._id,walls:[],lights:[],tokens:[],tiles:[],
    firstLevel:{background:{src:null},environment:structuredClone(data.environment??{}),textures:{},async update(patch){applyDocumentUpdate(this,patch);}},
    getFlag(scope,key) {
      if(scope!=='mapgen')throw new Error('Flag scope is not valid or not currently active.');
      return this.flags?.[scope]?.[key];
    },
    async setFlag(scope,key,value) {
      if(scope!=='mapgen')throw new Error('Flag scope is not valid or not currently active.');
      this.flags??={};
      this.flags[scope]??={};
      this.flags[scope][key]=structuredClone(value);
      return this;
    },
    async update(patch){applyDocumentUpdate(this,patch);return this;},
    async createEmbeddedDocuments(type,records) {
      const target=type==='Wall'?this.walls:this.lights;
      const docs=records.map(record=>{
        const item={...structuredClone(record),id:record._id};
        item.toObject=()=>{const {toObject,...value}=item;return structuredClone(value);};
        target.push(item);
        return item;
      });
      return docs;
    },
    async updateEmbeddedDocuments(type,updates) {
      if(type!=='AmbientLight')throw new Error('Unexpected embedded update type');
      return updates.map(update=>{
        const light=this.lights.find(item=>item.id===update._id);
        if(!light)throw new Error('Light no longer exists');
        applyDocumentUpdate(light,update);
        return light;
      });
    },
    async delete(){scenes.delete(this.id);},
    async view(){collection.viewed=this;return this;}
  };
  doc.levels={size:1};
  scenes.set(doc.id,doc);
  return doc;
}

globalThis.Hooks={
  once:(name,handler)=>hooks.set(name,handler),
  on:(name,handler)=>hooks.set(name,handler)
};
globalThis.foundry={applications:{
  api:{ApplicationV2:MockApplication,HandlebarsApplicationMixin:base=>base,DialogV2:{confirm:async()=>confirmed}},
  apps:{FilePicker:{
    createDirectory:async()=>({}),browse:async()=>({}),
    upload:async(_source,_directory,file)=>{
      uploads.push(file);
      await output(file.name,file);
      return {path:`/output/${file.name}`};
    }
  }}
}};
globalThis.ui={notifications:{
  error:message=>notifications.push({type:'error',message}),
  warn:message=>notifications.push({type:'warn',message}),
  info:message=>notifications.push({type:'info',message})
}};
globalThis.game={
  user:{isGM:true},world:{id:'isolated-browser-test'},scenes:collection,
  settings:{register:(_scope,key)=>registeredSettings.push(key),get:()=>true},modules:new Map([['mapgen',{}]])
};
globalThis.CONST={
  GRID_TYPES:{SQUARE:1},
  EDGE_SENSE_TYPES:{NONE:0,LIMITED:10,NORMAL:20,PROXIMITY:30,DISTANCE:40},
  WALL_MOVEMENT_TYPES:{NONE:0,NORMAL:20},
  WALL_DOOR_TYPES:{NONE:0,DOOR:1,SECRET:2},
  WALL_DOOR_STATES:{CLOSED:0,OPEN:1,LOCKED:2}
};
globalThis.CONFIG={};
globalThis.Scene={implementation:{create:async data=>makeDocument(data)}};

const canvas=document.createElement('canvas');
canvas.width=1120;canvas.height=770;
const ctx=canvas.getContext('2d');
ctx.fillStyle='#1e2932';ctx.fillRect(0,0,1120,770);
ctx.fillStyle='#665047';ctx.fillRect(90,90,940,590);
ctx.fillStyle='#382f35';ctx.fillRect(110,110,900,550);
ctx.fillStyle='#98775a';
for(let x=140;x<980;x+=105)ctx.fillRect(x,170,60,340);
ctx.fillStyle='#635154';ctx.fillRect(110,560,900,100);
ctx.fillStyle='#e2caa3';ctx.font='22px system-ui';ctx.fillText('SYNTHETIC IMPORT FIXTURE',145,620);
const png=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
const metadata={
  version:1,image:{width:1120,height:770},grid:{size:70,distance:5,units:'ft'},
  walls:[{x1:100,y1:100,x2:1000,y2:100},{x1:1000,y1:100,x2:1000,y2:670},
    {x1:1000,y1:670,x2:100,y2:670},{x1:100,y1:670,x2:100,y2:100}],
  doors:[{x1:450,y1:670,x2:520,y2:670}],
  windows:[{x1:1000,y1:250,x2:1000,y2:320}],
  lights:[{x:250,y:300,dim:15,bright:5,color:'#ffb45b',alpha:.5,luminosity:.6,animation:{type:'torch',speed:1.6,intensity:1.5,reverse:false}}]
};
metadata.format='mapgen';
metadata.name='Example interior - synthetic regression';
const imageFile=new File([png],'example-interior.png',{type:'image/png'});
const jsonFile=(scene=metadata)=>new File([typeof scene==='string'?scene:JSON.stringify(scene)],'scene.json',{type:'application/json'});
async function choose(app,name,files) {
  const input=app.element.querySelector(`[name="${name}"]`),transfer=new DataTransfer();
  for(const file of files)transfer.items.add(file);
  input.files=transfer.files;
  input.dispatchEvent(new Event('change',{bubbles:true}));
  await app.lastRun;
}
async function drop(app,files,zone='image') {
  const transfer=new DataTransfer();
  for(const file of files)transfer.items.add(file);
  app.element.querySelector(`[data-drop="${zone}"]`).dispatchEvent(new DragEvent('drop',{
    bubbles:true,cancelable:true,dataTransfer:transfer
  }));
  await app.lastRun;
}

let app;
try {
  const {MapGenApp,launch}=await import('../scripts/mapgen.js');
  hooks.get('init')();
  hooks.get('ready')();
  assert(same(registeredSettings,['enabled']),'Obsolete catalogue, palette and draft settings are not registered');
  assert(typeof game.modules.get('mapgen').api.importBattlemap==='function','Module API exposes direct image import');
  assert(!('importBattlemapPackage' in game.modules.get('mapgen').api),'Retired archive API is absent');
  const footer=document.createElement('footer');
  hooks.get('renderSceneDirectory')({},footer);
  hooks.get('renderSceneDirectory')({},footer);
  assert(footer.querySelectorAll('button').length===1,'Scenes directory gets exactly one launcher');
  assert(footer.querySelector('button').textContent==='MapGen','Scenes directory launcher uses the new product name');
  game.user.isGM=false;
  assert(await launch()===undefined,'Players cannot launch the importer');
  game.user.isGM=true;
  notifications.length=0;
  app=new MapGenApp();
  await app.render();
  assert(app.element.querySelector('h1').textContent==='MapGen'&&app.element.textContent.includes('AI-assisted battlemaps for Foundry VTT.'),'Product name and tagline are present in the working application');
  assert(app.element.querySelector('[name=imageFile]').accept.includes('.png'),'Primary input accepts the battlemap PNG');
  assert(!!app.element.querySelector('[name=metadataFile]'),'Secondary input accepts optional scene JSON');
  assert(!app.element.querySelector('[data-action=createScene]'),'Create is absent until a usable image exists');
  assert(!app.element.querySelector('[name=artworkReviewed]'),'No visual approval checkbox exists');
  assert(app.element.querySelector('[name=battlemapPrompt]').value===BATTLEMAP_PROMPT,'Turn 1 uses its centralized art-only prompt');
  assert(app.element.querySelector('[name=metadataPrompt]').value===METADATA_PROMPT,'Turn 2 uses its centralized exact-image metadata prompt');
  assert(app.element.textContent.includes('same ChatGPT conversation after the battlemap image has finished generating'),'Same-conversation guidance is visible');
  assert(app.element.textContent.includes('higher reasoning mode may improve')&&app.element.textContent.includes('not required'),'Reasoning-mode guidance is optional and nonblocking');
  const brief=app.element.querySelector('[name=brief]');
  brief.value='A flooded magical cave, not a tavern';
  brief.dispatchEvent(new Event('input',{bubbles:true}));
  assert(app.element.querySelector('[name=battlemapPrompt]').value===battlemapPrompt(brief.value),'Brief is appended only to Turn 1');
  assert(app.element.querySelector('[name=metadataPrompt]').value===METADATA_PROMPT,'Location brief does not turn metadata follow-up into an art-generation instruction');
  const contract=app.element.querySelector('.sa-contract');
  contract.open=true;
  contract.dispatchEvent(new Event('toggle'));
  await app.render();
  assert(app.element.querySelector('.sa-contract').open,'Prompt controls remain expanded after rendering');
  const clipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard'),copied=[];
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>copied.push(text)}});
  app.element.querySelector('[data-action=copyBattlemapPrompt]').click();
  await app.actionDone;
  app.element.querySelector('[data-action=copyMetadataPrompt]').click();
  await app.actionDone;
  assert(same(copied,[battlemapPrompt(app.brief),METADATA_PROMPT]),'Separate copy buttons send only their own canonical prompt');
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Clipboard denied for test');}}});
  await app.run('copyMetadataPrompt');
  assert(!app.error&&app.element.querySelector('[name=metadataPrompt]').closest('details').open,'Clipboard failure reveals the copyable follow-up instead of blocking the workflow');
  assert(document.activeElement===app.element.querySelector('[name=metadataPrompt]'),'Clipboard fallback focuses and selects the correct prompt');
  if(clipboard)Object.defineProperty(navigator,'clipboard',clipboard);else delete navigator.clipboard;

  await choose(app,'imageFile',[imageFile]);
  assert(!app.error&&!!app.project,'Image-only import is a successful normal workflow');
  assert(app.project.warnings.length===0&&!app.element.querySelector('.sa-warnings'),'Missing optional JSON does not generate warnings');
  assert(app.project.scene.walls.length===0&&app.project.scene.lights.length===0,'Image-only import has no invented geometry or lights');
  assert(app.project.scene.globalLight===true&&!app.element.querySelector('[data-action=createScene]').disabled,'Image-only is immediately playable and creatable');
  assert(app.element.querySelector('[data-lighting-preview]').getContext('2d').getImageData(0,0,1,1).data[3]===0,'Image-only lighting preview leaves the original artwork unshaded');
  assert(!app.element.querySelector('.sa-contract').open,'Prompt instructions collapse once artwork is ready');
  await app.run('createScene');
  assert(!app.error&&collection.viewed.walls.length===0&&collection.viewed.lights.length===0,'Image alone creates and opens an actual mock-host native scene');
  const imageOnlyScene=collection.viewed.id;
  await app.run('newProject');
  await choose(app,'metadataFile',[jsonFile()]);
  assert(!app.error&&!app.project&&app.pendingMetadata.raw,'JSON selected before an image waits without creating an invalid scene');
  assert(!app.element.querySelector('[role=alert]'),'Metadata-first selection is not an error');
  await choose(app,'imageFile',[imageFile]);
  assert(!app.error&&app.project.scene.walls.length===4,'Pending metadata is applied when its image arrives');
  await app.run('newProject');

  const partial=structuredClone(metadata);
  partial.image.width=1100;
  partial.walls.push({x1:-3,y1:600,x2:80,y2:600},{x1:40,y1:40,x2:40,y2:40},{x1:'bad',y1:1,x2:2,y2:3});
  await output('battlemap-regression.png',png);
  await output('battlemap-regression.json',JSON.stringify(partial,null,2));
  await choose(app,'imageFile',[jsonFile(partial),imageFile]);
  assert(!app.error,`Upload succeeds: ${app.error}`);
  assert(app.renderHistory.some(item=>item.image&&!item.project&&item.status.includes('No metadata is required')),'Artwork is rendered before optional metadata normalization completes');
  assert(app.project.scene.image.width===1120,'Actual PNG dimensions override incorrect metadata');
  assert(app.project.scene.walls.length===5,'Valid walls survive zero-length and malformed neighbors');
  assert(app.project.warnings.length>=3,'Minor normalization is explained by warnings');
  assert(!app.element.querySelector('[role=alert]'),'Minor geometry warnings never become a blocking alert');
  assert(!app.element.querySelector('.sa-warnings').open,'Warnings are collapsed, secondary information');
  assert(!app.element.querySelector('[data-action=createScene]').disabled,'Warnings do not disable scene creation');
  assert(notifications.every(item=>item.type!=='error'),'Minor metadata imperfections do not trigger error notifications');
  assert(app.element.querySelectorAll('[data-overlay] line[data-kind]').length===9,'Overlay includes native wall splits and leaves doors/windows unobstructed');
  assert(same(app.project.scene.walls[0],{x1:96,y1:96,x2:998,y2:96}),'Preview structural data uses the 8.75px lattice followed by native integer precision');
  assert(same(app.project.rawStructure.walls[0],partial.walls[0]),'Raw image-space structure remains available in memory');
  assert(app.project.scene.grid.size===70&&app.project.scene.grid.distance===5,'Snapping never changes the 70px/5ft gameplay grid');
  assert(app.project.scene.lights[0].x===250&&app.project.scene.lights[0].y===300&&app.project.scene.lights[0].dim===7.5,'Conservative import halves light radii without snapping or moving emitters');
  assert(app.project.lighting.baseLights[0].dim===15,'Original imported radii remain available for noncumulative tuning');
  const lightCanvas=app.element.querySelector('[data-lighting-preview]');
  assert(lightCanvas.dataset.darkness==='0'&&lightCanvas.dataset.globalLight==='true'&&lightCanvas.dataset.lightCount==='1','Lighting preview keeps the finished artwork readable when environment metadata is absent');
  assert(app.element.querySelector('[data-lighting-state]').textContent.includes('1 animated sources (shown statically here)'),'Preview discloses expressive native animations without pretending to simulate them');
  const structureBeforeLighting=overlayCoordinates(app),artBeforeLighting=app.previewUrl;
  const radiusInput=app.element.querySelector('[name=lightRadiusScale]');
  assert(radiusInput.value==='0.5','New metadata defaults to conservative 50% radii');
  radiusInput.value='0.25';
  radiusInput.dispatchEvent(new Event('change',{bubbles:true}));
  assert(app.previewScene().lights[0].dim===3.75&&Number(app.element.querySelector('[data-overlay] circle').getAttribute('r'))===52.5,'Radius control immediately updates the effective light data and overlay');
  assert(same(overlayCoordinates(app),structureBeforeLighting)&&app.previewUrl===artBeforeLighting,'Light tuning does not change structural geometry or artwork');
  const darkInput=app.element.querySelector('[name=darkness]');
  darkInput.value='0.8';darkInput.dispatchEvent(new Event('input',{bubbles:true}));
  const globalInput=app.element.querySelector('[name=globalLight]');
  globalInput.checked=true;globalInput.dispatchEvent(new Event('change',{bubbles:true}));
  assert(lightCanvas.dataset.darkness==='0.8'&&lightCanvas.dataset.globalLight==='true','Darkness and global illumination edits repaint lighting before saving');
  darkInput.value='0';darkInput.dispatchEvent(new Event('input',{bubbles:true}));
  globalInput.checked=true;globalInput.dispatchEvent(new Event('change',{bubbles:true}));
  radiusInput.value='0.5';radiusInput.dispatchEvent(new Event('change',{bubbles:true}));
  app.element.querySelector('[name=showLighting]').click();
  assert(lightCanvas.getContext('2d').getImageData(0,0,1,1).data[3]===0,'Lighting preview can be hidden without changing saved settings or image pixels');
  app.element.querySelector('[name=showLighting]').click();
  const originalNormalized=structuredClone(app.project.scene.walls);
  const fixedLayout=JSON.stringify({
    walls:app.project.scene.walls,doors:app.project.scene.doors,windows:app.project.scene.windows,lights:app.project.scene.lights
  }),imageBeforeCalibration=app.previewUrl;
  const pixelInput=app.element.querySelector('[name=gridSize]');
  assert(pixelInput.min==='20','Grid calibration permits the native minimum and 40/45px maps');
  pixelInput.value='45';
  pixelInput.dispatchEvent(new Event('input',{bubbles:true}));
  assert(app.element.querySelector('[name=showGrid]').checked,'Editing scale shows the gameplay grid without an extra workflow');
  assert(Number(app.element.querySelector('[data-overlay] line:not([data-kind])').getAttribute('x1'))===45,'Preview grid spacing updates immediately to 45px');
  assert(app.element.querySelector('[data-grid-scale]').textContent.includes('5 ft')&&app.element.querySelector('[data-grid-scale]').textContent.includes('45px'),'Preview explains one-square token size without changing five-foot semantics');
  assert(app.project.scene.grid.size===70,'Typing a draft calibration does not write native or committed settings');
  assert(JSON.stringify({walls:app.project.scene.walls,doors:app.project.scene.doors,windows:app.project.scene.windows,lights:app.project.scene.lights})===fixedLayout,'Immediate grid preview never moves geometry or light positions');
  assert(app.previewUrl===imageBeforeCalibration&&app.project.scene.image.width===1120,'Immediate scale preview preserves artwork and dimensions');
  await app.run('applySettings');
  assert(app.project.scene.grid.size===45&&app.project.scene.grid.distance===5,'Applied per-map calibration keeps one square equal to five feet');
  assert(same(app.project.scene.walls,originalNormalized),'Changing unsaved gameplay calibration leaves already normalized structure fixed');
  const invalidPixelInput=app.element.querySelector('[name=gridSize]');
  invalidPixelInput.value='2';
  invalidPixelInput.dispatchEvent(new Event('input',{bubbles:true}));
  assert(app.gridPreview.size===45&&app.element.querySelector('[data-grid-note]').textContent.includes('using 45'),'Questionable manual input keeps the last useful scale and reports a calm note');
  await app.run('applySettings');
  assert(!app.error&&app.project.scene.grid.size===45,'Invalid calibration never rejects the otherwise usable battlemap');
  app.element.querySelector('[name=gridSize]').value='70';
  await app.run('applySettings');
  assert(same(app.project.scene.walls,originalNormalized),'Repeated calibration edits never alter imported layout');
  app.element.querySelector('[name=showGrid]').click();
  const preview=app.element.querySelector('.sa-preview img');
  await preview.decode();
  assert(preview.naturalWidth===1120&&preview.naturalHeight===770,'Preview decodes the exact full battlemap');
  assert(preview.getBoundingClientRect().width>700,'Artwork is the dominant full-width preview');
  app.element.querySelector('[name=overlay]').click();
  assert(app.element.querySelector('[data-overlay]').children.length===0,'Geometry overlay can be hidden completely');
  app.element.querySelector('[name=showGrid]').click();
  assert(app.element.querySelector('[data-overlay]').children.length>0,'Gameplay grid preview works without baked image grid');
  app.element.querySelector('[name=overlay]').click();

  confirmed=false;
  await app.run('newProject');
  assert(!!app.project,'Declining replacement preserves an unsaved import');
  confirmed=true;
  app.element.querySelector('[name=gridSize]').value='80';
  app.element.querySelector('[data-action=createScene]').click();
  await app.actionDone;
  assert(!app.error,`Create and open succeeds: ${app.error}`);
  assert(scenes.size===2&&app.sceneId===collection.viewed?.id,'One action creates and views a new native scene');
  assert(uploads.length===2,'Each new image is uploaded once; JSON is never uploaded as a second project file');
  assert(same([...new Uint8Array(await uploads.at(-1).arrayBuffer())],[...new Uint8Array(await png.arrayBuffer())]),'Uploaded PNG is byte-for-byte identical to imported artwork');
  const saved=collection.viewed;
  assert(saved.width===1120&&saved.height===770&&saved.padding===0,'Scene frame matches actual image with zero padding');
  assert(saved.grid.size===80&&saved.grid.type===1,'Foundry square grid uses the selected size independently');
  assert(saved.walls.find(w=>w.flags['mapgen'].kind==='wall').c[0]===96,'Creation preserves the prepared geometry after an unapplied calibration edit');
  assert(saved.environment.darknessLevel===0&&saved.environment.globalLight.enabled===true,'Readable environment fallback uses native v14 scene fields without disabling local effects');
  assert(saved.firstLevel.background.src===app.project.src,'Foundry v14 first Level receives the image');
  assert(saved.shiftX===0&&saved.shiftY===0,'New scene origin is explicitly unshifted, independent of any viewed scene');
  assert(same(overlayCoordinates(app),saved.walls.map(w=>w.c).sort()),'Preview endpoints and opening spans exactly match created native Wall documents');
  assert(saved.walls.some(wall=>wall.door===1),'Native interactive door is created');
  assert(saved.walls.some(wall=>wall.move===20&&wall.sight===0),'Native window blocks movement but permits sight');
  assert(saved.lights.length===1&&saved.lights[0].x===250,'Native light remains at image-pixel position');
  assert(saved.lights[0].config.dim===7.5&&saved.lights[0].config.bright===2.5,'Native light radii match the conservative preview');
  assert(saved.lights[0].config.luminosity===.6&&saved.lights[0].config.animation.type==='torch','Contextual native intensity and animation are created alongside color');
  assert(saved.lights[0].config.animation.speed===2&&saved.lights[0].config.animation.intensity===2,'Fractional animation suggestions normalize to supported native integer parameters');
  assert(saved.getFlag('mapgen','scene')?.version===1,'Created scene has a durable scene marker');
  assert(saved.getFlag('mapgen','package')===undefined,'New direct-file scenes do not write the old marker');
  const geometryBeforeTone=saved.walls.map(w=>w.toObject());
  app.element.querySelector('[name=lightRadiusScale]').value='0.25';
  await app.run('applySettings');
  assert(!app.error&&saved.lights[0].config.dim===3.75,'Post-import tuning updates native imported light radii');
  assert(saved.lights[0].config.luminosity===.6&&saved.lights[0].config.animation.intensity===2&&saved.lights[0].config.color==='#ffb45b','Toning down radius retains intensity, animation character and color');
  assert(same(saved.walls.map(w=>w.toObject()),geometryBeforeTone),'Native lighting tuning leaves walls and doors unchanged');
  await app.run('openProject',saved.id);
  assert(app.element.querySelector('[name=lightRadiusScale]').value==='0.25'&&app.previewScene().lights[0].dim===3.75,'Save/reopen preserves the selected multiplier and actual light appearance');
  app.element.querySelector('[name=lightRadiusScale]').value='0.75';
  await app.run('applySettings');
  assert(!app.error&&saved.lights[0].config.dim===11.25,'Repeated tuning derives from the baseline rather than compounding');
  await saved.createEmbeddedDocuments('AmbientLight',[{
    _id:'native-added-light',x:50,y:50,walls:true,hidden:false,config:{dim:18,bright:6,color:'#ffffff',alpha:.25}
  }]);
  await app.run('openProject',saved.id);
  app.element.querySelector('[name=lightRadiusScale]').value='0.5';
  await app.run('applySettings');
  assert(!app.error&&saved.lights[0].config.dim===7.5&&saved.lights[1].config.dim===18,'Later GM-added light sources are preserved when imported lighting is tuned');

  const door=saved.walls.find(wall=>wall.door===1);
  door.ds=1;
  saved.walls[0].c[0]=123;
  saved.lights[0].x=270;
  saved.tokens.push({name:'Example token'});
  const wallsBefore=saved.walls.map(w=>w.toObject()),lightsBefore=saved.lights.map(l=>l.toObject());
  await app.run('openProject',saved.id);
  assert(!app.error,`Reopen succeeds: ${app.error}`);
  assert(app.project.scene.doors.some(item=>item.state==='open'),'Reopening reads current native door state');
  assert(app.project.scene.lights[0].x===270,'Reopening reads native light edits');
  assert(same(overlayCoordinates(app),saved.walls.map(w=>w.c).sort()),'Reopening displays actual native edits without re-snapping them');
  assert(app.element.querySelector(`[name=projectId] option[value="${saved.id}"]`),'MapGen scenes remain available in the saved scene selector');
  const nativeGridInput=app.element.querySelector('[name=gridSize]');
  nativeGridInput.value='40';
  nativeGridInput.dispatchEvent(new Event('input',{bubbles:true}));
  assert(saved.grid.size===80&&same(saved.walls.map(w=>w.toObject()),wallsBefore),'Previewing calibration on a saved scene does not mutate the native document');
  await app.run('applySettings');
  assert(saved.grid.size===40&&saved.grid.distance===5,'Saved per-map calibration supports 40px squares without changing five-foot distance');
  assert(same(saved.walls.map(w=>w.toObject()),wallsBefore)&&same(saved.lights.map(l=>l.toObject()),lightsBefore),'Saving a new pixel scale preserves existing native structure and lights');
  app.element.querySelector('[name=sceneName]').value='Edited battlemap';
  app.element.querySelector('[name=distance]').value='10';
  app.element.querySelector('[name=darkness]').value='0.5';
  app.element.querySelector('[name=globalLight]').checked=false;
  await app.run('applySettings');
  assert(saved.name==='Edited battlemap'&&saved.grid.distance===10,'Name and grid settings persist');
  assert(saved.environment.darknessLevel===.5&&saved.environment.globalLight.enabled===false,'Lighting settings persist on the Scene, not the Level');
  assert(same(saved.walls.map(w=>w.toObject()),wallsBefore),'Settings save preserves all native wall edits');
  assert(same(saved.lights.map(l=>l.toObject()),lightsBefore)&&saved.tokens.length===1,'Settings save preserves native lights and tokens');
  assert(!!saved.flags.mapgen.scene&&saved.flags.mapgen.scene.version===1,'Reopening and settings saves preserve the MapGen scene marker');
  const preserved=saved.id;
  await choose(app,'metadataFile',[jsonFile(metadata)]);
  assert(!app.error&&!app.sceneId&&app.project.src===saved.firstLevel.background.src,'Late JSON on a saved scene prepares a separate scene using its existing image');
  assert(same(saved.walls.map(w=>w.toObject()),wallsBefore),'Attaching new metadata never overwrites saved native geometry');
  await app.run('createScene');
  assert(!app.error&&app.sceneId!==preserved&&uploads.length===2,'A new scene copy reuses the durable image without a duplicate upload');
  assert(!!app.sceneDocument.getFlag('mapgen','scene'),'New scenes use the MapGen namespace');
  await app.run('newProject');
  assert(scenes.has(preserved)&&scenes.has(imageOnlyScene)&&!app.project,'New import never deletes an existing scene');

  await drop(app,[imageFile]);
  assert(!app.error&&app.project.scene.walls.length===0,'Drop imports an image-only battlemap without a correction loop');
  assert(app.project.scene.globalLight===true,'Image-only imports default to playable global illumination');
  assert(!app.element.querySelector('[data-action=createScene]').disabled,'Missing metadata is still a usable scene');
  assert(app.project.warnings.length===0,'An image-only drop does not inherit previous JSON or warnings');
  await drop(app,[jsonFile(partial)],'metadata');
  assert(!app.error&&app.project.scene.walls.length===5,'JSON dropped after the image adds all usable geometry');
  const goodGeometry=structuredClone(app.project.scene);
  await choose(app,'metadataFile',[jsonFile('{malformed')]);
  assert(!app.error&&same(app.project.scene,goodGeometry),'Malformed replacement JSON preserves the image and existing usable geometry');
  assert(app.project.warnings.length>0&&!app.element.querySelector('[role=alert]'),'Unreadable optional JSON produces a secondary warning only');
  await choose(app,'metadataFile',[jsonFile({...metadata,version:99})]);
  assert(!app.error&&same(app.project.scene,goodGeometry),'Unsupported replacement metadata does not erase the existing scene preview');
  await choose(app,'imageFile',[new File([png],'another-scene.png',{type:'image/png'})]);
  assert(app.project.scene.walls.length===0&&!app.metadataName,'Replacing the image clears all metadata from its predecessor');
  await choose(app,'imageFile',[imageFile,jsonFile('{broken')]);
  assert(!app.error&&app.project.scene.walls.length===0&&!app.element.querySelector('[data-action=createScene]').disabled,'A valid image plus malformed JSON remains a successful creatable import');
  await app.run('newProject');
  await choose(app,'metadataFile',[jsonFile('{broken')]);
  await choose(app,'imageFile',[imageFile]);
  assert(!app.error&&app.project.scene.walls.length===0,'Bad JSON loaded before the image still permits normal image-only import');
  await choose(app,'metadataFile',[jsonFile()]);
  await app.run('clearMetadata');
  assert(!app.metadataName&&app.project.scene.walls.length===0&&app.project.warnings.length===0,'Use image only clears optional geometry without changing artwork');
  for(const [name,size]of [['Small interior',120],['Medium building',70],['Large complex',45]]) {
    await choose(app,'metadataFile',[jsonFile({...metadata,name,grid:{size,distance:5,units:'ft'}})]);
    assert(app.project.scene.grid.size===size&&app.project.scene.grid.distance===5,`${name}: metadata-provided ${size}px calibration is respected`);
    const expected=Math.round(Math.round(100/(size/8))*(size/8));
    assert(app.project.scene.walls[0].x1===expected,`${name}: newly imported structure uses that map's fixed eighth-cell spacing`);
  }
  const oldPreview=app.previewUrl;
  await app.run('importFiles',[new File(['broken'],'broken.png',{type:'image/png'})]);
  assert(!!app.error,'Unreadable image reports an explicit hard error');
  assert(app.previewUrl===oldPreview&&!!app.project,'Failed replacement retains the previous usable import');
  await app.run('importFiles',[new File(['unsupported'],'old.zip',{type:'application/zip'})]);
  assert(!!app.error&&app.previewUrl===oldPreview,'Archive import is absent, not a hidden second mode');
  await drop(app,[jsonFile({...metadata,name:'<img src=x onerror=alert(1)>'}),imageFile,new File(['note'],'notes.txt')]);
  assert(!app.error&&!app.element.querySelector('.sa-shell img:not(.sa-preview img)'),'Metadata strings are escaped by the template');
  assert(app.project.warnings.some(w=>w.includes('Ignored files')),'Unrelated extras do not discard a usable image and JSON');
  const imageOnly=await importBattlemap(imageFile);
  assert(imageOnly.scene.walls.length===0&&imageOnly.warnings.length===0,'Real decoder succeeds without any metadata requirement');
  const animatedScene={...metadata,name:"Example dwelling animation regression",lights:[
    {...metadata.lights[0],animation:{type:'flicker',speed:.2,intensity:1.5}},
    {...metadata.lights[0],x:650,y:350,color:'#a855f7',animation:{type:'pulsing',speed:1.6,intensity:2}},
    {...metadata.lights[0],x:850,y:450,animation:null}
  ]};
  await drop(app,[imageFile,jsonFile(animatedScene)]);
  assert(!app.error&&app.project.scene.globalLight===true&&app.project.scene.darkness===0,'A readable inhabited scene gets expressive lights without inferred darkness');
  assert(same(app.previewScene().lights.map(l=>l.animation?.type),['torch','pulse',undefined]),'Intent synonyms reach the native effect types and static light stays static');
  assert(app.previewScene().lights[0].animation.speed===1,'Small positive flame speed cannot accidentally pause on import');
  await app.run('createScene');
  assert(!app.error&&same(app.sceneDocument.lights.map(l=>l.config.animation?.type),['torch','pulse',undefined]),'Full UI creation serializes effects into native AmbientLight config.animation');
  const animatedDocument=app.sceneDocument;
  app.element.querySelector('[name=lightRadiusScale]').value='0.25';
  await app.run('applySettings');
  await app.run('openProject',animatedDocument.id);
  assert(!app.error&&same(app.project.scene.lights.map(l=>l.animation?.type),['torch','pulse',undefined]),'Animation types survive radius save and project reopen');
  app.element.querySelector('[name=globalLight]').checked=false;
  app.element.querySelector('[name=darkness]').value='0.46';
  await app.run('applySettings');
  await app.run('openProject',animatedDocument.id);
  assert(!app.error&&app.project.scene.globalLight===false&&app.project.scene.darkness===.46,'Explicit saved gameplay darkness is never replaced by the readable fallback');
  const coverage=document.createElement('canvas');
  const sampleScene={image:{width:200,height:200},grid:{size:50,distance:5,units:'ft'},darkness:.5,globalLight:false,
    lights:[{x:100,y:100,dim:8,bright:2,color:'#66ccff',alpha:.25}]};
  drawLightingPreview(coverage,{...sampleScene,lights:scaleLights(sampleScene.lights,1)});
  const broad=[...coverage.getContext('2d').getImageData(160,100,1,1).data];
  drawLightingPreview(coverage,{...sampleScene,lights:scaleLights(sampleScene.lights,.5)});
  const restrained=[...coverage.getContext('2d').getImageData(160,100,1,1).data];
  assert(broad[2]>restrained[2]&&restrained[3]>broad[3],'Real canvas pixels show reduced colored coverage at conservative radii');
  const composite=document.createElement('canvas');
  composite.width=200;composite.height=200;
  const compositeContext=composite.getContext('2d');
  const brightness=luminosity=>{
    drawLightingPreview(coverage,{...sampleScene,lights:sampleScene.lights.map(light=>({...light,luminosity}))});
    compositeContext.fillStyle='#808080';compositeContext.fillRect(0,0,200,200);
    compositeContext.drawImage(coverage,0,0);
    return [...compositeContext.getImageData(100,100,1,1).data].slice(0,3).reduce((sum,value)=>sum+value,0);
  };
  assert(brightness(.8)>brightness(.2),'Approximate preview responds to native luminosity rather than flattening light intensity');
  const closedApp=new MapGenApp();
  await closedApp.render();
  const importing=closedApp.run('importFiles',[imageFile,jsonFile()]);
  await closedApp.close();
  await importing;
  assert(closedApp.closed&&!closedApp.project,'Closing during import does not install a late project');

  app=new MapGenApp();
  await app.render();
  await drop(app,[imageFile,jsonFile(partial)]);
  assert(!app.error,'Final evidence preview retains artwork with tolerant geometry');
  await output('browser-preview.html',app.element.outerHTML);
  document.querySelector('#check-summary').textContent=`${results.length} browser checks passed`;
  document.querySelector('#results').textContent=results.join('\n');
  await output('browser-results.json',JSON.stringify({passed:results.length,results,scope:'Synthetic direct PNG and optional JSON; real browser decoder and UI; mocked Foundry v14 document APIs.'},null,2));
} catch(error) {
  document.querySelector('#check-summary').textContent='Browser checks failed';
  document.querySelector('#results').textContent=`${results.join('\n')}\n${error.stack}`;
  await output('browser-results.json',JSON.stringify({passed:results.length,results,error:error.stack},null,2));
}
