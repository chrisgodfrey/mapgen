import test from 'node:test';
import assert from 'node:assert/strict';
import * as sceneImport from '../scripts/scene-import.js';
import {basicScene, makePng, SYNTHETIC_SCENES} from './scene-fixture.js';

const {importBattlemap, normalizeGrid, normalizeScene, readSceneMetadata} = sceneImport;
const imageSize = {width: 256, height: 192};
const decodeImage = async () => imageSize;
const load = (image = makePng(), options = {}) => importBattlemap(image, {decodeImage, ...options});
const warningsText = result => result.warnings.join('\n');
const metadataJson = (scene = basicScene()) => JSON.stringify({format: 'mapgen', ...scene});
const JSON_LIMIT = 2 * 1024 * 1024;
const PNG_LIMIT = 60 * 1024 * 1024;

function imageOnly(result) {
  assert.deepEqual(result.scene, {
    version: 1, name: result.scene.name, image: imageSize,
    grid: {size: 70, distance: 5, units: 'ft'},
    walls: [], doors: [], windows: [], lights: [], darkness: 0, globalLight: true
  });
}

async function withMetadata(scene) {
  const imported = await load();
  const metadata = await readSceneMetadata(metadataJson(scene));
  const normalized = normalizeScene(metadata.raw, imported.scene.image, {name: imported.scene.name});
  return {...normalized, imageBlob: imported.imageBlob, warnings: [...metadata.warnings, ...normalized.warnings]};
}

function replaceGlobal(t, key, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, {value, writable: true, configurable: true});
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  });
}

test('public exports expose only direct image import, metadata reading and normalization', () => {
  assert.deepEqual(Object.keys(sceneImport).sort(), ['importBattlemap', 'normalizeGrid', 'normalizeScene', 'readSceneMetadata']);
});

test('MapGen v1 metadata preserves scene semantics and other named formats are not interpreted',async()=>{
  const read=await readSceneMetadata(JSON.stringify({...basicScene(),format:'mapgen'}));
  assert.deepEqual(read.warnings,[]);
  const result=normalizeScene(read.raw,imageSize);
  assert.deepEqual(result.scene,basicScene());
  assert.deepEqual(result.warnings,[]);
  const unsupported=await readSceneMetadata(JSON.stringify({...basicScene(),format:'unsupported-format',version:1}));
  assert.equal(unsupported.raw,null);
  assert.match(warningsText(unsupported),/Unsupported/);
});

test('PNG without metadata succeeds with exact original bytes, defaults and no warnings', async () => {
  const image = makePng();
  const result = await load(image);
  assert.deepEqual(Object.keys(result).sort(), ['imageBlob', 'scene', 'warnings']);
  imageOnly(result);
  assert.equal(result.scene.name, 'Imported battlemap');
  assert.equal(result.imageBlob.type, 'image/png');
  assert.deepEqual(new Uint8Array(await result.imageBlob.arrayBuffer()), image);
  assert.deepEqual(result.warnings, []);
});

test('File, Blob, ArrayBuffer and nonzero-offset Uint8Array inputs preserve PNG bytes', async () => {
  const bytes = makePng();
  const padded = new Uint8Array(bytes.length + 10);
  padded.set(bytes, 5);
  for (const input of [new File([bytes], 'map.png'), new Blob([bytes], {type: 'application/octet-stream'}),
    bytes.buffer, padded.subarray(5, -5)]) {
    const result = await load(input);
    imageOnly(result);
    assert.deepEqual(new Uint8Array(await result.imageBlob.arrayBuffer()), bytes);
    assert.deepEqual(result.warnings, []);
  }
});

test('scene names use usable filenames without their final extension, bounded to 200 characters', async () => {
  for (const [filename, expected] of [
    ['Example tavern.PNG', 'Example tavern'],
    ['map.final.png', 'map.final'],
    ['  Example interior .png  ', 'Example interior'],
    ['Dungeon', 'Dungeon'],
    ['N'.repeat(200) + '.png', 'N'.repeat(200)],
    ['N'.repeat(201) + '.png', 'Imported battlemap'],
    ['.png', 'Imported battlemap'],
    ['   .png', 'Imported battlemap'],
    ['...png', 'Imported battlemap'],
    ['bad\0name.png', 'Imported battlemap']
  ]) {
    const result = await load(new File([makePng()], filename));
    assert.equal(result.scene.name, expected);
    assert.deepEqual(result.warnings, []);
  }
});

