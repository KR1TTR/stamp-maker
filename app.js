// app.js - the page: reads the controls, runs stamp.js, draws the previews.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as S from './stamp.js';

const $ = (id) => document.getElementById(id);
const MAX_SOURCE = 3000;   // longest side of the picture we keep, in pixels
const MAX_GRID = 1400;     // longest side of the design while building, in pixels
const MIN_PX = 0.03;       // finest detail we bother with, mm per pixel

let source = null;         // {canvas, gray, w, h, name}
let box = null;            // design's box inside the source picture
let last = null;           // latest result, for the download button
let resetCamera = true;

// ---- loading a design ---------------------------------------------------

function loadImage(url, name, isSvg) {
  const img = new Image();
  img.onload = () => {
    let w = img.naturalWidth || 1000, h = img.naturalHeight || 1000;
    // SVGs have no fixed resolution: draw them big. Pictures: keep their pixels.
    const scale = isSvg ? 2400 / Math.max(w, h) : Math.min(1, MAX_SOURCE / Math.max(w, h));
    w = Math.round(w * scale); h = Math.round(h * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    useSource(c, name);
    URL.revokeObjectURL(url);
  };
  img.onerror = () => {
    $('fileName').textContent = "Couldn't read that file as a picture.";
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

function loadFile(file) {
  if (!file) return;
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  loadImage(URL.createObjectURL(file), file.name, isSvg);
}

function useSource(canvas, name) {
  const { width: w, height: h } = canvas;
  const rgba = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  source = { canvas, gray: S.toGray(rgba, w, h), w, h, name };
  $('fileName').textContent = name;
  box = null;
  resetCamera = true;
  findBox(true);
  update();
}

// The design's box at the current threshold. A new design keeps the width
// the user typed and works out the height.
function findBox(newDesign) {
  if (!source) return;
  const mask = S.threshold(source.gray, +$('threshold').value, $('invert').checked);
  const old = box;
  box = S.designBox(mask, source.w, source.h);
  if (box && (newDesign || !old || aspect(old) !== aspect(box))) syncSize('width');
}
const aspect = (b) => (b.x1 - b.x0 + 1) / (b.y1 - b.y0 + 1);

function syncSize(changed) {
  if (!box) return;
  const a = aspect(box);
  if (changed === 'width') $('height').value = round1(+$('width').value / a);
  else $('width').value = round1(+$('height').value * a);
}
const round1 = (x) => Math.round(x * 10) / 10;

// A made-up design that shows off what the tool does: bold shapes, a line
// too thin to print and two lines close together.
function sample() {
  const c = document.createElement('canvas');
  c.width = c.height = 1200;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 1200, 1200);
  g.strokeStyle = g.fillStyle = '#000';
  g.lineWidth = 46;
  g.beginPath(); g.arc(600, 600, 560, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 14;
  g.beginPath(); g.arc(600, 600, 490, 0, Math.PI * 2); g.stroke();
  g.beginPath();                                   // star
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 110 : 260, t = -Math.PI / 2 + i * Math.PI / 5;
    g.lineTo(600 + r * Math.cos(t), 470 + r * Math.sin(t));
  }
  g.closePath(); g.fill();
  g.font = 'bold 150px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText('HANDMADE', 600, 870);
  g.lineWidth = 4;                                 // too thin
  g.beginPath(); g.moveTo(330, 940); g.lineTo(870, 940); g.stroke();
  g.lineWidth = 16;                                // close together
  for (const y of [990, 1020]) { g.beginPath(); g.moveTo(400, y); g.lineTo(800, y); g.stroke(); }
  for (const x of [250, 950]) { g.beginPath(); g.arc(x, 600, 34, 0, Math.PI * 2); g.fill(); }
  useSource(c, 'Sample design');
}

// ---- building ---------------------------------------------------------------

function options() {
  const n = (id) => +$(id).value;
  return {
    width: n('width'), height: n('height'),
    relief: n('relief'), backing: n('backing'), margin: n('margin'),
    taper: n('taper'), tip: n('tip'), layer: Math.max(0.04, n('layer')),
    minGap: n('minGap'), capTaper: $('capTaper').checked, minLine: n('minLine'),
    smooth: n('smooth'), threshold: n('threshold'),
    invert: $('invert').checked, mirror: $('mirror').checked,
  };
}

function build() {
  const o = options();
  if (!source || !box || !(o.width > 0) || !(o.height > 0)) return null;
  const px = Math.max(MIN_PX, Math.max(o.width, o.height) / MAX_GRID);
  const gw = Math.max(2, Math.round(o.width / px)), gh = Math.max(2, Math.round(o.height / px));

  // Cut out the design and scale it to the building grid.
  const c = document.createElement('canvas');
  c.width = gw; c.height = gh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, gw, gh);
  ctx.drawImage(source.canvas, box.x0, box.y0, box.x1 - box.x0 + 1, box.y1 - box.y0 + 1, 0, 0, gw, gh);
  let gray = S.toGray(ctx.getImageData(0, 0, gw, gh).data, gw, gh);
  gray = S.blur(gray, gw, gh, o.smooth / px);
  const design = S.threshold(gray, o.threshold, o.invert);

  const v2 = (r) => r.map((p) => new THREE.Vector2(p.x, p.y));
  const triangulate = (outer, holes) => THREE.ShapeUtils.triangulateShape(v2(outer), holes.map(v2));
  const opts = { ...o, px, tol: Math.max(0.01, px * 0.35), triangulate };
  const reach = S.taperReach(opts);
  const pad = Math.ceil((reach + o.margin) / px) + 4;
  const { mask, w, h } = S.padMask(design, gw, gh, pad, o.mirror);
  const an = S.analyse(mask, w, h, opts);
  const slabList = S.slabs(an, w, h, opts);
  const mesh = S.buildMesh(slabList, opts);
  if (!mesh) return null;
  return { o: opts, mask, w, h, an, slabs: slabList, mesh, reach };
}

let timer = 0;
function update() {
  clearTimeout(timer);
  $('busy').hidden = false;
  timer = setTimeout(() => {
    const t0 = performance.now();
    try {
      last = build();
    } catch (e) {
      console.error(e);
      last = null;
    }
    $('busy').hidden = true;
    if (last) last.ms = Math.round(performance.now() - t0);
    show();
  }, 60);
}

// ---- showing it ------------------------------------------------------------------

function cssColour(name) {
  const g = document.createElement('canvas').getContext('2d');
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const hex = g.fillStyle;   // always #rrggbb
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function show() {
  $('empty').hidden = !!last;
  $('download').disabled = !last;
  $('legend').hidden = !last;
  $('zoomBar').hidden = !last || !$('threeWrap').hidden;
  if (!last) {
    $('flat').width = $('flat').height = 0;
    $('stats').textContent = '';
    $('warnings').innerHTML = source && !box ? '<p>No design found at this threshold. Try moving the Threshold slider.</p>' : '';
    if (mesh3d) { scene.remove(mesh3d); mesh3d.geometry.dispose(); mesh3d = null; render(); }
    return;
  }
  drawFlat();
  draw3d();

  const { o, mesh, an } = last;
  const tris = mesh.tris.length / 9;
  const [sx, sy, sz] = mesh.size;
  $('stats').textContent = `Stamp ${sx.toFixed(1)} × ${sy.toFixed(1)} × ${sz.toFixed(1)} mm · ` +
    `${tris.toLocaleString()} triangles · ${(tris * 50 / 1e6).toFixed(1)} MB`;

  const warn = [];
  if (an.thinCount)
    warn.push(['', `Some lines are thinner than ${o.minLine} mm (orange). They may not print, or may snap off. ` +
      'Make the stamp bigger, or thicken those lines in your design.']);
  if (an.shallowCount && o.taper > 0) {
    if (o.capTaper)
      warn.push(['kept', `Where lines are close together (yellow), the taper was reduced so the gaps stay ` +
        `${Math.min(o.minGap, o.relief)} mm deep.`]);
    else
      warn.push(['gap', `Where lines are close together (red), the taper fills the gap to less than ` +
        `${Math.min(o.minGap, o.relief)} mm deep, so it may not show on the leather. ` +
        'Tick "Keep gaps between lines…", or use less taper.']);
  }
  if (!warn.length) warn.push(['ok', 'No problems found. Your stamp is ready to download.']);
  $('warnings').innerHTML = warn.map(([cls, text]) => `<p class="${cls}">${text}</p>`).join('');
  const legend = { thin: an.thinCount > 0, gap: an.shallowCount > 0 && o.taper > 0 && !o.capTaper,
    kept: an.shallowCount > 0 && o.taper > 0 && o.capTaper, foot: o.taper > 0 };
  for (const span of $('legend').children) {
    const k = span.querySelector('i').classList[1];
    span.hidden = k in legend && !legend[k];
  }
}

function drawFlat() {
  const { w, h, mask, an, o, mesh, reach } = last;
  const cv = $('flat');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w, h);
  const col = Object.fromEntries(['face', 'foot', 'plate', 'paper', 'thin', 'gap', 'kept']
    .map((k) => [k, cssColour('--' + k)]));
  const reachPx = reach / o.px;
  const [bx0, by0, bx1, by1] = mesh.box;
  const c0 = bx0 / o.px, c1 = bx1 / o.px, r0 = h - 1 - by1 / o.px, r1 = h - 1 - by0 / o.px;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let c;
      if (mask[i]) c = an.thin[i] ? col.thin : col.face;
      else if (an.narrow[i] && o.taper > 0) c = o.capTaper ? col.kept : col.gap;
      else if (o.taper > 0 && an.sd[i] < reachPx) c = col.foot;
      else if (x >= c0 && x <= c1 && y >= r0 && y <= r1) c = col.plate;
      else c = col.paper;
      img.data.set(c, i * 4);
      img.data[i * 4 + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  applyZoom(zoom);
}

// ---- flat view zoom and panning ----------------------------------------------------

const ZOOM_STEP = 1.5, ZOOM_MAX = 16;   // times the size that fits the view
let zoom = 1;                           // 1 = the whole stamp fits

function fitScale() {
  const wrap = $('flatWrap'), cv = $('flat');
  // offsetWidth includes the scrollbars, so "fit" doesn't change when they appear.
  return Math.min((wrap.offsetWidth - 24) / cv.width, (wrap.offsetHeight - 24) / cv.height);
}

function applyZoom(z) {
  const wrap = $('flatWrap'), cv = $('flat');
  if (!cv.width || !wrap.clientWidth) return;
  // Keep whatever is in the middle of the view in the middle.
  const oldW = cv.offsetWidth, oldH = cv.offsetHeight;
  const cx = oldW ? (wrap.scrollLeft + wrap.clientWidth / 2 - cv.offsetLeft) / oldW : 0.5;
  const cy = oldH ? (wrap.scrollTop + wrap.clientHeight / 2 - cv.offsetTop) / oldH : 0.5;
  zoom = Math.min(ZOOM_MAX, Math.max(1, z));
  const s = fitScale() * zoom;
  cv.style.width = Math.round(cv.width * s) + 'px';
  cv.style.height = Math.round(cv.height * s) + 'px';
  wrap.scrollLeft = cx * cv.offsetWidth + cv.offsetLeft - wrap.clientWidth / 2;
  wrap.scrollTop = cy * cv.offsetHeight + cv.offsetTop - wrap.clientHeight / 2;
  $('zoomFit').textContent = zoom === 1 ? 'Fit' : Math.round(zoom * 100) + '%';
  $('zoomOut').disabled = zoom <= 1;
  $('zoomIn').disabled = zoom >= ZOOM_MAX;
  wrap.classList.toggle('pannable', zoom > 1);
  wrap.classList.toggle('zoomed', s > 2);   // show crisp pixels up close
}

$('zoomIn').onclick = () => applyZoom(zoom * ZOOM_STEP);
$('zoomOut').onclick = () => applyZoom(zoom / ZOOM_STEP);
$('zoomFit').onclick = () => applyZoom(1);
new ResizeObserver(() => applyZoom(zoom)).observe($('flatWrap'));

// Ctrl + mouse wheel (or a trackpad pinch) zooms too.
$('flatWrap').addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  applyZoom(zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
}, { passive: false });

// Drag the picture around when zoomed in.
{
  const wrap = $('flatWrap');
  let drag = null;
  wrap.addEventListener('pointerdown', (e) => {
    if (zoom <= 1 || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, left: wrap.scrollLeft, top: wrap.scrollTop };
    wrap.setPointerCapture(e.pointerId);
    wrap.classList.add('panning');
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!drag) return;
    wrap.scrollLeft = drag.left - (e.clientX - drag.x);
    wrap.scrollTop = drag.top - (e.clientY - drag.y);
  });
  const stop = () => { drag = null; wrap.classList.remove('panning'); };
  wrap.addEventListener('pointerup', stop);
  wrap.addEventListener('pointercancel', stop);
}

