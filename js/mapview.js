/**
 * mapview.js — Geographic world map rendered on a rotating orthographic globe.
 *
 * Spec: docs/map.md
 *
 * Key behaviours:
 *  - Orthographic (globe) projection; drag rotates lon0/lat0
 *  - Region polygons are Voronoi cells built by half-plane intersection over the adjacency graph
 *  - Zoom range: 0.5 … 8 (scales globe radius)
 *  - Input: mouse wheel, trackpad/touch pinch, keyboard +/-, touch drag, tap-to-select
 *  - devicePixelRatio-aware canvas sizing (§4.3)
 */
// (No external imports — Voronoi cells are built from the adjacency graph in map.json)

// ── Colours ──────────────────────────────────────────────────────────────────

const FACTION_COLORS = {
  federation: '#4a9eff',
  syndicate:  '#e6a820',
  conspiracy: '#9b59b6',
};
const COL_OCEAN      = '#0a1020';
const COL_LAND_DEF   = '#1a2030';
const COL_BORDER     = '#2a3548';
const COL_BORDER_HOV = '#4a6088';
const COL_BORDER_SEL = '#8090c8';
const COL_TEXT       = '#d4d4e8';
const COL_MUTED      = '#6878a0';
const COL_UNREST_LO  = '#27ae60';
const COL_UNREST_MD  = '#e67e22';
const COL_UNREST_HI  = '#c0392b';

function unrestColor(u) {
  if (u > 60) return COL_UNREST_HI;
  if (u > 30) return COL_UNREST_MD;
  return COL_UNREST_LO;
}

// ── Region seeds, keys, and cell polygons ─────────────────────────────────────
// Keys: reg_* → strip "reg_" prefix; sea_* → kept as-is.
// Geometry is built lazily from world.regions on first render() — no fetch needed.
const _toKey = id => id.replace(/^reg_/, '');