for (const fixture of SYNTHETIC_SCENES) {
  test(`synthetic ${fixture.name}: independent PNG and metadata evidence, not aesthetic proof`, async () => {
    const scene = {...basicScene(), name: fixture.name, walls: fixture.walls};
    const image = makePng({color: fixture.color});
    const metadata = await readSceneMetadata(new File([metadataJson(scene)], 'scene.json'));
    const imported = await load(new File([image], `${fixture.name}.png`));
    imageOnly(imported);
    assert.equal(imported.scene.name, fixture.name);
    assert.deepEqual(imported.warnings, []);
    assert.deepEqual(metadata.warnings, []);
    const result = normalizeScene(metadata.raw, imported.scene.image, {name: imported.scene.name});
    assert.deepEqual(result.scene, scene);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(new Uint8Array(await imported.imageBlob.arrayBuffer()), image);
  });
}

test('onImage is awaited after decoding and before default scene name normalization or return', async () => {
  const events = [];
  class NamedImage extends Blob {
    get name() { events.push('read filename'); return 'Preview.png'; }
  }
  let previewBlob;
  const imported = await load(new NamedImage([makePng()]), {
    decodeImage: async () => { events.push('decode'); return imageSize; },
    onImage: async ({blob, width, height}) => {
      events.push('preview');
      assert.deepEqual({width, height}, imageSize);
      previewBlob = blob;
      await Promise.resolve();
      assert.deepEqual(events, ['decode', 'preview']);
      events.push('preview complete');
    }
  });
  events.push('returned');
  assert.deepEqual(events.slice(0, 3), ['decode', 'preview', 'preview complete']);
  assert.ok(events.indexOf('read filename') > events.indexOf('preview complete'));
  assert.equal(events.at(-1), 'returned');
  assert.equal(imported.imageBlob, previewBlob);
  assert.equal(imported.scene.name, 'Preview');
  assert.deepEqual(imported.warnings, []);
});

test('preview callback errors propagate and the callback is not retried', async () => {
  let calls = 0;
  await assert.rejects(load(makePng(), {
    onImage: async () => { calls++; throw new Error('Preview failed'); }
  }), /Preview failed/);
  assert.equal(calls, 1);
});

test('default bitmap decoder receives original PNG and closes its bitmap before preview', async t => {
  const image = makePng();
  const events = [];
  replaceGlobal(t, 'createImageBitmap', async blob => {
    assert.equal(blob.type, 'image/png');
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), image);
    events.push('decode');
    return {...imageSize, close: () => events.push('close')};
  });
  const result = await importBattlemap(image, {onImage: () => events.push('preview')});
  imageOnly(result);
  assert.deepEqual(events, ['decode', 'close', 'preview']);
});

test('bitmap resources are released even when decoded dimensions are invalid', async t => {
  let closed = false;
  replaceGlobal(t, 'createImageBitmap', async () => ({width: 0, height: 192, close: () => { closed = true; }}));
  await assert.rejects(importBattlemap(makePng()), /dimensions/);
  assert.equal(closed, true);
});

test('Image fallback revokes object URLs on both decode success and failure', async t => {
  replaceGlobal(t, 'createImageBitmap', undefined);
  let mode = 'success';
  const created = [], revoked = [];
  t.mock.method(URL, 'createObjectURL', blob => {
    assert.equal(blob.type, 'image/png');
    const url = `blob:test-${created.length}`;
    created.push(url);
    return url;
  });
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  replaceGlobal(t, 'Image', class {
    naturalWidth = 256;
    naturalHeight = 192;
    set src(value) {
      assert.equal(value, created.at(-1));
      queueMicrotask(() => mode === 'success' ? this.onload() : this.onerror());
    }
  });
  const imported = await importBattlemap(makePng());
  imageOnly(imported);
  assert.deepEqual(revoked, created);
  mode = 'failure';
  await assert.rejects(importBattlemap(makePng()), /could not decode/);
  assert.equal(created.length, 2);
  assert.deepEqual(revoked, created);
});

test('an unavailable browser decoder is an explicit image failure', async t => {
  replaceGlobal(t, 'createImageBitmap', undefined);
  replaceGlobal(t, 'Image', undefined);
  await assert.rejects(importBattlemap(makePng()), /No browser PNG decoder/);
});

