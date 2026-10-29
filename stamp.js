// stamp.js - turns a black-and-white design into a 3D-printable leather stamp.
//
// No page code in here: everything works on plain arrays and numbers.
// Pixels are a grid of `w` x `h`; mask[i] = 1 where the design is (the part
// that presses into the leather), 0 elsewhere.
//
// How the stamp is built:
//   * a signed distance field says how far each pixel is from the design's
//     edge (negative inside, positive outside);
//   * the stamp is a stack of slabs, one per printer layer, from the backing
//     plate up to the face. The top slab is the design itself; each slab
//     further down is the design grown outward by the taper, so thin lines
//     get a wide, strong foot;
//   * each slab's outline is traced from the distance field (marching
//     squares), simplified, triangulated and extruded. The slabs overlap
//     and slicers merge them into one solid.

// ---- image to mask -------------------------------------------------------

// RGBA pixels -> brightness 0..255, transparent areas count as white paper.
export function toGray(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3] / 255;
    const lum = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    g[i] = lum * a + 255 * (1 - a);
  }
  return g;
}

// Three passes of a box blur ~ a gaussian blur. radius in pixels.
export function blur(src, w, h, radius) {
  const r = Math.round(radius);
  if (r < 1) return src;
  let a = Float32Array.from(src), b = new Float32Array(w * h);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {          // horizontal
      let sum = 0;
      const row = y * w;
      for (let x = -r; x <= r; x++) sum += a[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[row + x] = sum / (2 * r + 1);
        sum += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {          // vertical
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = sum / (2 * r + 1);
        sum += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
  }
  return a;
}

// Dark pixels (below `level`) are the design, unless `invert`.
export function threshold(gray, level, invert) {
  const m = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) m[i] = (gray[i] < level) !== !!invert ? 1 : 0;
  return m;
}

// Smallest box around the design, or null if there is none.
export function designBox(mask, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

// Copy `mask` into a bigger grid with `pad` empty pixels on every side,
// mirrored left-right if asked.
export function padMask(mask, w, h, pad, mirror) {
  const W = w + 2 * pad, H = h + 2 * pad;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      out[(y + pad) * W + pad + (mirror ? w - 1 - x : x)] = mask[y * w + x];
  return { mask: out, w: W, h: H };
}

// ---- distances -------------------------------------------------------------

const INF = 1e20;

// Felzenszwalb & Huttenlocher's exact 1-D squared distance transform.
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s;
    while (true) {
      const p = v[k];
      s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
      if (s > z[k]) break;
      k--;
    }
    k++;
    v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
  }
}

// Distance (in pixels) from every pixel to the nearest pixel whose mask
// value is `target` (0 on those pixels themselves).
export function distanceTo(mask, w, h, target) {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n);
  const v = new Int32Array(n), z = new Float64Array(n + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = mask[i] === target ? 0 : INF;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
  }
  return out;
}

// Pixels on the "middle line" of a shape: where `dist` is at least as big
// as all 8 neighbours. For a gap between two lines this is the bottom of
// the gap; for a line it is its centre. `want(i)` picks which pixels count.
function ridgePoints(dist, w, h, want) {
  const pts = [];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, d = dist[i];
      if (d < 1 || !want(i)) continue;
      if (d >= dist[i - 1] && d >= dist[i + 1] && d >= dist[i - w] && d >= dist[i + w] &&
          d >= dist[i - w - 1] && d >= dist[i - w + 1] && d >= dist[i + w - 1] && d >= dist[i + w + 1])
        pts.push(i);
    }
  return pts;
}

// Mark every pixel within radius(point) of the given points.
function paintDisks(pts, radius, w, h) {
  const out = new Uint8Array(w * h);
  for (const i of pts) {
    const cx = i % w, cy = (i - cx) / w, r = radius(i), r2 = r * r, ri = Math.ceil(r);
    for (let y = Math.max(0, cy - ri); y <= Math.min(h - 1, cy + ri); y++)
      for (let x = Math.max(0, cx - ri); x <= Math.min(w - 1, cx + ri); x++)
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r2) out[y * w + x] = 1;
  }
  return out;
}

// ---- outlines --------------------------------------------------------------

