import {buildNativeData,IMPORT_SCENE_FRAME,isNativeValidationError,nativeConstants,normalizeStructure} from './foundry-data.js';
import {DEFAULT_LIGHT_RADIUS_SCALE,isLightRadiusScale,scaleLights} from './lighting.js';

export const MODULE_ID='mapgen';

function sceneMarker(document) {
  return document.flags?.[MODULE_ID]?.scene;
}
export function isImportedScene(document) {return sceneMarker(document)?.version===1;}

function durableImagePath(src) {
  if(typeof src!=='string'||!src.trim()
    ||(/^[a-z][a-z\d+.-]*:/i.test(src)&&!/^https?:\/\//i.test(src)))
    throw new Error('A durable Foundry image path is required.');
  return src;
}

function sceneSettings(settings) {
  if(typeof settings.name!=='string'||!settings.name.trim())throw new Error('Scene name is required.');
  const grid=settings.grid;
  if(!grid||!Number.isFinite(grid.size)||grid.size<=0)
    throw new Error('Grid size must be a positive number of pixels.');
  if(!Number.isFinite(grid.distance)||grid.distance<=0)throw new Error('Grid distance must be a positive number.');
  if(typeof grid.units!=='string')throw new Error('Grid units must be text.');
  if(!Number.isFinite(settings.darkness)||settings.darkness<0||settings.darkness>1)
    throw new Error('Darkness must be between 0 and 1.');
  if(typeof settings.globalLight!=='boolean')throw new Error('Global illumination must be enabled or disabled.');
  return {
    name:settings.name.trim(),
    'grid.size':grid.size,'grid.distance':grid.distance,'grid.units':grid.units,
    'environment.darknessLevel':settings.darkness,
    'environment.globalLight.enabled':settings.globalLight
  };
}

function importedSettings(scene) {
  return {...scene,darkness:scene.darkness??0,globalLight:scene.globalLight??true};
}

async function uploadImage(blob) {
  const picker=globalThis.foundry?.applications?.apps?.FilePicker;
  if(!picker?.upload||!picker?.createDirectory)throw new Error('Foundry v14 FilePicker is unavailable.');
  const world=globalThis.game?.world?.id;
  if(!world)throw new Error('A Foundry world must be open before importing.');
  const dir=`worlds/${world}/${MODULE_ID}`;
  let current='';
  for(const part of dir.split('/')) {
    current=current?`${current}/${part}`:part;
    try {await picker.createDirectory('data',current);}
    catch(error) {
      if(typeof picker.browse!=='function')throw error;
      // Already-existing directories also reject creation. A successful browse verifies access.
      try {await picker.browse('data',current);}
      catch(browseError) {throw new Error(`Cannot access upload directory "${current}": ${browseError.message}`,{cause:error});}
    }
  }
  const file=new File([blob],`${MODULE_ID}-${globalThis.crypto.randomUUID()}.png`,{type:'image/png'});
  const result=await picker.upload('data',dir,file,{}, {notify:false});
  if(!result||result.error||!(result.path||result.url))throw new Error(result?.error||'Foundry image upload failed.');
  const src=result.path||result.url;
  return durableImagePath(src);
}

const documents=collection=>Array.from(collection?.contents??collection?.values?.()??collection??[]);
const documentId=document=>document.id??document._id;
const newDocumentId=()=>globalThis.foundry?.utils?.randomID?.()??globalThis.crypto.randomUUID().replaceAll('-','').slice(0,16);
const same=(a,b)=>Object.is(a,b)||Boolean(a&&b&&typeof a==='object'&&typeof b==='object'
  &&Array.isArray(a)===Array.isArray(b)&&Object.keys(a).length===Object.keys(b).length
  &&Object.keys(a).every(key=>Object.hasOwn(b,key)&&same(a[key],b[key])));
const fieldValue=(document,key)=>key.split('.').reduce((data,part)=>data?.[part],document);
const lightFlag=(light,scope)=>light.flags?.[scope]?.lighting;
const validSceneLighting=flag=>flag?.version===1&&isLightRadiusScale(flag.radiusScale);
const validLightLighting=flag=>validSceneLighting(flag)
  &&[flag.baseDim,flag.baseBright,flag.appliedDim,flag.appliedBright].every(value=>Number.isFinite(value)&&value>=0)
  &&flag.appliedDim===flag.baseDim*flag.radiusScale&&flag.appliedBright===flag.baseBright*flag.radiusScale;

function lightingSnapshot(document) {
  const scope=MODULE_ID;
  return {
    sceneId:document.id,scope,flag:structuredClone(document.flags?.[scope]?.lighting??null),
    lights:documents(document.lights).map(light=>({
      id:documentId(light),dim:light.config?.dim,bright:light.config?.bright,
      flag:structuredClone(lightFlag(light,scope)??null)
    })).sort((a,b)=>String(a.id).localeCompare(String(b.id)))
  };
}

function readLighting(document,warnings) {
  const snapshot=lightingSnapshot(document),untracked=snapshot.flag===null;
  const invalidScene=!untracked&&!validSceneLighting(snapshot.flag);
  const invalidLight=!untracked&&snapshot.lights.some(light=>light.flag!==null&&!validLightLighting(light.flag));
  const recovered=invalidScene||invalidLight;
  const radiusScale=untracked||recovered?1:snapshot.flag.radiusScale;
  if(recovered)warnings.push('Saved light tuning is invalid. Current native radii are retained at 100%; choose a different radius to establish a new baseline.');
  const baseLights=[],lights=[];
  let specialLights=false;
  for(const native of documents(document.lights)) {
    const data=native.toObject?native.toObject():native,config=data.config??{};
    if(![data.x,data.y,config.dim,config.bright].every(Number.isFinite)||config.dim<0||config.bright<0) {
      warnings.push(`Native light ${documentId(native)??''} has invalid coordinates or radii and is omitted from the preview.`);
      continue;
    }
    const light={
      x:data.x,y:data.y,dim:config.dim,bright:config.bright,
      color:(config.color??'#ffffff').toString(),alpha:config.alpha??.5,
      ...(config.luminosity!==undefined?{luminosity:config.luminosity}:{}),
      ...(config.animation?.type?{animation:structuredClone(config.animation)}:{}),
      ...(data.hidden?{hidden:true}:{})
    };
    lights.push(light);
    const flag=lightFlag(native,snapshot.scope),managed=untracked||flag!=null;
    const matches=!recovered&&validLightLighting(flag)&&flag.radiusScale===radiusScale
      &&flag.appliedDim===light.dim&&flag.appliedBright===light.bright;
    baseLights.push({
      ...light,id:documentId(native),managed,
      dim:managed?(matches?flag.baseDim:light.dim/radiusScale):light.dim,
      bright:managed?(matches?flag.baseBright:light.bright/radiusScale):light.bright
    });
    if(data.hidden||(config.angle??360)!==360)specialLights=true;
  }
  if(specialLights)warnings.push('Hidden lights are omitted from the lighting preview; directional lighting is shown as radial coverage. Native settings remain unchanged.');
  return {lights,lighting:{radiusScale,baseLights,untracked,snapshot:{...snapshot,radiusScale}}};
}

async function createRecords(scene,type,records,warnings) {
  if(!records.length)return;
  const data=records.map(record=>({...record,_id:newDocumentId()}));
  const collection=()=>documents(type==='Wall'?scene.walls:scene.lights);
  const existing=()=>new Set(collection().map(documentId));
  const expected=new Set(data.map(record=>record._id));
  const completed=new Set();
  const write=async items=>{
    const result=await scene.createEmbeddedDocuments(type,items,{keepId:true});
    if(!Array.isArray(result))throw new Error(`Foundry returned no ${type} creation result.`);
    for(const document of result) {
      const id=documentId(document);
      if(!expected.has(id))throw new Error(`Foundry did not preserve ${type} IDs; import cannot safely retry.`);
      completed.add(id);
    }
  };
  try {await write(data);}
  catch(error) {
    if(!isNativeValidationError(error))throw error;
  }
  // Stable IDs and the live collection prevent duplicate records after a partially accepted batch.
  for(const record of data) {
    if(completed.has(record._id)||existing().has(record._id))continue;
    try {await write([record]);}
    catch(error) {
      if(!isNativeValidationError(error))throw error;
      if(!existing().has(record._id))warnings.push(`${type} skipped: ${error.message}`);
      continue;
    }
    if(!completed.has(record._id)&&!existing().has(record._id))
      warnings.push(`${type} skipped: Foundry did not create this record.`);
  }
}

export async function createImportedScene(imported) {
  if(imported?.scene?.version!==1)throw new Error('Unsupported scene metadata version.');
  const normalized=imported.structureNormalized?{scene:imported.scene,warnings:[]}:normalizeStructure(imported.scene);
  const scene=normalized.scene;
  if(!Number.isInteger(scene.image?.width)||scene.image.width<=0
    ||!Number.isInteger(scene.image?.height)||scene.image.height<=0)
    throw new Error('The original PNG must have valid pixel dimensions.');
  const hasImage=imported.imageBlob instanceof Blob&&imported.imageBlob.size>0;
  if(!hasImage&&!imported.src)throw new Error('The original PNG is missing.');
  const existingSrc=hasImage?null:durableImagePath(imported.src);
  const settings=importedSettings(scene);
  sceneSettings(settings);
  const radiusScale=imported.lighting?.radiusScale??DEFAULT_LIGHT_RADIUS_SCALE;
  const lights=scaleLights(imported.lighting?.baseLights??scene.lights??[],radiusScale);
  const native=buildNativeData({...scene,lights});
  const warnings=[...new Set([...(imported.warnings??[]),...normalized.warnings,...native.warnings])];
  const SceneClass=globalThis.Scene?.implementation??globalThis.CONFIG?.Scene?.documentClass;
  if(typeof SceneClass?.create!=='function')throw new Error('Foundry Scene creation is unavailable.');
  const ownedId=newDocumentId();
  if(globalThis.game?.scenes?.get?.(ownedId))throw new Error('The new scene ID is already in use. Please retry the import.');
  const src=existingSrc??await uploadImage(imported.imageBlob);
  let document;
  try {
    document=await SceneClass.create({
      _id:ownedId,name:settings.name.trim(),width:scene.image.width,height:scene.image.height,
      ...IMPORT_SCENE_FRAME,navigation:false,tokenVision:true,
      grid:{...settings.grid,type:globalThis.CONST?.GRID_TYPES?.SQUARE??1,alpha:.2},
      environment:{darknessLevel:settings.darkness,globalLight:{enabled:settings.globalLight}},
      flags:{[MODULE_ID]:{lighting:{version:1,radiusScale}}}
    },{keepId:true});
    if(!document)throw new Error('Foundry did not create the scene.');
    if(!same(document.getFlag(MODULE_ID,'lighting'),{version:1,radiusScale}))
      throw new Error('Foundry did not save the light radius setting.');
    if(!document.firstLevel?.update)throw new Error("Foundry v14 did not create the scene's first Level.");
    await document.firstLevel.update({'background.src':src});
    if(document.firstLevel.background?.src!==src)throw new Error('Foundry did not save the first Level background.');
    await createRecords(document,'Wall',native.walls,warnings);
    await createRecords(document,'AmbientLight',native.lights,warnings);
    await document.setFlag(MODULE_ID,'scene',{version:1,image:{...scene.image},warnings:[...warnings]});
    if(document.getFlag(MODULE_ID,'scene')?.version!==1)throw new Error('Foundry did not save the scene marker.');
    return {document,src,warnings};
  } catch(error) {
    let cleanupError;
    // Creation hooks can reject after persistence. Only recover the unique scene owned by this import.
    document??=globalThis.game?.scenes?.get?.(ownedId);
    if(document) {
      try {
        await document.delete();
        if(globalThis.game?.scenes?.get?.(document.id))throw new Error('Foundry did not delete the partial scene.');
      }
      catch(cleanup) {cleanupError=cleanup;}
    }
    const message=`${error.message} The ${hasImage?'uploaded PNG':'existing image'} remains at "${src}".`
      +(cleanupError?` Cleanup failed: ${cleanupError.message}. Partial scene ${document.id} remains; inspect or delete it manually.`:'');
    const failure=new Error(message,{cause:error});
    if(hasImage)failure.uploadedPath=src;
    if(cleanupError)failure.partialSceneId=document.id;
    throw failure;
  }
}

function assertSupportedScene(document) {
  if(documents(document.levels).length>1)
    throw new Error('This scene now has multiple Levels. Edit it in Foundry; MapGen only previews single-level imports.');
  const textures=document.firstLevel?.textures;
  if((document.padding??0)!==0||(document.shiftX??0)!==0||(document.shiftY??0)!==0
    ||['offsetX','offsetY','rotation'].some(key=>(textures?.[key]??0)!==0)
    ||['scaleX','scaleY'].some(key=>(textures?.[key]??1)!==1))
    throw new Error('This scene has padding or a transformed background. Edit it in Foundry; MapGen cannot accurately preview this coordinate frame.');
}

export function projectFromScene(document) {
  const marker=sceneMarker(document);
  if(marker?.version!==1)throw new Error('This scene is not a MapGen battlemap.');
  assertSupportedScene(document);
  const src=document.firstLevel?.background?.src??document.background?.src??'';
  const warnings=[...(marker.warnings??[])];
  const {door:D,state:DS,sense:S,movement:M}=nativeConstants();
  const scene={
    version:1,name:document.name,image:{width:document.width,height:document.height},
    grid:{size:document.grid.size,distance:document.grid.distance,units:document.grid.units},
    walls:[],doors:[],windows:[],lights:[],
    darkness:document.environment?.darknessLevel??0,
    globalLight:document.environment?.globalLight?.enabled??true
  };
  if(marker.image&&(marker.image.width!==document.width||marker.image.height!==document.height))
    warnings.push('Native scene dimensions have changed since import. The preview uses the current scene coordinate frame.');
  if((document.grid.type??1)!==(globalThis.CONST?.GRID_TYPES?.SQUARE??1))
    warnings.push('The native grid is no longer square. The preview only shows square-grid spacing; the native grid is unchanged.');
  if(!src)warnings.push('The native scene has no background image.');
  let specialWalls=false;
  for(const wall of documents(document.walls)) {
    const data=wall.toObject?wall.toObject():wall,c=data.c;
    if(!Array.isArray(c)||c.length!==4||!c.every(Number.isFinite)) {
      warnings.push(`Native wall ${documentId(wall)??''} has invalid coordinates and is omitted from the preview.`);
      continue;
    }
    const segment={x1:c[0],y1:c[1],x2:c[2],y2:c[3]};
    if(data.door===D.DOOR||data.door===D.SECRET) {
      const state=data.ds===DS.OPEN?'open':data.ds===DS.LOCKED?'locked':'closed';
      scene.doors.push({...segment,secret:data.door===D.SECRET,state});
    } else if(data.move===M.NORMAL&&data.light===S.NONE&&data.sight===S.NONE&&data.sound===S.NONE)
      scene.windows.push(segment);
    else {
      scene.walls.push(segment);
      if(data.move!==M.NORMAL||[data.light,data.sight,data.sound].some(value=>value!==S.NORMAL))specialWalls=true;
    }
  }
  if(specialWalls)warnings.push('Some native walls have custom blocking rules. The preview shows their positions; their native rules remain unchanged.');
  const {lights,lighting}=readLighting(document,warnings);
  scene.lights=lights;
  return {scene,src,sceneId:document.id,warnings,lighting};
}

function lightingFlagUpdate(previous,next,scope) {
  if(next==null)return {[`flags.${scope}.-=lighting`]:null};
  const value=structuredClone(next);
  if(value&&typeof value==='object'&&!Array.isArray(value)&&previous&&typeof previous==='object')
    for(const key of Object.keys(previous))if(!Object.hasOwn(value,key))value[`-=${key}`]=null;
  return {[`flags.${scope}.lighting`]:value};
}

function lightRadiusUpdate(previous,next,scope) {
  return {
    _id:previous.id,'config.dim':next.dim,'config.bright':next.bright,
    ...lightingFlagUpdate(previous.flag,next.flag,scope)
  };
}

function partiallyWrittenFlag(live,previous,next) {
  if(!live||typeof live!=='object'||Array.isArray(live))return false;
  return [...new Set([...Object.keys(live),...Object.keys(previous??{}),...Object.keys(next??{})])]
    .every(key=>same(live[key],previous?.[key])||same(live[key],next?.[key]));
}

async function saveLighting(document,update,state) {
  const {lighting}=readLighting(document,[]);
  const before=lightingSnapshot(document);
  const {scope}=before;
  const {radiusScale:openedScale,...openedSnapshot}=state.snapshot??{};
  if(!same(openedSnapshot,before)||openedScale!==lighting.radiusScale)
    throw new Error('Native lights or their tuning changed since opening. Reopen the scene before changing light radii.');
  const targets=scaleLights(lighting.baseLights,state.radiusScale).filter(light=>light.managed);
  const expected=structuredClone(before);
  for(const light of targets) {
    const item=expected.lights.find(item=>item.id===light.id);
    item.dim=light.dim;item.bright=light.bright;item.flag=light.lighting;
  }
  const changes=expected.lights.filter((item,index)=>!same(item,before.lights[index]));
  const settingsBefore=Object.fromEntries(Object.keys(update).map(key=>[key,fieldValue(document,key)]));
  const nextFlag={version:1,radiusScale:state.radiusScale};
  let sceneWriteStarted=false;
  try {
    if(changes.length)await document.updateEmbeddedDocuments('AmbientLight',
      changes.map(next=>lightRadiusUpdate(before.lights.find(item=>item.id===next.id),next,scope)));
    if(!same(lightingSnapshot(document),expected))
      throw new Error('Foundry did not apply every light radius update, or native lights changed during the save.');
    if(Object.entries(settingsBefore).some(([key,value])=>fieldValue(document,key)!==value))
      throw new Error('Scene settings changed during light tuning.');
    sceneWriteStarted=true;
    await document.update({...update,...lightingFlagUpdate(before.flag,nextFlag,scope)});
    if(Object.entries(update).some(([key,value])=>fieldValue(document,key)!==value)
      ||!same(lightingSnapshot(document),{...expected,flag:nextFlag}))
      throw new Error('Foundry did not persist the requested light tuning and scene settings.');
  } catch(error) {
    const failures=[];
    const current=lightingSnapshot(document),restore=[];
    for(const next of changes) {
      const old=before.lights.find(item=>item.id===next.id),live=current.lights.find(item=>item.id===next.id);
      if(!live) {failures.push(`Light ${next.id} was removed; it was not recreated.`);continue;}
      const patch={_id:next.id};
      for(const key of ['dim','bright','flag']) {
        if(same(live[key],old[key]))continue;
        if(!same(live[key],next[key])&&(key!=='flag'||!partiallyWrittenFlag(live.flag,old.flag,next.flag))) {
          failures.push(`Light ${next.id} ${key} changed again; that edit was retained.`);continue;
        }
        if(key==='flag')Object.assign(patch,lightingFlagUpdate(live.flag,old.flag,scope));
        else patch[`config.${key}`]=old[key];
      }
      if(Object.keys(patch).length>1)restore.push(patch);
    }
    if(restore.length) {
      try {
        await document.updateEmbeddedDocuments('AmbientLight',restore);
        const restored=lightingSnapshot(document);
        if(changes.some(next=>!same(restored.lights.find(item=>item.id===next.id),before.lights.find(item=>item.id===next.id))))
          throw new Error('Foundry did not restore all prior light radii and flags.');
      } catch(rollback) {failures.push(rollback.message);}
    }
    if(sceneWriteStarted) {
      const patch={};
      for(const [key,value] of Object.entries(settingsBefore)) {
        const live=fieldValue(document,key);
        if(live===value)continue;
        if(live!==update[key]) {failures.push(`Scene ${key} changed again; that edit was retained.`);continue;}
        patch[key]=value;
      }
      const liveFlag=document.flags?.[scope]?.lighting??null;
      if(!same(liveFlag,before.flag)) {
        if(same(liveFlag,nextFlag)||partiallyWrittenFlag(liveFlag,before.flag,nextFlag))
          Object.assign(patch,lightingFlagUpdate(liveFlag,before.flag,scope));
        else failures.push('Scene light tuning changed again; that edit was retained.');
      }
      if(Object.keys(patch).length) {
        try {
          await document.update(patch);
          if(Object.entries(settingsBefore).some(([key,value])=>fieldValue(document,key)!==value)
            ||!same(document.flags?.[scope]?.lighting??null,before.flag))
            throw new Error('Foundry did not restore prior scene settings and light tuning.');
        } catch(rollback) {failures.push(rollback.message);}
      }
    }
    throw new Error(`Light radius tuning failed: ${error.message} ${failures.length
      ?`Rollback incomplete: ${failures.join(' ')}`
      :'Previous radii, flags and settings were restored.'} Reopen the scene before retrying.`,{cause:error});
  }
}

export async function saveSceneSettings(document,settings,lightingState) {
  if(!isImportedScene(document))
    throw new Error('This scene is not a MapGen battlemap.');
  const update=sceneSettings(settings);
  if(lightingState) {
    if(!isLightRadiusScale(lightingState.radiusScale))
      throw new Error('Choose a light radius of 25%, 50%, 75%, 100% or 125%.');
    const openedScale=lightingState.snapshot?.radiusScale??readLighting(document,[]).lighting.radiusScale;
    if(lightingState.radiusScale!==openedScale)return saveLighting(document,update,lightingState);
  }
  await document.update(update);
  if(Object.entries(update).some(([key,value])=>fieldValue(document,key)!==value))
    throw new Error('Foundry did not apply the requested scene settings. Reopen the scene to inspect its current settings.');
}