test('missing, corrupt and unreadable images fail without showing a preview', async () => {
  let previews = 0;
  for (const input of [undefined, null, '', 'map.png', new Blob(), new Uint8Array([1, 2, 3]), {}]) {
    await assert.rejects(importBattlemap(input, {
      decodeImage, onImage: () => { previews++; }
    }), /PNG/);
  }
  class UnreadableImage extends Blob {
    async arrayBuffer() { throw new Error('File no longer available'); }
  }
  await assert.rejects(load(new UnreadableImage(), {onImage: () => { previews++; }}), /could not be read/);
  await assert.rejects(load(makePng(), {
    decodeImage: async () => { throw new Error('Invalid pixel stream'); },
    onImage: () => { previews++; }
  }), /Invalid pixel stream/);
  assert.equal(previews, 0);
});

test('PNG bytes are bounded before reading or decoding', async () => {
  let reads = 0, decodes = 0;
  class OversizedImage extends Blob {
    get size() { return PNG_LIMIT + 1; }
    async arrayBuffer() { reads++; return new ArrayBuffer(0); }
  }
  const decoder = async () => { decodes++; return imageSize; };
  await assert.rejects(load(new OversizedImage(), {decodeImage: decoder}), /60 MiB/);
  assert.equal(reads, 0);
  const oversized = new Uint8Array(PNG_LIMIT + 1);
  await assert.rejects(load(oversized, {decodeImage: decoder}), /60 MiB/);
  await assert.rejects(load(oversized.buffer, {decodeImage: decoder}), /60 MiB/);
  assert.equal(decodes, 0);
});

test('PNG size is checked again after a file is read', async () => {
  class MisreportedImage extends Blob {
    async arrayBuffer() { return new ArrayBuffer(PNG_LIMIT + 1); }
  }
  await assert.rejects(load(new MisreportedImage()), /60 MiB/);
});

test('IHDR dimensions are bounded before calling the image decoder', async () => {
  for (const [width, height] of [[0, 192], [256, 0], [16385, 1], [1, 16385], [10000, 4001]]) {
    await assert.rejects(load(makePng({width, height, headerOnly: true}), {
      decodeImage: () => assert.fail('Oversized PNG must not reach the decoder')
    }), /dimensions.*limit/);
  }
});

test('exact dimension and pixel boundaries reach the injected decoder', async () => {
  for (const [width, height] of [[16384, 1], [1, 16384], [10000, 4000]]) {
    const imported = await load(makePng({width, height, headerOnly: true}), {
      decodeImage: async () => ({width, height})
    });
    assert.deepEqual(imported.scene.image, {width, height});
    assert.deepEqual(imported.warnings, []);
  }
});

test('PNG signature, IHDR layout and IHDR CRC are validated before decoding', async () => {
  for (const index of [0, 11, 12, 24, 25, 26, 27, 28, 29]) {
    const image = makePng();
    image[index] ^= 0xff;
    await assert.rejects(load(image, {
      decodeImage: () => assert.fail('Invalid header must not reach the decoder')
    }), /PNG/);
  }
  await assert.rejects(load(makePng().subarray(0, 32)), /canonical PNG/);
});

test('decoded dimensions must be finite positive integers and match IHDR', async () => {
  for (const decoded of [{width: 128, height: 96}, {width: 0, height: 0}, {width: Infinity, height: 192},
    {width: 256.5, height: 192}, {width: '256', height: 192}, null, undefined]) {
    await assert.rejects(load(makePng(), {
      decodeImage: async () => decoded,
      onImage: () => assert.fail('Mismatched image must not be shown')
    }), /dimensions/);
  }
});

test('omitted metadata is a normal no-op and differs from explicitly malformed raw metadata', async () => {
  for (const input of [undefined, null]) {
    assert.deepEqual(await readSceneMetadata(input), {raw: undefined, warnings: []});
  }
  const absent = normalizeScene(undefined, imageSize);
  imageOnly(absent);
  assert.deepEqual(absent.warnings, []);
  for (const raw of [null, [], '', 0, false]) {
    const result = normalizeScene(raw, imageSize);
    imageOnly(result);
    assert.match(warningsText(result), /malformed/);
  }
});

