// Одноразовый генератор PWA-иконок для apps/web/public/icons.
// Без внешних зависимостей: рисуем RGBA-буфер и кодируем PNG через zlib.
// Дизайн намеренно простой: фон бренда #0f172a + центральный янтарный
// «алерт»-кружок (#f59e0b) с белым кольцом — узнаётся как уведомление.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function png(size) {
  const bg = [15, 23, 42]; // #0f172a
  const dot = [245, 158, 11]; // #f59e0b
  const ring = [255, 255, 255];
  const cx = size / 2,
    cy = size / 2;
  const rDot = size * 0.28;
  const rRingOuter = size * 0.34;
  const rRingInner = size * 0.30;
  // raw: каждая строка начинается с filter-byte 0
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      let col = bg;
      if (d <= rDot) col = dot;
      else if (d >= rRingInner && d <= rRingOuter) col = ring;
      const o = y * (stride + 1) + 1 + x * 4;
      raw[o] = col[0];
      raw[o + 1] = col[1];
      raw[o + 2] = col[2];
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'apps', 'web', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
const files = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
];
for (const [name, size] of files) {
  fs.writeFileSync(path.join(outDir, name), png(size));
  console.log('wrote', name, size);
}
