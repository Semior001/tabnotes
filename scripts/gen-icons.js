#!/usr/bin/env node
// Generates icons/icon-{16,32,48,96,128}.png: a notepad glyph drawn in normalized
// coordinates and supersampled for anti-aliasing. No dependencies beyond node.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZES = [16, 32, 48, 96, 128];
const SAMPLES = 4; // per axis

const BORDER = [52, 73, 94];
const PAGE = [255, 250, 230];
const LINE = [120, 144, 168];

// color at normalized point (x, y) in [0, 1), or null for transparent
function shade(x, y) {
  const l = 0.14;
  const r = 0.86;
  const t = 0.08;
  const b = 0.92;
  const edge = 0.07;
  if (x < l || x >= r || y < t || y >= b) return null;
  if (x < l + edge || x >= r - edge || y < t + edge || y >= b - edge) return BORDER;
  // spiral binding strip along the top
  if (y < t + 0.2) return BORDER;
  for (const ly of [0.45, 0.6, 0.75]) {
    if (y >= ly && y < ly + 0.06 && x >= l + 0.15 && x < r - 0.15) return LINE;
  }
  return PAGE;
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const n = SAMPLES * SAMPLES;
  for (let py = 0; py < size; py++) {
    for (let qx = 0; qx < size; qx++) {
      let cr = 0;
      let cg = 0;
      let cb = 0;
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = shade((qx + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size);
          if (!c) continue;
          cr += c[0];
          cg += c[1];
          cb += c[2];
          hits++;
        }
      }
      const i = (py * size + qx) * 4;
      if (hits === 0) continue;
      px[i] = Math.round(cr / hits);
      px[i + 1] = Math.round(cg / hits);
      px[i + 2] = Math.round(cb / hits);
      px[i + 3] = Math.round((255 * hits) / n);
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // compression, filter, interlace stay 0
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, encodePNG(size, render(size)));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
