import {deflateSync} from 'node:zlib';

function checksum(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, bytes) {
  const result = Buffer.alloc(12 + bytes.length);
  result.writeUInt32BE(bytes.length, 0);
  result.write(type, 4, 'ascii');
  Buffer.from(bytes).copy(result, 8);
  result.writeUInt32BE(checksum(result.subarray(4, -4)), result.length - 4);
  return result;
}

// These generated color fields are parser fixtures, not artwork or aesthetic evidence.
export function makePng({width = 256, height = 192, color = [70, 90, 110], headerOnly = false} = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (!headerOnly) {
    const pixels = Buffer.alloc(height * (width * 3 + 1));
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = y * (width * 3 + 1) + 1 + x * 3;
      for (let channel = 0; channel < 3; channel++) pixels[index + channel] = (color[channel] + (x + y) % 16) % 256;
    }
    parts.push(chunk('IDAT', deflateSync(pixels)));
  }
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(parts));
}

export const basicScene = () => ({
  version: 1, name: 'Synthetic parser fixture', image: {width: 256, height: 192},
  grid: {size: 70, distance: 5, units: 'ft'},
  walls: [{x1: 10, y1: 10, x2: 200, y2: 10}],
  doors: [{x1: 80, y1: 10, x2: 100, y2: 10, secret: false, state: 'closed'}],
  windows: [{x1: 140, y1: 10, x2: 160, y2: 10}],
  lights: [{x: 90, y: 90, dim: 30, bright: 10, color: '#fac864', alpha: 0.4}],
  darkness: 0.2, globalLight: false
});

export const SYNTHETIC_SCENES = [
  {name: 'Example tavern', color: [100, 65, 35], walls: [{x1: 15, y1: 20, x2: 180, y2: 20}, {x1: 180, y1: 20, x2: 180, y2: 150}]},
  {name: 'Dungeon', color: [70, 70, 75], walls: [{x1: 10, y1: 10, x2: 120, y2: 10}, {x1: 120.25, y1: 10, x2: 240, y2: 10}]},
  {name: 'Mansion', color: [110, 90, 60], walls: [{x1: 40, y1: 20, x2: 40, y2: 170}, {x1: 40, y1: 85, x2: 220, y2: 85}]},
  {name: 'Laboratory', color: [65, 100, 100], walls: [{x1: 20, y1: 40, x2: 200, y2: 40}, {x1: 100, y1: 40, x2: 220, y2: 40}]},
  {name: 'Ship', color: [75, 80, 110], walls: [{x1: 20, y1: 90, x2: 130, y2: 20}, {x1: 130, y1: 20, x2: 240, y2: 90}]},
  {name: 'Shop', color: [125, 80, 70], walls: [{x1: 30, y1: 30, x2: 200, y2: 30}, {x1: 30, y1: 30, x2: 30, y2: 160}]},
  {name: 'Cave', color: [75, 90, 70], walls: [{x1: 14.5, y1: 48.25, x2: 68.75, y2: 20.1}, {x1: 68.75, y1: 20.1, x2: 160.5, y2: 45.8}]},
  {name: 'Magical sanctum', color: [100, 60, 130], walls: [{x1: 30, y1: 30, x2: 200, y2: 160}, {x1: 30, y1: 160, x2: 200, y2: 30}]},
  {name: 'Example interior', color: [65, 85, 60], walls: [{x1: 20, y1: 20, x2: 20, y2: 160}, {x1: 20, y1: 90, x2: 220, y2: 90}, {x1: 130.5, y1: 20, x2: 130.5, y2: 160}]}
];