// Marching squares: closed outlines where field `g` crosses zero
// (g < 0 = solid). Points are in pixel units (x = column, y = row).
// The grid's border must be outside (g > 0) so every outline closes.
export function contours(g, w, h) {
  const pos = new Map();   // edge key -> [x, y]
  const adj = new Map();   // edge key -> [neighbour, neighbour]
  const point = (key) => {
    if (pos.has(key)) return;
    const cell = key >> 1, x = cell % w, y = (cell - x) / w;
    const a = g[cell], b = key & 1 ? g[cell + w] : g[cell + 1];
    const t = a / (a - b);
    pos.set(key, key & 1 ? [x, y + t] : [x + t, y]);
  };
  const link = (k1, k2) => {
    point(k1); point(k2);
    let a = adj.get(k1); if (!a) adj.set(k1, a = []); a.push(k2);
    let b = adj.get(k2); if (!b) adj.set(k2, b = []); b.push(k1);
  };
  for (let y = 0; y < h - 1; y++)
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      const a = g[i] < 0, b = g[i + 1] < 0, c = g[i + w + 1] < 0, d = g[i + w] < 0;
      const code = (a ? 8 : 0) | (b ? 4 : 0) | (c ? 2 : 0) | (d ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const T = i * 2, L = i * 2 + 1, B = (i + w) * 2, R = (i + 1) * 2 + 1;
      switch (code) {
        case 1: case 14: link(L, B); break;
        case 2: case 13: link(B, R); break;
        case 3: case 12: link(L, R); break;
        case 4: case 11: link(T, R); break;
        case 6: case 9: link(T, B); break;
        case 7: case 8: link(L, T); break;
        case 5: case 10: {
          // Two opposite corners solid: the centre decides how they join.
          const centre = (g[i] + g[i + 1] + g[i + w + 1] + g[i + w]) < 0;
          if ((code === 5) === centre) { link(L, T); link(B, R); }
          else { link(T, R); link(L, B); }
        }
      }
    }
  const rings = [], seen = new Set();
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const ring = [];
    let prev = -1, cur = start;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      ring.push(pos.get(cur));
      const [n1, n2] = adj.get(cur);
      const next = n1 !== prev ? n1 : n2;
      prev = cur;
      cur = next;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

// Douglas-Peucker for a closed ring: drop points that stray less than
// `tol` from a straight line.
export function simplifyRing(ring, tol) {
  const n = ring.length;
  if (n < 4) return ring;
  // Split at the point farthest from the first one.
  let far = 0, best = -1;
  for (let i = 1; i < n; i++) {
    const dx = ring[i][0] - ring[0][0], dy = ring[i][1] - ring[0][1], d = dx * dx + dy * dy;
    if (d > best) { best = d; far = i; }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const stack = [[0, far], [far, n]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e - s < 2) continue;
    const p = ring[s], q = ring[e % n];
    const dx = q[0] - p[0], dy = q[1] - p[1], len2 = dx * dx + dy * dy;
    let idx = -1, max = tol2;
    for (let i = s + 1; i < e; i++) {
      const r = ring[i];
      let d;
      if (len2 === 0) d = (r[0] - p[0]) ** 2 + (r[1] - p[1]) ** 2;
      else {
        const cross = (r[0] - p[0]) * dy - (r[1] - p[1]) * dx;
        d = cross * cross / len2;
      }
      if (d > max) { max = d; idx = i; }
    }
    if (idx >= 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[i]);
  return out;
}

function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2;   // > 0 = counter-clockwise (y up)
}

function inside(pt, r) {
  let c = false;
  const [x, y] = pt;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// Sort rings into outlines with their holes. Returns [{outer, holes}],
// outer counter-clockwise, holes clockwise.
export function groupRings(rings) {
  const info = rings.map((r) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of r) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { r, area: Math.abs(ringArea(r)), x0, y0, x1, y1, depth: 0, parent: -1 };
  });
  for (let i = 0; i < info.length; i++) {
    const a = info[i], pt = a.r[0];
    let parentArea = Infinity;
    for (let j = 0; j < info.length; j++) {
      const b = info[j];
      if (i === j || b.area <= a.area || pt[0] < b.x0 || pt[0] > b.x1 || pt[1] < b.y0 || pt[1] > b.y1) continue;
      if (inside(pt, b.r)) {
        a.depth++;
        if (b.area < parentArea) { parentArea = b.area; a.parent = j; }
      }
    }
  }
  const turn = (r) => { r.reverse(); if (r.raw) r.raw.reverse(); };
  const polys = new Map();
  info.forEach((a, i) => {
    if (a.depth % 2 === 0) {
      if (ringArea(a.r) < 0) turn(a.r);
      polys.set(i, { outer: a.r, holes: [] });
    }
  });
  info.forEach((a) => {
    if (a.depth % 2 === 1 && polys.has(a.parent)) {
      if (ringArea(a.r) > 0) turn(a.r);
      polys.get(a.parent).holes.push(a.r);
    }
  });
  return [...polys.values()];
}

