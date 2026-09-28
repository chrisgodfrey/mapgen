import test from 'node:test';
import assert from 'node:assert/strict';
import {buildNativeData,cutWallOpenings,isNativeValidationError,normalizeStructure} from '../scripts/foundry-data.js';
import {MODULE_ID,createImportedScene,isImportedScene,projectFromScene,saveSceneSettings} from '../scripts/project.js';
import {normalizeScene} from '../scripts/scene-import.js';
import {LIGHT_RADIUS_SCALES,scaleLights} from '../scripts/lighting.js';

const segment=(x1,y1,x2,y2)=>({x1,y1,x2,y2});
const light=(x=25.5,y=40.25)=>({x,y,dim:15,bright:5,color:'#ffbb77',alpha:.5});
const sceneData=overrides=>({
  version:1,name:'Original map',image:{width:321,height:237},
  grid:{size:60,distance:5,units:'ft'},
  walls:[segment(0,20,200,20)],
  doors:[{...segment(40,20,80,20),secret:false,state:'closed'}],
  windows:[segment(100,20,130,20)],
  lights:[light()],darkness:0,globalLight:true,...overrides
});
const pngBytes=Uint8Array.from([137,80,78,71,13,10,26,10,0,255,128,42]);
const imported=overrides=>({
  scene:sceneData(overrides),imageBlob:new Blob([pngBytes],{type:'image/png'}),warnings:[]
});
class DataModelValidationError extends Error {
  constructor(message) {super(message);this.name='DataModelValidationError';}
}
const invalid=message=>new DataModelValidationError(message);

function applyUpdate(target,changes) {
  for(const [key,value] of Object.entries(changes)) {
    if(key==='_id')continue;
    const parts=key.split('.');
    let data=target;
    for(const part of parts.slice(0,-1))data=data[part]??={};
    const last=parts.at(-1);
    if(last.startsWith('-='))delete data[last.slice(2)];
    else if(value&&typeof value==='object'&&!Array.isArray(value)) {
      if(!data[last]||typeof data[last]!=='object')data[last]={};
      applyUpdate(data[last],value);
    } else data[last]=value;
  }
}

function installHost(t,options={}) {
  const originals=Object.fromEntries(['CONFIG','CONST','foundry','game','Scene'].map(key=>[key,globalThis[key]]));
  t.after(()=>{
    for(const [key,value] of Object.entries(originals)) {
      if(value===undefined)delete globalThis[key];
      else globalThis[key]=value;
    }
  });
  const events=[],uploads=[],embeddedCalls=[],lightUpdates=[],updates=[],scenes=new Map();
  const unrelated={id:'unrelated',name:'Existing scene',walls:[{c:[1,2,3,4]}],tokens:[{name:'Hero'}]};
  const before=structuredClone(unrelated);
  scenes.set(unrelated.id,unrelated);
  let nextId=0;
  class Wall {
    static schema={fields:{c:{clean:value=>value.map(Math.round)}}};
    constructor(data) {
      this.data=data;
      if(options.constructError)throw options.constructError;
    }
    validate() {return options.validate?.('Wall',this.data)??true;}
  }
  class AmbientLight extends Wall {
    static schema={fields:{x:{clean:Math.round},y:{clean:Math.round}}};
    validate() {return options.validate?.('AmbientLight',this.data)??true;}
  }
  globalThis.CONFIG={Wall:{documentClass:Wall},AmbientLight:{documentClass:AmbientLight}};
  globalThis.CONST={
    GRID_TYPES:{SQUARE:1},
    EDGE_SENSE_TYPES:{NONE:0,NORMAL:20},
    WALL_MOVEMENT_TYPES:{NONE:0,NORMAL:20},
    WALL_DOOR_TYPES:{NONE:0,DOOR:1,SECRET:2},
    WALL_DOOR_STATES:{CLOSED:0,OPEN:1,LOCKED:2}
  };
  globalThis.game={world:{id:'test-world'},scenes};
  const picker={
    async createDirectory(source,path) {
      events.push(['directory',source,path]);
      if(options.directoryError)throw options.directoryError;
    },
    async browse(source,path) {
      events.push(['browse',source,path]);
      if(options.browseError)throw options.browseError;
      return {dirs:[]};
    },
    async upload(source,dir,file,body,configuration) {
      uploads.push({source,dir,file,body,configuration});
      events.push(['upload']);
      if(options.uploadError)throw options.uploadError;
      if('uploadResult' in options)return options.uploadResult;
      return {path:`${dir}/${file.name}`};
    }
  };
  globalThis.foundry={
    applications:{apps:{FilePicker:picker}},
    data:{validation:{DataModelValidationError}},
    utils:{randomID:()=>`record${++nextId}`.padEnd(16,'0')}
  };
  let created;
  const addRecords=(document,type,data)=>{
    const result=data.map(item=>({...structuredClone(item),id:item._id}));
    document[type==='Wall'?'walls':'lights'].push(...result);
    return result;
  };
  globalThis.Scene={implementation:{async create(data,operation) {
    assert.equal(operation.keepId,true);
    events.push(['create',structuredClone(data)]);
    if(options.createError)throw options.createError;
    if(options.createNull)return null;
    const level={
      background:{src:null},textures:{offsetX:0,offsetY:0,rotation:0,scaleX:1,scaleY:1},
      async update(change) {
        events.push(['background',change]);
        if(options.backgroundError)throw options.backgroundError;
        if(options.cancelBackground)return;
        this.background.src=change['background.src'];
      }
    };
    created={
      ...structuredClone(data),id:options.failAfterCreate?data._id:'new-scene',walls:[],lights:[],
      tokens:[{id:'token',hidden:true}],tiles:[{id:'tile'}],notes:[{id:'note'}],
      background:{src:'untracked-background.png'},firstLevel:options.noLevel?null:level,levels:[level],
      getFlag(module,key) {
        if(module!==MODULE_ID)throw new Error('Flag scope is not valid or not currently active.');
        return this.flags[module]?.[key];
      },
      async setFlag(module,key,value) {
        if(module!==MODULE_ID)throw new Error('Flag scope is not valid or not currently active.');
        events.push(['flag',key,structuredClone(value)]);
        if(options.flagError)throw options.flagError;
        if(options.cancelFlag)return;
        this.flags[module]??={};
        this.flags[module][key]=structuredClone(value);
      },
      async createEmbeddedDocuments(type,records,operation) {
        const call={type,data:structuredClone(records),operation};
        embeddedCalls.push(call);
        events.push(['embedded',type,records.length]);
        if(options.embedded)return options.embedded({document:this,type,data:records,operation,add:addRecords,call:embeddedCalls.length});
        return addRecords(this,type,records);
      },
      async updateEmbeddedDocuments(type,records) {
        assert.equal(type,'AmbientLight');
        lightUpdates.push(structuredClone(records));
        const apply=items=>items.map(item=>{
          const light=this.lights.find(light=>(light.id??light._id)===item._id);
          assert.ok(light,`Missing light ${item._id}`);
          applyUpdate(light,item);
          return light;
        });
        if(options.lightUpdate)return options.lightUpdate({document:this,data:records,call:lightUpdates.length,apply});
        return apply(records);
      },
      async update(change) {
        updates.push(structuredClone(change));
        if(options.updateError)throw options.updateError;
        if(options.cancelUpdate)return;
        if(options.sceneUpdate)return options.sceneUpdate({document:this,data:change,call:updates.length,apply:change=>applyUpdate(this,change)});
        applyUpdate(this,change);
        return this;
      },
      async delete() {
        events.push(['delete',this.id]);
        if(options.cleanupError)throw options.cleanupError;
        if(options.cancelDelete)return;
        scenes.delete(this.id);
      }
    };
    if(options.cancelInitialLighting)delete created.flags[MODULE_ID].lighting;
    scenes.set(created.id,created);
    if(options.failAfterCreate)throw options.failAfterCreate;
    return created;
  }}};
  return {events,uploads,embeddedCalls,lightUpdates,updates,scenes,unrelated,before,picker,addRecords,get document(){return created;}};
}

