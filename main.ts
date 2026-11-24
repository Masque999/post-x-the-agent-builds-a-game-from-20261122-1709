// Ghost Catcher — a tiny browser game built from one prompt.
// main.ts (Node 22, standard library only) builds the game, renders
// deterministic demo frames, and writes everything to the output dir.
//
// The prompt it was built from:
//   "Build a tiny browser game where a cute ghost catches falling stars —
//    move with arrow keys or mouse, 3 lives, score points, it gets faster,
//    game over screen with a restart button."
//
// Run it:  node main.ts            (writes to $MAKEFUN_OUTPUT_DIR or /output)
// Play it: open the game.html it writes in any browser.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const SEED = 1337;
const DEMO_STEPS = 600; // 10 seconds at 60 steps a second
const FRAME_EVERY = 6; // one rendered frame every 6 steps (10 fps)
const W = 960;
const H = 540;

// ---------------------------------------------------------------------------
// The game itself, as one JavaScript source string. It is environment
// agnostic: in the browser it boots a canvas game; in Node it is evaluated
// and driven by the demo below. One source of truth, no copies.
// ---------------------------------------------------------------------------
const GAME_SRC = `
// Ghost Catcher: a cute ghost catches falling stars.
var GW = 960, GH = 540;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createGame(seed) {
  var rng = mulberry32(seed);
  var bg = [];
  for (var i = 0; i < 26; i++) {
    bg.push({ x: rng() * GW, y: rng() * GH, r: 0.8 + rng() * 1.6, tw: rng() * 6.283 });
  }
  return {
    seed: seed, time: 0, score: 0, lives: 3, combo: 0, bestCombo: 0,
    ghost: { x: GW / 2, y: GH - 64, vx: 0 },
    falling: [], particles: [],
    spawnT: 0, spawnEvery: 0.85, speed: 1,
    caught: 0, missed: 0, over: false, overT: 0,
    bgStars: bg, rng: rng, flash: 0
  };
}

// input: { left, right, mouseX } — mouseX null means no mouse control.
function stepGame(s, input, dt) {
  if (s.over) { s.overT += dt; return; }
  s.time += dt;
  var g = s.ghost;
  var target = null;
  if (input.mouseX !== null && input.mouseX !== undefined) target = input.mouseX;
  else if (input.left) target = g.x - 420 * dt;
  else if (input.right) target = g.x + 420 * dt;
  if (target !== null) {
    var dx = target - g.x;
    var maxStep = 560 * dt;
    if (dx > maxStep) dx = maxStep;
    if (dx < -maxStep) dx = -maxStep;
    g.x += dx;
  }
  if (g.x < 46) g.x = 46;
  if (g.x > GW - 46) g.x = GW - 46;
  // spawn falling stars
  s.spawnT += dt;
  while (s.spawnT >= s.spawnEvery) {
    s.spawnT -= s.spawnEvery;
    var kind = s.rng() < 0.16 ? 'big' : 'star';
    s.falling.push({
      x: 30 + s.rng() * (GW - 60), y: -24,
      vy: (95 + s.rng() * 55) * s.speed,
      vx: (s.rng() - 0.5) * 36,
      r: kind === 'big' ? 17 : 11 + s.rng() * 5,
      rot: s.rng() * 6.283, vr: (s.rng() - 0.5) * 2.2,
      kind: kind
    });
  }
  // move falling stars, catch or miss
  for (var i = s.falling.length - 1; i >= 0; i--) {
    var f = s.falling[i];
    f.y += f.vy * dt; f.x += f.vx * dt; f.rot += f.vr * dt;
    if (f.x < 14) { f.x = 14; f.vx = Math.abs(f.vx); }
    if (f.x > GW - 14) { f.x = GW - 14; f.vx = -Math.abs(f.vx); }
    var nearX = Math.abs(f.x - g.x) < 58;
    var nearY = f.y > g.y - 52 && f.y < g.y + 26;
    if (nearX && nearY) {
      s.falling.splice(i, 1);
      s.caught++;
      s.combo++;
      if (s.combo > s.bestCombo) s.bestCombo = s.combo;
      var pts = (f.kind === 'big' ? 25 : 10) + (s.combo - 1) * 2;
      s.score += pts;
      s.flash = 1;
      for (var p = 0; p < 10; p++) {
        s.particles.push({
          x: f.x, y: f.y,
          vx: (s.rng() - 0.5) * 260, vy: -40 - s.rng() * 160,
          life: 0.55 + s.rng() * 0.3, max: 0.85, r: 2 + s.rng() * 3
        });
      }
      if (s.caught % 8 === 0) {
        s.speed += 0.12;
        if (s.spawnEvery > 0.42) s.spawnEvery -= 0.06;
      }
    } else if (f.y > GH + 30) {
      s.falling.splice(i, 1);
      s.missed++;
      s.combo = 0;
      s.lives--;
      if (s.lives <= 0) { s.over = true; s.overT = 0; }
    }
  }
  // particles
  for (var j = s.particles.length - 1; j >= 0; j--) {
    var pt = s.particles[j];
    pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.vy += 300 * dt; pt.life -= dt;
    if (pt.life <= 0) s.particles.splice(j, 1);
  }
  if (s.flash > 0) s.flash -= dt * 3;
}

// Autoplay: steer the ghost at the lowest falling star.
function autoplayInput(s) {
  var best = null;
  for (var i = 0; i < s.falling.length; i++) {
    var f = s.falling[i];
    if (!best || f.y > best.y) best = f;
  }
  return { left: false, right: false, mouseX: best ? best.x : GW / 2 };
}
`;

