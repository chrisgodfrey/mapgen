import {normalizeLightAnimation} from './lighting.js';

const MODULE_ID='mapgen';
export const IMPORT_SCENE_FRAME=Object.freeze({padding:0,shiftX:0,shiftY:0});

export function nativeConstants() {
  const c=globalThis.CONST??{};
  return {
    sense:c.EDGE_SENSE_TYPES??{NONE:0,NORMAL:20},
    movement:c.WALL_MOVEMENT_TYPES??{NONE:0,NORMAL:20},
    door:c.WALL_DOOR_TYPES??{NONE:0,DOOR:1,SECRET:2},
    state:c.WALL_DOOR_STATES??{CLOSED:0,OPEN:1,LOCKED:2}
  };
}

class InvalidRecord extends Error {}

export function isNativeValidationError(error) {
  const ValidationError=globalThis.foundry?.data?.validation?.DataModelValidationError;
  return error instanceof InvalidRecord
    || (typeof ValidationError==='function'&&error instanceof ValidationError)
    || ['DataModelValidationError','ValidationError'].includes(error?.name)
    || /^(?:(?:Wall|AmbientLight)(?: \[[^\]\r\n]+\])? validation errors?:|DataModelValidationError:)/i.test(error?.message??'');
}

function coordinates(segment) {
  if(!segment||typeof segment!=='object'||Array.isArray(segment))
    throw new InvalidRecord('The structural segment must be an object.');
  const c=[segment.x1,segment.y1,segment.x2,segment.y2];
  if(!c.every(Number.isFinite))throw new InvalidRecord('Coordinates must be finite numbers.');
  if(c[0]===c[2]&&c[1]===c[3])throw new InvalidRecord('The segment has no length.');
  return c;
}