test('native records use installed constants, pixel coordinates, secret doors and every door state',t=>{
  installHost(t);
  globalThis.CONST.EDGE_SENSE_TYPES={NONE:7,NORMAL:27};
  globalThis.CONST.WALL_MOVEMENT_TYPES={NONE:8,NORMAL:28};
  globalThis.CONST.WALL_DOOR_TYPES={NONE:9,DOOR:3,SECRET:4};
  globalThis.CONST.WALL_DOOR_STATES={CLOSED:12,OPEN:13,LOCKED:14};
  const input=sceneData({
    walls:[segment(0,10,100,10)],
    doors:['closed','open','locked'].map((state,i)=>({...segment(i*20+10,10,i*20+20,10),state,secret:i===2})),
    windows:[segment(80,10,90,10)],lights:[light(16,19)]
  });
  const before=structuredClone(input),native=buildNativeData(input);
  assert.deepEqual(input,before);
  assert.deepEqual(native.warnings,[]);
  assert.deepEqual(native.walls.slice(0,3).map(w=>[w.door,w.ds]),[[3,12],[3,13],[4,14]]);
  assert.deepEqual(native.walls[0].c,[10,10,20,10]);
  const window=native.walls.find(w=>w.flags[MODULE_ID].kind==='window');
  assert.deepEqual([window.move,window.light,window.sight,window.sound],[28,7,7,7]);
  assert.equal('threshold' in window,false);
  assert.deepEqual(native.walls.filter(w=>w.door===9&&w.light===27).map(w=>w.c),[
    [0,10,10,10],[20,10,30,10],[40,10,50,10],[60,10,80,10],[90,10,100,10]
  ]);
  assert.deepEqual(native.lights[0].config,{dim:15,bright:5,color:'#ffbb77',alpha:.5});
  assert.equal(native.lights[0].x,16);
  assert.equal(native.lights[0].flags,undefined);
});

test('wall cuts merge overlapping reversed diagonal fractional openings',()=>{
  const wall=segment(.5,1.5,100.5,101.5);
  const cuts=cutWallOpenings(wall,[
    segment(25.5,26.5,35.5,36.5),
    segment(75.5,76.5,65.5,66.5),
    segment(30.5,31.5,70.5,71.5)
  ]);
  assert.deepEqual(cuts,[segment(.5,1.5,25.5,26.5),segment(75.5,76.5,100.5,101.5)]);
  assert.deepEqual(cutWallOpenings(segment(20,80,20,0),[
    segment(20,-10,20,10),segment(20,60,20,100)
  ]),[segment(20,60,20,10)]);
  assert.deepEqual(cutWallOpenings(wall,[segment(-.5,.5,101.5,102.5)]),[]);
  assert.deepEqual(cutWallOpenings(segment(0,0,100,100),[segment(28.5,28.5,58.5,58.5)]),[
    segment(0,0,28.5,28.5),segment(58.5,58.5,100,100)
  ]);
});

test('near-detached or crossing openings never snap or cut a supplied wall',()=>{
  const wall=segment(0,20,100,20);
  assert.deepEqual(cutWallOpenings(wall,[
    segment(20,20.00001,40,20.00001),segment(50,10,50,30),segment(110,20,120,20)
  ]),[wall]);
  const input=sceneData({walls:[wall],doors:[{...segment(20,20.125,40,20.125),state:'open'}],windows:[]});
  const native=buildNativeData(input);
  assert.deepEqual(native.walls.map(w=>w.c),[[20,20.125,40,20.125],[0,20,100,20]]);
});

test('disconnected, intersecting, diagonal and imperfect geometry is usable without topology gates',()=>{
  const native=buildNativeData(sceneData({
    walls:[segment(1,1,120,180),segment(70,11,12,189),segment(250.5,5.5,310.75,70.125)],
    doors:[{...segment(190,30,200,40),secret:true,state:'locked'}],windows:[segment(80,80,90,95)]
  }));
  assert.equal(native.walls.length,5);
  assert.deepEqual(native.warnings,[]);
  assert.deepEqual(native.walls.at(-1).c,[250.5,5.5,310.75,70.125]);
});

test('host coordinate cleaning matches fractional Wall and AmbientLight fields',t=>{
  installHost(t);
  const native=buildNativeData(sceneData({
    walls:[segment(1.2,4.8,90.7,19.2),segment(30.1,40.1,30.2,40.2)],
    doors:[],windows:[],lights:[light()]
  }));
  assert.deepEqual(native.walls[0].c,[1,5,91,19]);
  assert.equal(native.walls.length,1);
  assert.deepEqual([native.lights[0].x,native.lights[0].y],[26,40]);
  assert.match(native.warnings[0],/no length after Foundry coordinate cleaning/);
});

test('invalid records skip individually and rejected openings do not cut a good wall',t=>{
  installHost(t,{validate(type,data) {
    if(type==='Wall'&&data.door)throw invalid('Rejected opening');
    if(type==='AmbientLight'&&data.x===99)return false;
    return true;
  }});
  const native=buildNativeData(sceneData({
    walls:[segment(0,20,200,20),segment(NaN,20,40,20),segment(40,40,40,40)],
    windows:[],lights:[light(),light(99,10),{...light(),dim:Infinity}]
  }));
  assert.deepEqual(native.walls.map(w=>w.c),[[0,20,200,20]]);
  assert.equal(native.lights.length,1);
  assert.equal(native.warnings.length,5);
});

test('missing host schema and unexpected constructor errors are not mislabeled as geometry',t=>{
  const host=installHost(t);
  delete globalThis.CONFIG.Wall.documentClass.schema.fields.c;
  assert.throws(()=>buildNativeData(sceneData()),/coordinate field is unavailable/);
  assert.equal(host.uploads.length,0);
  assert.equal(isNativeValidationError(new TypeError('Document API failure')),false);
  assert.equal(isNativeValidationError(new Error('Permission denied')),false);
  assert.equal(isNativeValidationError(new Error('Wall validation service disconnected')),false);
  assert.equal(isNativeValidationError(new Error('AmbientLight validation errors: config.dim is invalid')),true);
  assert.equal(isNativeValidationError(invalid('Bad data')),true);
});

test('image-only import uploads original PNG bytes once with exact dimensions and playable defaults',async t=>{
  const host=installHost(t);
  const input=imported({walls:[],doors:[],windows:[],lights:undefined,globalLight:undefined,darkness:undefined});
  const result=await createImportedScene(input);
  assert.equal(host.uploads.length,1);
  const upload=host.uploads[0];
  assert.deepEqual(new Uint8Array(await upload.file.arrayBuffer()),pngBytes);
  assert.equal(upload.file.type,'image/png');
  assert.equal(upload.source,'data');
  assert.equal(upload.dir,'worlds/test-world/mapgen');
  assert.match(upload.file.name,/^mapgen-[0-9a-f-]{36}\.png$/);
  assert.deepEqual(upload.configuration,{notify:false});
  assert.deepEqual(host.events.filter(e=>e[0]==='directory').map(e=>e[2]),[
    'worlds','worlds/test-world','worlds/test-world/mapgen'
  ]);
  assert.equal(result.document.width,321);
  assert.equal(result.document.height,237);
  assert.equal(result.document.padding,0);
  assert.equal(result.document.shiftX,0);
  assert.equal(result.document.shiftY,0);
  assert.equal(result.document.tokenVision,true);
  assert.equal(result.document.grid.size,60);
  assert.equal(result.document.grid.alpha,.2);
  assert.equal(result.document.grid.type,1);
  assert.equal(result.document.environment.darknessLevel,0);
  assert.equal(result.document.environment.globalLight.enabled,true);
  assert.equal(host.embeddedCalls.length,0);
  assert.equal(result.document.firstLevel.background.src,result.src);
  assert.equal(result.document.background.src,'untracked-background.png');
  assert.deepEqual(host.unrelated,host.before);
});

test('per-map pixel calibration remains five feet and creates a native square grid at the supplied size',async t=>{
  const host=installHost(t);
  for(const [name,size]of [['Small interior',120],['Medium building',70],['Large complex',45]]) {
    const result=await createImportedScene(imported({name,grid:{size,distance:5,units:'ft'}}));
    assert.deepEqual({size:result.document.grid.size,distance:result.document.grid.distance,units:result.document.grid.units},
      {size,distance:5,units:'ft'});
    assert.equal(result.document.grid.type,1);
    assert.equal(result.document.width,321);
    assert.equal(result.document.height,237);
    assert.deepEqual(new Uint8Array(await host.uploads.at(-1).file.arrayBuffer()),pngBytes);
  }
});