// Drawing + browser bootstrap, same source string as the simulation above.
// drawGame only uses the small graphics interface g:
//   clear(color) rect(x,y,w,h,color,alpha) circle(x,y,r,color,alpha)
//   star(x,y,r,rot,color,alpha) heart(x,y,s,color,alpha)
//   text(str,x,y,size,color,align,alpha)
const GAME_DRAW_SRC = `
// -- drawing ---------------------------------------------------------------
function drawGame(g, s) {
  // background: vertical bands, deep navy to purple
  var bands = 24;
  for (var b = 0; b < bands; b++) {
    var t = b / (bands - 1);
    var r = Math.round(13 + (36 - 13) * t);
    var gg = Math.round(16 + (17 - 16) * t);
    var bb = Math.round(48 + (69 - 48) * t);
    g.rect(0, Math.floor(b * GH / bands), GW, Math.ceil(GH / bands) + 1,
      'rgb(' + r + ',' + gg + ',' + bb + ')');
  }
  // twinkling background stars
  for (var i = 0; i < s.bgStars.length; i++) {
    var st = s.bgStars[i];
    var a = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(s.time * 2 + st.tw));
    g.circle(st.x, st.y, st.r, '#ffffff', a);
  }
  // falling stars: glow + star shape
  for (var j = 0; j < s.falling.length; j++) {
    var f = s.falling[j];
    var col = f.kind === 'big' ? '#ff9de2' : '#ffd75e';
    g.circle(f.x, f.y, f.r * 2.1, col, 0.16);
    g.circle(f.x, f.y, f.r * 1.35, col, 0.35);
    g.star(f.x, f.y, f.r, f.rot, col, 1);
  }
  // particles
  for (var k = 0; k < s.particles.length; k++) {
    var p = s.particles[k];
    g.circle(p.x, p.y, p.r, '#ffe9a8', Math.max(0, p.life / p.max));
  }
  // ghost: white body from primitives, face, blush
  var gx = s.ghost.x, gy = s.ghost.y;
  g.circle(gx, gy - 14, 26, '#ffffff');
  g.rect(gx - 26, gy - 14, 52, 30, '#ffffff');
  g.circle(gx - 17, gy + 16, 9, '#ffffff');
  g.circle(gx, gy + 16, 9, '#ffffff');
  g.circle(gx + 17, gy + 16, 9, '#ffffff');
  g.circle(gx - 10, gy - 18, 4, '#191419');
  g.circle(gx + 10, gy - 18, 4, '#191419');
  g.circle(gx, gy - 6, 3, '#191419');
  g.circle(gx - 17, gy - 8, 4, '#ff9de2', 0.7);
  g.circle(gx + 17, gy - 8, 4, '#ff9de2', 0.7);
  // HUD: score left, lives right, combo under score
  g.text('SCORE ' + s.score, 20, 44, 30, '#ffffff', 'left');
  for (var l = 0; l < 3; l++) {
    var hx = GW - 30 - l * 40;
    if (l < s.lives) g.heart(hx, 32, 13, '#c41c83', 1);
    else g.heart(hx, 32, 13, '#5a5470', 1);
  }
  if (s.combo >= 2) {
    g.text('COMBO x' + s.combo, 20, 78, 22, '#ffd75e', 'left');
  }
  g.text('SPEED x' + s.speed.toFixed(1), 20, GH - 18, 18, '#8f88ad', 'left');
  if (s.flash > 0) g.rect(0, 0, GW, GH, '#ffffff', s.flash * 0.12);
  if (s.over) {
    g.rect(0, 0, GW, GH, '#0d1030', 0.72);
    g.text('GAME OVER', GW / 2, GH / 2 - 30, 54, '#ffffff', 'center');
    g.text('SCORE ' + s.score + '   BEST COMBO x' + s.bestCombo, GW / 2, GH / 2 + 24, 26, '#ffd75e', 'center');
    g.text('PRESS R OR CLICK TO RESTART', GW / 2, GH / 2 + 66, 20, '#c9c4de', 'center');
  }
}

// -- browser bootstrap (only runs in a browser) -----------------------------
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  (function () {
    var params = new URLSearchParams(window.location.search);
    var demo = params.get('demo') === '1';
    var seed = parseInt(params.get('seed') || '1337', 10);
    var canvas = document.getElementById('game');
    var ctx = canvas.getContext('2d');
    canvas.width = GW; canvas.height = GH;
    var state = createGame(seed);
    var keys = { left: false, right: false };
    var mouseX = null;
    window.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') keys.left = true;
      if (e.key === 'ArrowRight') keys.right = true;
      if ((e.key === 'r' || e.key === 'R') && state.over) state = createGame(seed);
    });
    window.addEventListener('keyup', function (e) {
      if (e.key === 'ArrowLeft') keys.left = false;
      if (e.key === 'ArrowRight') keys.right = false;
    });
    canvas.addEventListener('mousemove', function (e) {
      var rect = canvas.getBoundingClientRect();
      mouseX = (e.clientX - rect.left) * (GW / rect.width);
    });
    canvas.addEventListener('click', function () {
      if (state.over) state = createGame(seed);
    });
    var g = makeCanvasG(ctx);
    function frame() {
      var input = demo ? autoplayInput(state) : { left: keys.left, right: keys.right, mouseX: mouseX };
      stepGame(state, input, 1 / 60);
      drawGame(g, state);
      requestAnimationFrame(frame);
    }
    function makeCanvasG(ctx) {
      return {
        rect: function (x, y, w, h, color, alpha) {
          ctx.globalAlpha = alpha === undefined ? 1 : alpha;
          ctx.fillStyle = color; ctx.fillRect(x, y, w, h); ctx.globalAlpha = 1;
        },
        circle: function (x, y, r, color, alpha) {
          ctx.globalAlpha = alpha === undefined ? 1 : alpha;
          ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill(); ctx.globalAlpha = 1;
        },
        star: function (x, y, r, rot, color, alpha) {
          ctx.globalAlpha = alpha === undefined ? 1 : alpha;
          ctx.fillStyle = color; ctx.beginPath();
          for (var i = 0; i < 10; i++) {
            var rr = i % 2 === 0 ? r : r * 0.45;
            var a = rot + i * Math.PI / 5 - Math.PI / 2;
            var px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
        },
        heart: function (x, y, s, color, alpha) {
          ctx.globalAlpha = alpha === undefined ? 1 : alpha;
          ctx.fillStyle = color; ctx.beginPath();
          ctx.arc(x - s * 0.35, y - s * 0.25, s * 0.38, 0, 6.2832);
          ctx.arc(x + s * 0.35, y - s * 0.25, s * 0.38, 0, 6.2832);
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(x - s * 0.68, y - s * 0.05);
          ctx.lineTo(x + s * 0.68, y - s * 0.05);
          ctx.lineTo(x, y + s * 0.75);
          ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
        },
        text: function (str, x, y, size, color, align, alpha) {
          ctx.globalAlpha = alpha === undefined ? 1 : alpha;
          ctx.fillStyle = color;
          ctx.font = 'bold ' + size + 'px sans-serif';
          ctx.textAlign = align || 'left'; ctx.textBaseline = 'middle';
          ctx.fillText(str, x, y); ctx.globalAlpha = 1;
        }
      };
    }
    // hooks for the video capture: deterministic stepping, no rAF timing.
    window.__game = state;
    window.__advance = function (n) {
      for (var i = 0; i < n; i++) stepGame(state, autoplayInput(state), 1 / 60);
      drawGame(g, state);
      return { score: state.score, lives: state.lives, caught: state.caught, over: state.over };
    };
    window.__render = function () { drawGame(g, state); };
    window.__reset = function (sd) { state = createGame(sd || seed); window.__game = state; };
    if (!demo) requestAnimationFrame(frame);
    else drawGame(g, state);
  })();
}
`;

