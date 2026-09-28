import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_LIGHT_RADIUS_SCALE,LIGHT_RADIUS_SCALES,normalizeLightAnimation,scaleLights} from '../scripts/lighting.js';
import {normalizeScene} from '../scripts/scene-import.js';
import {buildNativeData} from '../scripts/foundry-data.js';

const image={width:1000,height:800};
const source=(x=100,y=100)=>({x,y,dim:20,bright:4,color:'#ffb45b',alpha:.25});
const raw=overrides=>({
  version:1,image,grid:{size:50,distance:5,units:'ft'},
  walls:[{x1:20,y1:20,x2:400,y2:20}],doors:[],windows:[],...overrides
});

test('conservative radius defaults halve coverage radii without compounding or moving sources',()=>{
  const base=[source()],before=structuredClone(base);
  assert.equal(DEFAULT_LIGHT_RADIUS_SCALE,.5);
  for(const scale of LIGHT_RADIUS_SCALES) {
    const [light]=scaleLights(base,scale);
    assert.equal(light.dim,20*scale);
    assert.equal(light.bright,4*scale);
    assert.equal(light.x,100);
    assert.equal(light.y,100);
    assert.equal(light.color,base[0].color);
    assert.equal(light.alpha,base[0].alpha);
    assert.deepEqual(light.lighting,{version:1,baseDim:20,baseBright:4,radiusScale:scale,appliedDim:20*scale,appliedBright:4*scale});
  }
  assert.deepEqual(scaleLights(base,.5),scaleLights(base,.5));
  assert.deepEqual(base,before);
});

test('later native-added lights are not changed by the imported radius control',()=>{
  const base=[source(),{...source(500,500),managed:false,id:'native-added'}];
  const lights=scaleLights(base,.25);
  assert.equal(lights[0].dim,5);
  assert.deepEqual(lights[1],base[1]);
  assert.equal(lights[1].lighting,undefined);
});

test('invalid tuning values report an explicit control error',()=>{
  for(const value of [0,-1,NaN,Infinity,2,'0.5',undefined])
    assert.throws(()=>scaleLights([source()],value),/Choose a light radius/);
});

test('image-only and absent lighting remain successful without darkening defaults',()=>{
  for(const input of [undefined,raw({}),raw({lights:[]})]) {
    const result=normalizeScene(input,image);
    assert.deepEqual(result.scene.lights,[]);
    assert.equal(result.scene.darkness,0);
    assert.equal(result.scene.globalLight,true);
    assert.deepEqual(result.warnings,[]);
  }
});

test('warm tavern imports keep localized emitters, discard duplicate/inert records and remain readable',()=>{
  const input=raw({lights:[
    source(),{...source(100.2,100.1),color:'#FFB45B'},
    {x:400,y:300,dim:0,bright:0,color:'#ffb45b'},
    {x:600,y:300,dim:12,bright:2,color:'#ffcc88'}
  ]});
  const result=normalizeScene(input,image);
  assert.equal(result.scene.lights.length,2);
  assert.equal(result.scene.lights[1].alpha,.25);
  assert.equal(result.scene.globalLight,true);
  assert.equal(result.scene.darkness,0);
  assert.match(result.warnings.join(' '),/duplicate/);
  assert.match(result.warnings.join(' '),/no gameplay radius/);
  assert.deepEqual(result.scene.walls,input.walls);
  assert.deepEqual(result.scene.image,image);
});

test('icy palace duplicate blue glows do not multiply emitters and conservative radii reduce overlap footprint',()=>{
  const emitters=Array.from({length:8},(_,i)=>({...source(100+i*90,300),color:'#66ccff',dim:25,bright:6}));
  const input=raw({name:'Icy palace',lights:[...emitters,...emitters.map(l=>({...l})),{x:100,y:500,dim:0,bright:0}]});
  const result=normalizeScene(input,image);
  assert.equal(result.scene.lights.length,8);
  const tuned=scaleLights(result.scene.lights,DEFAULT_LIGHT_RADIUS_SCALE);
  assert.equal(tuned.reduce((sum,l)=>sum+l.dim*l.dim,0),emitters.reduce((sum,l)=>sum+l.dim*l.dim,0)/4);
  assert.equal(result.scene.globalLight,true);
  assert.equal(result.scene.darkness,0);
  assert.deepEqual(tuned.map(l=>[l.x,l.y]),emitters.map(l=>[l.x,l.y]));
});

test('decorative magical ambience alone creates no inferred gameplay emitter',()=>{
  const decorative=normalizeScene(raw({name:'Magical chamber',description:'Luminous floor art and reflected violet aura',decorativeGlow:true}),image);
  assert.deepEqual(decorative.scene.lights,[]);
  assert.equal(decorative.scene.globalLight,true);
  const focal=normalizeScene(raw({name:'Magical chamber',lights:[{...source(500,400),color:'#aa66ff',dim:15,bright:3}]}),image);
  assert.equal(focal.scene.lights.length,1);
  assert.equal(scaleLights(focal.scene.lights,.5)[0].bright,1.5);
});