test('metadata can be read before the image or applied after preview without image side effects', async () => {
  for (const before of [true, false]) {
    const scene = {...basicScene(), image: {width: 999, height: 999}};
    let metadata;
    if (before) metadata = await readSceneMetadata(metadataJson(scene));
    const image = await load();
    imageOnly(image);
    if (!before) metadata = await readSceneMetadata(metadataJson(scene));
    assert.deepEqual(metadata.raw, {format: 'mapgen', ...scene});
    assert.deepEqual(metadata.warnings, []);
    const applied = normalizeScene(metadata.raw, image.scene.image, {name: image.scene.name});
    assert.deepEqual(applied.scene.walls, scene.walls);
    assert.deepEqual(applied.scene.image, imageSize);
    assert.match(warningsText(applied), /coordinates were not rescaled/);
    imageOnly(image);
  }
});

test('JSON strings, Files and Blobs read consistently, with or without a UTF-8 BOM', async () => {
  const raw = {format: 'mapgen', ...basicScene()};
  const json = JSON.stringify(raw);
  for (const text of [json, `\uFEFF${json}`]) {
    for (const input of [text, new File([text], 'scene.json'), new Blob([text])]) {
      const result = await readSceneMetadata(input);
      assert.deepEqual(result, {raw, warnings: []});
    }
  }
});

test('empty, malformed and nonobject JSON returns raw null with calm warnings, not rejection', async () => {
  for (const text of ['', '  ', '\uFEFF', '{bad JSON', '[]', 'null', '42', 'true', '"scene"']) {
    for (const input of [text, new Blob([text])]) {
      const result = await readSceneMetadata(input);
      assert.equal(result.raw, null);
      assert.ok(result.warnings.length > 0);
      assert.match(warningsText(result), /not applied/);
    }
  }
  for (const input of [0, false, [], {}, new Uint8Array()]) {
    const result = await readSceneMetadata(input);
    assert.equal(result.raw, null);
    assert.match(warningsText(result), /JSON file or JSON text/);
  }
});

test('a malformed metadata replacement is distinguishable and does not mutate the prior preview', async () => {
  const valid = await readSceneMetadata(metadataJson());
  const preview = normalizeScene(valid.raw, imageSize);
  const original = structuredClone(preview);
  const replacement = await readSceneMetadata('{"walls":');
  assert.equal(replacement.raw, null);
  assert.ok(replacement.warnings.length > 0);
  assert.deepEqual(preview, original);
  assert.deepEqual(valid.raw, {format: 'mapgen', ...basicScene()});
  assert.equal((await readSceneMetadata(undefined)).raw, undefined);
});

test('unsupported scene formats and versions never reinterpret geometry', async () => {
  for (const override of [{version: 99}, {version: 0}, {version: null}, {version: true}, {version: 'future'},
    {format: 'unknown'}, {format: null}, {format: 1}]) {
    const raw = {format: 'mapgen', ...basicScene(), ...override};
    const result = await readSceneMetadata(JSON.stringify(raw));
    assert.equal(result.raw, null);
    assert.match(warningsText(result), /Unsupported scene/);
    const normalized = normalizeScene(raw, imageSize);
    imageOnly(normalized);
    assert.match(warningsText(normalized), /Unsupported scene/);
  }
});

test('missing format or version is allowed with a version-one warning', async () => {
  const raw = {format: 'mapgen', ...basicScene()};
  for (const keys of [['format'], ['version'], ['format', 'version']]) {
    const source = {...raw};
    for (const key of keys) delete source[key];
    const result = await readSceneMetadata(JSON.stringify(source));
    assert.deepEqual(result.raw, source);
    assert.match(warningsText(result), /missing.*version 1/);
    const normalized = normalizeScene(result.raw, imageSize);
    assert.deepEqual(normalized.scene, basicScene());
    if (keys.includes('version')) assert.match(warningsText(normalized), /version is missing/);
  }
  const empty = await readSceneMetadata('{}');
  assert.deepEqual(empty.raw, {});
  assert.match(warningsText(empty), /missing/);
});

test('numeric-string version one is accepted with a warning without rewriting the raw object', async () => {
  const raw = {format: 'mapgen', ...basicScene(), version: ' 1 '};
  const result = await readSceneMetadata(JSON.stringify(raw));
  assert.deepEqual(result.raw, raw);
  assert.match(warningsText(result), /numeric string/);
  const normalized = normalizeScene(result.raw, imageSize);
  assert.deepEqual(normalized.scene, basicScene());
  assert.match(warningsText(normalized), /numeric string/);
});