test('editing scale after metadata normalization never re-snaps prepared geometry during creation or save',async t=>{
  installHost(t);
  const prepared=normalizeStructure(sceneData({grid:{size:70,distance:5,units:'ft'}}));
  const expected=buildNativeData(prepared.scene).walls.map(wall=>wall.c);
  const input=imported();
  input.scene={...prepared.scene,grid:{size:45,distance:5,units:'ft'}};
  input.structureNormalized=true;
  const {document}=await createImportedScene(input);
  assert.equal(document.grid.size,45);
  assert.equal(document.grid.distance,5);
  assert.deepEqual(document.walls.map(wall=>wall.c),expected);
  const before=structuredClone({walls:document.walls,lights:document.lights,background:document.firstLevel.background});
  document.tokens.push({name:'Medium creature',width:1,height:1});
  await saveSceneSettings(document,{...sceneData(),grid:{size:40,distance:5,units:'ft'}});
  assert.equal(document.grid.size,40);
  assert.equal(document.grid.distance,5);
  assert.deepEqual(document.walls,before.walls);
  assert.deepEqual(document.lights,before.lights);
  assert.deepEqual(document.firstLevel.background,before.background);
  assert.deepEqual(document.tokens.at(-1),{name:'Medium creature',width:1,height:1});
  const reopened=projectFromScene(document);
  assert.equal(reopened.scene.grid.size,40);
  assert.equal(reopened.scene.grid.distance,5);
});

test('successful native import marks the scene only after geometry warnings are known and reopens actual data',async t=>{
  const host=installHost(t);
  const input=imported({walls:[segment(0,20,200,20),segment(1,1,1,1)]});
  input.warnings=['Optional feature omitted by metadata importer.'];
  const result=await createImportedScene(input);
  const marker=result.document.getFlag(MODULE_ID,'scene');
  assert.equal(marker.version,1);
  assert.deepEqual(marker.image,{width:321,height:237});
  assert.deepEqual(marker.warnings,result.warnings);
  assert.equal(result.warnings.length,2);
  assert.equal(host.events.at(-1)[0],'flag');
  assert.equal(JSON.stringify(marker).includes('blob:'),false);
  assert.equal('walls' in marker,false);
  assert.equal('lights' in marker,false);
  assert.equal('plan' in result.document.flags[MODULE_ID],false);
  const reopened=projectFromScene(result.document);
  assert.equal(reopened.sceneId,result.document.id);
  assert.equal(reopened.src,result.src);
  assert.equal(reopened.scene.walls.length,3);
  assert.deepEqual(reopened.scene.doors,[{...segment(38,23,83,23),secret:false,state:'closed'}]);
  assert.deepEqual(reopened.scene.windows,[segment(98,23,128,23)]);
  assert.deepEqual(reopened.scene.lights,[{...light(26,40),dim:7.5,bright:2.5}]);
  assert.deepEqual(reopened.warnings,result.warnings);
});

test('scene discovery never calls scoped flag APIs on unrelated or inactive-module documents',()=>{
  const cannotRead=()=>{throw new Error('Flag scope is not valid or not currently active.');};
  assert.equal(isImportedScene({flags:{},getFlag:cannotRead}),false);
  assert.equal(isImportedScene({getFlag:cannotRead}),false);
  assert.equal(isImportedScene({flags:{mapgen:{scene:{version:1}}},getFlag:cannotRead}),true);
  assert.equal(isImportedScene({flags:{unrelated:{scene:{version:1}}},getFlag:cannotRead}),false);
  assert.equal(isImportedScene({flags:{mapgen:{scene:{version:99}}},getFlag:cannotRead}),false);
});

test('new metadata can create a separate scene from an existing durable image without another upload',async t=>{
  const host=installHost(t);
  const input=imported();
  delete input.imageBlob;
  input.src='worlds/test-world/existing-battlemap.png';
  const result=await createImportedScene(input);
  assert.equal(host.uploads.length,0);
  assert.equal(result.src,input.src);
  assert.equal(result.document.firstLevel.background.src,input.src);
  assert.equal(result.document.getFlag(MODULE_ID,'scene').version,1);
  assert.equal(result.document.getFlag(MODULE_ID,'package'),undefined);
  assert.deepEqual(host.unrelated,host.before);
});

test('copying with a transient or executable image URL is rejected before mutation',async t=>{
  const host=installHost(t);
  for(const src of ['blob:temp','data:image/png;base64,abc','javascript:alert(1)','file:///image.png']) {
    await assert.rejects(createImportedScene({scene:sceneData(),src}),/durable Foundry image path/);
  }
  assert.equal(host.uploads.length,0);
  assert.equal(host.scenes.size,1);
});

test('a failed copied scene leaves its existing image untouched and reports no uploaded orphan',async t=>{
  const host=installHost(t,{backgroundError:new Error('Level write failed')});
  await assert.rejects(createImportedScene({scene:sceneData(),src:'worlds/test-world/existing.png'}),error=>{
    assert.match(error.message,/existing image remains/);
    assert.equal(error.uploadedPath,undefined);
    return true;
  });
  assert.equal(host.uploads.length,0);
  assert.equal(host.scenes.size,1);
  assert.deepEqual(host.unrelated,host.before);
});

test('native wall/light additions, deletions, door states, background and token edits survive settings save/reopen',async t=>{
  const host=installHost(t);
  const {document}=await createImportedScene(imported());
  document.name='Edited directly in Foundry';
  const door=document.walls.find(w=>w.door===1);
  door.c=[41,22,81,23];door.door=2;door.ds=2;
  document.walls=document.walls.filter(w=>w.flags[MODULE_ID].kind!=='window');
  document.walls.push({_id:'custom',c:[2,3,10,19],door:0,ds:0,move:20,light:20,sight:20,sound:20});
  document.lights=[];
  document.lights.push({_id:'new-light',x:17,y:19,hidden:true,config:{dim:40,bright:7,alpha:.7,color:'#123456',animation:{type:'torch'}}});
  document.firstLevel.background.src='worlds/test-world/manually-changed.png';
  document.grid.color='#12abcd';
  document.grid.alpha=.65;
  document.tokens[0].hidden=false;
  assert.equal(projectFromScene(document).scene.name,'Edited directly in Foundry');
  const retained=structuredClone({
    walls:document.walls,lights:document.lights,tokens:document.tokens,tiles:document.tiles,notes:document.notes,
    background:document.firstLevel.background,flags:document.flags
  });
  await saveSceneSettings(document,{name:'Saved settings',grid:{size:80,distance:10,units:'m'},darkness:.6,globalLight:false});
  assert.deepEqual(host.updates,[{
    name:'Saved settings','grid.size':80,'grid.distance':10,'grid.units':'m',
    'environment.darknessLevel':.6,'environment.globalLight.enabled':false
  }]);
  for(const key of ['walls','lights','tokens','tiles','notes','flags'])assert.deepEqual(document[key],retained[key]);
  assert.deepEqual(document.firstLevel.background,retained.background);
  assert.equal(document.grid.color,'#12abcd');
  assert.equal(document.grid.alpha,.65);
  assert.equal(document.width,321);
  const reopened=projectFromScene(document);
  assert.equal(reopened.scene.name,'Saved settings');
  assert.equal(reopened.src,'worlds/test-world/manually-changed.png');
  assert.deepEqual(reopened.scene.grid,{size:80,distance:10,units:'m'});
  assert.equal(reopened.scene.darkness,.6);
  assert.equal(reopened.scene.globalLight,false);
  assert.deepEqual(reopened.scene.doors,[{...segment(41,22,81,23),secret:true,state:'locked'}]);
  assert.equal(reopened.scene.windows.length,0);
  assert.deepEqual(reopened.scene.walls.at(-1),segment(2,3,10,19));
  assert.deepEqual(reopened.scene.lights,[light(17,19)].map(l=>({...l,dim:40,bright:7,alpha:.7,color:'#123456',hidden:true,animation:{type:'torch'}})));
  door.ds=1;
  assert.equal(projectFromScene(document).scene.doors[0].state,'open');
  assert.deepEqual(host.unrelated,host.before);
});

