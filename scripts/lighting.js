export const DEFAULT_LIGHT_RADIUS_SCALE=0.5;
export const LIGHT_RADIUS_SCALES=Object.freeze([0.25,0.5,0.75,1,1.25]);
export const isLightRadiusScale=value=>LIGHT_RADIUS_SCALES.includes(value);

const ANIMATION_ALIASES=Object.freeze({
  fire:'flame',flicker:'torch',flickering:'torch',candle:'torch',candlelight:'torch',
  'torch flicker':'torch','flame flicker':'flame','slow pulse':'pulse',pulsing:'pulse'
});
const PORTABLE_ANIMATIONS=Object.freeze({torch:true,flame:true,pulse:true});
const DEFAULT_ANIMATION_PARAMETER=5;

export function normalizeLightAnimation(value,{catalog=globalThis.CONFIG?.Canvas?.lightAnimations,
  warn=()=>{},label='Light animation'}={}) {
  if(value==null)return undefined;
  const source=typeof value==='string'?{type:value}:value;
  if(!source||typeof source!=='object'||Array.isArray(source)||typeof source.type!=='string') {
    warn(`${label}: invalid animation; kept the light static.`);
    return undefined;
  }
  const requested=source.type.trim();
  if(!requested)return undefined;
  const registered=catalog??PORTABLE_ANIMATIONS;
  const lower=requested.toLowerCase();
  let type=Object.hasOwn(registered,requested)?requested:
    Object.keys(registered).find(key=>key.toLowerCase()===lower);
  if(!type) {
    const alias=Object.hasOwn(ANIMATION_ALIASES,lower)?ANIMATION_ALIASES[lower]:null;
    if(alias&&Object.hasOwn(registered,alias))type=alias;
  }
  if(!type) {
    warn(`${label}: unsupported animation "${requested}"; kept the light static.`);
    return undefined;
  }
  if(type!==requested)warn(`${label}: mapped "${requested}" to native "${type}".`);
  if(typeof value==='string')warn(`${label}: converted an animation name to settings.`);
  const parameter=(key,min)=>{
    const raw=source[key];
    if(raw===undefined)return DEFAULT_ANIMATION_PARAMETER;
    const numeric=typeof raw==='number'?raw:
      typeof raw==='string'&&/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim())?Number(raw):NaN;
    if(!Number.isFinite(numeric)) {
      warn(`${label}.${key}: invalid value; using ${DEFAULT_ANIMATION_PARAMETER}.`);
      return DEFAULT_ANIMATION_PARAMETER;
    }
    let result=Math.max(min,Math.min(10,Math.round(numeric)));
    // Foundry stores integers; do not accidentally pause a requested positive speed.
    if(key==='speed'&&numeric>0&&result===0)result=1;
    if(result!==raw)warn(`${label}.${key}: normalized to native integer ${result}.`);
    return result;
  };
  let reverse=false;
  if(source.reverse!==undefined) {
    if(typeof source.reverse==='boolean')reverse=source.reverse;
    else warn(`${label}.reverse: invalid boolean; using false.`);
  }
  return {type,speed:parameter('speed',0),intensity:parameter('intensity',1),reverse};
}

export function scaleLights(baseLights,radiusScale) {
  if(!isLightRadiusScale(radiusScale))throw new Error('Choose a light radius of 25%, 50%, 75%, 100% or 125%.');
  return baseLights.map(light=>{
    const {lighting,...source}=light;
    if(light.managed===false)return source;
    const dim=light.dim*radiusScale,bright=light.bright*radiusScale;
    if(!Number.isFinite(dim)||!Number.isFinite(bright)||dim<0||bright<0)
      throw new Error('Light radii must be finite nonnegative distances.');
    return {...source,dim,bright,lighting:{
      version:1,baseDim:light.dim,baseBright:light.bright,radiusScale,appliedDim:dim,appliedBright:bright
    }};
  });
}
