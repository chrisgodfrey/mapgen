import test from 'node:test';
import assert from 'node:assert/strict';
import {buildNativeData,normalizeStructure} from '../scripts/foundry-data.js';

const segment=(x1,y1,x2,y2)=>({x1,y1,x2,y2});
const scene=overrides=>({
  version:1,name:'Structural fixture',image:{width:700,height:560},
  grid:{size:70,distance:5,units:'ft'},walls:[segment(15.4,18.2,103.1,89.6)],
  doors:[],windows:[],lights:[{x:45.25,y:66.75,dim:20,bright:10,color:'#fac864',alpha:.5}],
  darkness:.2,globalLight:true,...overrides
});
const points=record=>[record.x1,record.y1,record.x2,record.y2];

test('70px/5ft gameplay stays unchanged while structural spacing is 8.75px',()=>{
  const source=scene(),before=structuredClone(source);
  const result=normalizeStructure(source);
  assert.equal(result.resolution,8);
  assert.equal(result.spacing,8.75);
  assert.deepEqual(result.scene.grid,{size:70,distance:5,units:'ft'});
  assert.deepEqual(points(result.scene.walls[0]),[18,18,105,88]);
  assert.deepEqual(result.scene.image,before.image);
  assert.deepEqual(result.scene.lights,before.lights);
  assert.deepEqual(source,before);
  assert.deepEqual(result.warnings,[]);
  assert.equal(result.scene.grid.size/result.scene.grid.distance,14);
});

test('fixed eighth-cell precision follows each map rather than the adaptive wall-toolbar thresholds',()=>{
  for(const size of [20,40,45,50,63,64,70,100,127,128,200]) {
    const result=normalizeStructure(scene({grid:{size,distance:5,units:'ft'}}));
    assert.equal(result.resolution,8);
    assert.equal(result.spacing,size/8);
    assert.equal(result.scene.grid.size,size);
  }
});

test('fractional size uses native grid field precision without changing supplied gameplay settings',()=>{
  for(const [size,effective,resolution]of [[63.5,64,8],[70.5,71,8],[127.999,128,8]]) {
    const source=scene({grid:{size,distance:5,units:'ft'}});
    const result=normalizeStructure(source);
    assert.equal(result.spacing,effective/resolution);
    assert.equal(result.resolution,resolution);
    assert.deepEqual(result.scene.grid,source.grid);
    const expected=Math.round(Math.round(15.4/result.spacing)*result.spacing);
    assert.equal(result.scene.walls[0].x1,expected);
  }
});

for(const [name,size]of [['Small interior',120],['Medium building',70],['Large complex',45]]) {
  test(`${name} scale regression: same raster can use ${size}px per five-foot square`,()=>{
    const source=scene({
      name,image:{width:1448,height:1086},grid:{size,distance:5,units:'ft'},
      walls:[segment(13.2,27.3,325.1,61.8)],
      doors:[{...segment(60.2,80.4,60.2+size*.8,80.4),state:'closed',secret:false}],
      windows:[segment(80.2,110.7,80.2+size*.6,110.7)]
    });
    const before=structuredClone(source),result=normalizeStructure(source);
    assert.equal(result.spacing,size/8);
    assert.deepEqual(result.scene.grid,{size,distance:5,units:'ft'});
    for(const key of ['walls','doors','windows'])assert.deepEqual(points(result.scene[key][0]),
      points(source[key][0]).map(value=>Math.round(Math.round(value/(size/8))*(size/8))));
    assert.deepEqual(result.scene.lights,source.lights);
    assert.deepEqual(result.scene.image,{width:1448,height:1086});
    assert.deepEqual(source,before);
  });
}