test('JSON byte budget is checked before file reads and before any parse', async t => {
  let reads = 0, parses = 0;
  class OversizedMetadata extends Blob {
    get size() { return JSON_LIMIT + 1; }
    async arrayBuffer() { reads++; return new ArrayBuffer(0); }
  }
  const original = JSON.parse;
  t.mock.method(JSON, 'parse', (...args) => { parses++; return original(...args); });
  for (const input of [new OversizedMetadata(), ' '.repeat(JSON_LIMIT + 1),
    `{"text":"${'\u00e9'.repeat(JSON_LIMIT / 2)}"}`]) {
    const result = await readSceneMetadata(input);
    assert.equal(result.raw, null);
    assert.match(warningsText(result), /2 MiB/);
  }
  assert.equal(reads, 0);
  assert.equal(parses, 0);
});

test('JSON exactly at the UTF-8 byte limit is allowed for both strings and files', async () => {
  const raw = {format: 'mapgen', version: 1, name: 'Caf\u00e9'};
  const json = JSON.stringify(raw);
  const text = json + ' '.repeat(JSON_LIMIT - new TextEncoder().encode(json).length);
  assert.equal(new TextEncoder().encode(text).length, JSON_LIMIT);
  for (const input of [text, new Blob([text])]) {
    assert.deepEqual(await readSceneMetadata(input), {raw, warnings: []});
  }
});

test('metadata read failures, invalid UTF-8 and actual oversize bytes return raw null', async () => {
  class UnreadableMetadata extends Blob {
    async arrayBuffer() { throw new Error('Read failed'); }
  }
  const unreadable = await readSceneMetadata(new UnreadableMetadata());
  assert.equal(unreadable.raw, null);
  assert.match(warningsText(unreadable), /could not be read/);
  for (const bytes of [[0xff, 0xfe], [0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d]]) {
    const result = await readSceneMetadata(new Blob([new Uint8Array(bytes)]));
    assert.equal(result.raw, null);
    assert.match(warningsText(result), /UTF-8/);
  }
  class MisreportedMetadata extends Blob {
    async arrayBuffer() { return new ArrayBuffer(JSON_LIMIT + 1); }
  }
  const oversized = await readSceneMetadata(new MisreportedMetadata());
  assert.equal(oversized.raw, null);
  assert.match(warningsText(oversized), /2 MiB/);
});

test('metadata reading leaves individual records for normalization and never passes unknown fields into the scene', async () => {
  const raw = {format: 'mapgen', ...basicScene(), unexpected: {enabled: true}};
  raw.grid.extra = 'ignored';
  raw.walls[0].extra = 'ignored';
  raw.doors[0].extra = 'ignored';
  raw.windows[0].extra = 'ignored';
  raw.lights[0].extra = 'ignored';
  raw.walls.push(null);
  const read = await readSceneMetadata(JSON.stringify(raw));
  assert.deepEqual(read, {raw, warnings: []});
  const normalized = normalizeScene(read.raw, imageSize);
  assert.deepEqual(normalized.scene, basicScene());
  assert.match(warningsText(normalized), /malformed record/);
});

test('overlong and malformed generated names recover without losing geometry', () => {
  for (const name of ['N'.repeat(201), '', '  ', null, 1]) {
    const result = normalizeScene({...basicScene(), name}, imageSize, {name: 'Image filename'});
    assert.equal(result.scene.name, 'Image filename');
    assert.deepEqual(result.scene.walls, basicScene().walls);
    assert.match(warningsText(result), /[Nn]ame/);
  }
  const fallback = normalizeScene({...basicScene(), name: 'S'.repeat(201)}, imageSize, {name: 'M'.repeat(201)});
  assert.equal(fallback.scene.name, 'Imported battlemap');
  assert.equal(normalizeScene({...basicScene(), name: 'N'.repeat(200)}, imageSize).scene.name.length, 200);
});

test('dimension mismatch never resizes the actual image or rescales geometry', async () => {
  const scene = {...basicScene(), image: {width: 1024, height: 768}};
  const result = await withMetadata(scene);
  assert.deepEqual(result.scene.image, imageSize);
  assert.deepEqual(result.scene.walls, scene.walls);
  assert.deepEqual(result.scene.lights, scene.lights);
  assert.match(warningsText(result), /coordinates were not rescaled/);
});