test('unrelated document flags never cause a scene to be opened or changed',async t=>{
  const host=installHost(t);
  const original={...host.unrelated,flags:{unrelated:{scene:{version:1}}},
    getFlag(){assert.fail('Unrelated flag scope was queried');},update(){assert.fail('Unrelated scene changed');}};
  assert.throws(()=>projectFromScene(original),/not a MapGen battlemap/);
  await assert.rejects(saveSceneSettings(original,sceneData()),/not a MapGen battlemap/);
  assert.deepEqual(host.unrelated,host.before);
});

test('multi-level or transformed backgrounds give a targeted preview failure, not misleading coordinates',async t=>{
  installHost(t);
  const {document}=await createImportedScene(imported());
  document.levels.push({});
  assert.throws(()=>projectFromScene(document),/multiple Levels/);
  document.levels.pop();
  for(const [field,value] of [['rotation',30],['offsetX',15],['offsetY',-1],['scaleX',2],['scaleY',.75]]) {
    const old=document.firstLevel.textures[field];
    document.firstLevel.textures[field]=value;
    assert.throws(()=>projectFromScene(document),/transformed background/);
    document.firstLevel.textures[field]=old;
  }
  document.padding=.2;
  assert.throws(()=>projectFromScene(document),/padding/);
  document.padding=0;
  document.width=500;
  assert.match(projectFromScene(document).warnings.at(-1),/dimensions have changed/);
});

test('invalid settings fail before updating and host update failures are surfaced without deleting the scene',async t=>{
  const host=installHost(t,{updateError:new Error('Permission denied')});
  const {document}=await createImportedScene(imported());
  const valid={name:'Name',grid:{size:50,distance:5,units:'ft'},darkness:.3,globalLight:true};
  for(const settings of [
    {...valid,name:' '},{...valid,grid:{...valid.grid,size:NaN}},{...valid,grid:{...valid.grid,size:0}},
    {...valid,grid:{...valid.grid,size:Infinity}},{...valid,grid:{...valid.grid,distance:-1}},
    {...valid,grid:{...valid.grid,units:null}},{...valid,darkness:1.01},
    {...valid,darkness:NaN},{...valid,globalLight:'true'}
  ])await assert.rejects(saveSceneSettings(document,settings));
  assert.equal(host.updates.length,0);
  await assert.rejects(saveSceneSettings(document,valid),/Permission denied/);
  assert.equal(host.scenes.has(document.id),true);
  assert.equal(host.events.some(event=>event[0]==='delete'),false);
});

test('cancelled settings updates are reported rather than claiming success',async t=>{
  const host=installHost(t,{cancelUpdate:true});
  const {document}=await createImportedScene(imported());
  await assert.rejects(saveSceneSettings(document,{...sceneData(),name:'Not persisted'}),/did not apply the requested scene settings/);
  assert.equal(document.name,'Original map');
  assert.equal(host.scenes.has(document.id),true);
});

test('directory creation recovers only when a browse verifies an existing directory',async t=>{
  const host=installHost(t,{directoryError:new Error('Already exists')});
  await createImportedScene(imported());
  assert.equal(host.events.filter(e=>e[0]==='browse').length,3);
  assert.equal(host.uploads.length,1);
});

test('directory access failure stops before upload and scene creation',async t=>{
  const host=installHost(t,{directoryError:new Error('Cannot create'),browseError:new Error('Permission denied')});
  await assert.rejects(createImportedScene(imported()),/Cannot access upload directory.*Permission denied/);
  assert.equal(host.uploads.length,0);
  assert.equal(host.document,undefined);
});

test('upload failure is fatal and does not create or mutate any scene',async t=>{
  const host=installHost(t,{uploadError:new Error('Network offline')});
  await assert.rejects(createImportedScene(imported()),/Network offline/);
  assert.equal(host.uploads.length,1);
  assert.equal(host.document,undefined);
  assert.deepEqual(host.unrelated,host.before);
});

test('unsuccessful FilePicker response is not mistaken for a usable image',async t=>{
  const host=installHost(t,{uploadResult:{error:'Storage quota exceeded'}});
  await assert.rejects(createImportedScene(imported()),/Storage quota exceeded/);
  assert.equal(host.document,undefined);
});