test('explicit darkness and global illumination remain authoritative and editable',()=>{
  const result=normalizeScene(raw({lights:[source()],globalLight:true,darkness:.15}),image);
  assert.equal(result.scene.globalLight,true);
  assert.equal(result.scene.darkness,.15);
  const night=normalizeScene(raw({lights:[],globalLight:false,darkness:.8}),image);
  assert.equal(night.scene.darkness,.8);
  assert.equal(night.scene.globalLight,false);
});

test('readable interiors can combine global illumination with local effects without a contradictory warning',()=>{
  const result=normalizeScene(raw({lights:Array.from({length:9},(_,i)=>source(50+i*80,200)),globalLight:true,darkness:0}),image);
  assert.equal(result.scene.lights.length,9);
  assert.equal(result.scene.globalLight,true);
  assert.equal(result.scene.darkness,0);
  assert.deepEqual(result.warnings,[]);
});

test('malformed optional lighting cannot reject the scene or invent replacement sources',()=>{
  const result=normalizeScene(raw({lights:[null,{x:'bad',y:3},source(100,100),{x:5,y:5,dim:-2,bright:'oops'}]}),image);
  assert.equal(result.scene.lights.length,1);
  assert.deepEqual(result.scene.walls,raw({}).walls);
  assert.ok(result.warnings.length>0);
});

test('absurd radii recover as optional metadata errors without overflow or image rejection',()=>{
  const result=normalizeScene(raw({lights:[{...source(),dim:1e308,bright:1e308},source(300,300)]}),image);
  assert.equal(result.scene.lights.length,1);
  assert.equal(scaleLights(result.scene.lights,1.25)[0].dim,25);
  assert.match(result.warnings.join(' '),/invalid value/);
});

test('warm flame, icy pulse and magical focal effects retain their color, intensity and animation when toned down',()=>{
  for(const [color,type,luminosity]of [['#ffb45b','torch',.45],['#66ccff','pulse',.55],['#aa66ff','flame',.6]]) {
    const result=normalizeScene(raw({lights:[{...source(),color,luminosity,animation:{type,speed:2,intensity:3,reverse:false}}]}),image);
    const [light]=scaleLights(result.scene.lights,.25);
    assert.equal(light.dim,5);
    assert.equal(light.bright,1);
    assert.equal(light.color,color);
    assert.equal(light.luminosity,luminosity);
    assert.deepEqual(light.animation,{type,speed:2,intensity:3,reverse:false});
  }
});

test('different intentional effects at the same pixel are not mistaken for duplicate emitters',()=>{
  const result=normalizeScene(raw({lights:[
    {...source(),animation:{type:'torch'}},
    {...source(),animation:{type:'pulse'}},
    {...source(),luminosity:.7}
  ]}),image);
  assert.equal(result.scene.lights.length,3);
  assert.deepEqual(result.warnings,[]);
});

test('malformed or unavailable animation becomes static without dropping a usable light',()=>{
  const result=normalizeScene(raw({lights:[
    {...source(),animation:{type:'unknown-shader'}},
    {...source(200,200),luminosity:2,animation:{type:'pulse',speed:-1,intensity:99,reverse:'no'}},
    {...source(300,300),animation:'torch'}
  ]}),image);
  assert.equal(result.scene.lights.length,3);
  assert.equal(result.scene.lights[0].animation,undefined);
  assert.equal(result.scene.lights[1].luminosity,1);
  assert.deepEqual(result.scene.lights[1].animation,{type:'pulse',speed:0,intensity:10,reverse:false});
  assert.deepEqual(result.scene.lights[2].animation,{type:'torch',speed:5,intensity:5,reverse:false});
  assert.match(result.warnings.join(' '),/kept the light static/);
});

test('registered Foundry animation keys are accepted without inventing shader implementations',t=>{
  const original=globalThis.CONFIG;
  t.after(()=>{if(original===undefined)delete globalThis.CONFIG;else globalThis.CONFIG=original;});
  globalThis.CONFIG={Canvas:{lightAnimations:{customGlow:{}}}};
  const result=normalizeScene(raw({lights:[{...source(),animation:{type:'customGlow',speed:1,intensity:2}}]}),image);
  assert.equal(result.scene.lights[0].animation.type,'customGlow');
});

for(const name of ["Example dwelling",'Tavern','Shop','Large complex','Magical chamber']) {
  test(`${name}: local animated emitters never infer gameplay darkness`,()=>{
    const result=normalizeScene(raw({name,lights:[
      {...source(),animation:{type:'torch',speed:1.6,intensity:1.5},luminosity:.5},
      {...source(500,400),color:'#a855f7',animation:{type:'pulse',speed:1,intensity:2},luminosity:.6}
    ]}),image);
    assert.equal(result.scene.globalLight,true);
    assert.equal(result.scene.darkness,0);
    assert.equal(result.scene.lights.length,2);
    const native=buildNativeData({...result.scene,lights:scaleLights(result.scene.lights,.5)});
    assert.deepEqual(native.lights[0].config.animation,{type:'torch',speed:2,intensity:2,reverse:false});
    assert.equal(native.lights[1].config.animation.type,'pulse');
    assert.equal(native.lights[1].config.color,'#a855f7');
    assert.equal(native.lights[1].config.luminosity,.6);
    assert.match(result.warnings.join(' '),/normalized to native integer 2/);
  });
}

