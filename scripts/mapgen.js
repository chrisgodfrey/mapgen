import {importBattlemap, readSceneMetadata, normalizeGrid, normalizeScene} from './scene-import.js';
import {MODULE_ID, createImportedScene, isImportedScene, projectFromScene, saveSceneSettings} from './project.js';
import {battlemapPrompt, METADATA_PROMPT} from './generation-contract.js';
import {drawLightingPreview,drawOverlay} from './preview.js';
import {normalizeStructure} from './foundry-data.js';
import {DEFAULT_LIGHT_RADIUS_SCALE,LIGHT_RADIUS_SCALES,isLightRadiusScale,scaleLights} from './lighting.js';

const {ApplicationV2, HandlebarsApplicationMixin, DialogV2}=foundry.applications.api;
const actions=['newProject','copyBattlemapPrompt','copyMetadataPrompt','openProject','applySettings','createScene','viewScene','clearMetadata'];

export class MapGenApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS={
    id:'mapgen-app',classes:['mapgen'],tag:'div',
    position:{width:1000,height:850},
    window:{title:'MapGen',icon:'fa-solid fa-map',resizable:true},
    actions:Object.fromEntries(actions.map(name=>[name,async function(){await this.run(name);}]))
  };
  static PARTS={main:{template:`modules/${MODULE_ID}/templates/mapgen.hbs`}};

  constructor(options={}) {
    super(options);
    this.project=null;
    this.image=null;
    this.previewUrl=null;
    this.ownedUrl=null;
    this.sceneId=null;
    this.busy=false;
    this.closed=false;
    this.epoch=0;
    this.overlay=true;
    this.showGrid=false;
    this.showLighting=true;
    this.lightingDraft=null;
    this.brief='';
    this.pendingMetadata=null;
    this.metadataName='';
    this.contractOpen=true;
    this.settingsOpen=false;
    this.gridPreview=null;
    this.gridPreviewWarnings=[];
    this.status='Generate a battlemap or import a finished PNG. Scene metadata is optional.';
    this.error='';
  }

  get sceneDocument() {return game.scenes.get(this.sceneId);}

  async _prepareContext() {
    const scene=this.previewScene();
    const displayGrid=scene?.grid;
    const lighting=this.project?this.lightingState():null;
    const radiusScale=this.lightingDraft?.radiusScale??lighting?.radiusScale??DEFAULT_LIGHT_RADIUS_SCALE;
    const warnings=this.project?.warnings??this.pendingMetadata?.warnings??[];
    return {
      scene,hasImage:!!this.image,hasProject:!!this.project,previewUrl:this.previewUrl,
      busy:this.busy,canCreate:!!scene&&!this.sceneId&&!this.busy,
      saved:!!this.sceneId,overlay:this.overlay,showGrid:this.showGrid,showLighting:this.showLighting,
      status:this.status,error:this.error,brief:this.brief,
      battlemapPrompt:battlemapPrompt(this.brief),metadataPrompt:METADATA_PROMPT,
      metadataName:this.metadataName,
      battlemapTextOpen:this.copyFallback==='battlemapPrompt',metadataTextOpen:this.copyFallback==='metadataPrompt',
      contractOpen:this.contractOpen,settingsOpen:this.settingsOpen,
      gridScale:displayGrid?this.gridScaleLabel(displayGrid):'',gridPreviewNote:this.gridPreviewWarnings.join(' '),
      radiusOptions:LIGHT_RADIUS_SCALES.map(value=>({value,label:`${value*100}%${value===.5?' (conservative)':''}`,selected:value===radiusScale})),
      lightingSummary:scene?this.lightingSummary(scene,radiusScale):'',untrackedLighting:lighting?.untracked,
      unmanagedLights:lighting?.baseLights.filter(light=>light.managed===false).length??0,
      warnings,warningCount:warnings.length,
      counts:this.project?`${scene.walls.length} walls, ${scene.doors.length} doors, ${scene.windows.length} windows, ${scene.lights.length} lights`:'',
      projects:[...game.scenes].filter(isImportedScene)
        .map(doc=>({id:doc.id,name:doc.name,selected:doc.id===this.sceneId}))
    };
  }

  _onRender(context,options) {
    super._onRender(context,options);
    const root=this.element;
    for(const name of ['imageFile','metadataFile']) {
      root.querySelector(`[name="${name}"]`)?.addEventListener('change',event=>{
        const files=Array.from(event.target.files??[]);
        if(files.length)void this.run('importFiles',files);
      });
    }
    for(const drop of root.querySelectorAll('[data-drop]')) {
      drop.addEventListener('dragover',event=>{
        event.preventDefault();
        if(event.dataTransfer)event.dataTransfer.dropEffect=this.busy?'none':'copy';
      });
      drop.addEventListener('drop',event=>{
        event.preventDefault();
        event.stopPropagation();
        const files=Array.from(event.dataTransfer?.files??[]);
        if(files.length)void this.run('importFiles',files);
      });
    }
    for(const name of ['overlay','showGrid','showLighting'])root.querySelector(`[name="${name}"]`)?.addEventListener('change',event=>{
      this[name]=event.target.checked;
      this.paintOverlay();
    });
    for(const name of ['gridSize','distance','units']) {
      const input=root.querySelector(`[name="${name}"]`);
      for(const event of ['input','change'])input?.addEventListener(event,()=>this.updateGridPreview());
    }
    for(const name of ['lightRadiusScale','darkness','globalLight']) {
      const input=root.querySelector(`[name="${name}"]`);
      for(const event of ['input','change'])input?.addEventListener(event,()=>this.updateLightingPreview());
    }
    root.querySelector('[name="brief"]')?.addEventListener('input',event=>{
      this.brief=event.target.value;
      root.querySelector('[name="battlemapPrompt"]').value=battlemapPrompt(this.brief);
    });
    for(const [selector,key] of [['.sa-contract','contractOpen'],['.sa-settings','settingsOpen']]) {
      root.querySelector(selector)?.addEventListener('toggle',event=>{this[key]=event.target.open;});
    }
    this.paintOverlay();
    this.syncBusy();
  }

  paintOverlay() {
    const svg=this.element?.querySelector('[data-overlay]');
    const scene=this.previewScene();
    if(svg&&scene)drawOverlay(svg,scene,{
      geometry:this.overlay,grid:this.showGrid,cutOpenings:!this.sceneId
    });
    const lighting=this.element?.querySelector('[data-lighting-preview]');
    if(lighting&&scene)drawLightingPreview(lighting,scene,{enabled:this.showLighting});
  }

  lightingState() {
    return this.project.lighting??{radiusScale:DEFAULT_LIGHT_RADIUS_SCALE,baseLights:this.project.scene.lights};
  }

  previewScene() {
    if(!this.image)return null;
    if(!this.project)return {image:this.image,lights:[],darkness:0,globalLight:true};
    const scene=this.project.scene,state=this.lightingState(),draft=this.lightingDraft;
    return {...scene,grid:this.gridPreview??scene.grid,
      darkness:draft?.darkness??scene.darkness,globalLight:draft?.globalLight??scene.globalLight,
      lights:scaleLights(state.baseLights,draft?.radiusScale??state.radiusScale)};
  }

  lightingSummary(scene,scale) {
    const animated=scene.lights.filter(light=>light.animation?.type&&!light.hidden).length;
    return `${scene.lights.filter(light=>!light.hidden).length} local lights; imported radii ${scale*100}%; darkness ${Math.round(scene.darkness*100)}%; global illumination ${scene.globalLight?'on':'off'}.${animated?` ${animated} animated sources (shown statically here).`:''}`;
  }

  readLighting() {
    const radiusScale=Number(this.element.querySelector('[name="lightRadiusScale"]')?.value??this.lightingState().radiusScale);
    const darkness=Number(this.element.querySelector('[name="darkness"]')?.value);
    const globalLight=!!this.element.querySelector('[name="globalLight"]')?.checked;
    if(!isLightRadiusScale(radiusScale))throw new Error('Choose one of the available light radius percentages.');
    if(!Number.isFinite(darkness)||darkness<0||darkness>1)throw new Error('Darkness must be between 0 and 1.');
    return {radiusScale,darkness,globalLight};
  }

  updateLightingPreview() {
    if(!this.project)return;
    const note=this.element.querySelector('[data-lighting-state]');
    try {this.lightingDraft=this.readLighting();}
    catch(error) {note.textContent=error.message;return;}
    note.textContent=this.lightingSummary(this.previewScene(),this.lightingDraft.radiusScale);
    this.paintOverlay();
  }

  gridScaleLabel(grid) {
    return `One square = ${grid.distance} ${grid.units}; a one-square token is ${grid.size}px wide.`;
  }

  readGrid() {
    const value=name=>this.element.querySelector(`[name="${name}"]`)?.value;
    return normalizeGrid({
      size:value('gridSize')?.trim()?Number(value('gridSize')):NaN,
      distance:value('distance')?.trim()?Number(value('distance')):NaN,
      units:value('units')
    },{fallback:this.gridPreview??this.project.scene.grid,image:this.image});
  }

  updateGridPreview() {
    if(!this.project)return;
    const {grid,warnings}=this.readGrid();
    this.gridPreview=grid;
    this.gridPreviewWarnings=warnings;
    this.showGrid=true;
    this.element.querySelector('[name="showGrid"]').checked=true;
    this.element.querySelector('[data-grid-scale]').textContent=this.gridScaleLabel(grid);
    this.element.querySelector('[data-grid-note]').textContent=warnings.join(' ');
    this.paintOverlay();
  }

  clearGridPreview() {
    this.gridPreview=null;
    this.gridPreviewWarnings=[];
  }

  syncBusy() {
    this.element?.setAttribute('aria-busy',String(this.busy));
    for(const input of this.element?.querySelectorAll('button,input,select,textarea:not([readonly])')??[]) {
      input.disabled=this.busy;
    }
  }

  async run(action,...args) {
    if(!game.user.isGM) {
      ui.notifications.error('MapGen is GM-only.');
      return;
    }
    if(this.busy||this.closed)return;
    this.busy=true;
    this.error='';
    this.syncBusy();
    try {await this[action](...args);}
    catch(error) {
      console.error(`${MODULE_ID} | ${action}`,error);
      this.error=error.message;
      ui.notifications.error(`MapGen: ${error.message}`);
    } finally {
      this.busy=false;
      if(!this.closed) {
        await this.render();
        if(this.copyFallback) {
          const textarea=this.element.querySelector(`[name="${this.copyFallback}"]`);
          textarea?.focus();
          textarea?.select();
          this.copyFallback=null;
        }
      }
    }
  }

  async mayReplace() {
    if(!this.project||this.sceneId)return true;
    return DialogV2.confirm({
      window:{title:'Replace unsaved import?'},
      content:'<p>This battlemap has not been saved as a Foundry scene. Replace the preview? Your original files are unchanged.</p>',
      rejectClose:false
    });
  }

  releasePreview() {
    if(this.ownedUrl)URL.revokeObjectURL(this.ownedUrl);
    this.ownedUrl=null;
    this.previewUrl=null;
  }

  async newProject() {
    if(!await this.mayReplace())return;
    this.epoch++;
    this.releasePreview();
    this.project=null;
    this.image=null;
    this.sceneId=null;
    this.pendingMetadata=null;
    this.metadataName='';
    this.clearGridPreview();
    this.lightingDraft=null;
    this.status='Drop a battlemap image to begin. Scene metadata is optional.';
  }

  async importFiles(files) {
    const images=files.filter(file=>/\.png$/i.test(file.name)||file.type==='image/png');
    const json=files.filter(file=>/\.json$/i.test(file.name)||file.type==='application/json');
    if(!images.length&&!json.length)throw new Error('Choose a PNG battlemap image or an optional scene.json file.');
    const notes=[];
    if(images.length>1)notes.push('Several images were supplied; used the first PNG. Import another image separately.');
    if(json.length>1)notes.push('Several metadata files were supplied; used the first JSON file.');
    if(files.some(file=>!images.includes(file)&&!json.includes(file)))notes.push('Ignored files other than PNG artwork and JSON metadata.');
    if(images.length) {
      if(!await this.mayReplace())return;
      await this.importImage(images[0],json[0],notes);
    } else {
      const metadata=await readSceneMetadata(json[0]);
      if(this.closed)return;
      metadata.warnings.push(...notes);
      if(this.project)this.attachMetadata(metadata,json[0].name);
      else {
        this.pendingMetadata=metadata;
        this.metadataName=json[0].name;
        this.status=metadata.raw?'Scene metadata is ready. Choose its battlemap image next.':
          'Metadata could not be used. Choose a battlemap image; it can be played without metadata.';
      }
    }
  }

  attachMetadata(metadata,name) {
    if(metadata.raw==null) {
      this.project.warnings.push(...metadata.warnings);
      this.status='Metadata could not be used. The current battlemap and usable geometry are unchanged.';
      return;
    }
    const prior=this.project.scene;
    const normalized=normalizeScene({
      grid:this.gridPreview??prior.grid,...metadata.raw
    },this.image,{name:prior.name});
    const copying=!!this.sceneId;
    const prepared=normalizeStructure(normalized.scene);
    const lighting={radiusScale:DEFAULT_LIGHT_RADIUS_SCALE,baseLights:normalized.scene.lights};
    this.project={...this.project,scene:{...prepared.scene,lights:scaleLights(lighting.baseLights,lighting.radiusScale)},
      lighting,structureNormalized:true,
      rawStructure:Object.fromEntries(['walls','doors','windows'].map(key=>[key,normalized.scene[key]])),
      warnings:[...metadata.warnings,...normalized.warnings,...prepared.warnings]};
    this.clearGridPreview();
    this.lightingDraft=null;
    if(copying)delete this.project.imageBlob;
    this.sceneId=null;
    this.metadataName=name;
    this.pendingMetadata=null;
    this.status=copying?'Metadata applied to a new scene preview. Create a new scene; the saved scene is unchanged.':
      'Usable scene metadata applied. The battlemap is ready for Foundry.';
  }

  async clearMetadata() {
    this.pendingMetadata=null;
    this.metadataName='';
    if(this.project&&!this.sceneId) {
      for(const collection of ['walls','doors','windows','lights'])this.project.scene[collection]=[];
      this.project.warnings=[];
      this.project.lighting={radiusScale:DEFAULT_LIGHT_RADIUS_SCALE,baseLights:[]};
      this.lightingDraft=null;
      delete this.project.rawStructure;
    }
    this.status=this.project?'Image-only preview ready. Grid and lighting settings are unchanged.':
      'Optional metadata cleared. Choose a battlemap image when ready.';
  }

  async importImage(file,metadataFile,notes=[]) {
    const epoch=++this.epoch;
    const previous={project:this.project,image:this.image,previewUrl:this.previewUrl,
      ownedUrl:this.ownedUrl,sceneId:this.sceneId,pendingMetadata:this.pendingMetadata,metadataName:this.metadataName,
      contractOpen:this.contractOpen,gridPreview:this.gridPreview,gridPreviewWarnings:this.gridPreviewWarnings,
      lightingDraft:this.lightingDraft};
    const pending=this.image?null:this.pendingMetadata;
    let nextUrl=null;
    this.status='Opening battlemap image...';
    await this.render();
    try {
      const imported=await importBattlemap(file,{onImage:async image=>{
        if(this.closed||epoch!==this.epoch)return;
        nextUrl=URL.createObjectURL(image.blob);
        this.previewUrl=nextUrl;
        this.ownedUrl=nextUrl;
        this.image={width:image.width,height:image.height};
        this.project=null;
        this.sceneId=null;
        this.clearGridPreview();
        this.lightingDraft=null;
        this.contractOpen=false;
        this.status='Battlemap ready. No metadata is required.';
        await this.render();
      }});
      if(this.closed||epoch!==this.epoch) {
        if(nextUrl)URL.revokeObjectURL(nextUrl);
        if(previous.ownedUrl)URL.revokeObjectURL(previous.ownedUrl);
        return;
      }
      this.project=imported;
      this.image=imported.scene.image;
      this.pendingMetadata=null;
      this.metadataName='';
      this.contractOpen=false;
      this.status='Battlemap imported. Create a Foundry scene when ready.';
      const metadata=metadataFile?await readSceneMetadata(metadataFile):pending;
      if(this.closed||epoch!==this.epoch) {
        if(nextUrl)URL.revokeObjectURL(nextUrl);
        if(previous.ownedUrl)URL.revokeObjectURL(previous.ownedUrl);
        this.project=null;
        return;
      }
      if(metadata)this.attachMetadata(metadata,metadataFile?.name??previous.metadataName);
      this.project.warnings.push(...notes);
      if(previous.ownedUrl)URL.revokeObjectURL(previous.ownedUrl);
    } catch(error) {
      if(nextUrl)URL.revokeObjectURL(nextUrl);
      if(!this.closed)Object.assign(this,previous);
      else if(previous.ownedUrl)URL.revokeObjectURL(previous.ownedUrl);
      this.status=previous.project?'The previous battlemap is unchanged.':'Choose another battlemap PNG.';
      throw error;
    }
  }

  settings() {
    const value=name=>this.element.querySelector(`[name="${name}"]`)?.value;
    const name=value('sceneName')?.trim();
    const {grid,warnings}=this.readGrid();
    const {radiusScale,darkness,globalLight}=this.readLighting();
    if(!name||name.length>200)throw new Error('Enter a scene name of 1 to 200 characters.');
    this.gridPreviewWarnings=warnings;
    return {name,grid,darkness,globalLight,lighting:{...this.lightingState(),radiusScale}};
  }

  async applySettings() {
    if(!this.project)return;
    const {lighting,...settings}=this.settings();
    if(this.sceneId) {
      const doc=this.sceneDocument;
      if(!doc)throw new Error('The saved scene no longer exists. Import its image again.');
      await saveSceneSettings(doc,settings,lighting);
      const reopened=projectFromScene(doc);
      this.project={...this.project,...reopened};
      this.status='Scene and imported lighting settings saved. Native geometry and gameplay content were preserved.';
    } else {
      Object.assign(this.project.scene,settings,{lights:scaleLights(lighting.baseLights,lighting.radiusScale)});
      this.project.lighting=lighting;
      this.status='Preview settings updated. Artwork, structural geometry and light positions are unchanged.';
    }
    this.gridPreview=null;
    this.lightingDraft=null;
  }

  async createScene() {
    if(!this.project||this.sceneId)throw new Error('Import a battlemap image first.');
    const {lighting,...settings}=this.settings();
    Object.assign(this.project.scene,settings,{lights:scaleLights(lighting.baseLights,lighting.radiusScale)});
    this.project.lighting=lighting;
    this.gridPreview=null;
    this.lightingDraft=null;
    await this.render();
    const result=await createImportedScene(this.project);
    this.sceneId=result.document.id;
    Object.assign(this.project,projectFromScene(result.document));
    delete this.project.rawStructure;
    delete this.project.structureNormalized;
    this.status='Saved to Foundry. Native walls, doors, windows and lights are ready for play.';
    await result.document.view();
  }

  async openProject(id) {
    if(!await this.mayReplace())return;
    const sceneId=id??this.element.querySelector('[name="projectId"]')?.value;
    const doc=game.scenes.get(sceneId);
    if(!doc)throw new Error('Choose a saved battlemap scene.');
    const project=projectFromScene(doc);
    const image=new Image();
    image.src=project.src;
    try {await image.decode();}
    catch(error) {throw new Error('The saved battlemap image could not be loaded. Check the Foundry image path and permissions.',{cause:error});}
    if(this.closed)return;
    this.epoch++;
    this.releasePreview();
    this.project=project;
    this.image=project.scene.image;
    this.previewUrl=project.src;
    this.sceneId=doc.id;
    this.clearGridPreview();
    this.lightingDraft=null;
    this.pendingMetadata=null;
    this.metadataName='';
    this.status='Saved battlemap reopened with its current native scene geometry.';
  }

  async viewScene() {
    if(!this.sceneDocument)throw new Error('The saved scene no longer exists.');
    await this.sceneDocument.view();
  }

  async copyText(text,label,field) {
    try {
      await navigator.clipboard.writeText(text);
      this.status=`${label} copied.`;
    } catch(error) {
      console.warn(`${MODULE_ID} | Clipboard unavailable`,error);
      this.status='Clipboard unavailable. Select and copy the prompt text below.';
      this.contractOpen=true;
      this.copyFallback=field;
    }
  }

  async copyBattlemapPrompt() {await this.copyText(battlemapPrompt(this.brief),'Battlemap prompt','battlemapPrompt');}
  async copyMetadataPrompt() {await this.copyText(METADATA_PROMPT,'Metadata follow-up for the same conversation','metadataPrompt');}

  async close(options={}) {
    if(!this.busy&&!await this.mayReplace())return this;
    this.closed=true;
    this.epoch++;
    this.releasePreview();
    return super.close(options);
  }
}