// ---------------------------------------------------------------------------
// Node side: software rasterizer, PNG encoder, and the build itself.
// ---------------------------------------------------------------------------
const GAME_JS = GAME_SRC + GAME_DRAW_SRC;

// 5x7 bitmap font, one 35-char row-major string per glyph (7 rows x 5 cols).
const FONT: Record<string, string> = {
  A: '01110100011000111111100011000110001',
  B: '11110100011000111110100011000111110',
  C: '01110100011000010000100001000101110',
  D: '11110100011000110001100011000111110',
  E: '11111100001000011110100001000011111',
  F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111',
  H: '10001100011000111111100011000110001',
  I: '01110001000010000100001000010001110',
  J: '00111000100001000010000101001001100',
  K: '10001100101010011000101001001010001',
  L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001',
  N: '10001110011010110011100011000110001',
  O: '01110100011000110001100011000101110',
  P: '11110100011000111110100001000010000',
  Q: '01110100011000110001101011001001101',
  R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110',
  T: '11111001000010000100001000010000100',
  U: '10001100011000110001100011000101110',
  V: '10001100011000110001100010101000100',
  W: '10001100011000110101101011101110001',
  X: '10001100010101000100010101000110001',
  Y: '10001100010101000100001000010000100',
  Z: '11111000010001000100010001000011111',
  '0': '01110100011001110101110011000101110',
  '1': '00100011000010000100001000010001110',
  '2': '01110100010000100010001000100011111',
  '3': '11111000100010000010000011000101110',
  '4': '00010001100101010010111110001000010',
  '5': '11111100001111000001000011000101110',
  '6': '00110010001000011110100011000101110',
  '7': '11111000010001000100010000100001000',
  '8': '01110100011000101110100011000101110',
  '9': '01110100011000101111000010001001100',
  ' ': '00000000000000000000000000000000000',
  '!': '00100001000010000100001000000000100',
  '.': '00000000000000000000000000110001100',
  ':': '00000011000110000000011000110000000',
  '-': '00000000000000001110000000000000000',
};

