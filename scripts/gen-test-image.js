// 生成 test/test.png 样例图:320x240,白底 + 偏右红色圆 + 左上蓝色方块 + 绿色小方块。
// 不依赖任何第三方库(zlib 为 Node 内置),视觉模型能描述出"白底上有红圆、蓝方块、绿方块"。
//
// 用法:node scripts/gen-test-image.js(输出到 test/test.png)
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDTH = 320;
const HEIGHT = 240;

// 逐像素绘制(像素值均为 0-255)
function pixelAt(x, y) {
  // 白底
  let r = 255, g = 255, b = 255;
  // 偏右红色圆:半径 60,圆心 (170, 120)(320x240 中心在 (160,120),故意略偏右)
  const dx = x - 170, dy = y - 120;
  if (dx * dx + dy * dy <= 60 * 60) { r = 220; g = 40; b = 40; }
  // 左上蓝色方块:40x40,(30, 20)
  if (x >= 30 && x < 70 && y >= 20 && y < 60) { r = 40; g = 80; b = 220; }
  // 左下绿色小方块:30x30,(30, 190)
  if (x >= 30 && x < 60 && y >= 190 && y < 220) { r = 40; g = 180; b = 70; }
  return [r, g, b];
}

// ---- PNG 编码 ----
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** 组装一个 PNG 块:长度 + 类型 + 数据 + CRC。 */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function buildPng() {
  // 每行前面加 filter byte(0 = None),颜色类型 2 = RGB
  const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    const rowStart = y * (WIDTH * 3 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < WIDTH; x++) {
      const [r, g, b] = pixelAt(x, y);
      const off = rowStart + 1 + x * 3;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8;  // 位深
  ihdr[9] = 2;  // 颜色类型 RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'test.png');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, buildPng());
console.log(`已生成 ${outPath}(${WIDTH}x${HEIGHT}, ${(statSync(outPath).size / 1024).toFixed(1)}KB)`);