// ── Voronoi cells (adjacency-graph half-plane intersection) ──────────────────
//
// For each region seed p, clip the EA bounding box by the perpendicular bisector
// between p and each adjacent seed. The resulting polygon is the set of EA points
// closer to p than to any declared neighbour. Together the non-sea cells tile the
// visible globe with no gaps.
//
// Called once on first render() with world.regions as input.
function _buildGeo(regions) {
  const seeds   = new Map(regions.map(r => [_toKey(r.id), r]));
  const geoKeys = [...seeds.keys()].filter(k => !k.startsWith('sea_'));
  const geoCells = (() => {
  const EA_FWD = (lon, lat) => [lon, Math.sin(lat * Math.PI / 180)];
  const EA_INV = (x, y)    => [x,   Math.asin(Math.max(-1, Math.min(1, y))) * 180 / Math.PI];

  // Sutherland-Hodgman clip of an EA polygon to yMin ≤ y ≤ yMax.
  function _clipEA(poly, yMin, yMax) {
    let pts = poly;
    // clip north: keep y ≤ yMax
    {
      const out = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if (a[1] <= yMax) out.push(a);
        if ((a[1] <= yMax) !== (b[1] <= yMax)) {
          const t = (yMax - a[1]) / (b[1] - a[1]);
          out.push([a[0] + t * (b[0] - a[0]), yMax]);
        }
      }
      pts = out;
    }
    // clip south: keep y ≥ yMin
    {
      const out = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if (a[1] >= yMin) out.push(a);
        if ((a[1] >= yMin) !== (b[1] >= yMin)) {
          const t = (yMin - a[1]) / (b[1] - a[1]);
          out.push([a[0] + t * (b[0] - a[0]), yMin]);
        }
      }
      pts = out;
    }
    return pts;
  }

  // Build a spherical cap polygon in lon/lat by densely sampling the boundary
  // latitude circle (every 2° lon) then closing through the pole.
  function _capPoly(capLat, poleLat) {
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 2) pts.push([lon, capLat]);
    pts.push([180, poleLat]);
    pts.push([-180, poleLat]);
    pts.push([-180, capLat]);
    return _subdividePoly(pts);
  }

  // Clip poly to the half-plane closer to (ax, ay) than to (bx, by) in EA space.
  // Adjusts bx to take the shorter path across the antimeridian when needed.
  // If the adjusted path still spans >180°, the bisector falls outside the bounding
  // box and the clip is skipped (poly returned unchanged).
  function _clipHalfPlane(poly, ax, ay, bx, by) {
    if (bx - ax > 180) bx -= 360;
    else if (bx - ax < -180) bx += 360;
    if (Math.abs(bx - ax) > 180) return poly;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const nx = bx - ax, ny = by - ay;
    const inside = (px, py) => (px - mx) * nx + (py - my) * ny <= 0;
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const aIn = inside(a[0], a[1]);
      const bIn = inside(b[0], b[1]);
      if (aIn) out.push(a);
      if (aIn !== bIn) {
        const denom = (b[0] - a[0]) * nx + (b[1] - a[1]) * ny;
        if (Math.abs(denom) > 1e-10) {
          const t = ((mx - a[0]) * nx + (my - a[1]) * ny) / denom;
          if (t > 0 && t < 1)
            out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
        }
      }
    }
    return out;
  }

  // Non-polar cells are capped at these EA y values so no cell touches y=±1.
  const MAX_Y_N = Math.sin(75 * Math.PI / 180);   //  sin(75°) ≈ 0.966
  const MAX_Y_S = Math.sin(-60 * Math.PI / 180);  // sin(−60°) ≈ −0.866

  const cells = {};
  for (const [key, region] of seeds) {
    if (key === 'arctic')     { cells[key] = _capPoly(75, 90);   continue; }
    if (key === 'antarctica') { cells[key] = _capPoly(-60, -90); continue; }

    let cell = [[-180, -1], [180, -1], [180, 1], [-180, 1]];
    const [ax, ay] = EA_FWD(region.lon, region.lat);

    for (const [otherKey, other] of seeds) {
      if (otherKey === key) continue;
      const [bx, by] = EA_FWD(other.lon, other.lat);
      cell = _clipHalfPlane(cell, ax, ay, bx, by);
      if (cell.length < 3) break;
    }

    if (cell.length < 3) continue;
    const clipped = _clipEA(cell, MAX_Y_S, MAX_Y_N);
    if (clipped.length < 3) continue;
    cells[key] = _subdividePoly(clipped.map(([x, y]) => EA_INV(x, y)));
  }
  return cells;
  })();
  return { seeds, geoKeys, geoCells };
}

// Match a game region to its seed entry in the seeds map.
function findGeo(id, name, seeds, geoKeys) {
  const norm = s => (s ?? '').toLowerCase()
    .replace(/^reg_/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const nid   = norm(id);
  const nname = norm(name);

  if (seeds.has(nid))   return seeds.get(nid);
  if (seeds.has(nname)) return seeds.get(nname);

  for (const key of geoKeys) {
    if (key.length >= 5 && nid.length >= 5 && (nid === key || nid.includes(key) || key.includes(nid)))
      return seeds.get(key);
  }

  const ALIAS = {
    usa: 'usa_midwest', america: 'usa_midwest',
    russia: 'russia_northwest', siberia: 'siberia_west',
    china: 'china_north', japan: 'japan_central',
    india: 'india_north', africa: 'nigeria',
    uk: 'england_wales', britain: 'england_wales',
    france: 'france_north', germany: 'germany_north',
    iran: 'iran_north', turkey: 'turkey_west',
    korea: 'korea_south', australia: 'australia_south',
    brazil: 'brazil_central', mexico: 'mexico',
    canada: 'canada_west', argentina: 'argentina',
  };
  for (const [alias, geoKey] of Object.entries(ALIAS)) {
    if (nname.includes(alias) || nid.includes(alias)) {
      const seed = seeds.get(geoKey);
      if (seed) return seed;
    }
  }
  return null;
}

// ── Projection ───────────────────────────────────────────────────────────────
//
// Orthographic projection centred at (lon0, lat0).
// Returns {x, y} in screen pixels, or null if the point is on the back hemisphere.

/**
 * Projects (lon, lat) to canvas (x, y) via orthographic projection centred at (lon0, lat0).
 * Returns null for back-hemisphere points unless `force` is true.
 * Pass force=true for already-clipped polygons where the canvas clip handles edge cases.
 */
function projectOrtho(lon, lat, lon0, lat0, R, cx, cy, force = false) {
  const toRad = Math.PI / 180;
  const φ  = lat  * toRad;
  const φ0 = lat0 * toRad;
  const Δλ = (lon - lon0) * toRad;
  const cosC = Math.sin(φ0) * Math.sin(φ) + Math.cos(φ0) * Math.cos(φ) * Math.cos(Δλ);
  if (!force && cosC < 0) return null;
  return {
    x: cx + R * Math.cos(φ) * Math.sin(Δλ),
    y: cy - R * (Math.cos(φ0) * Math.sin(φ) - Math.sin(φ0) * Math.cos(φ) * Math.cos(Δλ)),
  };
}

// ── Point-in-polygon (ray casting, lon/lat space) ────────────────────────────

function pointInPolyLonLat(lon, lat, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (((yi > lat) !== (yj > lat)) &&
        (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi))
      inside = !inside;
  }
  return inside;
}