function parseColor(color: string): [number, number, number] {
  if (color.startsWith('#')) {
    const n = parseInt(color.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = color.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
  return [255, 255, 255];
}

class SoftCanvas {
  w: number; h: number; buf: Uint8Array;
  constructor(w: number, h: number) {
    this.w = w; this.h = h;
    this.buf = new Uint8Array(w * h * 3);
  }
  px(x: number, y: number, r: number, g: number, b: number, a: number) {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return;
    const o = (yi * this.w + xi) * 3;
    if (a >= 1) { this.buf[o] = r; this.buf[o + 1] = g; this.buf[o + 2] = b; return; }
    this.buf[o] = Math.round(r * a + this.buf[o] * (1 - a));
    this.buf[o + 1] = Math.round(g * a + this.buf[o + 1] * (1 - a));
    this.buf[o + 2] = Math.round(b * a + this.buf[o + 2] * (1 - a));
  }
  rect(x: number, y: number, w: number, h: number, color: string, alpha = 1) {
    const [r, g, b] = parseColor(color);
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.w, Math.ceil(x + w)), y1 = Math.min(this.h, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy++)
      for (let xx = x0; xx < x1; xx++) this.px(xx, yy, r, g, b, alpha);
  }
  circle(x: number, y: number, r: number, color: string, alpha = 1) {
    const [cr, cg, cb] = parseColor(color);
    const x0 = Math.max(0, Math.floor(x - r)), y0 = Math.max(0, Math.floor(y - r));
    const x1 = Math.min(this.w, Math.ceil(x + r)), y1 = Math.min(this.h, Math.ceil(y + r));
    for (let yy = y0; yy < y1; yy++)
      for (let xx = x0; xx < x1; xx++) {
        const dx = xx + 0.5 - x, dy = yy + 0.5 - y;
        if (dx * dx + dy * dy <= r * r) this.px(xx, yy, cr, cg, cb, alpha);
      }
  }
  poly(points: Array<[number, number]>, color: string, alpha = 1) {
    const [r, g, b] = parseColor(color);
    let minY = Infinity, maxY = -Infinity;
    for (const [, y] of points) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    for (let yy = Math.max(0, Math.floor(minY)); yy <= Math.min(this.h - 1, Math.ceil(maxY)); yy++) {
      const xs: number[] = [];
      for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
        if ((y1 <= yy + 0.5 && y2 > yy + 0.5) || (y2 <= yy + 0.5 && y1 > yy + 0.5)) {
          xs.push(x1 + ((yy + 0.5 - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
      xs.sort((a, b2) => a - b2);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let xx = Math.max(0, Math.ceil(xs[k])); xx <= Math.min(this.w - 1, Math.floor(xs[k + 1])); xx++) {
          this.px(xx, yy, r, g, b, alpha);
        }
      }
    }
  }
  star(x: number, y: number, r: number, rot: number, color: string, alpha = 1) {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 === 0 ? r : r * 0.45;
      const a = rot + (i * Math.PI) / 5 - Math.PI / 2;
      pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]);
    }
    this.poly(pts, color, alpha);
  }
  heart(x: number, y: number, s: number, color: string, alpha = 1) {
    this.circle(x - s * 0.35, y - s * 0.25, s * 0.38, color, alpha);
    this.circle(x + s * 0.35, y - s * 0.25, s * 0.38, color, alpha);
    this.poly([[x - s * 0.68, y - s * 0.05], [x + s * 0.68, y - s * 0.05], [x, y + s * 0.75]], color, alpha);
  }
  text(str: string, x: number, y: number, size: number, color: string, align = 'left', alpha = 1) {
    const [r, g, b] = parseColor(color);
    const scale = Math.max(1, Math.round(size / 7));
    const up = str.toUpperCase();
    const totalW = up.length * 6 * scale - scale;
    let x0 = x;
    if (align === 'center') x0 = x - totalW / 2;
    if (align === 'right') x0 = x - totalW;
    const y0 = y - (7 * scale) / 2;
    for (let ci = 0; ci < up.length; ci++) {
      const glyph = FONT[up[ci]] ?? FONT[' '];
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row * 5 + col] === '1') {
            this.rect(x0 + (ci * 6 + col) * scale, y0 + row * scale, scale, scale,
              `rgb(${r},${g},${b})`, alpha);
          }
        }
      }
    }
  }
  toPNG(): Buffer {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 3 + 1)] = 0;
      raw.set(this.buf.subarray(y * this.w * 3, (y + 1) * this.w * 3), y * (this.w * 3 + 1) + 1);
    }
    const idat = zlib.deflateSync(raw, { level: 6 });
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
  }
}

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function gameHtml(): string {
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>Ghost Catcher — a tiny game built from one prompt</title>\n' +
    '<style>body{margin:0;background:#0d1030;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;color:#fff;font-family:sans-serif}canvas{max-width:96vw;max-height:82vh;border:2px solid #c41c83;border-radius:12px}p{color:#c9c4de;margin:10px 0 0}</style>\n' +
    '</head>\n<body>\n<canvas id="game"></canvas>\n' +
    '<p>Move with arrow keys or mouse — catch the falling stars. 3 lives. R restarts.</p>\n' +
    '<script>\n' + GAME_JS + '\n</script>\n</body>\n</html>\n';
}