test('fractional diagonals, tiny gaps, overlaps, intersections and detached openings are preserved', () => {
  const raw = {
    ...basicScene(),
    walls: [
      {x1: 0.125, y1: 0.25, x2: 50.75, y2: 100.5},
      {x1: 50.750001, y1: 100.5, x2: 100, y2: 130},
      {x1: 0, y1: 20, x2: 100, y2: 20},
      {x1: 50, y1: 20, x2: 150, y2: 20},
      {x1: 75, y1: 0, x2: 75, y2: 100}
    ],
    doors: [{x1: 200.5, y1: 100.2, x2: 235.8, y2: 120.1, secret: true, state: 'locked'}],
    windows: [{x1: 10, y1: 175, x2: 15, y2: 180}]
  };
  const result = normalizeScene(raw, imageSize);
  assert.deepEqual(result.scene, raw);
  assert.deepEqual(result.warnings, []);
});

test('only malformed and zero-length individual records are skipped', () => {
  const good = {x1: 1, y1: 2, x2: 3, y2: 4};
  const raw = {
    version: 1,
    walls: [null, [], 'bad', {x1: 1}, {x1: Infinity, y1: 0, x2: 1, y2: 1}, {x1: 1, y1: 1, x2: 1, y2: 1}, good],
    doors: [null, {...good, secret: true, state: 'open'}],
    windows: [{x1: 2, y1: 2, x2: 2, y2: 2}, good],
    lights: [{x: null, y: 1}, {x: 5, y: 6, dim: 20, bright: 10, color: '#abcdef', alpha: 0.7}]
  };
  const result = normalizeScene(raw, imageSize);
  assert.deepEqual(result.scene.walls, [good]);
  assert.deepEqual(result.scene.doors, [{...good, secret: true, state: 'open'}]);
  assert.deepEqual(result.scene.windows, [good]);
  assert.equal(result.scene.lights.length, 1);
  assert.match(warningsText(result), /zero-length/);
  assert.match(warningsText(result), /malformed record/);
});

test('endpoints at most eight pixels outside are clamped; farther records are skipped', () => {
  const raw = {
    version: 1,
    walls: [
      {x1: -8, y1: -0.5, x2: 264, y2: 200},
      {x1: -8.001, y1: 2, x2: 3, y2: 4},
      {x1: 1, y1: 2, x2: 264.001, y2: 4},
      {x1: 1, y1: -8.001, x2: 3, y2: 4},
      {x1: 1, y1: 2, x2: 3, y2: 200.001},
      {x1: -1, y1: 0, x2: 0, y2: -1}
    ],
    lights: [{x: 264, y: -8, dim: 5}, {x: 265, y: 1, dim: 5}]
  };
  const result = normalizeScene(raw, imageSize);
  assert.deepEqual(result.scene.walls, [{x1: 0, y1: 0, x2: 256, y2: 192}]);
  assert.deepEqual(result.scene.lights, [{x: 256, y: 0, dim: 5, bright: 0, color: '#ffffff', alpha: 0.25}]);
  assert.match(warningsText(result), /clamped coordinates/);
  assert.match(warningsText(result), /more than 8 pixels/);
  assert.match(warningsText(result), /zero-length/);
});

test('finite numeric strings are recovered with warnings, never interpreted as booleans', () => {
  const raw = {
    version: '1', image: {width: '256', height: '192'},
    grid: {size: ' 70.5 ', distance: '2.5', units: 'm'},
    darkness: '0.4', globalLight: 'false',
    walls: [{x1: '1.2', y1: '2e1', x2: '35', y2: '60'}],
    doors: [{x1: '4', y1: '5', x2: '6', y2: '7', secret: 'true'}],
    lights: [{x: '50', y: '70', dim: '30.5', bright: '10', color: '#AABBcc', alpha: '0'}]
  };
  const result = normalizeScene(raw, imageSize);
  assert.deepEqual(result.scene.grid, {size: 71, distance: 2.5, units: 'm'});
  assert.deepEqual(result.scene.walls, [{x1: 1.2, y1: 20, x2: 35, y2: 60}]);
  assert.equal(result.scene.darkness, 0.4);
  assert.equal(result.scene.globalLight, true);
  assert.equal(result.scene.doors[0].secret, false);
  assert.deepEqual(result.scene.lights, [{x: 50, y: 70, dim: 30.5, bright: 10, color: '#AABBcc', alpha: 0}]);
  assert.match(warningsText(result), /numeric string/);
  assert.match(warningsText(result), /invalid boolean/);
});