test('explicit Occupied-interior dark settings and intentional dark cave/crypt settings survive unchanged',()=>{
  for(const [name,globalLight,darkness]of [
    ["Example dwelling",false,.46],['Unlit cave',false,.8],['Abandoned crypt',false,1],
    ['Inhabited underground palace',true,.1]
  ]) {
    const result=normalizeScene(raw({name,globalLight,darkness,lights:[source()]}),image);
    assert.equal(result.scene.globalLight,globalLight);
    assert.equal(result.scene.darkness,darkness);
  }
});

test('missing environment fields use readable fallbacks independently of each other or local lights',()=>{
  for(const lights of [[],[source()]]) {
    assert.equal(normalizeScene(raw({lights,globalLight:false}),image).scene.darkness,0);
    assert.equal(normalizeScene(raw({lights,darkness:.8}),image).scene.globalLight,true);
    const invalid=normalizeScene(raw({lights,globalLight:'no',darkness:'bad'}),image);
    assert.equal(invalid.scene.globalLight,true);
    assert.equal(invalid.scene.darkness,0);
    assert.ok(invalid.warnings.length>=2);
  }
});

test('small animation intent mapping preserves native names and resolves only safe synonyms',()=>{
  const catalog={torch:{},flame:{},pulse:{},customGlow:{},fire:{}};
  for(const [input,type]of [['torch','torch'],[' Flame ','flame'],['PULSE','pulse'],
    ['flicker','torch'],['candle','torch'],['candlelight','torch'],['pulsing','pulse'],
    ['slow pulse','pulse'],['fire','fire'],['CUSTOMGLOW','customGlow']]) {
    const result=normalizeLightAnimation({type:input,speed:3,intensity:2,reverse:true},{catalog});
    assert.deepEqual(result,{type,speed:3,intensity:2,reverse:true});
  }
  assert.equal(normalizeLightAnimation({type:'fire'},{catalog:{flame:{}}}).type,'flame');
  assert.equal(normalizeLightAnimation({type:'flicker'},{catalog:{pulse:{}}}),undefined);
});

test('positive fractional speed cannot silently become paused; explicit zero remains paused',()=>{
  for(const [speed,expected]of [[.2,1],[.49,1],[1.6,2],[3,3],[0,0],[10.2,10]]) {
    const warnings=[];
    const result=normalizeLightAnimation({type:'torch',speed,intensity:1.5},{warn:w=>warnings.push(w)});
    assert.equal(result.speed,expected);
    assert.equal(result.intensity,2);
    assert.match(warnings.join(' '),/native integer/);
  }
});

test('missing animation parameters use visible native midpoint defaults independently of light reach and brightness',()=>{
  for(const type of ['torch','flame','pulse']) {
    const parsed=normalizeScene(raw({lights:[{...source(),luminosity:.4,animation:{type}}]}),image);
    const scaled=scaleLights(parsed.scene.lights,.25);
    const native=buildNativeData({...parsed.scene,lights:scaled}).lights[0];
    assert.deepEqual(native.config.animation,{type,speed:5,intensity:5,reverse:false});
    assert.equal(native.config.dim,5);
    assert.equal(native.config.bright,1);
    assert.equal(native.config.luminosity,.4);
    assert.equal(native.config.alpha,.25);
    assert.equal(native.config.color,'#ffb45b');
  }
});

test('invalid animation parameters recover to midpoint defaults but explicit subtle or paused intent remains authoritative',()=>{
  const warnings=[];
  assert.deepEqual(normalizeLightAnimation({type:'torch',speed:'bad',intensity:null},{warn:w=>warnings.push(w)}),
    {type:'torch',speed:5,intensity:5,reverse:false});
  assert.equal(warnings.filter(w=>w.includes('using 5')).length,2);
  for(const speed of [0,1,2])assert.deepEqual(normalizeLightAnimation({type:'pulse',speed,intensity:1}),
    {type:'pulse',speed,intensity:1,reverse:false});
});

test('serialization independently normalizes intents and drops only bad animation, not the emitter',()=>{
  const native=buildNativeData({...raw({}),lights:[
    {...source(),animation:{type:'flicker',speed:.2,intensity:1.5},luminosity:.4},
    {...source(300,300),animation:{type:'unknown-effect'}},
    {...source(500,500),animation:{speed:2}},
    source(700,700)
  ]});
  assert.equal(native.lights.length,4);
  assert.deepEqual(native.lights[0].config.animation,{type:'torch',speed:1,intensity:2,reverse:false});
  assert.equal(native.lights[0].config.luminosity,.4);
  for(const light of native.lights.slice(1))assert.equal(light.config.animation,undefined);
  assert.match(native.warnings.join(' '),/kept the light static/);
});