// The combined public snapping modes at API resolution 4 give a fixed eighth-cell lattice.
export function normalizeStructure(scene,{origin={x:0,y:0}}={}) {
  // The grid origin in image pixels is (-sceneX, -sceneY); IMPORT_SCENE_FRAME makes both zero.
  const warnings=[],keys=['walls','doors','windows'];
  if(!keys.some(key=>scene[key]?.length))return {scene,warnings};
  const square=globalThis.CONST?.GRID_TYPES?.SQUARE??1;
  if((scene.grid?.type??square)!==square)return {scene,warnings};
  const suppliedSize=scene.grid?.size,{width,height}=scene.image??{};
  if(![suppliedSize,width,height,origin.x,origin.y].every(Number.isFinite)||suppliedSize<=0||width<=0||height<=0)
    return {scene,warnings:['Structural snapping could not use this grid/frame; supplied geometry was retained.']};
  // Match the size Foundry will store, without modifying the supplied gameplay settings.
  let size;
  try {
    const field=globalThis.CONFIG?.Scene?.documentClass?.schema?.fields?.grid?.fields?.size;
    size=typeof field?.clean==='function'?field.clean(suppliedSize):Math.round(suppliedSize);
    if(!Number.isFinite(size)||size<=0)throw new InvalidRecord('Invalid native grid size.');
  } catch(error) {
    return {scene,warnings:[`Structural snapping retained supplied geometry: ${error.message}`]};
  }
  const resolution=8,spacing=size/resolution;
  const Grid=globalThis.foundry?.grid?.SquareGrid,modes=globalThis.CONST?.GRID_SNAPPING_MODES;
  let grid;
  if(Grid&&modes) {
    try {grid=new Grid({size,distance:scene.grid.distance,units:scene.grid.units});}
    catch(error) {warnings.push(`Foundry grid snapping unavailable; equivalent local snapping was used: ${error.message}`);}
  }
  const snap=point=>grid?grid.getSnappedPoint(point,{
    mode:modes.CENTER|modes.VERTEX|modes.CORNER|modes.SIDE_MIDPOINT,resolution:resolution/2
  }):{x:Math.round(point.x/spacing)*spacing,y:Math.round(point.y/spacing)*spacing};
  const offsets=[origin.x,origin.y,origin.x,origin.y];
  const clean=values=>{
    const field=globalThis.CONFIG?.Wall?.documentClass?.schema?.fields?.c;
    const native=typeof field?.clean==='function'?field.clean(values):values.map(Math.round);
    if(!Array.isArray(native)||native.length!==4||!native.every(Number.isFinite))
      throw new InvalidRecord('Foundry could not clean these wall coordinates.');
    return native.map((value,index)=>value+offsets[index]);
  };
  const usable=c=>c[0]!==c[2]||c[1]!==c[3];
  const inBounds=c=>c.every((value,index)=>value>=0&&value<=(index%2?height:width));
  const result={...scene};
  for(const key of keys) {
    result[key]=[];
    if(scene[key]!==undefined&&!Array.isArray(scene[key])) {
      warnings.push(`${key}: malformed collection skipped during structural snapping.`);
      continue;
    }
    for(const [index,segment]of (scene[key]??[]).entries()) {
      let raw,normalized;
      try {
        raw=coordinates(segment).map((value,i)=>value-offsets[i]);
        const a=snap({x:raw[0],y:raw[1]}),b=snap({x:raw[2],y:raw[3]});
        normalized=clean([a.x,a.y,b.x,b.y]);
        if(!usable(normalized)||!inBounds(normalized))
          throw new InvalidRecord('Snapping would collapse the segment or move it outside the image.');
      } catch(error) {
        try {
          normalized=raw?clean(raw):null;
          if(!normalized||!usable(normalized)||!inBounds(normalized)) {
            warnings.push(`${key}[${index}]: unusable structural segment skipped: ${error.message}`);
            continue;
          }
          warnings.push(`${key}[${index}]: supplied coordinates retained with native pixel precision: ${error.message}`);
        } catch(cleanup) {
          warnings.push(`${key}[${index}]: structural segment skipped: ${error.message} ${cleanup.message}`);
          continue;
        }
      }
      const [x1,y1,x2,y2]=normalized;
      result[key].push({...segment,x1,y1,x2,y2});
    }
  }
  return {scene:result,warnings,resolution,spacing};
}

function wallData(segment,kind) {
  const {sense:S,movement:M,door:D,state:DS}=nativeConstants();
  const data={
    c:coordinates(segment),move:M.NORMAL,light:S.NORMAL,sight:S.NORMAL,sound:S.NORMAL,
    door:D.NONE,ds:DS.CLOSED,flags:{[MODULE_ID]:{kind}}
  };
  if(kind==='door') {
    data.door=segment.secret?D.SECRET:D.DOOR;
    data.ds=DS[String(segment.state??'closed').toUpperCase()];
    if(data.ds===undefined)throw new InvalidRecord('Unknown door state.');
  }
  if(kind==='window')data.light=data.sight=data.sound=S.NONE;
  return data;
}

function lightData(light,warn) {
  if(![light.x,light.y,light.dim,light.bright,light.alpha].every(Number.isFinite))
    throw new InvalidRecord('Light coordinates, radii and alpha must be finite numbers.');
  if(light.dim<0||light.bright<0||light.alpha<0||light.alpha>1)
    throw new InvalidRecord('Light radii must be nonnegative and alpha must be between 0 and 1.');
  const animation=normalizeLightAnimation(light.animation,{warn});
  return {
    x:light.x,y:light.y,walls:true,vision:false,hidden:false,
    config:{dim:light.dim,bright:light.bright,color:light.color,alpha:light.alpha,
      ...(light.luminosity!==undefined?{luminosity:light.luminosity}:{}),
      ...(animation?{animation}:{})},
    ...(light.lighting?{flags:{[MODULE_ID]:{lighting:structuredClone(light.lighting)}}}:{})
  };
}