export async function launch() {
  if(!game.user.isGM) {
    ui.notifications.warn('MapGen is GM-only.');
    return;
  }
  const app=new MapGenApp();
  await app.render({force:true});
  const viewed=game.scenes.viewed;
  if(viewed&&isImportedScene(viewed))await app.run('openProject',viewed.id);
  return app;
}

Hooks.once('init',()=>{
  game.settings.register(MODULE_ID,'enabled',{
    name:'Enable MapGen',scope:'world',config:true,type:Boolean,default:true,restricted:true
  });
});
Hooks.on('renderSceneDirectory',(_app,element)=>{
  if(!game.user.isGM||!game.settings.get(MODULE_ID,'enabled')||element.querySelector?.('.mapgen-launch'))return;
  const button=document.createElement('button');
  button.type='button';
  button.className='mapgen-launch';
  button.textContent='MapGen';
  button.addEventListener('click',()=>launch().catch(error=>{
    console.error(`${MODULE_ID} | launch`,error);
    ui.notifications.error(error.message);
  }));
  (element.querySelector?.('.directory-footer')||element.querySelector?.('footer')||element).appendChild(button);
});
Hooks.once('ready',()=>{
  game.modules.get(MODULE_ID).api={launch,importBattlemap,readSceneMetadata,battlemapPrompt,metadataPrompt:METADATA_PROMPT};
});
