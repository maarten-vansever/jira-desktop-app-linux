// Generates build/icon.png + build/icons/512x512.png without external tooling.
// Draws a rounded tile with a Jira-style blue diamond mark (a geometric
// recreation in Atlassian blue — two interlocking chevrons meeting at a
// centre notch). Supersampled 3x for smooth diagonals, then PNG-encoded by hand.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = 512;
const SS = 3;
const S = OUT * SS;
const px = new Float64Array(S * S * 4);

function put(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const na = a + px[i + 3] * (1 - a);
  if (na <= 0) return;
  px[i] = (r * a + px[i] * px[i + 3] * (1 - a)) / na;
  px[i + 1] = (g * a + px[i + 1] * px[i + 3] * (1 - a)) / na;
  px[i + 2] = (b * a + px[i + 2] * px[i + 3] * (1 - a)) / na;
  px[i + 3] = na;
}

const u = S / 512; // logical→canvas scale

// --- rounded rect (tile) via signed distance ---
function sdRoundRect(x, y, cx, cy, hw, hh, rad) {
  const dx = Math.abs(x - cx) - (hw - rad);
  const dy = Math.abs(y - cy) - (hh - rad);
  const ox = Math.max(dx, 0), oy = Math.max(dy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(dx, dy), 0) - rad;
}
function fillRoundRect(cx, cy, w, h, rad, colorFn) {
  const hw = w / 2, hh = h / 2;
  for (let y = Math.floor(cy - hh - 2); y <= Math.ceil(cy + hh + 2); y++) {
    for (let x = Math.floor(cx - hw - 2); x <= Math.ceil(cx + hw + 2); x++) {
      const d = sdRoundRect(x + 0.5, y + 0.5, cx, cy, hw, hh, rad);
      const cov = Math.min(1, Math.max(0, 0.5 - d));
      if (cov <= 0) continue;
      const [r, g, b, a] = colorFn(x, y);
      put(x, y, r, g, b, a * cov);
    }
  }
}

// --- polygon fill (even-odd, AA via supersampling) ---
function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function fillPoly(ptsLogical, colorFn) {
  const pts = ptsLogical.map(([x, y]) => [x * u, y * u]);
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
    for (let x = Math.floor(minX); x <= Math.ceil(maxX); x++) {
      if (!pointInPoly(x + 0.5, y + 0.5, pts)) continue;
      const [r, g, b, a] = colorFn(x / u, y / u);
      put(x, y, r, g, b, a);
    }
  }
}

// ---------------------------- artwork ----------------------------
// tile background: deep slate with a soft vertical gradient
fillRoundRect(S / 2, S / 2, 512 * u, 512 * u, 112 * u, (x, y) => {
  const t = y / S; return [0x10 + t * 5, 0x15 + t * 7, 0x20 + t * 11, 1];
});
// subtle blue glow behind the mark
fillRoundRect(S / 2, S / 2, 512 * u, 512 * u, 112 * u, (x, y) => {
  const d = Math.hypot(x - S * 0.5, y - S * 0.42) / S;
  return [38, 132, 255, Math.max(0, 0.14 - d * 0.24)];
});

// Jira-style diamond mark. Outer diamond corners + centre.
const T = [256, 84], R = [428, 256], B = [256, 428], L = [84, 256], C = [256, 256];
// centre notch (small diamond) that the two chevrons meet at
const t2 = [256, 200], r2 = [312, 256], b2 = [256, 312], l2 = [200, 256];

// Atlassian-blue gradient helper (top #2684FF → bottom #0747A6)
function grad(x, y) {
  const t = Math.min(1, Math.max(0, (y - 84) / (428 - 84)));
  return [38 + (7 - 38) * t, 132 + (71 - 132) * t, 255 + (166 - 255) * t, 1];
}
const LIGHT = () => [76, 154, 255, 1]; // #4C9AFF folds

// front (dark, gradient) chevron: top-right & lower-left faces, minus centre notch
fillPoly([T, R, C], grad);
fillPoly([B, L, C], grad);
// back (light) chevron folds: upper-left & lower-right faces
fillPoly([L, T, C], LIGHT);
fillPoly([R, B, C], LIGHT);
// centre notch, one shade darker, to read as the interlock seam
fillPoly([t2, r2, b2, l2], () => [7, 71, 166, 1]);

// ---------------------------- downsample + encode ----------------------------
function encodePNG(size) {
  const scale = S / size;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const x0 = Math.floor(x * scale), x1 = Math.floor((x + 1) * scale);
      const y0 = Math.floor(y * scale), y1 = Math.floor((y + 1) * scale);
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        const i = (sy * S + sx) * 4;
        r += px[i] * px[i + 3]; g += px[i + 1] * px[i + 3]; b += px[i + 2] * px[i + 3]; a += px[i + 3]; n++;
      }
      const o = (y * size + x) * 4;
      out[o] = a ? Math.round(r / a) : 0;
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function pngBuffer(size) {
  const rgba = encodePNG(size);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'build', 'icons'), { recursive: true });
const png512 = pngBuffer(512);
fs.writeFileSync(path.join(root, 'build', 'icon.png'), png512);
fs.writeFileSync(path.join(root, 'build', 'icons', '512x512.png'), png512);
fs.writeFileSync(path.join(root, 'build', 'icons', '256x256.png'), pngBuffer(256));
fs.writeFileSync(path.join(root, 'build', 'icons', '128x128.png'), pngBuffer(128));
console.log('wrote build/icon.png and build/icons/{512,256,128}.png');