// ── Spherical geometry helpers ────────────────────────────────────────────────

function _toXYZ(lon, lat) {
  const φ = lat * Math.PI / 180, λ = lon * Math.PI / 180;
  return [Math.cos(φ)*Math.cos(λ), Math.cos(φ)*Math.sin(λ), Math.sin(φ)];
}

function _fromXYZ(x, y, z) {
  return [Math.atan2(y, x) * 180/Math.PI, Math.asin(z) * 180/Math.PI];
}

/** Subdivide a closed d3-delaunay polygon along great circle arcs (≤ maxDeg° per segment). */
function _subdividePoly(poly, maxDeg = 4) {
  const out = [];
  for (let i = 0, n = poly.length - 1; i < n; i++) {
    const p1 = poly[i], p2 = poly[i + 1];
    const v1 = _toXYZ(p1[0], p1[1]), v2 = _toXYZ(p2[0], p2[1]);
    const dot = Math.max(-1, Math.min(1, v1[0]*v2[0] + v1[1]*v2[1] + v1[2]*v2[2]));
    const θ   = Math.acos(dot);
    const segs = Math.max(1, Math.ceil(θ * 180/Math.PI / maxDeg));
    for (let j = 0; j < segs; j++) {
      const t = j / segs;
      if (θ < 1e-6) { out.push(p1); continue; }
      const s = Math.sin(θ);
      const w1 = Math.sin((1 - t) * θ) / s, w2 = Math.sin(t * θ) / s;
      out.push(_fromXYZ(
        w1*v1[0] + w2*v2[0],
        w1*v1[1] + w2*v2[1],
        w1*v1[2] + w2*v2[2],
      ));
    }
  }
  return out;
}

/**
 * Sutherland-Hodgman clip of a polygon to the visible hemisphere facing (lon0, lat0).
 * Returns an open polygon suitable for closePath() rendering.
 */
function _clipHemisphere(poly, lon0, lat0) {
  const N   = _toXYZ(lon0, lat0);
  const dN  = p => { const q = _toXYZ(p[0], p[1]); return N[0]*q[0] + N[1]*q[1] + N[2]*q[2]; };
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const P1 = poly[i], P2 = poly[(i + 1) % poly.length];
    const d1 = dN(P1),  d2 = dN(P2);
    if (d1 > 0) out.push(P1);
    if ((d1 > 0) !== (d2 > 0)) {
      const a = _toXYZ(P1[0], P1[1]), b = _toXYZ(P2[0], P2[1]);
      const t  = d1 / (d1 - d2);
      const ix = a[0]+t*(b[0]-a[0]), iy = a[1]+t*(b[1]-a[1]), iz = a[2]+t*(b[2]-a[2]);
      const len = Math.sqrt(ix*ix + iy*iy + iz*iz);
      out.push(_fromXYZ(ix/len, iy/len, iz/len));
    }
  }
  return out;
}