function main() {
  const mod = new Function(GAME_JS + '\n;return { createGame, stepGame, drawGame, autoplayInput, GW, GH };')() as {
    createGame: (seed: number) => any;
    stepGame: (s: any, input: any, dt: number) => void;
    drawGame: (g: any, s: any) => void;
    autoplayInput: (s: any) => any;
    GW: number; GH: number;
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, 'frames'), { recursive: true });

  const files: Array<{ name: string; bytes: number; sha256: string }> = [];
  const write = (rel: string, data: string | Buffer) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const full = path.join(OUT_DIR, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buf);
    files.push({ name: rel, bytes: buf.length, sha256: sha256(buf) });
  };

  write('game.js', GAME_JS);
  write('game.html', gameHtml());

  const state = mod.createGame(SEED);
  let frameCount = 0;
  for (let step = 0; step < DEMO_STEPS; step++) {
    mod.stepGame(state, mod.autoplayInput(state), 1 / 60);
    if ((step + 1) % FRAME_EVERY === 0) {
      const cv = new SoftCanvas(mod.GW, mod.GH);
      const g = {
        rect: (x: number, y: number, w: number, h: number, c: string, a = 1) => cv.rect(x, y, w, h, c, a),
        circle: (x: number, y: number, r: number, c: string, a = 1) => cv.circle(x, y, r, c, a),
        star: (x: number, y: number, r: number, rot: number, c: string, a = 1) => cv.star(x, y, r, rot, c, a),
        heart: (x: number, y: number, s: number, c: string, a = 1) => cv.heart(x, y, s, c, a),
        text: (s2: string, x: number, y: number, sz: number, c: string, al = 'left', a = 1) => cv.text(s2, x, y, sz, c, al, a),
      };
      mod.drawGame(g, state);
      const png = Buffer.concat([PNG_SIG, cv.toPNG()]);
      write(`frames/frame-${String(frameCount).padStart(3, '0')}.png`, png);
      frameCount++;
    }
  }

  const manifest = {
    game: 'Ghost Catcher',
    prompt: 'Build a tiny browser game where a cute ghost catches falling stars — move with arrow keys or mouse, 3 lives, score points, it gets faster, game over screen with a restart button.',
    seed: SEED,
    steps: DEMO_STEPS,
    dt: 1 / 60,
    frames: frameCount,
    width: mod.GW,
    height: mod.GH,
    final: {
      score: state.score,
      lives: state.lives,
      caught: state.caught,
      missed: state.missed,
      bestCombo: state.bestCombo,
      over: state.over,
    },
    files,
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), manifestBuf);

  console.log('ghost-catcher build');
  console.log('seed ' + SEED);
  console.log('steps ' + DEMO_STEPS + ' (10.0s at 60/s)');
  console.log('frames ' + frameCount);
  console.log('final score ' + state.score + ' lives ' + state.lives +
    ' caught ' + state.caught + ' missed ' + state.missed +
    ' bestCombo ' + state.bestCombo + ' over ' + state.over);
  for (const f of files) console.log('file ' + f.name + ' ' + f.bytes + ' bytes sha256:' + f.sha256);
  console.log('manifest manifest.json ' + manifestBuf.length + ' bytes sha256:' + sha256(manifestBuf));
}

main();