test('scene creation failure reports the uploaded orphan path and leaves unrelated scenes alone',async t=>{
  const host=installHost(t,{createError:new Error('Scene permission denied')});
  await assert.rejects(createImportedScene(imported()),error=>{
    assert.match(error.message,/Scene permission denied.*uploaded PNG remains/);
    assert.match(error.uploadedPath,/^worlds\/test-world\/mapgen\//);
    assert.equal(error.cause.message,'Scene permission denied');
    return true;
  });
  assert.deepEqual(host.unrelated,host.before);
  assert.equal(host.events.some(e=>e[0]==='delete'),false);
});

test('a Scene create hook that rejects after persistence still cleans only the uniquely owned scene',async t=>{
  const host=installHost(t,{failAfterCreate:new Error('Post-create hook failed')});
  await assert.rejects(createImportedScene(imported()),/Post-create hook failed.*uploaded PNG remains/);
  assert.equal(host.scenes.has(host.document.id),false);
  assert.deepEqual(host.events.filter(e=>e[0]==='delete'),[['delete',host.document.id]]);
  assert.deepEqual(host.unrelated,host.before);
});

test('missing v14 Level deletes only the newly-created partial scene and reports the orphan image',async t=>{
  const host=installHost(t,{noLevel:true});
  await assert.rejects(createImportedScene(imported()),/first Level.*uploaded PNG remains/);
  assert.equal(host.scenes.has('new-scene'),false);
  assert.equal(host.scenes.has('unrelated'),true);
  assert.deepEqual(host.events.filter(e=>e[0]==='delete'),[['delete','new-scene']]);
});

test('background update failure cleans the owned scene instead of leaving a marked broken import',async t=>{
  const host=installHost(t,{backgroundError:new Error('Level write failed')});
  await assert.rejects(createImportedScene(imported()),/Level write failed.*uploaded PNG remains/);
  assert.equal(host.scenes.has('new-scene'),false);
  assert.equal(host.embeddedCalls.length,0);
  assert.equal(host.document.getFlag(MODULE_ID,'scene'),undefined);
});

test('flag failure cleans the owned scene and a failed cleanup explicitly identifies the partial scene',async t=>{
  const host=installHost(t,{flagError:new Error('Flag write failed'),cleanupError:new Error('Delete permission denied')});
  await assert.rejects(createImportedScene(imported()),error=>{
    assert.match(error.message,/Flag write failed.*uploaded PNG remains.*Cleanup failed: Delete permission denied.*Partial scene new-scene remains/);
    assert.equal(error.partialSceneId,'new-scene');
    assert.equal(typeof error.uploadedPath,'string');
    return true;
  });
  assert.equal(host.scenes.has('new-scene'),true);
  assert.deepEqual(host.unrelated,host.before);
});

test('cancelled scene marking and scene deletion explicitly report the remaining partial scene',async t=>{
  const host=installHost(t,{cancelFlag:true,cancelDelete:true});
  await assert.rejects(createImportedScene(imported()),error=>{
    assert.match(error.message,/did not save the scene marker.*Cleanup failed: Foundry did not delete/);
    assert.equal(error.partialSceneId,host.document.id);
    return true;
  });
  assert.equal(host.scenes.has(host.document.id),true);
});

test('cancelled background writes never return a falsely successful import',async t=>{
  const host=installHost(t,{cancelBackground:true});
  await assert.rejects(createImportedScene(imported()),/did not save the first Level background/);
  assert.equal(host.scenes.has(host.document.id),false);
  assert.equal(host.embeddedCalls.length,0);
});

test('prevalidated batch rejection preserves partial successes, skips bad records and never duplicates IDs',async t=>{
  const host=installHost(t,{embedded({document,type,data,add,call,operation}) {
    assert.equal(operation.keepId,true);
    if(call===1) {
      add(document,type,[data[0]]);
      throw invalid('One wall rejected by server validation');
    }
    if(data[0].c?.[0]===53)throw invalid('Bad wall at normalized x=53');
    return add(document,type,data);
  }});
  const result=await createImportedScene(imported({
    walls:[segment(0,10,30,10),segment(50,10,60,10),segment(80,10,90,10)],
    doors:[],windows:[],lights:[light()]
  }));
  assert.deepEqual(result.document.walls.map(w=>w.c),[[0,8,30,8],[83,8,90,8]]);
  assert.equal(result.document.lights.length,1);
  assert.equal(new Set(result.document.walls.map(w=>w.id)).size,2);
  assert.equal(host.embeddedCalls.length,4);
  assert.equal(host.embeddedCalls.filter(call=>call.data.some(d=>d.c?.[0]===0)).length,1);
  assert.match(result.warnings[0],/Wall skipped: Bad wall/);
  assert.deepEqual(result.document.getFlag(MODULE_ID,'scene').warnings,result.warnings);
  assert.equal(host.events.some(e=>e[0]==='delete'),false);
});

test('partially returned batch retries missing IDs only and preserves good image-only imports when all records fail',async t=>{
  const host=installHost(t,{embedded({document,type,data,add,call}) {
    if(call===1)return add(document,type,[data[0]]);
    if(type==='AmbientLight')throw invalid('Unsupported light');
    return add(document,type,data);
  }});
  const result=await createImportedScene(imported({walls:[segment(0,10,30,10),segment(50,10,60,10)],doors:[],windows:[]}));
  assert.equal(result.document.walls.length,2);
  assert.equal(result.document.lights.length,0);
  assert.equal(host.embeddedCalls[1].data.length,1);
  assert.equal(host.embeddedCalls[1].data[0].c[0],53);
  assert.equal(result.document.firstLevel.background.src,result.src);
  assert.match(result.warnings[0],/AmbientLight skipped: Unsupported light/);
  assert.equal(result.document.getFlag(MODULE_ID,'scene').version,1);
});

test('server-serialized validation errors for every native record still produce a playable marked image scene',async t=>{
  const host=installHost(t,{embedded({type}) {throw new Error(`${type} validation errors: rejected record`);}});
  const result=await createImportedScene(imported());
  assert.deepEqual(result.document.walls,[]);
  assert.deepEqual(result.document.lights,[]);
  assert.equal(result.document.firstLevel.background.src,result.src);
  assert.equal(result.document.environment.globalLight.enabled,true);
  assert.equal(result.document.getFlag(MODULE_ID,'scene').version,1);
  assert.equal(result.warnings.length,6);
  assert.equal(host.events.some(e=>e[0]==='delete'),false);
});

test('network errors in document creation are not retried as bad geometry and trigger owned scene cleanup',async t=>{
  const host=installHost(t,{embedded({document,type,data,add}) {
    add(document,type,[data[0]]);
    throw new Error('Socket disconnected');
  }});
  await assert.rejects(createImportedScene(imported()),/Socket disconnected.*uploaded PNG remains/);
  assert.equal(host.embeddedCalls.length,1);
  assert.equal(host.scenes.has('new-scene'),false);
  assert.deepEqual(host.unrelated,host.before);
});

test('malformed embedded document API responses fail explicitly instead of silently dropping geometry',async t=>{
  const host=installHost(t,{embedded(){return undefined;}});
  await assert.rejects(createImportedScene(imported()),/no Wall creation result/);
  assert.equal(host.embeddedCalls.length,1);
  assert.equal(host.scenes.has('new-scene'),false);
});

test('unexpected local document API exceptions surface before uploading',async t=>{
  const host=installHost(t,{constructError:new TypeError('Host schema API broke')});
  await assert.rejects(createImportedScene(imported()),/Host schema API broke/);
  assert.equal(host.uploads.length,0);
  assert.equal(host.document,undefined);
});

test('contextual color, luminosity and animation survive creation, tuning and reopening',async t=>{
  installHost(t);
  const animation={type:'pulse',speed:2,intensity:3,reverse:false};
  const {document}=await createImportedScene(imported({
    lights:[{...light(),color:'#66ccff',luminosity:.6,animation}]
  }));
  const native=document.lights[0];
  assert.equal(native.config.luminosity,.6);
  assert.deepEqual(native.config.animation,animation);
  let project=projectFromScene(document);
  assert.deepEqual(project.scene.lights[0].animation,animation);
  assert.equal(project.scene.lights[0].luminosity,.6);
  await saveSceneSettings(document,project.scene,{...project.lighting,radiusScale:.25});
  assert.equal(native.config.dim,3.75);
  assert.equal(native.config.color,'#66ccff');
  assert.equal(native.config.luminosity,.6);
  assert.deepEqual(native.config.animation,animation);
  native.config.luminosity=.8;
  native.config.animation={type:'torch',speed:1,intensity:2,reverse:true};
  project=projectFromScene(document);
  await saveSceneSettings(document,project.scene,{...project.lighting,radiusScale:.75});
  assert.equal(native.config.dim,11.25);
  assert.equal(native.config.luminosity,.8);
  assert.deepEqual(native.config.animation,{type:'torch',speed:1,intensity:2,reverse:true});
});

test('Dwelling animation intent survives parse, native config, radius changes and persisted JSON reload',async t=>{
  installHost(t);
  const input=imported({name:"Example dwelling",grid:{size:45,distance:5,units:'ft'}});
  const metadata={...input.scene,lights:[
    {...light(50,60),color:'#ffad55',luminosity:.5,animation:{type:'torch',speed:1.6,intensity:1.5}},
    {...light(150,120),color:'#aa55ee',luminosity:.6,animation:{type:'slow pulse',speed:1,intensity:2}},
    {...light(220,170),color:'#ffeecc',luminosity:.4}
  ]};
  delete metadata.globalLight;delete metadata.darkness;
  const parsed=normalizeScene(metadata,input.scene.image);
  input.scene=parsed.scene;input.warnings=parsed.warnings;
  const {document}=await createImportedScene(input);
  assert.equal(document.environment.globalLight.enabled,true);
  assert.equal(document.environment.darknessLevel,0);
  const expected=[
    {type:'torch',speed:2,intensity:2,reverse:false},
    {type:'pulse',speed:1,intensity:2,reverse:false},
    undefined
  ];
  assert.deepEqual(document.lights.map(l=>l.config.animation),expected);
  assert.deepEqual(document.lights.map(l=>l.config.luminosity),[.5,.6,.4]);
  assert.deepEqual(document.lights.map(l=>l.config.color),['#ffad55','#aa55ee','#ffeecc']);
  for(const radiusScale of [.25,1,.5]) {
    const project=projectFromScene(document);
    await saveSceneSettings(document,project.scene,{...project.lighting,radiusScale});
    assert.deepEqual(document.lights.map(l=>l.config.animation),expected);
    assert.deepEqual(document.lights.map(l=>l.config.dim),[15,15,15].map(radius=>radius*radiusScale));
  }
  document.lights=JSON.parse(JSON.stringify(document.lights));
  document.flags=JSON.parse(JSON.stringify(document.flags));
  const reopened=projectFromScene(document);
  assert.deepEqual(reopened.scene.lights.map(l=>l.animation),expected);
  assert.equal(reopened.scene.globalLight,true);
  assert.equal(reopened.scene.darkness,0);
  document.lights[0].config.animation={type:'flame',speed:3,intensity:4,reverse:true};
  document.environment.globalLight.enabled=false;
  document.environment.darknessLevel=.46;
  const edited=projectFromScene(document);
  assert.equal(edited.scene.globalLight,false);
  assert.equal(edited.scene.darkness,.46);
  await saveSceneSettings(document,edited.scene,{...edited.lighting,radiusScale:.75});
  assert.deepEqual(document.lights[0].config.animation,{type:'flame',speed:3,intensity:4,reverse:true});
  assert.equal(document.environment.globalLight.enabled,false);
  assert.equal(document.environment.darknessLevel,.46);
});

test('direct native serialization retains valid lights with unsupported or malformed animation as static',async t=>{
  installHost(t);
  const {document,warnings}=await createImportedScene(imported({lights:[
    {...light(50,50),animation:{type:'not-a-native-effect'}},
    {...light(100,100),animation:{speed:1}},
    {...light(200,100),animation:{type:'fire',speed:.2,intensity:1.5}}
  ]}));
  assert.equal(document.lights.length,3);
  assert.equal(document.lights[0].config.animation,undefined);
  assert.equal(document.lights[1].config.animation,undefined);
  assert.deepEqual(document.lights[2].config.animation,{type:'flame',speed:1,intensity:2,reverse:false});
  assert.match(warnings.join(' '),/kept the light static/);
});

const chosenLighting=(document,radiusScale)=>({...projectFromScene(document).lighting,radiusScale});
const savedSettings=document=>({
  name:document.name,grid:{size:document.grid.size,distance:document.grid.distance,units:document.grid.units},
  darkness:document.environment.darknessLevel,globalLight:document.environment.globalLight.enabled
});
const radiusFlag=(dim=15,bright=5,radiusScale=.5)=>({
  version:1,baseDim:dim,baseBright:bright,radiusScale,appliedDim:dim*radiusScale,appliedBright:bright*radiusScale
});
const nativeAddedLight=(id='gm-light')=>({
  _id:id,id,x:140,y:130,hidden:true,elevation:25,config:{
    dim:23,bright:11,color:'#778899',alpha:.8,angle:120,animation:{type:'torch'}
  },flags:{other:{keep:true}}
});

test('new scene lighting defaults to half-radius with original baselines and independent native flags',async t=>{
  const host=installHost(t),input=imported(),source=structuredClone(input.scene);
  const {document}=await createImportedScene(input);
  const flag=document.lights[0].flags[MODULE_ID].lighting;
  assert.deepEqual(flag,radiusFlag());
  assert.deepEqual(document.getFlag(MODULE_ID,'lighting'),{version:1,radiusScale:.5});
  assert.deepEqual(host.events.find(event=>event[0]==='create')[1].flags[MODULE_ID],{lighting:{version:1,radiusScale:.5}});
  assert.deepEqual(input.scene,source);
  assert.deepEqual(document.lights[0].config,{dim:7.5,bright:2.5,color:'#ffbb77',alpha:.5});
  const project=projectFromScene(document);
  assert.equal(project.lighting.radiusScale,.5);
  assert.equal(project.lighting.untracked,false);
  assert.deepEqual(project.lighting.baseLights,[{...light(26,40),id:document.lights[0].id,managed:true}]);
  assert.equal(project.lighting.snapshot.radiusScale,.5);
  assert.equal(project.lighting.snapshot.sceneId,document.id);
  assert.equal(project.scene.lights[0].dim,7.5);
  const effective=scaleLights([light()],.25);
  const serialized=buildNativeData(sceneData({lights:effective})).lights[0];
  assert.deepEqual(serialized.flags[MODULE_ID].lighting,radiusFlag(15,5,.25));
  effective[0].lighting.baseDim=999;
  assert.equal(serialized.flags[MODULE_ID].lighting.baseDim,15);
});

test('all chosen scales create from original bases once, even when scene lights are already preview-scaled',async t=>{
  installHost(t);
  for(const radiusScale of LIGHT_RADIUS_SCALES) {
    const input=imported();
    input.lighting={radiusScale,baseLights:[light()],untracked:false};
    input.scene.lights=scaleLights(input.lighting.baseLights,radiusScale);
    const {document}=await createImportedScene(input);
    assert.equal(document.lights[0].config.dim,15*radiusScale);
    assert.equal(document.lights[0].config.bright,5*radiusScale);
    assert.deepEqual(document.lights[0].flags[MODULE_ID].lighting,radiusFlag(15,5,radiusScale));
    assert.deepEqual(document.getFlag(MODULE_ID,'lighting'),{version:1,radiusScale});
    assert.equal(document.grid.size,60);
    assert.equal(document.width,321);
    assert.equal(document.height,237);
  }
});

test('image-only scenes save radius preference without creating native light documents',async t=>{
  const host=installHost(t);
  const {document}=await createImportedScene(imported({lights:[]}));
  assert.deepEqual(projectFromScene(document).lighting.baseLights,[]);
  await saveSceneSettings(document,savedSettings(document),chosenLighting(document,.25));
  assert.deepEqual(document.getFlag(MODULE_ID,'lighting'),{version:1,radiusScale:.25});
  assert.deepEqual(document.lights,[]);
  assert.deepEqual(host.lightUpdates,[]);
});

test('creation verifies the saved radius preference before completing the scene marker',async t=>{
  const host=installHost(t,{cancelInitialLighting:true});
  await assert.rejects(createImportedScene(imported()),/did not save the light radius setting/);
  assert.equal(host.scenes.has(host.document.id),false);
  assert.equal(host.document.getFlag(MODULE_ID,'scene'),undefined);
});

test('invalid individual host lights still skip after default scaling without losing a good image scene',async t=>{
  installHost(t,{validate(type,data) {return type!=='AmbientLight'||data.x!==50;}});
  const result=await createImportedScene(imported({lights:[light(),light(50,60)]}));
  assert.equal(result.document.lights.length,1);
  assert.equal(result.document.lights[0].config.dim,7.5);
  assert.deepEqual(result.document.lights[0].flags[MODULE_ID].lighting,radiusFlag());
  assert.ok(result.warnings.some(warning=>warning.includes('light 2 skipped')));
  assert.equal(result.document.firstLevel.background.src,result.src);
  assert.deepEqual(result.document.getFlag(MODULE_ID,'scene').warnings,result.warnings);
});

test('repeated save and reopen scales noncumulatively and never recreates lights',async t=>{
  const host=installHost(t);
  const {document}=await createImportedScene(imported());
  const id=document.lights[0].id,createCount=host.embeddedCalls.length;
  for(const scale of [.25,.75,1,1.25,.5,.25,1]) {
    await saveSceneSettings(document,savedSettings(document),chosenLighting(document,scale));
    assert.equal(document.lights[0].id,id);
    assert.equal(document.lights[0].config.dim,15*scale);
    assert.equal(document.lights[0].config.bright,5*scale);
    const reopened=projectFromScene(document);
    assert.equal(reopened.lighting.radiusScale,scale);
    assert.equal(reopened.lighting.baseLights[0].dim,15);
    assert.equal(reopened.lighting.baseLights[0].bright,5);
    assert.equal(reopened.scene.lights[0].dim,15*scale);
  }
  assert.equal(host.embeddedCalls.length,createCount);
  assert.equal(host.events.some(event=>event[0]==='delete'),false);
});

test('reopening rebases GM radius edits at the saved scale instead of reverting them',async t=>{
  installHost(t);
  const {document}=await createImportedScene(imported());
  document.lights[0].config.dim=13;
  document.lights[0].config.bright=4;
  const reopened=projectFromScene(document);
  assert.equal(reopened.lighting.radiusScale,.5);
  assert.deepEqual([reopened.scene.lights[0].dim,reopened.scene.lights[0].bright],[13,4]);
  assert.deepEqual([reopened.lighting.baseLights[0].dim,reopened.lighting.baseLights[0].bright],[26,8]);
  await saveSceneSettings(document,savedSettings(document),{...reopened.lighting,radiusScale:.75});
  assert.deepEqual([document.lights[0].config.dim,document.lights[0].config.bright],[19.5,6]);
  assert.deepEqual(document.lights[0].flags[MODULE_ID].lighting,radiusFlag(26,8,.75));
});

test('scale-only saves preserve all non-radius native properties and later GM-added lights',async t=>{
  const host=installHost(t);
  const {document}=await createImportedScene(imported());
  const native=document.lights[0];
  Object.assign(native,{x:100.5,y:70.5,hidden:true,elevation:35,rotation:75});
  Object.assign(native.config,{color:'#abcdef',alpha:.85,angle:145,animation:{type:'torch',speed:3}});
  native.flags[MODULE_ID].custom='retain';
  native.flags.other={value:'untouched'};
  document.lights.push(nativeAddedLight());
  const before=structuredClone(document.lights),structure=structuredClone({
    walls:document.walls,tokens:document.tokens,tiles:document.tiles,background:document.firstLevel.background
  });
  const reopened=projectFromScene(document);
  assert.deepEqual(reopened.lighting.baseLights.map(light=>light.managed),[true,false]);
  assert.equal(reopened.scene.lights[0].hidden,true);
  assert.ok(reopened.warnings.some(warning=>warning.includes('directional lighting')));
  await saveSceneSettings(document,savedSettings(document),{...reopened.lighting,radiusScale:.75});
  assert.deepEqual(host.lightUpdates[0],[{
    _id:native.id,'config.dim':11.25,'config.bright':3.75,
    [`flags.${MODULE_ID}.lighting`]:radiusFlag(15,5,.75)
  }]);
  const expected=before[0];
  expected.config.dim=11.25;expected.config.bright=3.75;
  expected.flags[MODULE_ID].lighting=radiusFlag(15,5,.75);
  assert.deepEqual(document.lights[0],expected);
  assert.deepEqual(document.lights[1],before[1]);
  assert.deepEqual({walls:document.walls,tokens:document.tokens,tiles:document.tiles,background:document.firstLevel.background},structure);
  assert.equal(projectFromScene(document).lighting.baseLights[1].managed,false);
  assert.deepEqual(host.unrelated,host.before);
});

test('settings-only and unchanged-scale saves never rewrite lights or either lighting flag',async t=>{
  const host=installHost(t);
  const {document}=await createImportedScene(imported());
  const lighting=projectFromScene(document).lighting;
  document.lights[0].config.dim=99;
  document.lights.push(nativeAddedLight());
  const before=structuredClone({lights:document.lights,flags:document.flags});
  await saveSceneSettings(document,{...savedSettings(document),name:'Settings only'});
  await saveSceneSettings(document,{...savedSettings(document),name:'Same radius'},lighting);
  assert.deepEqual(document.lights,before.lights);
  assert.deepEqual(document.flags,before.flags);
  assert.deepEqual(host.lightUpdates,[]);
  assert.ok(host.updates.every(update=>!Object.keys(update).some(key=>key.startsWith('flags.'))));
});

test('untracked scene reopen is read-only and explicit scale change adopts only the current light set',async t=>{
  const host=installHost(t);
  const {document}=await createImportedScene(imported());
  delete document.flags[MODULE_ID].lighting;
  delete document.lights[0].flags[MODULE_ID].lighting;
  document.lights[0].config.dim=30;document.lights[0].config.bright=10;
  document.lights.push(nativeAddedLight('untracked-light'));
  const before=structuredClone({lights:document.lights,flags:document.flags});
  const reopened=projectFromScene(document);
  assert.equal(reopened.lighting.untracked,true);
  assert.equal(reopened.lighting.radiusScale,1);
  assert.deepEqual(reopened.lighting.baseLights.map(light=>light.managed),[true,true]);
  assert.deepEqual(document.lights,before.lights);
  await saveSceneSettings(document,savedSettings(document),reopened.lighting);
  assert.deepEqual(document.flags,before.flags);
  assert.deepEqual(document.lights,before.lights);
  assert.equal(host.lightUpdates.length,0);
  await saveSceneSettings(document,savedSettings(document),{...reopened.lighting,radiusScale:.5});
  assert.deepEqual(document.lights.map(light=>light.config.dim),[15,11.5]);
  assert.deepEqual(document.getFlag(MODULE_ID,'lighting'),{version:1,radiusScale:.5});
  assert.equal(projectFromScene(document).lighting.untracked,false);
  document.lights.push(nativeAddedLight('added-later'));
  await saveSceneSettings(document,savedSettings(document),chosenLighting(document,.25));
  assert.deepEqual(document.lights.map(light=>light.config.dim),[7.5,5.75,23]);
  assert.equal(document.lights[2].flags[MODULE_ID],undefined);
});

test('Foundry Color values become strings and malformed saved tuning falls back to actual radii at 100%',async t=>{
  installHost(t);
  const {document}=await createImportedScene(imported());
  document.lights[0].config.color={toString:()=>'#aabbcc'};
  document.lights.push(nativeAddedLight());
  const savedFlag=structuredClone(document.getFlag(MODULE_ID,'lighting'));
  for(const bad of [{version:99,radiusScale:.5},{version:1,radiusScale:NaN},'invalid']) {
    document.flags[MODULE_ID].lighting=bad;
    const reopened=projectFromScene(document);
    assert.equal(reopened.lighting.radiusScale,1);
    assert.equal(reopened.lighting.untracked,false);
    assert.equal(reopened.scene.lights[0].color,'#aabbcc');
    assert.equal(reopened.lighting.baseLights[0].dim,7.5);
    assert.equal(reopened.lighting.baseLights[1].managed,false);
    assert.ok(reopened.warnings.some(warning=>warning.includes('Saved light tuning is invalid')));
  }
  document.flags[MODULE_ID].lighting=savedFlag;
  document.lights[0].flags[MODULE_ID].lighting.baseDim=999;
  const reopened=projectFromScene(document);
  assert.equal(reopened.lighting.radiusScale,1);
  assert.equal(reopened.lighting.baseLights[0].dim,7.5);
  await saveSceneSettings(document,savedSettings(document),{...reopened.lighting,radiusScale:.5});
  assert.equal(document.lights[0].config.dim,3.75);
  assert.equal(document.lights[0].flags[MODULE_ID].lighting.baseDim,7.5);
});

test('stale radius, light list, flags and scene scale changes block tuning before any writes',async t=>{
  const host=installHost(t);
  const {document}=await createImportedScene(imported());
  for(const mutate of [
    ()=>document.lights[0].config.dim++,
    ()=>document.lights.push(nativeAddedLight()),
    ()=>document.lights.pop(),
    ()=>document.lights[0].flags[MODULE_ID].lighting.baseDim=500,
    ()=>document.flags[MODULE_ID].lighting.radiusScale=.75
  ]) {
    const state=chosenLighting(document,.25);
    mutate();
    const lights=structuredClone(document.lights);
    await assert.rejects(saveSceneSettings(document,savedSettings(document),state),/Reopen the scene before changing light radii/);
    assert.deepEqual(document.lights,lights);
  }
  assert.equal(host.lightUpdates.length,0);
  assert.equal(host.updates.length,0);
});

test('non-radius native edits made after opening are preserved without needlessly rejecting tuning',async t=>{
  installHost(t);
  const {document}=await createImportedScene(imported());
  const state=chosenLighting(document,.75);
  const light=document.lights[0];
  light.x=222;light.y=111;light.hidden=true;
  Object.assign(light.config,{color:'#010203',alpha:.9,animation:{type:'pulse'}});
  await saveSceneSettings(document,savedSettings(document),state);
  assert.deepEqual([light.x,light.y,light.hidden],[222,111,true]);
  assert.deepEqual(light.config,{dim:11.25,bright:3.75,color:'#010203',alpha:.9,animation:{type:'pulse'}});
});

test('invalid choices and tuning without an opening snapshot fail explicitly before writes',async t=>{
  const host=installHost(t);
  const {document}=await createImportedScene(imported());
  await assert.rejects(saveSceneSettings(document,savedSettings(document),chosenLighting(document,.6)),/Choose a light radius/);
  await assert.rejects(saveSceneSettings(document,savedSettings(document),{radiusScale:.25,baseLights:[]}),/Reopen the scene/);
  assert.deepEqual(host.lightUpdates,[]);
  assert.deepEqual(host.updates,[]);
});

test('recovering reordered or incomplete tuning flags uses semantic values and removes stale fields',async t=>{
  installHost(t);
  const {document}=await createImportedScene(imported());
  document.flags[MODULE_ID].lighting={radiusScale:.5,version:1,obsolete:true};
  document.lights[0].flags[MODULE_ID].lighting={radiusScale:.5,version:1,obsolete:true};
  const state=chosenLighting(document,.75);
  assert.equal(state.snapshot.radiusScale,1);
  await saveSceneSettings(document,savedSettings(document),state);
  assert.deepEqual(document.getFlag(MODULE_ID,'lighting'),{version:1,radiusScale:.75});
  assert.deepEqual(document.lights[0].flags[MODULE_ID].lighting,radiusFlag(7.5,2.5,.75));
  assert.equal(projectFromScene(document).lighting.baseLights[0].dim,7.5);
});

test('partial failed embedded updates roll back radii and flags and retry from the same baseline',async t=>{
  const host=installHost(t,{lightUpdate({data,call,apply}) {
    if(call===1) {apply([data[0]]);throw new Error('Socket disconnected');}
    return apply(data);
  }});
  const {document}=await createImportedScene(imported({lights:[light(),light(50,60)]}));
  const before=structuredClone({lights:document.lights,flags:document.flags}),state=chosenLighting(document,.75);
  await assert.rejects(saveSceneSettings(document,{...savedSettings(document),name:'Should roll back'},state),
    /Socket disconnected.*Previous radii, flags and settings were restored.*Reopen/);
  assert.deepEqual(document.lights,before.lights);
  assert.deepEqual(document.flags,before.flags);
  assert.equal(document.name,'Original map');
  assert.equal(host.updates.length,0);
  assert.equal(host.lightUpdates[1].length,1);
  await saveSceneSettings(document,savedSettings(document),state);
  assert.deepEqual(document.lights.map(light=>light.config.dim),[11.25,11.25]);
});

test('cancelled or partially accepted embedded updates never report success and restore applied records',async t=>{
  let partial=false;
  const host=installHost(t,{lightUpdate({data,call,apply}) {
    if(call===1)return [];
    if(call===2&&partial)return apply([data[0]]);
    return apply(data);
  }});
  const {document}=await createImportedScene(imported({lights:[light(),light(50,60)]}));
  const before=structuredClone(document.lights);
  await assert.rejects(saveSceneSettings(document,savedSettings(document),chosenLighting(document,1)),/did not apply every light radius update/);
  assert.deepEqual(document.lights,before);
  partial=true;
  await assert.rejects(saveSceneSettings(document,savedSettings(document),chosenLighting(document,1)),/Previous radii, flags and settings were restored/);
  assert.deepEqual(document.lights,before);
  assert.equal(host.updates.length,0);
});

test('partial field writes in a light are restored without keeping new baseline flag fragments',async t=>{
  installHost(t,{lightUpdate({data,call,apply}) {
    if(call===1)return apply([{
      _id:data[0]._id,'config.dim':data[0]['config.dim'],
      [`flags.${MODULE_ID}.lighting.appliedDim`]:data[0][`flags.${MODULE_ID}.lighting`].appliedDim
    }]);
    return apply(data);
  }});
  const {document}=await createImportedScene(imported());
  const before=structuredClone(document.lights);
  await assert.rejects(saveSceneSettings(document,savedSettings(document),chosenLighting(document,1)),
    /Previous radii, flags and settings were restored/);
  assert.deepEqual(document.lights,before);
});

test('failed scene flag/settings write rolls back both scopes after light updates succeeded',async t=>{
  const host=installHost(t,{sceneUpdate({data,call,apply}) {
    apply(data);
    if(call===1)throw new Error('Scene flag network failure');
  }});
  const {document}=await createImportedScene(imported());
  const before=structuredClone({lights:document.lights,flags:document.flags}),settings=savedSettings(document);
  await assert.rejects(saveSceneSettings(document,{
    name:'Changed',grid:{size:90,distance:10,units:'m'},darkness:.6,globalLight:false
  },chosenLighting(document,1)),/Scene flag network failure.*Previous radii, flags and settings were restored/);
  assert.deepEqual(document.lights,before.lights);
  assert.deepEqual(document.flags,before.flags);
  assert.deepEqual(savedSettings(document),settings);
  assert.equal(host.lightUpdates.length,2);
  assert.equal(host.updates.length,2);
});

test('cancelled scene writes roll back scaled lights and do not advance the saved radius scale',async t=>{
  installHost(t,{sceneUpdate({data,call,apply}) {if(call!==1)apply(data);}});
  const {document}=await createImportedScene(imported());
  const before=structuredClone({lights:document.lights,flags:document.flags});
  await assert.rejects(saveSceneSettings(document,savedSettings(document),chosenLighting(document,.75)),
    /did not persist.*Previous radii, flags and settings were restored/);
  assert.deepEqual(document.lights,before.lights);
  assert.deepEqual(document.flags,before.flags);
});

test('partial scene settings write rolls back only changed settings while preserving original lighting flag',async t=>{
  const host=installHost(t,{sceneUpdate({data,call,apply}) {
    if(call===1)apply({name:data.name,'grid.size':data['grid.size']});
    else apply(data);
  }});
  const {document}=await createImportedScene(imported());
  const before=structuredClone({lights:document.lights,flags:document.flags}),settings=savedSettings(document);
  await assert.rejects(saveSceneSettings(document,{...settings,name:'Partial',grid:{size:90,distance:10,units:'m'}},chosenLighting(document,1)),
    /Previous radii, flags and settings were restored/);
  assert.deepEqual(document.lights,before.lights);
  assert.deepEqual(document.flags,before.flags);
  assert.deepEqual(savedSettings(document),settings);
  assert.deepEqual(host.updates[1],{name:'Original map','grid.size':60});
});

test('untracked adoption failure removes only new lighting flags and restores preexisting module data',async t=>{
  const host=installHost(t,{sceneUpdate({data,call,apply}) {
    apply(data);
    if(call===1)throw new Error('Cannot finish untracked tuning');
  }});
  const {document}=await createImportedScene(imported());
  delete document.flags[MODULE_ID].lighting;
  delete document.lights[0].flags[MODULE_ID].lighting;
  document.flags[MODULE_ID].custom='scene data';
  document.lights[0].flags[MODULE_ID].custom='light data';
  const before=structuredClone({lights:document.lights,flags:document.flags});
  await assert.rejects(saveSceneSettings(document,savedSettings(document),chosenLighting(document,.5)),
    /Cannot finish untracked tuning.*Previous radii, flags and settings were restored/);
  assert.deepEqual(document.lights,before.lights);
  assert.deepEqual(document.flags,before.flags);
  assert.equal(host.lightUpdates[1][0][`flags.${MODULE_ID}.-=lighting`],null);
  assert.equal(host.updates[1][`flags.${MODULE_ID}.-=lighting`],null);
});

test('rollback failures are explicit and prevent blindly retrying a stale saved lighting state',async t=>{
  installHost(t,{lightUpdate({data,call,apply}) {
    if(call===1) {apply(data);throw new Error('Initial network failure');}
    throw new Error('Rollback network failure');
  }});
  const {document}=await createImportedScene(imported());
  const state=chosenLighting(document,1);
  await assert.rejects(saveSceneSettings(document,savedSettings(document),state),
    /Initial network failure.*Rollback incomplete: Rollback network failure.*Reopen/);
  await assert.rejects(saveSceneSettings(document,savedSettings(document),state),/Native lights or their tuning changed/);
});

test('cancelled light rollback is detected and the scene flag is still restored independently',async t=>{
  installHost(t,{
    lightUpdate({data,call,apply}) {return call===1?apply(data):[];},
    sceneUpdate({data,call,apply}) {
      apply(data);
      if(call===1)throw new Error('Scene write interrupted');
    }
  });
  const {document}=await createImportedScene(imported());
  await assert.rejects(saveSceneSettings(document,savedSettings(document),chosenLighting(document,1)),
    /Rollback incomplete: Foundry did not restore all prior light radii and flags/);
  assert.equal(document.lights[0].config.dim,15);
  assert.equal(document.getFlag(MODULE_ID,'lighting').radiusScale,.5);
});

test('cancelled scene rollback is explicit even when native light rollback succeeds',async t=>{
  installHost(t,{sceneUpdate({data,call,apply}) {
    if(call===1) {apply(data);throw new Error('Scene write interrupted');}
  }});
  const {document}=await createImportedScene(imported());
  const before=structuredClone(document.lights);
  await assert.rejects(saveSceneSettings(document,{...savedSettings(document),name:'Partially persisted'},chosenLighting(document,1)),
    /Rollback incomplete: Foundry did not restore prior scene settings and light tuning/);
  assert.deepEqual(document.lights,before);
  assert.equal(document.name,'Partially persisted');
});

test('concurrent GM edits during a failed save are retained with explicit incomplete rollback guidance',async t=>{
  installHost(t,{lightUpdate({document,data,call,apply}) {
    if(call===1) {
      apply(data);
      document.lights[0].config.dim=123;
      document.lights[0].x=222;
      throw new Error('Write failed after concurrent edit');
    }
    return apply(data);
  }});
  const {document}=await createImportedScene(imported());
  await assert.rejects(saveSceneSettings(document,savedSettings(document),chosenLighting(document,1)),
    /Rollback incomplete: Light .* dim changed again; that edit was retained/);
  assert.equal(document.lights[0].config.dim,123);
  assert.equal(document.lights[0].x,222);
  assert.equal(document.lights[0].config.bright,2.5);
});