test('fractional grid sizes match native integer pixels without changing geometry or distance units', () => {
  for (const size of [50.5, 70.25, 999.9, '50.5']) {
    const raw = {...basicScene(), grid: {size, distance: 2.5, units: 'm'}};
    const result = normalizeScene(raw, imageSize);
    assert.deepEqual(result.scene.grid, {size: Math.round(Number(size)), distance: 2.5, units: 'm'});
    assert.deepEqual(result.scene.walls, raw.walls);
    assert.deepEqual(result.scene.doors, raw.doors);
    assert.deepEqual(result.scene.windows, raw.windows);
    assert.deepEqual(result.scene.lights, raw.lights);
    assert.match(warningsText(result), /rounded/);
    assert.doesNotMatch(warningsText(result), /rescaled/);
  }
});

test('grid settings at the documented UI boundaries are retained', () => {
  for (const grid of [
    {size: 20, distance: 0.01, units: 'm'},
    {size: 1000, distance: 10000, units: 'x'.repeat(32)}
  ]) {
    const image = {width: 3000, height: 2400};
    const result = normalizeScene({...basicScene(), image, grid}, image);
    assert.deepEqual(result.scene.grid, grid);
    assert.deepEqual(result.warnings, []);
  }
  const result = normalizeScene({version: 1, grid: {units: '  ft  '}}, imageSize);
  assert.equal(result.scene.grid.units, 'ft');
  assert.deepEqual(result.warnings, []);
});

test('out-of-range grid settings default with warnings instead of blocking Create', async () => {
  for (const [key, values, label] of [
    ['size', [0, -1, 0.1, 2, '0.1', 19.999, 1000.001, '1001', Infinity, NaN], 'Grid size'],
    ['distance', [0, -1, 10000.001, '10001', Infinity, NaN], 'Grid distance'],
    ['units', ['', '   ', 'x'.repeat(33), null, 5], 'Grid units']
  ]) {
    for (const value of values) {
      const raw = basicScene();
      raw.grid[key] = value;
      const result = normalizeScene(raw, imageSize);
      assert.deepEqual(result.scene.grid, {size: 70, distance: 5, units: 'ft'});
      assert.ok(result.warnings.some(warning => warning.startsWith(label)));
      for (const collection of ['walls', 'doors', 'windows', 'lights']) {
        assert.deepEqual(result.scene[collection], raw[collection]);
      }
    }
  }
  const raw = {...basicScene(), grid: {size: 2, distance: 10001, units: 'x'.repeat(33)}};
  const imported = await withMetadata(raw);
  assert.deepEqual(imported.scene.grid, {size: 70, distance: 5, units: 'ft'});
  assert.deepEqual(imported.scene.walls, raw.walls);
  assert.match(warningsText(imported), /Grid size/);
  assert.match(warningsText(imported), /Grid distance/);
  assert.match(warningsText(imported), /Grid units/);
});

test('per-map calibration accepts native-supported 20, 40 and 45px values without substituting 70',async()=>{
  for(const size of [20,35,40,45,70,120]) {
    const raw={...basicScene(),grid:{size,distance:5,units:'ft'}};
    const result=await withMetadata(raw);
    assert.deepEqual(result.scene.grid,raw.grid);
    assert.deepEqual(result.scene.walls,raw.walls);
    assert.deepEqual(result.scene.lights,raw.lights);
    assert.equal(result.warnings.some(message=>message.includes('using 70')),false);
  }
});

test('large relative grid size warns but respects the estimate and preserves usable geometry',()=>{
  const raw={...basicScene(),image:{width:1448,height:1086},grid:{size:900,distance:5,units:'ft'}};
  const result=normalizeScene(raw,raw.image);
  assert.equal(result.scene.grid.size,900);
  assert.match(warningsText(result),/large relative.*one-square token/);
  assert.deepEqual(result.scene.walls,raw.walls);
});