// ── Faction influence helpers ─────────────────────────────────────────────────

/** Returns the faction_id with the highest influence share, or null. */
function dominantFaction(region) {
  const inf = region.faction_influence ?? {};
  let best = null, bestVal = -1;
  for (const [fid, val] of Object.entries(inf)) {
    if (val > bestVal) { best = fid; bestVal = val; }
  }
  return best;
}

// ── View-mode colour helpers ──────────────────────────────────────────────────

const VIEWS = {
  political:  { label: 'Political',  legend: null },
  population: { label: 'Population', legend: [['Low','#1a3a5c'],['High','#00d4ff']] },
  unrest:     { label: 'Unrest',     legend: [['Low','#27ae60'],['Mid','#e67e22'],['High','#c0392b']] },
  prosperity: { label: 'Prosperity', legend: [['Low','#c0392b'],['Mid','#e67e22'],['High','#27ae60']] },
};

function lerp(a, b, t) { return a + (b - a) * t; }

function heatColor(value, lo, hi, fromHex, toHex) {
  const t  = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
  const fr = parseInt(fromHex.slice(1,3),16), fg = parseInt(fromHex.slice(3,5),16), fb = parseInt(fromHex.slice(5,7),16);
  const tr = parseInt(toHex.slice(1,3),16),   tg = parseInt(toHex.slice(3,5),16),   tb = parseInt(toHex.slice(5,7),16);
  return `rgb(${Math.round(lerp(fr,tr,t))},${Math.round(lerp(fg,tg,t))},${Math.round(lerp(fb,tb,t))})`;
}

function threeStopColor(value, lo, mid, hi, colLo, colMid, colHi) {
  if (value <= mid) return heatColor(value, lo, mid, colLo, colMid);
  return heatColor(value, mid, hi, colMid, colHi);
}

// ── Constants ────────────────────────────────────────────────────────────────

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;

// ── MapView ──────────────────────────────────────────────────────────────────