test('walls, doors and windows share exactly the same endpoint rule and retain properties',()=>{
  const source=scene({
    walls:[{...segment(15.4,18.2,103.1,89.6),kind:'wall',dir:1}],
    doors:[{...segment(15.4,18.2,103.1,89.6),state:'locked',secret:true,dir:2}],
    windows:[{...segment(15.4,18.2,103.1,89.6),kind:'window',move:20,sight:0,light:0}]
  });
  const {scene:result}=normalizeStructure(source);
  for(const key of ['walls','doors','windows']) {
    assert.deepEqual(points(result[key][0]),[18,18,105,88]);
    const {x1,y1,x2,y2,...properties}=source[key][0];
    const {x1:a,y1:b,x2:c,y2:d,...retained}=result[key][0];
    assert.deepEqual(retained,properties);
  }
});

test('nearby join points become identical only when they choose the same lattice vertex',()=>{
  const {scene:result}=normalizeStructure(scene({
    walls:[segment(70,70,140.1,70.1),segment(140.4,69.8,210,140)],
    doors:[segment(144.2,70,175,70)],windows:[segment(144.5,70,175,70)]
  }));
  assert.equal(result.walls[0].x2,result.walls[1].x1);
  assert.equal(result.walls[0].y2,result.walls[1].y1);
  assert.equal(result.doors[0].x1,140);
  assert.equal(result.windows[0].x1,149);
});

test('diagonals and multi-segment curves remain separate structural segments',()=>{
  const walls=[segment(20.1,25.2,100.3,90.7),segment(100.3,90.7,145.7,115.2),segment(145.7,115.2,171.2,169.4)];
  const result=normalizeStructure(scene({walls})).scene.walls;
  assert.equal(result.length,walls.length);
  for(let i=0;i<result.length;i++) {
    assert.notEqual(result[i].x1,result[i].x2);
    assert.notEqual(result[i].y1,result[i].y2);
    if(i)assert.deepEqual([result[i].x1,result[i].y1],[result[i-1].x2,result[i-1].y2]);
  }
});

test('midpoint ties and native whole-pixel cleaning match public v14 observations',()=>{
  const result=normalizeStructure(scene({walls:[segment(4.375,13.125,21.875,30.625)]}));
  assert.deepEqual(points(result.scene.walls[0]),[9,18,26,35]);
  assert.deepEqual(normalizeStructure(result.scene).scene,result.scene);
});

test('nonzero image-space grid origin uses forward and inverse coordinate translations',()=>{
  const source=scene({walls:[segment(33,27,60,60)]});
  const result=normalizeStructure(source,{origin:{x:23,y:17}});
  assert.deepEqual(points(result.scene.walls[0]),[32,26,58,61]);
  assert.deepEqual(result.scene.grid,source.grid);
});

test('target SquareGrid public semantics are used instead of an unrelated active canvas',t=>{
  const original={foundry:globalThis.foundry,CONST:globalThis.CONST,canvas:globalThis.canvas,CONFIG:globalThis.CONFIG};
  t.after(()=>{for(const [key,value]of Object.entries(original)) {
    if(value===undefined)delete globalThis[key];else globalThis[key]=value;
  }});
  const calls=[];
  globalThis.canvas={grid:{getSnappedPoint(){assert.fail('Must not use another scene grid');}}};
  globalThis.CONST={GRID_TYPES:{SQUARE:1},GRID_SNAPPING_MODES:{CENTER:1,VERTEX:240,CORNER:3840,SIDE_MIDPOINT:61440}};
  globalThis.foundry={grid:{SquareGrid:class {
    constructor(config){assert.deepEqual(config,{size:70,distance:5,units:'ft'});}
    getSnappedPoint(point,behavior) {
      calls.push({point,behavior});
      const step=70/(2*behavior.resolution);
      return {x:Math.round(point.x/step)*step,y:Math.round(point.y/step)*step};
    }
  }}};
  const cleaned=[],sizes=[];
  globalThis.CONFIG={
    Scene:{documentClass:{schema:{fields:{grid:{fields:{size:{clean(value){sizes.push(value);return Math.round(value);}}}}}}}},
    Wall:{documentClass:{schema:{fields:{c:{clean(value){cleaned.push([...value]);return value.map(Math.round);}}}}}}
  };
  const result=normalizeStructure(scene());
  assert.deepEqual(calls.map(call=>call.behavior),[{mode:65521,resolution:4},{mode:65521,resolution:4}]);
  assert.deepEqual(cleaned[0],[17.5,17.5,105,87.5]);
  assert.deepEqual(sizes,[70]);
  assert.deepEqual(points(result.scene.walls[0]),[18,18,105,88]);
  assert.deepEqual(result.warnings,[]);
});

