import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Handlebars from 'handlebars';
import {BATTLEMAP_PROMPT,METADATA_PROMPT,battlemapPrompt} from '../scripts/generation-contract.js';

const root=new URL('../',import.meta.url);
const template=Handlebars.compile(fs.readFileSync(new URL('templates/mapgen.hbs',root),'utf8'));

test('MapGen 1.0 product identity, tagline and install paths agree across the release',()=>{
  const manifest=JSON.parse(fs.readFileSync(new URL('module.json',root)));
  const pkg=JSON.parse(fs.readFileSync(new URL('package.json',root)));
  const html=template({});
  assert.equal(manifest.id,'mapgen');
  assert.equal(manifest.title,'MapGen');
  assert.equal(manifest.description,'AI-assisted battlemaps for Foundry VTT.');
  assert.match(manifest.version,/^1\.\d+\.\d+$/);
  assert.equal(pkg.name,'mapgen');
  assert.equal(pkg.version,manifest.version);
  assert.equal(manifest.url,'https://github.com/chrisgodfrey/mapgen');
  assert.equal(manifest.manifest,'https://raw.githubusercontent.com/chrisgodfrey/mapgen/main/module.json');
  assert.equal(manifest.download,`https://github.com/chrisgodfrey/mapgen/releases/download/v${manifest.version}/mapgen.zip`);
  assert.deepEqual(manifest.authors,[{name:'MapGen contributors'}]);
  assert.deepEqual(manifest.esmodules,['scripts/mapgen.js']);
  assert.deepEqual(manifest.styles,['styles/mapgen.css']);
  for(const path of [...manifest.esmodules,...manifest.styles])assert.ok(fs.existsSync(new URL(path,root)));
  assert.match(html,/<h1>MapGen<\/h1>/);
  assert.match(html,/AI-assisted battlemaps for Foundry VTT\./);
  assert.match(METADATA_PROMPT,/"format":"mapgen"/);
});