export class MapView {
  constructor(canvas, onSelect) {
    this.canvas   = canvas;
    this.ctx      = canvas.getContext('2d');
    this.onSelect = onSelect;

    this._world    = null;
    this._seeds    = null;   // Map<key, region> — built from world.regions on first render
    this._geoKeys  = null;   // string[] — renderable (non-sea) keys
    this._geoCells = null;   // { [key]: [[lon,lat],...] } — Voronoi cells
    this._entries  = [];   // { region, key, cLon, cLat }
    this._allGeo   = [];   // { key, poly, cLon, cLat }
    this._selected = null;
    this._hovered  = null;
    this._view     = 'political';

    // Zoom / pan state (in logical/CSS pixels)
    this._zoom  = 1;
    this._panX  = 0;   // unclamped; normalised in _draw / _hitTest
    this._panY  = 0;

    // Drag state
    this._drag  = null;   // { startX, startY, panX0, panY0, moved }
    this._pinch = null;   // { dist0, zoom0, panX0, panY0 }

    // Keyboard zoom
    this._keyHandler = e => this._onKey(e);
    document.addEventListener('keydown', this._keyHandler);

    canvas.addEventListener('click',      e => this._onClick(e));
    canvas.addEventListener('mousemove',  e => this._onMouseMove(e));
    canvas.addEventListener('mousedown',  e => this._onMouseDown(e));
    canvas.addEventListener('mouseup',    () => this._onMouseUp());
    canvas.addEventListener('mouseleave', () => { this._drag = null; this._hovered = null; this._draw(); });
    canvas.addEventListener('wheel',      e => this._onWheel(e), { passive: false });

    canvas.addEventListener('touchstart', e => this._onTouchStart(e), { passive: false });
    canvas.addEventListener('touchmove',  e => this._onTouchMove(e),  { passive: false });
    canvas.addEventListener('touchend',   e => this._onTouchEnd(e),   { passive: false });

    this._ro = new ResizeObserver(() => this._layout());
    this._ro.observe(canvas.parentElement ?? canvas);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  render(world) {
    this._world    = world;
    this._selected = null;
    if (!this._seeds) {
      const { seeds, geoKeys, geoCells } = _buildGeo(world.regions ?? []);
      this._seeds    = seeds;
      this._geoKeys  = geoKeys;
      this._geoCells = geoCells;
    }
    this._layout();
  }

  deselect() {
    this._selected = null;
    this._draw();
  }

  setView(mode) {
    if (!VIEWS[mode]) return;
    this._view = mode;
    this._draw();
  }

  /** Select a region by game ID and rotate the globe to centre on it. */
  selectById(regionId) {
    const entry = this._entries.find(e => e.region.id === regionId);
    if (!entry) return;
    this._selected = regionId;
    this._panX = entry.cLon;
    this._panY = entry.cLat;
    this._clampPanY();
    this.onSelect(entry.region);
    this._draw();
  }

  // ── Layout ────────────────────────────────────────────────────────────────

  _layout() {
    // Clear explicit styles so flex assigns the canvas its natural allocated size
    this.canvas.style.width  = '';
    this.canvas.style.height = '';
    const W = Math.max(this.canvas.clientWidth,  400);
    const H = Math.max(this.canvas.clientHeight, 250);
    const dpr = window.devicePixelRatio || 1;

    // Physical canvas size
    this.canvas.width  = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.canvas.style.width  = W + 'px';
    this.canvas.style.height = H + 'px';

    // All draw calls use logical (CSS) pixel coordinates
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Use pre-computed Voronoi cells — projected per-frame in _draw()
    this._allGeo = (this._geoKeys ?? [])
      .filter(key => this._geoCells[key])
      .map(key => {
        const seed = this._seeds.get(key);
        return {
          key,
          poly: this._geoCells[key],   // [[lon, lat], ...] Voronoi cell
          cLon: seed.lon,
          cLat: seed.lat,
        };
      });

    this._entries = (this._world?.regions ?? []).map(r => {
      const key  = r.id.replace(/^reg_/, '');
      const seed = this._seeds.get(key) ?? findGeo(r.id, r.name, this._seeds, this._geoKeys);
      if (!seed) return null;
      const cLon = r.lon  != null ? r.lon  : seed.lon;
      const cLat = r.lat  != null ? r.lat  : seed.lat;
      return { region: r, key, cLon, cLat };
    }).filter(Boolean);

    // Index for O(1) lookup in _hitTest
    this._byKey = {};
    for (const e of this._entries) this._byKey[e.key] = e;

    this._clampPanY();
    this._draw();
  }

  // ── Coordinate helpers ────────────────────────────────────────────────────

  /** Logical canvas size in CSS pixels. */
  _logSize() {
    return {
      W: this.canvas.width  / (window.devicePixelRatio || 1),
      H: this.canvas.height / (window.devicePixelRatio || 1),
    };
  }

  /** Globe radius in logical pixels at current zoom. */
  _globeR(W, H) { return Math.max(10, Math.min(W, H) / 2 * this._zoom - 4); }

  /** Normalise lon0 to [-180, 180] after long drag sessions. */
  _normalisePanX() {
    this._panX = ((this._panX + 180) % 360 + 360) % 360 - 180;
  }

  /** Clamp lat0 so the poles stay on the globe. */
  _clampPanY() {
    this._panY = Math.max(-85, Math.min(85, this._panY));
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  _draw() {
    const { W, H } = this._logSize();
    const ctx  = this.ctx;
    const cx   = W / 2, cy = H / 2;
    const R    = this._globeR(W, H);
    const lon0 = this._panX, lat0 = this._panY;

    ctx.clearRect(0, 0, W, H);

    // Ocean sphere
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = COL_OCEAN;
    ctx.fill();

    // Clip all land drawing to the globe disc
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();

    if (!this._world) {
      this._drawEmpty(ctx, lon0, lat0, R, cx, cy);
    } else {
      const factionCol = this._factionColorMap();
      const armies     = this._indexBy(this._world.armies ?? [], 'region_id');
      const heroes     = this._indexBy(this._world.heroes ?? [], 'region_id');

      for (const { key, poly, cLon, cLat } of this._allGeo) {
        const clipped = _clipHemisphere(poly, lon0, lat0);
        if (clipped.length < 3) continue;

        const ge    = this._byKey[key];
        const isSel = ge && this._selected === ge.region.id;
        const isHov = ge && this._hovered  === ge.region.id;
        const fill  = ge ? this._regionFill(ge.region, factionCol, isHov) : COL_LAND_DEF;

        const pts = clipped.map(([lo, la]) => projectOrtho(lo, la, lon0, lat0, R, cx, cy, true));

        if (isSel) {
          ctx.shadowColor = factionCol[dominantFaction(ge.region)] ?? '#7070b0';
          ctx.shadowBlur  = 16;
        }

        ctx.beginPath();
        pts.forEach(({ x, y }, i) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.strokeStyle = isSel ? COL_BORDER_SEL : isHov ? COL_BORDER_HOV : COL_BORDER;
        ctx.lineWidth   = isSel ? 1.5 : 0.5;
        ctx.stroke();
      }

      // Overlays (labels, badges)
      for (const { region, cLon, cLat } of this._entries) {
        const pt = projectOrtho(cLon, cLat, lon0, lat0, R, cx, cy);
        if (!pt) continue;
        this._drawOverlay(ctx, region, pt.x, pt.y,
          this._hovered  === region.id,
          this._selected === region.id,
          armies[region.id] ?? [],
          heroes[region.id] ?? []);
      }
    }

    ctx.restore();

    // Globe rim
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = '#243456';
    ctx.lineWidth   = 1;
    ctx.stroke();

    if (!this._world) {
      ctx.fillStyle    = COL_MUTED;
      ctx.font         = '14px system-ui';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No world data — complete setup or wait for turn 1.', cx, cy);
    }
  }

  _drawEmpty(ctx, lon0, lat0, R, cx, cy) {
    for (const { poly } of this._allGeo) {
      const clipped = _clipHemisphere(poly, lon0, lat0);
      if (clipped.length < 3) continue;
      const pts = clipped.map(([lo, la]) => projectOrtho(lo, la, lon0, lat0, R, cx, cy, true));
      ctx.beginPath();
      pts.forEach(({ x, y }, i) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
      ctx.closePath();
      ctx.fillStyle   = COL_LAND_DEF;
      ctx.fill();
      ctx.strokeStyle = COL_BORDER;
      ctx.lineWidth   = 0.5;
      ctx.stroke();
    }
  }

  _drawOverlay(ctx, region, cx, cy, isHov, isSel, armies, heroes) {
    const unrest = region.unrest ?? 0;

    if (unrest > 0) {
      ctx.beginPath();
      ctx.arc(cx, cy - 14, 4, 0, Math.PI * 2);
      ctx.fillStyle = unrestColor(unrest);
      ctx.fill();
    }

    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.font         = `${isSel ? 'bold ' : ''}10px system-ui`;
    ctx.fillStyle    = isHov || isSel ? COL_TEXT : 'rgba(212,212,232,0.8)';
    ctx.fillText(region.name ?? region.id, cx, cy);

    const pop = region.population >= 1000
      ? `${(region.population / 1000).toFixed(1)}B`
      : `${region.population}M`;
    ctx.font      = '8px system-ui';
    ctx.fillStyle = isHov || isSel ? COL_MUTED : 'rgba(104,120,160,0.6)';
    ctx.fillText(pop, cx, cy + 11);

    let bx = cx + 22;
    if (armies.length) { this._badge(ctx, bx, cy - 18, `⚔${armies.length}`, '#e74c3c'); bx += 26; }
    if (heroes.length) { this._badge(ctx, bx, cy - 18, `★${heroes.length}`, '#f39c12'); }
  }

  _badge(ctx, x, y, text, color) {
    ctx.fillStyle = color;
    _roundRect(ctx, x - 10, y - 7, 22, 14, 4);
    ctx.fill();
    ctx.fillStyle    = '#fff';
    ctx.font         = 'bold 8px system-ui';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 1, y);
  }

  _regionFill(region, factionCol, isHov) {
    const dim = c => this._dim(c, isHov ? 1 : 0.55);
    switch (this._view) {
      case 'population': {
        const pop = region.population ?? 0;
        const col = heatColor(Math.log10(Math.max(pop, 1)), 0, Math.log10(1400), '#1a3a5c', '#00d4ff');
        return isHov ? col : this._dim(col, 0.75);
      }
      case 'unrest': {
        const u = region.unrest ?? 0;
        const col = threeStopColor(u, 0, 40, 80, '#27ae60', '#e67e22', '#c0392b');
        return isHov ? col : this._dim(col, 0.75);
      }
      case 'prosperity': {
        const p = region.prosperity ?? 0;
        const col = threeStopColor(p, 0, 50, 100, '#c0392b', '#e67e22', '#27ae60');
        return isHov ? col : this._dim(col, 0.75);
      }
      default: {  // political — colour by dominant faction
        const base = factionCol[dominantFaction(region)] ?? COL_LAND_DEF;
        return dim(base);
      }
    }
  }

  _dim(hex, factor) {
    if (!hex?.startsWith('#') || hex.length < 7) return COL_LAND_DEF;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    if (isNaN(r)) return COL_LAND_DEF;
    return `rgb(${Math.round(r * factor)},${Math.round(g * factor)},${Math.round(b * factor)})`;
  }

  // ── Hit test ──────────────────────────────────────────────────────────────
  //
  // Inverse-project screen (sx, sy) to (lon, lat), then test all geo polygons.

  _hitTest(sx, sy) {
    const { W, H } = this._logSize();
    const cx = W / 2, cy = H / 2;
    const R  = this._globeR(W, H);

    // Normalised coordinates relative to globe centre
    const p = (sx - cx) / R;
    const q = -(sy - cy) / R;
    if (p * p + q * q > 1) return null; // outside globe disc

    // Inverse orthographic → lon/lat
    const toDeg = 180 / Math.PI;
    const lat0  = this._panY * (Math.PI / 180);
    const ρ     = Math.sqrt(p * p + q * q);

    let lon, lat;
    if (ρ < 1e-9) {
      lat = this._panY;
      lon = this._panX;
    } else {
      const c = Math.asin(Math.min(ρ, 1));
      lat = Math.asin(Math.cos(c) * Math.sin(lat0) + q * Math.sin(c) * Math.cos(lat0) / ρ) * toDeg;
      lon = this._panX + Math.atan2(
        p * Math.sin(c),
        ρ * Math.cos(c) * Math.cos(lat0) - q * Math.sin(c) * Math.sin(lat0),
      ) * toDeg;
    }
    lon = ((lon + 180) % 360 + 360) % 360 - 180;

    for (const { key, poly } of this._allGeo) {
      if (pointInPolyLonLat(lon, lat, poly)) return this._byKey[key] ?? null;
    }
    return null;
  }

  // ── Mouse input ───────────────────────────────────────────────────────────

  _onClick(e) {
    if (this._drag?.moved) return;
    const { x, y } = this._canvasPos(e);
    const hit = this._hitTest(x, y);
    if (hit) {
      this._selected = hit.region.id;
      this.onSelect(hit.region);
    } else {
      this._selected = null;
      this.onSelect(null);
    }
    this._draw();
  }

  _onMouseDown(e) {
    const { x, y } = this._canvasPos(e);
    this._drag = { startX: x, startY: y, panX0: this._panX, panY0: this._panY, moved: false };
    this.canvas.style.cursor = 'grabbing';
  }

  _onMouseMove(e) {
    const { x, y } = this._canvasPos(e);
    if (this._drag) {
      const dx = x - this._drag.startX;
      const dy = y - this._drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this._drag.moved = true;
      const { W, H } = this._logSize();
      const dpp = 180 / (Math.PI * this._globeR(W, H)); // degrees per pixel
      this._panX = this._drag.panX0 - dx * dpp;
      this._panY = this._drag.panY0 - dy * dpp;
      this._clampPanY();
      this._draw();
      return;
    }
    this._onHover(e);
  }

  _onMouseUp() {
    const wasDragging = this._drag?.moved;
    this._drag = null;
    if (!wasDragging) {
      this.canvas.style.cursor = this._hovered ? 'pointer' : 'default';
    } else {
      this.canvas.style.cursor = 'default';
      this._normalisePanX();  // prevent float drift after long drag
    }
  }

  _onHover(e) {
    const { x, y } = this._canvasPos(e);
    const hit = this._hitTest(x, y);
    const id  = hit?.region.id ?? null;
    if (id !== this._hovered) {
      this._hovered = id;
      this.canvas.style.cursor = id ? 'pointer' : 'default';
      this._draw();
    }
  }

  _onWheel(e) {
    e.preventDefault();
    this._applyZoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }

  // ── Keyboard input (§5.4) ─────────────────────────────────────────────────

  _onKey(e) {
    // Only respond when no input/textarea is focused
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === '+' || e.key === '=') this._applyZoom(1.15);
    if (e.key === '-')                   this._applyZoom(1 / 1.15);
  }

  _applyZoom(factor) {
    this._zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this._zoom * factor));
    this._draw();
  }

