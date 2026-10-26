/**
 * 生成扩展图标（纯 Node，无第三方依赖）
 * 用法: node tools/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SS = 4; // 超采样倍数
const SIZE = 128;

/* --- 绘制工具（坐标空间 0..SIZE） --- */
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return 0;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return Math.hypot(x - cx, y - cy) <= r ? 1 : 0;
}

function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside ? 1 : 0;
}

// 由两点生成粗线段四边形
function thickLine(p1, p2, w) {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (w / 2);
  const ny = (dx / len) * (w / 2);
  return [
    [p1[0] + nx, p1[1] + ny],
    [p2[0] + nx, p2[1] + ny],
    [p2[0] - nx, p2[1] - ny],
    [p1[0] - nx, p1[1] - ny]
  ];
}

const BG_TOP = [79, 156, 249];
const BG_BOTTOM = [29, 78, 216];

const SHAPES = [
  // 字母 A 的三笔
  thickLine([34, 92], [54, 38], 10),
  thickLine([54, 38], [74, 92], 10),
  thickLine([42, 70], [66, 70], 8),
  // 右侧箭头
  thickLine([80, 64], [100, 64], 9),
  [
    [96, 48],
    [96, 80],
    [114, 64]
  ]
];

function pixel(x, y) {
  // 背景
  const inBg = inRoundRect(x, y, 3, 3, SIZE - 3, SIZE - 3, 26);
  if (!inBg) return [0, 0, 0, 0];
  const t = Math.min(1, Math.max(0, (y - 3) / (SIZE - 6)));
  let r = BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t;
  let g = BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t;
  let b = BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t;
  // 前景白色
  for (const s of SHAPES) {
    if (inPoly(x, y, s)) {
      r = 255;
      g = 255;
      b = 255;
      break;
    }
  }
  return [r, g, b, 255];
}

function render(size) {
  const n = size * SS;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px * SS + sx + 0.5) / n) * SIZE;
          const y = ((py * SS + sy + 0.5) / n) * SIZE;
          const c = pixel(x, y);
          const ka = c[3] / 255;
          r += c[0] * ka;
          g += c[1] * ka;
          b += c[2] * ka;
          a += c[3];
        }
      }
      const total = SS * SS;
      a = a / total;
      // 背景为不透明，直接做预乘还原
      const k = a > 0 ? 255 / a : 0;
      const i = (py * size + px) * 4;
      buf[i] = Math.round((r / total) * k);
      buf[i + 1] = Math.round((g / total) * k);
      buf[i + 2] = Math.round((b / total) * k);
      buf[i + 3] = Math.round(a);
    }
  }
  return buf;
}

/* --- PNG 编码 --- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 48, 128]) {
  const buf = png(size, render(size));
  writeFileSync(join(OUT_DIR, `icon${size}.png`), buf);
  console.log(`icon${size}.png  ${buf.length} bytes`);
}