function checkedRecord(type,data) {
  const DocumentClass=globalThis.CONFIG?.[type]?.documentClass;
  if(!DocumentClass)return data;
  // Use the installed host's own coordinate cleaning; lights do not share structural snapping.
  for(const key of type==='Wall'?['c']:['x','y']) {
    const field=DocumentClass.schema?.fields?.[key];
    if(typeof field?.clean!=='function')
      throw new Error(`Foundry ${type} ${key} coordinate field is unavailable. Reload Foundry before importing.`);
    data[key]=field.clean(data[key]);
    const values=key==='c'?data[key]:[data[key]];
    if(!Array.isArray(values)||values.length!==(key==='c'?4:1)||!values.every(Number.isFinite))
      throw new InvalidRecord(`Foundry rejected the ${key} coordinate field.`);
  }
  if(type==='Wall'&&data.c[0]===data.c[2]&&data.c[1]===data.c[3])
    throw new InvalidRecord('The segment has no length after Foundry coordinate cleaning.');
  const document=new DocumentClass(data,{strict:true});
  if(document.validate?.({strict:true})===false)throw new InvalidRecord('Foundry rejected this record.');
  return data;
}

// Only exact collinearity cuts a wall. Nearby, detached openings are never snapped into it.
export function cutWallOpenings(wall,openings) {
  const [x,y,x2,y2]=coordinates(wall),dx=x2-x,dy=y2-y;
  const intervals=[];
  for(const opening of openings) {
    const [ax,ay,bx,by]=coordinates(opening);
    if((ax-x)*dy!==(ay-y)*dx||(bx-x)*dy!==(by-y)*dx)continue;
    const a=Math.abs(dx)>=Math.abs(dy)?(ax-x)/dx:(ay-y)/dy;
    const b=Math.abs(dx)>=Math.abs(dy)?(bx-x)/dx:(by-y)/dy;
    const start=Math.max(0,Math.min(a,b)),end=Math.min(1,Math.max(a,b));
    if(end>start)intervals.push({
      start,end,
      from:start===0?[x,y]:a<b?[ax,ay]:[bx,by],
      to:end===1?[x2,y2]:a<b?[bx,by]:[ax,ay]
    });
  }
  intervals.sort((a,b)=>a.start-b.start);
  const parts=[];
  let cursor=0,from=[x,y];
  const append=(a,b)=>parts.push({x1:a[0],y1:a[1],x2:b[0],y2:b[1]});
  for(const interval of intervals) {
    if(interval.start>cursor)append(from,interval.from);
    if(interval.end>cursor) {
      cursor=interval.end;
      from=interval.to;
    }
  }
  if(cursor<1)append(from,[x2,y2]);
  return parts;
}

export function buildNativeData(scene) {
  const walls=[],lights=[],warnings=[],openings=[];
  const add=(type,label,data,output)=>{
    try {output.push(checkedRecord(type,data()));return true;}
    catch(error) {
      if(!isNativeValidationError(error))throw error;
      warnings.push(`${label} skipped: ${error.message}`);
      return false;
    }
  };
  for(const [kind,items] of [['door',scene.doors??[]],['window',scene.windows??[]]]) {
    items.forEach((item,index)=>{
      if(add('Wall',`${kind} ${index+1}`,()=>wallData(item,kind),walls))openings.push(item);
    });
  }
  (scene.walls??[]).forEach((wall,index)=>{
    let parts;
    try {parts=cutWallOpenings(wall,openings);}
    catch(error) {
      if(!isNativeValidationError(error))throw error;
      warnings.push(`wall ${index+1} skipped: ${error.message}`);
      return;
    }
    for(const part of parts)add('Wall',`wall ${index+1}`,()=>wallData(part,'wall'),walls);
  });
  (scene.lights??[]).forEach((light,index)=>add('AmbientLight',`light ${index+1}`,
    ()=>lightData(light,message=>warnings.push(`light ${index+1}: ${message}`)),lights));
  return {walls,lights,warnings};
}