// ---- 3D view ------------------------------------------------------------------------

let renderer, scene, camera, controls, mesh3d;

function init3d() {
  const wrap = $('threeWrap');
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  wrap.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
  camera.up.set(0, 0, 1);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.addEventListener('change', render);
  scene.add(new THREE.HemisphereLight(0xfff4e6, 0x5a4636, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(-1, -2, 3);
  scene.add(sun);
  new ResizeObserver(resize3d).observe(wrap);
}

function resize3d() {
  const wrap = $('threeWrap');
  const { clientWidth: w, clientHeight: h } = wrap;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  render();
}

const render = () => renderer && renderer.render(scene, camera);

function draw3d() {
  if (!renderer) init3d();
  if (mesh3d) { scene.remove(mesh3d); mesh3d.geometry.dispose(); }
  const { tris, size } = last.mesh;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(tris, 3));
  geom.computeVertexNormals();
  // Shade by height: backing light tan, the face dark brown, so the
  // design reads from any angle.
  const low = new THREE.Color(0xe3c39a), high = new THREE.Color(0x6b3d1e), tint = new THREE.Color();
  const colours = new Float32Array(tris.length);
  const base = last.o.backing;
  for (let i = 0; i < tris.length; i += 3) {
    const t = Math.min(1, Math.max(0, (tris[i + 2] - base) / last.o.relief));
    tint.copy(low).lerp(high, t * t);
    colours[i] = tint.r; colours[i + 1] = tint.g; colours[i + 2] = tint.b;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  mesh3d = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, flatShading: true }));
  mesh3d.position.set(-size[0] / 2, -size[1] / 2, 0);
  scene.add(mesh3d);
  if (resetCamera) {
    const d = Math.max(size[0], size[1]) * 2.2;
    camera.position.set(0, -d * 0.75, d * 0.8);
    controls.target.set(0, 0, size[2] / 2);
    controls.update();
    resetCamera = false;
  }
  render();
}