test('collapsed short openings retain usable source coordinates with a warning',()=>{
  const source=scene({walls:[],doors:[{...segment(98,100,100,100),secret:true,state:'closed'}]});
  const result=normalizeStructure(source);
  assert.deepEqual(result.scene.doors,source.doors);
  assert.match(result.warnings.join(' '),/retained.*collapse/);
});

test('unsafe snapping near an image edge retains the usable raw segment',()=>{
  const source=scene({image:{width:101,height:101},walls:[segment(90,90,101,101)]});
  const result=normalizeStructure(source);
  assert.deepEqual(result.scene.walls,source.walls);
  assert.match(result.warnings.join(' '),/outside the image/);
});

test('bad individual records never prevent useful neighboring structural geometry',()=>{
  const result=normalizeStructure(scene({
    walls:[null,segment(NaN,1,2,3),segment(10,10,10,10),segment(.1,.1,.2,.2),segment(14,18,70,70)],
    doors:'bad'
  }));
  assert.deepEqual(result.scene.walls,[segment(18,18,70,70)]);
  assert.deepEqual(result.scene.doors,[]);
  assert.equal(result.warnings.length,5);
});

test('image-only imports and unsupported grids or frames remain usable without new failures',()=>{
  const imageOnly=scene({walls:[]});
  assert.deepEqual(normalizeStructure(imageOnly),{scene:imageOnly,warnings:[]});
  const hex=scene({grid:{type:2,size:70,distance:5,units:'ft'}});
  assert.deepEqual(normalizeStructure(hex),{scene:hex,warnings:[]});
  const source=scene();
  const invalid=normalizeStructure(source,{origin:{x:NaN,y:0}});
  assert.equal(invalid.scene,source);
  assert.equal(invalid.warnings.length,1);
});

test('Medium building-style adjacent rooms share cleaned joins without adding walls across openings',()=>{
  const source=scene({
    name:'Medium building-style structural regression',
    walls:[segment(35.2,35.1,315.2,35.1),segment(315.1,35.2,315.1,245.1),
      segment(315.2,245.2,35.2,245.2),segment(35.1,245.1,35.1,35.2),
      segment(175.2,35.2,175.2,245.1),segment(35.1,140.2,315.1,140.2)],
    doors:[{...segment(175.1,95.4,175.2,113.5),secret:false,state:'closed'},
      {...segment(113.6,140.1,131.4,140.2),secret:true,state:'locked'}],
    windows:[segment(315.2,175.2,315.1,201.3)]
  });
  const {scene:normalized,warnings}=normalizeStructure(source);
  assert.deepEqual(warnings,[]);
  assert.equal(normalized.walls.length,6);
  assert.equal(normalized.doors.length,2);
  assert.equal(normalized.walls[0].x2,normalized.walls[1].x1);
  const native=buildNativeData(normalized);
  assert.equal(native.walls.filter(w=>w.door!==0).length,2);
  for(const door of normalized.doors) {
    const midpoint={x:(door.x1+door.x2)/2,y:(door.y1+door.y2)/2};
    assert.ok(!native.walls.filter(w=>w.flags['mapgen'].kind==='wall').some(({c})=>
      c[0]===c[2]&&midpoint.x===c[0]&&midpoint.y>Math.min(c[1],c[3])&&midpoint.y<Math.max(c[1],c[3])
      ||c[1]===c[3]&&midpoint.y===c[1]&&midpoint.x>Math.min(c[0],c[2])&&midpoint.x<Math.max(c[0],c[2])));
  }
  assert.deepEqual(normalized.lights,source.lights);
});