  // ── Touch input (§12) ─────────────────────────────────────────────────────

  _onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      const pos = this._touchPos(e.touches[0]);
      this._drag  = { startX: pos.x, startY: pos.y, panX0: this._panX, panY0: this._panY, moved: false };
      this._pinch = null;
    } else if (e.touches.length === 2) {
      this._drag  = null;
      this._pinch = {
        dist0: this._touchDist(e.touches[0], e.touches[1]),
        zoom0: this._zoom,
        panX0: this._panX,
        panY0: this._panY,
        midX:  (this._touchPos(e.touches[0]).x + this._touchPos(e.touches[1]).x) / 2,
        midY:  (this._touchPos(e.touches[0]).y + this._touchPos(e.touches[1]).y) / 2,
      };
    }
  }

  _onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 1 && this._drag) {
      const pos = this._touchPos(e.touches[0]);
      const dx  = pos.x - this._drag.startX;
      const dy  = pos.y - this._drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this._drag.moved = true;
      const { W, H } = this._logSize();
      const dpp = 180 / (Math.PI * this._globeR(W, H));
      this._panX = this._drag.panX0 - dx * dpp;
      this._panY = this._drag.panY0 - dy * dpp;
      this._clampPanY();
      this._draw();
    } else if (e.touches.length === 2 && this._pinch) {
      const dist = this._touchDist(e.touches[0], e.touches[1]);
      this._zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this._pinch.zoom0 * dist / this._pinch.dist0));
      this._draw();
    }
  }

  _onTouchEnd(e) {
    e.preventDefault();
    if (e.touches.length === 0) {
      // Tap to select
      if (this._drag && !this._drag.moved) {
        const hit = this._hitTest(this._drag.startX, this._drag.startY);
        if (hit) {
          this._selected = hit.region.id;
          this.onSelect(hit.region);
        } else {
          this._selected = null;
          this.onSelect(null);
        }
      }
      if (this._drag?.moved) this._normalisePanX();
      this._drag  = null;
      this._pinch = null;
      this._draw();
    }
  }

  _touchPos(touch) {
    const r = this.canvas.getBoundingClientRect();
    return { x: touch.clientX - r.left, y: touch.clientY - r.top };
  }

  _touchDist(t1, t2) {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  _factionColorMap() {
    const map = {};
    for (const f of (this._world?.factions ?? [])) {
      map[f.id] = FACTION_COLORS[f.type] ?? '#7c5cbf';
    }
    return map;
  }

  _indexBy(arr, key) {
    return arr.reduce((acc, item) => {
      const k = item[key];
      if (k) (acc[k] = acc[k] ?? []).push(item);
      return acc;
    }, {});
  }

  _canvasPos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
}

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