// ---- the stamp ---------------------------------------------------------------

// opts (all lengths in mm):
//   px        size of one pixel
//   relief    height of the design above the backing (e.g. 3)
//   backing   thickness of the backing plate
//   margin    backing plate border around the design (and its taper)
//   taper     angle in degrees (0 = straight walls)
//   tip       straight part just under the face before the taper starts
//   layer     printer layer height (taper steps)
//   minGap    shallowest gap between features before we warn
//   capTaper  keep gaps at least minGap deep by taking taper away there
//   minLine   thinnest line the printer can make
//   tol       outline smoothing tolerance
//   triangulate(outer, holes) -> [[i, j, k], ...] indices into outer+holes
//
// The mask must already be padded (padMask) by at least taperReach(opts)
// pixels + 3.
export function taperReach(o) {
  return Math.max(0, o.relief - o.tip) * Math.tan(o.taper * Math.PI / 180);
}

export function analyse(mask, w, h, o) {
  const dOut = distanceTo(mask, w, h, 1);   // outside: distance to design
  const dIn = distanceTo(mask, w, h, 0);    // inside: distance to paper
  const sd = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) sd[i] = mask[i] ? 0.5 - dIn[i] : dOut[i] - 0.5;

  const tanT = Math.tan(o.taper * Math.PI / 180);
  const minGap = Math.min(o.minGap, o.relief);

  // Gaps: how deep the bottom of each gap ends up once the taper has
  // grown in from both sides.
  let shallow = [];
  if (tanT > 0) {
    shallow = ridgePoints(dOut, w, h, (i) => !mask[i]).filter((i) => {
      const half = (dOut[i] - 0.5) * o.px;              // half the gap width
      return Math.min(o.relief, o.tip + half / tanT) < minGap;
    });
  }
  const narrow = paintDisks(shallow, (i) => dOut[i] + 1, w, h);
  for (let i = 0; i < w * h; i++) if (mask[i]) narrow[i] = 0;

  // Lines too thin for the printer's nozzle.
  const thinPts = ridgePoints(dIn, w, h, (i) => mask[i] === 1)
    .filter((i) => 2 * (dIn[i] - 0.5) * o.px < o.minLine);
  const thin = paintDisks(thinPts, (i) => dIn[i] + 0.5, w, h);
  for (let i = 0; i < w * h; i++) if (!mask[i]) thin[i] = 0;

  return { sd, narrow, thin, shallowCount: shallow.length, thinCount: thinPts.length };
}

// The slabs, top (the face) first: [{top, rings}] with rings in mm,
// y pointing up, not yet shifted onto the backing.
export function slabs(an, w, h, o) {
  const tanT = Math.tan(o.taper * Math.PI / 180);
  const minGap = Math.min(o.minGap, o.relief);
  const steps = tanT > 0 ? Math.max(1, Math.ceil(o.relief / o.layer - 1e-9)) : 1;
  const out = [];
  let lastKey = null;
  const g = new Float32Array(w * h);
  for (let k = 0; k < steps; k++) {
    const depth = k * o.layer;                          // below the face
    const r = Math.max(0, depth - o.tip) * tanT / o.px; // grow, in pixels
    const capped = o.capTaper && depth < minGap && r > 0;
    const key = r + (capped ? 'c' : '');
    if (key === lastKey) continue;   // same outline as the slab above
    lastKey = key;
    for (let i = 0; i < w * h; i++) g[i] = an.sd[i] - (capped && an.narrow[i] ? 0 : r) + 1e-6;
    const rings = [];
    for (const ring of contours(g, w, h)) {
      // No repeated points: the triangulator would quietly drop them.
      const s = simplifyRing(ring, o.tol / o.px).filter((p, i, a) => {
        const q = a[(i + 1) % a.length];
        return Math.abs(p[0] - q[0]) > 1e-6 || Math.abs(p[1] - q[1]) > 1e-6;
      });
      if (s.length < 3) continue;
      const toMM = (r) => r.map(([x, y]) => [x * o.px, (h - 1 - y) * o.px]);
      const mm = toMM(s);
      if (Math.abs(ringArea(mm)) < o.px * o.px * 0.5) continue;   // a speck
      // Keep the unsimplified outline too: where two outlines nearly touch,
      // simplifying can make them cross, and buildMesh falls back to this.
      mm.raw = toMM(ring);
      rings.push(mm);
    }
    out.push({ top: o.relief - depth, rings });
  }
  return out;
}