test('invalid manual calibration retains the last usable per-map scale rather than reverting to 70',()=>{
  const fallback={size:45,distance:5,units:'ft'};
  const result=normalizeGrid({size:2,distance:0,units:''},{fallback,image:imageSize});
  assert.deepEqual(result.grid,fallback);
  assert.equal(result.warnings.length,3);
  assert.deepEqual(fallback,{size:45,distance:5,units:'ft'});
  assert.deepEqual(normalizeGrid({size:40,distance:5,units:'ft'},{fallback}).grid,{size:40,distance:5,units:'ft'});
});

test('malformed optional values default without losing usable records', () => {
  const raw = {
    version: 1, name: 42, image: null, grid: {size: 'no', distance: 0, units: ''},
    darkness: NaN, globalLight: null,
    walls: 'not an array',
    doors: [{x1: 1, y1: 2, x2: 3, y2: 4, state: 'ajar', secret: 1}],
    lights: [{x: 4, y: 5, dim: -1, bright: 'Infinity', color: 'red', alpha: 'bad'}]
  };
  const result = normalizeScene(raw, imageSize, {name: 'Fallback name'});
  assert.equal(result.scene.name, 'Fallback name');
  assert.deepEqual(result.scene.grid, {size: 70, distance: 5, units: 'ft'});
  assert.equal(result.scene.darkness, 0);
  assert.equal(result.scene.globalLight, true);
  assert.deepEqual(result.scene.doors, [{x1: 1, y1: 2, x2: 3, y2: 4, secret: false, state: 'closed'}]);
  assert.deepEqual(result.scene.lights, []);
  assert.ok(result.warnings.length >= 10);
  for (const value of [null, [], 'grid']) {
    assert.deepEqual(normalizeScene({version: 1, grid: value}, imageSize).scene.grid, {size: 70, distance: 5, units: 'ft'});
  }
});

test('light radii stay in scene distance units; darkness and alpha are bounded', () => {
  const raw = {
    version: 1, grid: {size: 50, distance: 5, units: 'm'}, darkness: 1.5,
    lights: [
      {x: 1, y: 2, dim: 40, bright: 20, color: '#112233', alpha: 1.2},
      {x: 2, y: 3, dim: 1, bright: 0, color: '#112233', alpha: -0.1}
    ]
  };
  const result = normalizeScene(raw, imageSize);
  assert.equal(result.scene.darkness, 1);
  assert.deepEqual(result.scene.lights.map(light => [light.dim, light.bright, light.alpha]), [[40, 20, 1], [1, 0, 0]]);
  assert.match(warningsText(result), /clamped/);
});

test('all door states, secret doors and window coordinates survive normalization', () => {
  const raw = {
    version: 1,
    doors: ['closed', 'open', 'locked'].map((state, index) => ({x1: 1, y1: index, x2: 2, y2: index, state, secret: index === 2})),
    windows: [{x1: 3.1, y1: 4.2, x2: 5.3, y2: 6.4}]
  };
  const result = normalizeScene(raw, imageSize);
  assert.deepEqual(result.scene.doors, raw.doors);
  assert.deepEqual(result.scene.windows, raw.windows);
  assert.deepEqual(result.warnings, []);
});

test('record budget is aggregate and warnings remain bounded for malformed input', () => {
  const record = {x1: 1, y1: 2, x2: 3, y2: 4};
  const result = normalizeScene({
    version: 1, walls: Array(19999).fill(record), doors: [record, record], windows: [record], lights: [{x: 1, y: 2}]
  }, imageSize);
  assert.equal(result.scene.walls.length, 19999);
  assert.equal(result.scene.doors.length, 1);
  assert.equal(result.scene.windows.length, 0);
  assert.equal(result.scene.lights.length, 0);
  assert.match(warningsText(result), /20000 aggregate record limit/);
  const malformed = normalizeScene({version: 1, walls: Array(25000).fill(null)}, imageSize);
  assert.equal(malformed.warnings.length, 201);
  assert.equal(malformed.warnings.at(-1), 'Additional metadata warnings omitted.');
});

test('normalization is deterministic and does not mutate source metadata', () => {
  const raw = {...basicScene(), image: {width: 1024, height: 768}};
  raw.walls.push({x1: -1, y1: 2, x2: 4, y2: 5});
  const before = structuredClone(raw);
  assert.deepEqual(normalizeScene(raw, imageSize), normalizeScene(raw, imageSize));
  assert.deepEqual(raw, before);
  assert.throws(() => normalizeScene(raw, {width: 0, height: 1}), /dimensions/);
});