// ---- controls --------------------------------------------------------------------------

function setTab(three) {
  $('tabFlat').classList.toggle('on', !three);
  $('tab3d').classList.toggle('on', three);
  $('tabFlat').setAttribute('aria-selected', !three);
  $('tab3d').setAttribute('aria-selected', three);
  $('flatWrap').hidden = three;
  $('threeWrap').hidden = !three;
  $('zoomBar').hidden = three || !last;
  if (three && renderer) resize3d();
  if (!three) applyZoom(zoom);
}
$('tabFlat').onclick = () => setTab(false);
$('tab3d').onclick = () => setTab(true);

const outputs = {
  threshold: (v) => v,
  smooth: (v) => (+v ? v + ' mm' : 'off'),
  taper: (v) => (+v ? v + '°' : 'none (straight walls)'),
};
function showOutputs() {
  for (const [id, f] of Object.entries(outputs)) $(id + 'Out').textContent = f($(id).value);
}

$('file').onchange = (e) => loadFile(e.target.files[0]);
$('sample').onclick = sample;
const drop = $('drop');
for (const t of [drop, document.querySelector('.stage')]) {
  t.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  t.addEventListener('dragleave', () => drop.classList.remove('over'));
  t.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    loadFile(e.dataTransfer.files[0]);
  });
}

for (const el of document.querySelectorAll('.controls input:not([type=file])')) {
  el.addEventListener('input', () => {
    showOutputs();
    if (el.id === 'width' || el.id === 'height') syncSize(el.id);
    if (el.id === 'threshold' || el.id === 'invert') findBox(false);
    update();
  });
}

$('download').onclick = () => {
  if (!last) return;
  const base = (source.name || 'stamp').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_');
  const blob = new Blob([S.toSTL(last.mesh.tris, base)], { type: 'model/stl' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${base}-stamp.stl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

showOutputs();
show();

// For testing from the browser console.
window.stampMaker = { get last() { return last; }, S, sample, build };
