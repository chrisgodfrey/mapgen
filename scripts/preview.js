import {cutWallOpenings} from './foundry-data.js';

const SVG_NS='http://www.w3.org/2000/svg';

export function drawOverlay(svg,scene,{geometry=true,grid=false,cutOpenings=false}={}) {
  const {width,height}=scene.image;
  svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio','none');
  svg.replaceChildren();
  const line=(segment,color,dash='',kind)=>{
    const element=document.createElementNS(SVG_NS,'line');
    for(const key of ['x1','y1','x2','y2'])element.setAttribute(key,String(segment[key]));
    element.setAttribute('stroke',color);
    element.setAttribute('stroke-width','1.5');
    element.setAttribute('stroke-opacity','.8');
    element.setAttribute('vector-effect','non-scaling-stroke');
    if(dash)element.setAttribute('stroke-dasharray',dash);
    if(kind)element.dataset.kind=kind;
    svg.append(element);
  };
  if(grid&&scene.grid) {
    for(let x=scene.grid.size;x<width;x+=scene.grid.size)line({x1:x,y1:0,x2:x,y2:height},'#e2e8f0','2 6');
    for(let y=scene.grid.size;y<height;y+=scene.grid.size)line({x1:0,y1:y,x2:width,y2:y},'#e2e8f0','2 6');
  }
  if(!geometry)return;
  for(const [key,color,dash] of [['walls','#f0e7d0',''],['doors','#e5bd70',''],['windows','#7ed4e6','4 3']]) {
    for(const segment of scene[key]??[]) {
      const parts=key==='walls'&&cutOpenings?cutWallOpenings(segment,[...(scene.doors??[]),...(scene.windows??[])]):[segment];
      for(const part of parts)line(part,color,dash,key);
    }
  }
  for(const light of scene.lights??[]) {
    if(light.hidden)continue;
    const circle=document.createElementNS(SVG_NS,'circle');
    circle.setAttribute('cx',String(light.x));
    circle.setAttribute('cy',String(light.y));
    const radius=Math.max(light.dim,light.bright)*scene.grid.size/scene.grid.distance;
    circle.setAttribute('r',String(Math.min(Math.hypot(width,height)*2,Math.max(3,radius))));
    circle.setAttribute('fill','none');
    circle.setAttribute('stroke','#f2d698');
    circle.setAttribute('stroke-width','1');
    circle.setAttribute('stroke-dasharray','2 5');
    circle.setAttribute('vector-effect','non-scaling-stroke');
    svg.append(circle);
  }
}

export function drawLightingPreview(canvas,scene,{enabled=true}={}) {
  const {width,height}=scene.image;
  const scale=Math.min(1,1200/Math.max(width,height));
  canvas.width=Math.max(1,Math.round(width*scale));
  canvas.height=Math.max(1,Math.round(height*scale));
  const ctx=canvas.getContext('2d');
  if(!ctx)throw new Error('Lighting preview requires Canvas 2D.');
  const darkness=Math.max(0,Math.min(1,scene.darkness??0)),globalLight=scene.globalLight??true;
  const lights=(scene.lights??[]).filter(light=>!light.hidden&&Math.max(light.dim,light.bright)>0);
  canvas.dataset.darkness=String(darkness);
  canvas.dataset.globalLight=String(globalLight);
  canvas.dataset.lightCount=String(lights.length);
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if(!enabled)return;
  const ambient=globalLight?darkness*.45:.55+darkness*.35;
  ctx.fillStyle=`rgba(0,0,0,${ambient})`;
  ctx.fillRect(0,0,canvas.width,canvas.height);
  const pixelsPerUnit=(scene.grid?.size??70)/(scene.grid?.distance??5)*scale;
  for(const light of lights) {
    const x=light.x*scale,y=light.y*scale;
    const radius=Math.min(Math.hypot(canvas.width,canvas.height)*2,Math.max(light.dim,light.bright)*pixelsPerUnit);
    if(!Number.isFinite(radius)||radius<=0)continue;
    const core=Math.min(.95,light.bright/Math.max(light.dim,light.bright));
    const strength=Math.max(0,Math.min(1,light.luminosity??.5));
    const reveal=ctx.createRadialGradient(x,y,0,x,y,radius);
    reveal.addColorStop(0,`rgba(0,0,0,${Math.min(1,(light.bright>0?1:.55)*strength*2)})`);
    reveal.addColorStop(core,`rgba(0,0,0,${Math.min(1,(light.bright>0?.9:.55)*strength*2)})`);
    reveal.addColorStop(1,'rgba(0,0,0,0)');
    ctx.globalCompositeOperation='destination-out';
    ctx.fillStyle=reveal;
    ctx.fillRect(x-radius,y-radius,radius*2,radius*2);
  }
  ctx.globalCompositeOperation='lighter';
  for(const light of lights) {
    const x=light.x*scale,y=light.y*scale;
    const radius=Math.min(Math.hypot(canvas.width,canvas.height)*2,Math.max(light.dim,light.bright)*pixelsPerUnit);
    if(!Number.isFinite(radius)||radius<=0)continue;
    const color=/^#[0-9a-f]{6}$/i.test(String(light.color))?String(light.color):'#ffffff';
    const rgb=[1,3,5].map(start=>parseInt(color.slice(start,start+2),16)).join(',');
    const alpha=Math.max(0,Math.min(1,light.alpha??.25));
    const strength=Math.max(0,Math.min(1,light.luminosity??.5));
    const glow=ctx.createRadialGradient(x,y,0,x,y,radius);
    glow.addColorStop(0,`rgba(${rgb},${alpha*strength})`);
    glow.addColorStop(1,`rgba(${rgb},0)`);
    ctx.fillStyle=glow;
    ctx.fillRect(x-radius,y-radius,radius*2,radius*2);
  }
  ctx.globalCompositeOperation='source-over';
}
