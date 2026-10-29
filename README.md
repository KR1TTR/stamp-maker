# Stamp Maker

A picture in, a 3D-printable leather stamp out.

**Use it online: https://kr1ttr.github.io/stamp-maker/**

Created by **Justin Stapleton, KR1TTR**, with **Claude Code** (Claude Opus 5.5).

Everything runs in your browser: your pictures are never uploaded anywhere.

## What it does
1. **Load a design**: a PNG, JPG or SVG. Dark lines on a light background work best.
2. **Black and white**: a threshold slider turns the picture into clean lines; the
   design is mirrored so it reads the right way round on the leather.
3. **Size**: design width/height in mm, relief depth (3 mm), backing plate and border.
4. **Taper**: widens the lines toward the backing so thin lines and dots don't
   snap off. The face that touches the leather keeps your exact design. It warns
   about lines too thin to print, and can keep the gaps between close lines deep
   enough to show on the leather.
5. **Download** an STL for your slicer. Print it face up; a 0.2 mm nozzle keeps fine
   lines crisp.

The flat view shows the stamp face with any problem spots coloured in; the 3D view
shows the finished stamp.

## Running it on your own computer
The page uses JavaScript modules, so it has to be served rather than opened as a file:

    python3 -m http.server 8093 --bind 127.0.0.1

then open http://127.0.0.1:8093. The 3D part (three.js) is loaded from the
jsDelivr CDN, so it needs an internet connection.

## Files
- `index.html`, `style.css`, `icon.svg` - the page.
- `app.js` - controls, flat view, 3D view (three.js), download.
- `stamp.js` - the geometry, no page code: threshold, distance field, taper
  slabs (one per layer height), marching-squares outlines, triangulation,
  binary STL, and a watertight check (`checkMesh`).

## How the stamp is built
A backing plate plus a stack of slabs, one per printer layer. The top slab is the
design; each lower slab is the design grown outward by the taper angle (after a
short straight tip). The slabs overlap slightly and slicers merge them into one
solid. Where lines are so close that the taper would fill the gap to less than the
minimum gap depth, "Keep gaps deep" stops the taper there for the top part of the
gap.

Tested with widths of 20-80 mm, tapers of 0-45 degrees and layer heights of
0.08-0.2 mm: every result is watertight, Bambu Studio reports the files as
manifold, and they slice cleanly.

## Licence
GNU General Public License v3 - see [LICENSE](LICENSE). Use at your own risk.