// Triangles as a flat Float32Array (x, y, z per corner, 9 per triangle),
// outward-facing. Base of the backing at z = 0, face on top.
export function buildMesh(slabList, o) {
  // Backing: around the widest (lowest) slab plus the margin.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of slabList)
    for (const r of s.rings)
      for (const [x, y] of r) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
  if (!isFinite(x0)) return null;
  x0 -= o.margin; y0 -= o.margin; x1 += o.margin; y1 += o.margin;
  const dx = -x0, dy = -y0;

  const tris = [];
  const tri = (a, b, c) => tris.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);

  // A closed prism from z0 to z1 over the polygons.
  const prism = (polys, z0, z1) => {
    const xy = (r) => r.map(([x, y]) => ({ x, y }));
    for (let { outer, holes } of polys) {
      // A complete triangulation of an outline with holes has exactly
      // (points + 2 * holes - 2) triangles; fewer means it gave up somewhere.
      const count = (ou, hs) => ou.length + hs.reduce((n, r) => n + r.length, 0) + 2 * hs.length - 2;
      let faces = o.triangulate(xy(outer), holes.map(xy));
      if (faces.length !== count(outer, holes) && outer.raw) {
        outer = outer.raw;
        holes = holes.map((r) => r.raw || r);
        faces = o.triangulate(xy(outer), holes.map(xy));
      }
      const pts = outer.concat(...holes);
      for (const [ia, ib, ic] of faces) {
        let a = pts[ia], b = pts[ib], c = pts[ic];
        if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0) [b, c] = [c, b];
        tri([a[0] + dx, a[1] + dy, z1], [b[0] + dx, b[1] + dy, z1], [c[0] + dx, c[1] + dy, z1]);
        tri([a[0] + dx, a[1] + dy, z0], [c[0] + dx, c[1] + dy, z0], [b[0] + dx, b[1] + dy, z0]);
      }
      for (const ring of [outer, ...holes])
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i], q = ring[(i + 1) % ring.length];
          const p0 = [p[0] + dx, p[1] + dy, z0], q0 = [q[0] + dx, q[1] + dy, z0];
          const p1 = [p[0] + dx, p[1] + dy, z1], q1 = [q[0] + dx, q[1] + dy, z1];
          tri(p0, q0, q1);
          tri(p0, q1, p1);
        }
    }
  };

  prism([{ outer: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], holes: [] }], 0, o.backing);
  // Each slab reaches a little way down into the one below it, so the
  // slicer sees one solid without any paper-thin seams.
  const overlap = Math.min(o.layer, 0.1);
  for (const s of slabList) prism(groupRings(s.rings), o.backing - overlap, o.backing + s.top);
  return { tris: new Float32Array(tris), size: [x1 - x0, y1 - y0, o.backing + o.relief], box: [x0, y0, x1, y1] };
}

// Binary STL file.
export function toSTL(tris, name) {
  const n = tris.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const view = new DataView(buf);
  const head = ('Stamp Maker: ' + name).slice(0, 80);
  for (let i = 0; i < head.length; i++) view.setUint8(i, head.charCodeAt(i) & 0x7f);
  view.setUint32(80, n, true);
  let off = 84;
  for (let t = 0; t < n; t++) {
    const p = tris.subarray(t * 9, t * 9 + 9);
    const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2];
    const vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    view.setFloat32(off, nx / len, true); view.setFloat32(off + 4, ny / len, true); view.setFloat32(off + 8, nz / len, true);
    for (let k = 0; k < 9; k++) view.setFloat32(off + 12 + k * 4, p[k], true);
    off += 50;
  }
  return buf;
}

// Self-check: every edge of every triangle must be matched by the same edge
// running the other way (closed, consistently facing shells), and the volume
// must come out positive. Returns {open, volume}.
export function checkMesh(tris) {
  const key = (i) => tris[i].toFixed(4) + ',' + tris[i + 1].toFixed(4) + ',' + tris[i + 2].toFixed(4);
  const edges = new Map();
  let volume = 0;
  for (let t = 0; t < tris.length; t += 9) {
    const k = [key(t), key(t + 3), key(t + 6)];
    for (let e = 0; e < 3; e++) {
      const fwd = k[e] + '|' + k[(e + 1) % 3], back = k[(e + 1) % 3] + '|' + k[e];
      if (edges.get(back) > 0) edges.set(back, edges.get(back) - 1);
      else edges.set(fwd, (edges.get(fwd) || 0) + 1);
    }
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = tris.subarray(t, t + 9);
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  let open = 0;
  for (const v of edges.values()) open += v;
  return { open, volume };
}
