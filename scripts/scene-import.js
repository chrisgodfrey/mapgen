import {normalizeLightAnimation} from './lighting.js';

const MAX_PNG_BYTES = 60 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION = 16384;
const MAX_PIXELS = 40000000;
const MAX_RECORDS = 20000;
const MAX_LIGHT_RADIUS = 1_000_000;
const DEFAULT_GRID = Object.freeze({size: 70, distance: 5, units: 'ft'});
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function warningList() {
  const warnings = [];
  return {warnings, warn(message) {
    if (warnings.length < 200) warnings.push(message);
    else if (warnings.length === 200) warnings.push('Additional metadata warnings omitted.');
  }};
}

function numeric(value, label, warn) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      warn(`${label}: converted a numeric string to a number.`);
      return number;
    }
  }
  return null;
}

function optionalNumber(value, fallback, label, warn, {min = -Infinity, max = Infinity, exclusiveMin = false, clamp = false} = {}) {
  if (value === undefined) return fallback;
  const number = numeric(value, label, warn);
  if (number === null || (exclusiveMin && number === min)) {
    warn(`${label}: invalid value; using ${fallback}.`);
    return fallback;
  }
  if (number < min || number > max) {
    if (clamp) {
      warn(`${label}: clamped to ${min}-${max}.`);
      return Math.max(min, Math.min(max, number));
    }
    warn(`${label}: invalid value; using ${fallback}.`);
    return fallback;
  }
  return number;
}

function optionalBoolean(value, fallback, label, warn) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  warn(`${label}: invalid boolean; using ${fallback}.`);
  return fallback;
}

function text(value, fallback, label, warn, maxLength = Infinity) {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() && value.trim().length <= maxLength) return value.trim();
  warn(`${label}: invalid text; using the default.`);
  return fallback;
}

function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
      width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new Error('PNG dimensions exceed the 16384 dimension or 40 million pixel limit, or are invalid.');
  }
}

function supportedMetadata(raw, warn) {
  if ((raw.format !== undefined && raw.format !== 'mapgen') ||
      (raw.version !== undefined && numeric(raw.version, 'Scene version', warn) !== 1)) {
    warn('Unsupported scene format or version; metadata was not applied.');
    return false;
  }
  return true;
}

export function normalizeGrid(input, {fallback = DEFAULT_GRID, image} = {}) {
  const {warnings, warn} = warningList();
  if (input !== undefined && !isObject(input)) warn('Grid metadata is malformed; using the previous or starting settings.');
  const values = isObject(input) ? input : {};
  const size = optionalNumber(values.size, fallback.size, 'Grid size', warn, {min: 20, max: 1000});
  const rounded = Math.round(size);
  if (rounded !== size) warn(`Grid size: rounded to Foundry's whole-pixel size ${rounded}.`);
  const grid = {
    size: rounded,
    distance: optionalNumber(values.distance, fallback.distance, 'Grid distance', warn, {min: 0, max: 10000, exclusiveMin: true}),
    units: text(values.units, fallback.units, 'Grid units', warn, 32)
  };
  if (values.size !== undefined && image && grid.size > Math.min(image.width, image.height) / 2)
    warn('Grid size is large relative to this image; check the one-square token scale in the preview.');
  return {grid, warnings};
}