test('README stays a short installation and usage guide',()=>{
  const readme=fs.readFileSync(new URL('README.md',root),'utf8').replace(/^---[\s\S]*?---\s*/,'');
  assert.ok(readme.trim().split(/\s+/).length<=200,'Keep detailed reference material outside the README');
  assert.deepEqual(readme.match(/^## .+$/gm),['## Install','## Create a scene']);
  assert.match(readme,/AI-assisted battlemaps for Foundry VTT\./);
});

test('Turn 1 asks only for finished orthographic artwork and excludes metadata responsibilities',()=>{
  assert.match(BATTLEMAP_PROMPT,/Create one finished VTT battlemap/);
  assert.match(BATTLEMAP_PROMPT,/only on producing the finished artwork/);
  assert.match(BATTLEMAP_PROMPT,/Do not create wall\s+metadata, JSON, manifests, ZIP files or packaging instructions/);
  assert.match(BATTLEMAP_PROMPT,/PNG/);
  assert.doesNotMatch(BATTLEMAP_PROMPT,/"version"|scene\.json|x1|x2/);
  assert.equal(battlemapPrompt(),BATTLEMAP_PROMPT);
  assert.equal(battlemapPrompt(' \n An Example interior. \n '),`${BATTLEMAP_PROMPT}\n\nUSER LOCATION BRIEF:\nAn Example interior.`);
});

test('Turn 1 defines the visual requirements for a strict architectural plan view',()=>{
  const prompt=BATTLEMAP_PROMPT.replace(/\s+/g,' ');
  for(const requirement of [
    'CAMERA / PROJECTION REQUIREMENT - NON-NEGOTIABLE',
    'VTT battlemap / architectural plan view',
    'camera exactly 90 degrees vertically downward',
    'orthographic projection only',
    'no perspective',
    'no isometric projection',
    "no oblique or bird's-eye camera angle",
    'no horizon',
    'no foreshortening',
    'parallel architectural lines remain parallel',
    'circles remain circles rather than ellipses',
    'do not show the vertical faces or sides of walls, furniture, stairs, platforms, cages or other structures',
    'walls should read as top-down wall thicknesses or footprints, not visible wall faces',
    'stairs should be represented in plan view, not as receding perspective steps',
    'professional top-down Foundry VTT battlemap, not concept art, a diorama, an isometric map or an aerial illustration'
  ])assert.ok(prompt.includes(requirement),`Missing camera requirement: ${requirement}`);
});

test('Turn 1 requires a final camera self-check without adding an import validation gate',()=>{
  const prompt=BATTLEMAP_PROMPT.replace(/\s+/g,' ');
  assert.ok(prompt.includes('Before returning the image, check the camera geometry yourself.'));
  assert.ok(prompt.includes('If any significant vertical wall faces or perspective recession are visible, the image does not satisfy the request.'));
  assert.ok(prompt.includes('Do not include UI, textual room labels or a baked-in gameplay grid unless explicitly requested.'));
  assert.doesNotMatch(METADATA_PROMPT,/CAMERA \/ PROJECTION REQUIREMENT|Before returning the image/);
});

test('Turn 2 traces the exact existing image without regeneration or packaging',()=>{
  assert.match(METADATA_PROMPT,/exact finished battlemap image you just created in this conversation/);
  assert.match(METADATA_PROMPT,/Do not regenerate, redraw, repaint or redesign/);
  assert.match(METADATA_PROMPT,/scene\.json must describe the battlemap that actually exists/);
  assert.match(METADATA_PROMPT,/Return one scene\.json file/);
  assert.match(METADATA_PROMPT,/do not force walls, doors or windows onto gameplay grid lines/);
  assert.match(METADATA_PROMPT,/MapGen handles\s+minor structural coordinate normalization after import/);
  assert.doesNotMatch(METADATA_PROMPT,/\bZIP\b|manifest|package/i);
  const scene=JSON.parse(METADATA_PROMPT.match(/\n(\{\n[\s\S]+?\n\})/)[1]);
  assert.equal(scene.format,'mapgen');
  assert.equal(scene.version,1);
  assert.deepEqual(scene.image,{width:2800,height:2240});
  assert.equal(scene.grid.size,null);
  assert.deepEqual({distance:scene.grid.distance,units:scene.grid.units},{distance:5,units:'ft'});
  for(const key of ['walls','doors','windows','lights'])assert.ok(Array.isArray(scene[key]));
});

test('metadata prompt requires per-image scale estimation without a fixed numeric-size example',()=>{
  const prompt=METADATA_PROMPT.replace(/\s+/g,' ');
  assert.doesNotMatch(prompt,/\b70\b/);
  for(const requirement of [
    'Choose grid.size from the actual visual scale',
    'Do not copy an example grid size mechanically',
    'normal doors, corridor widths, beds, tables, chairs, stairs, human-scale furniture and room proportions',
    'do not assume every opening is exactly 5 feet',
    'one gameplay square represents 5 feet and a Medium creature occupies one square',
    'Do not return null for grid.size',
    'Aim for plausible tabletop scale, not false precision'
  ])assert.ok(prompt.includes(requirement),`Missing scale instruction: ${requirement}`);
});

test('metadata prompt separates painted ambience from restrained gameplay emitters',()=>{
  const prompt=METADATA_PROMPT.replace(/\s+/g,' ');
  for(const requirement of [
    'Only place lights at visible or strongly implied localized emitters',
    'Do not create lights merely because artwork is bright, glowing, snowy, icy, reflective or magically color-tinted',
    'Decorative floor glow and general ambience can remain in the artwork',
    'Prefer fewer sources, restrained radii, small bright cores and broader dim edges',
    'When uncertain, under-light rather than over-light',
    'Keep the lighting expressive and contextual, not uniformly dim or colorless',
    'Choose darkness and globalLight for visibility needs'
  ])assert.ok(prompt.includes(requirement),`Missing lighting guidance: ${requirement}`);
  const scene=JSON.parse(METADATA_PROMPT.match(/\n(\{\n[\s\S]+?\n\})/)[1]);
  assert.equal(scene.globalLight,true);
  assert.equal(scene.darkness,0);
  assert.ok(scene.lights[0].bright<scene.lights[0].dim);
  assert.equal(scene.lights[0].animation.type,'torch');
  assert.equal(scene.lights[0].animation.speed,5);
  assert.equal(scene.lights[0].animation.intensity,5);
  assert.equal(scene.lights[0].luminosity,.5);
});

test('metadata guidance keeps motion perceptible without increasing lighting coverage or brightness',()=>{
  const prompt=METADATA_PROMPT.replace(/\s+/g,' ');
  for(const requirement of [
    'Make selected animations clearly perceptible at normal play zoom, not nearly static',
    'For torch/flame start around speed 5 and intensity 5',
    'for magical pulse start around speed 3 to 5 and intensity 5 to 6',
    'Conservative lighting means limited coverage and brightness, not imperceptible motion',
    'Keep radii and luminosity restrained instead of weakening animation until it vanishes'
  ])assert.ok(prompt.includes(requirement),`Missing perceptible-animation guidance: ${requirement}`);
  assert.doesNotMatch(prompt,/Prefer subtle speed\/intensity around 1 to 3/);
});

test('metadata guidance treats readable art as already lit and reserves darkness for intended visibility limits',()=>{
  const prompt=METADATA_PROMPT.replace(/\s+/g,' ');
  for(const requirement of [
    'The finished battlemap is already visually lit',
    'For normally occupied, visibly readable homes, taverns, shops, laboratories, palaces and other interiors',
    'prefer globalLight true and low darkness (often 0)',
    'Do not set globalLight false merely because local emitters exist',
    'Use false and stronger darkness only when restricted visibility is intended',
    'Interpret the artwork and brief, not genre alone',
    'Do not reproduce painted shadows, nighttime/blue coloring, snow glare or magical ambience by adding substantial darkness a second time',
    'Local effects should not be required to make an otherwise readable room visible'
  ])assert.ok(prompt.includes(requirement),`Missing environment guidance: ${requirement}`);
});
test('UI has separate art and metadata prompts, same-chat and nonmandatory reasoning guidance',()=>{
  const html=template({battlemapPrompt:BATTLEMAP_PROMPT,metadataPrompt:METADATA_PROMPT});
  assert.match(html,/Copy battlemap prompt/);
  assert.match(html,/Copy metadata follow-up/);
  assert.match(html,/same ChatGPT conversation after the battlemap image has finished generating/);
  assert.match(html,/higher reasoning mode may improve.*if available/);
  assert.match(html,/It is not required/);
  assert.match(html,/name="imageFile"[^>]+multiple/);
  assert.match(html,/name="metadataFile"/);
  assert.doesNotMatch(html,/Drop a battlemap ZIP|One ZIP|Copy generation contract|subscription/i);
});

test('template escapes untrusted names and warnings and never gates creation on optional metadata',()=>{
  const html=template({
    hasProject:true,hasImage:true,canCreate:true,scene:{name:'<img src=x onerror=alert(1)>',grid:{}},
    previewUrl:'blob:trusted',warnings:['<script>alert(1)</script>'],warningCount:1
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;img src'));
  assert.match(html,/<button[^>]+data-action="createScene"[^>]*>/);
  assert.doesNotMatch(html,/<button[^>]+data-action="createScene"[^>]*disabled/);
  assert.doesNotMatch(html,/<details class="sa-warnings"[^>]*open/);
  assert.doesNotMatch(html,/role="alert"/);
  assert.ok(html.indexOf('class="sa-preview"')<html.indexOf('class="sa-warnings"'));
  const imageOnly=template({hasProject:true,hasImage:true,canCreate:true,scene:{grid:{}}});
  assert.doesNotMatch(imageOnly,/class="sa-warnings"|role="alert"/);
});

test('production graph has no archive reader and release metadata remains consistent',()=>{
  const manifest=JSON.parse(fs.readFileSync(new URL('module.json',root)));
  const pkg=JSON.parse(fs.readFileSync(new URL('package.json',root)));
  assert.equal(manifest.version,pkg.version);
  assert.ok(manifest.download.includes(`/v${manifest.version}/`));
  const names=fs.readdirSync(new URL('scripts/',root)).filter(name=>name.endsWith('.js'));
  assert.deepEqual(names.sort(),[
    'foundry-data.js','generation-contract.js','lighting.js','mapgen.js','preview.js','project.js','scene-import.js'
  ]);
  for(const name of names) {
    const file=new URL(`scripts/${name}`,root),source=fs.readFileSync(file,'utf8');
    for(const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g))
      assert.ok(fs.existsSync(new URL(match[1],file)),`${name} references ${match[1]}`);
    assert.doesNotMatch(source,/\bbattlemat\b|readZip|DecompressionStream|importBattlemapPackage/);
  }
});