export function normalizeScene(raw, {width, height}, {name = 'Imported battlemap'} = {}) {
  dimensions(width, height);
  const {warnings, warn} = warningList();
  const scene = {
    version: 1, name: text(name, 'Imported battlemap', 'Name', warn, 200), image: {width, height},
    grid: {...DEFAULT_GRID},
    walls: [], doors: [], windows: [], lights: [], darkness: 0, globalLight: true
  };
  if (raw === undefined) return {scene, warnings};
  if (!isObject(raw)) {
    warn('Scene metadata is malformed; using the image with defaults.');
    return {scene, warnings};
  }
  if (!supportedMetadata(raw, warn)) return {scene, warnings};
  if (raw.version === undefined) warn('Scene version is missing; treating metadata as version 1.');
  scene.name = text(raw.name, scene.name, 'Scene name', warn, 200);
  if (raw.image !== undefined) {
    if (!isObject(raw.image)) warn('Scene image dimensions are malformed; using the actual image pixels.');
    else for (const [axis, actual] of [['width', width], ['height', height]]) {
      const declared = numeric(raw.image[axis], `Image ${axis}`, warn);
      if (declared !== actual) warn(`Image ${axis} does not match the actual PNG (${actual}); coordinates were not rescaled.`);
    }
  }
  const calibration = normalizeGrid(raw.grid, {image: {width, height}});
  scene.grid = calibration.grid;
  for (const warning of calibration.warnings) warn(warning);
  const lightLocations = new Set();
  function coordinates(record, keys, label) {
    const result = {};
    let clamped = false;
    for (const key of keys) {
      const value = numeric(record[key], `${label}.${key}`, warn);
      const max = key.startsWith('x') ? width : height;
      if (value === null || value < -8 || value > max + 8) {
        warn(`${label}: skipped because coordinates are invalid or more than 8 pixels outside the image.`);
        return null;
      }
      result[key] = Math.max(0, Math.min(max, value));
      clamped ||= result[key] !== value;
    }
    if (clamped) warn(`${label}: clamped coordinates within 8 pixels of the image edge.`);
    return result;
  }
  let remaining = MAX_RECORDS;
  for (const collection of ['walls', 'doors', 'windows', 'lights']) {
    const records = raw[collection];
    if (records === undefined) continue;
    if (!Array.isArray(records)) {
      warn(`${collection}: expected an array; ignored this collection.`);
      continue;
    }
    const count = Math.min(remaining, records.length);
    remaining -= count;
    if (records.length > count) warn(`${collection}: truncated at the ${MAX_RECORDS} aggregate record limit.`);
    for (let index = 0; index < count; index++) {
      const record = records[index];
      const label = `${collection}[${index}]`;
      if (!isObject(record)) {
        warn(`${label}: skipped a malformed record.`);
        continue;
      }
      const point = coordinates(record, collection === 'lights' ? ['x', 'y'] : ['x1', 'y1', 'x2', 'y2'], label);
      if (!point) continue;
      if (collection === 'lights') {
        let color = '#ffffff';
        if (record.color !== undefined) {
          if (typeof record.color === 'string' && /^#[0-9a-f]{6}$/i.test(record.color)) color = record.color;
          else warn(`${label}.color: invalid color; using #ffffff.`);
        }
        const light = {
          ...point,
          dim: optionalNumber(record.dim, 0, `${label}.dim`, warn, {min: 0, max: MAX_LIGHT_RADIUS}),
          bright: optionalNumber(record.bright, 0, `${label}.bright`, warn, {min: 0, max: MAX_LIGHT_RADIUS}),
          color,
          alpha: optionalNumber(record.alpha, 0.25, `${label}.alpha`, warn, {min: 0, max: 1, clamp: true})
        };
        if(record.luminosity!==undefined)
          light.luminosity=optionalNumber(record.luminosity,.5,`${label}.luminosity`,warn,{min:0,max:1,clamp:true});
        const animation=normalizeLightAnimation(record.animation,{label:`${label}.animation`,warn});
        if(animation)light.animation=animation;
        if (!light.dim && !light.bright) {
          warn(`${label}: omitted a light with no gameplay radius.`);
          continue;
        }
        const location = JSON.stringify([Math.round(light.x),Math.round(light.y),color.toLowerCase(),
          light.dim,light.bright,light.alpha,light.luminosity??.5,light.animation??null]);
        if (lightLocations.has(location)) {
          warn(`${label}: omitted a duplicate matching emitter at the same native pixel.`);
          continue;
        }
        lightLocations.add(location);
        scene.lights.push(light);
      } else {
        if (point.x1 === point.x2 && point.y1 === point.y2) {
          warn(`${label}: skipped a zero-length segment.`);
          continue;
        }
        if (collection === 'doors') {
          point.secret = optionalBoolean(record.secret, false, `${label}.secret`, warn);
          point.state = ['closed', 'open', 'locked'].includes(record.state) ? record.state : 'closed';
          if (record.state !== undefined && point.state !== record.state) warn(`${label}.state: invalid state; using closed.`);
        }
        scene[collection].push(point);
      }
    }
  }
  scene.globalLight = optionalBoolean(raw.globalLight, true, 'Global light', warn);
  scene.darkness = optionalNumber(raw.darkness, 0, 'Darkness', warn, {min: 0, max: 1, clamp: true});
  return {scene, warnings};
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngHeader(bytes) {
  if (bytes.length > MAX_PNG_BYTES) throw new Error('PNG exceeds the 60 MiB image limit.');
  if (bytes.length < 33 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) throw new Error('Image is not a canonical PNG.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw new Error('PNG has an invalid IHDR header.');
  const width = view.getUint32(16), height = view.getUint32(20);
  dimensions(width, height);
  const bitDepths = {0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]};
  if (!bitDepths[bytes[25]]?.includes(bytes[24]) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1 ||
      crc32(bytes.subarray(12, 29)) !== view.getUint32(29)) throw new Error('PNG has a corrupt or unsupported IHDR header.');
  return {width, height};
}

async function browserDecodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    try { return {width: bitmap.width, height: bitmap.height}; }
    finally { bitmap.close(); }
  }
  if (typeof Image === 'undefined') throw new Error('No browser PNG decoder is available.');
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('The browser could not decode the PNG image.'));
      image.src = url;
    });
    return {width: image.naturalWidth, height: image.naturalHeight};
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function readSceneMetadata(input) {
  if (input === undefined || input === null) return {raw: undefined, warnings: []};
  const {warnings, warn} = warningList();
  const invalid = {raw: null, warnings};
  const tooLarge = () => {
    warn('Scene metadata exceeds the 2 MiB JSON limit; it was not applied. You can continue with the image.');
    return invalid;
  };
  let source;
  if (typeof input === 'string') {
    if (input.length > MAX_JSON_BYTES || new TextEncoder().encode(input).length > MAX_JSON_BYTES) return tooLarge();
    source = input;
  } else if (typeof Blob !== 'undefined' && input instanceof Blob) {
    if (input.size > MAX_JSON_BYTES) return tooLarge();
    let bytes;
    try { bytes = new Uint8Array(await input.arrayBuffer()); }
    catch {
      warn('Scene metadata could not be read; it was not applied. You can continue with the image.');
      return invalid;
    }
    if (bytes.length > MAX_JSON_BYTES) return tooLarge();
    try { source = new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
    catch {
      warn('Scene metadata is not valid UTF-8 text; it was not applied. You can continue with the image.');
      return invalid;
    }
  } else {
    warn('Scene metadata must be a JSON file or JSON text; it was not applied.');
    return invalid;
  }
  let raw;
  try { raw = JSON.parse(source.replace(/^\uFEFF/, '')); }
  catch {
    warn('Scene metadata is empty or contains malformed JSON; it was not applied. You can continue with the image.');
    return invalid;
  }
  if (!isObject(raw)) {
    warn('Scene metadata must contain a JSON object; it was not applied.');
    return invalid;
  }
  if (!supportedMetadata(raw, warn)) return invalid;
  if (raw.format === undefined || raw.version === undefined) warn('Scene format or version is missing; treating metadata as version 1.');
  return {raw, warnings};
}

export async function importBattlemap(imageFile, {onImage, decodeImage = browserDecodeImage} = {}) {
  if (imageFile === undefined || imageFile === null) throw new Error('Choose a PNG image to import.');
  let bytes;
  if (typeof Blob !== 'undefined' && imageFile instanceof Blob) {
    if (imageFile.size > MAX_PNG_BYTES) throw new Error('PNG exceeds the 60 MiB image limit.');
    try { bytes = new Uint8Array(await imageFile.arrayBuffer()); }
    catch (error) { throw new Error('The PNG image could not be read. Please choose the image again.', {cause: error}); }
  } else if (imageFile instanceof Uint8Array) bytes = imageFile;
  else if (imageFile instanceof ArrayBuffer) bytes = new Uint8Array(imageFile);
  else throw new TypeError('The battlemap image must be a PNG File, Blob, Uint8Array or ArrayBuffer.');
  const {width, height} = pngHeader(bytes);
  const imageBlob = new Blob([bytes], {type: 'image/png'});
  const decoded = await decodeImage(imageBlob);
  dimensions(decoded?.width, decoded?.height);
  if (decoded.width !== width || decoded.height !== height) throw new Error('Decoded PNG dimensions do not match its IHDR header.');
  if (onImage) await onImage({blob: imageBlob, width, height});
  const filename = typeof imageFile.name === 'string' ? imageFile.name.trim().replace(/\.[^.]*$/, '').trim() : '';
  const name = filename && filename.length <= 200 && !/^[.]+$|[\\/\x00-\x1f\x7f]/.test(filename) ? filename : 'Imported battlemap';
  return {...normalizeScene(undefined, {width, height}, {name}), imageBlob};
}
