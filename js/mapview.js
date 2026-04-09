/**
 * mapview.js — Globe renderer using globe.gl (WebGL / Three.js).
 *
 * Spec: docs/map.md
 *
 * Public API (unchanged):
 *   new MapView(container, onSelect)
 *   .render(world)
 *   .getAdjacentIds(regionId) → string[]
 *   .deselect()
 *   .setView(mode)
 *   .selectById(regionId)
 *
 * Depends on globe.gl loaded as window.Globe before this module runs.
 * Script: /libs/globe.gl/globe.gl.min.js
 */

// ── CSS helpers ──────────────────────────────────────────────────────────────
const _css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const COL_OCEAN      = _css('--map-ocean')      || '#0a1020';
const COL_LAND_DEF   = _css('--map-land')       || '#1a2030';
const COL_BORDER     = _css('--map-border')     || '#2a3548';
const COL_BORDER_HOV = _css('--map-border-hov') || '#4a6088';
const COL_BORDER_SEL = _css('--map-border-sel') || '#8090c8';

const FACTION_COLORS = {
  federation: _css('--accent2')            || '#4a9eff',
  syndicate:  _css('--faction-syndicate')  || '#e6a820',
  conspiracy: _css('--faction-conspiracy') || '#9b59b6',
};

// ── Region ID key helper ────────────────────────────────────────────────────
const _toKey = id => id.replace(/^reg_/, '');

// ── 3-D convex hull (= spherical Delaunay triangulation) ─────────────────────
//
// For points on the unit sphere, the 3-D convex hull faces ARE the Delaunay
// triangles (Guibas & Stolfi 1985).  Each face's outward unit normal is the
// corresponding Voronoi vertex on the sphere.
//
// Algorithm: randomised incremental insertion with conflict lists
// (de Berg et al. "Computational Geometry" §11.2).
// Expected O(n log n) time.
function _convexHull3D(pts) {
  const n = pts.length;
  if (n < 4) return [];

  const orient = (a,b,c,d) => {
    const pa=pts[a], pb=pts[b], pc=pts[c], pd=pts[d];
    const ux=pb[0]-pa[0], uy=pb[1]-pa[1], uz=pb[2]-pa[2];
    const vx=pc[0]-pa[0], vy=pc[1]-pa[1], vz=pc[2]-pa[2];
    const wx=pd[0]-pa[0], wy=pd[1]-pa[1], wz=pd[2]-pa[2];
    return ux*(vy*wz-vz*wy) - uy*(vx*wz-vz*wx) + uz*(vx*wy-vy*wx);
  };

  const hull    = [];
  const F       = id => hull[id];
  const addF    = (a,b,c) => (hull.push({v:[a,b,c], adj:[-1,-1,-1], pts:new Set(), alive:true}), hull.length-1);
  const link    = (fi,ei, fj,ej) => { F(fi).adj[ei]=fj; F(fj).adj[ej]=fi; };
  const edgeOf  = (fi,u,v) => { const w=F(fi).v; for(let e=0;e<3;e++) if(w[e]===u&&w[(e+1)%3]===v)return e; return -1; };
  const visible = (fi,q)   => orient(F(fi).v[0], F(fi).v[1], F(fi).v[2], q) > 1e-10;

  // ── Step 1: Initial tetrahedron ──────────────────────────────────────────
  let p0=0, p1=-1, p2=-1, p3=-1;
  for (let i=1; i<n&&p1<0; i++) {
    const a=pts[0], b=pts[i];
    if ((a[0]-b[0])**2+(a[1]-b[1])**2+(a[2]-b[2])**2 > 1e-8) p1=i;
  }
  if (p1<0) return [];
  for (let i=0; i<n&&p2<0; i++) {
    if (i===p0||i===p1) continue;
    const [ax,ay,az]=pts[p0], [bx,by,bz]=pts[p1], [cx,cy,cz]=pts[i];
    const nx=(by-ay)*(cz-az)-(bz-az)*(cy-ay);
    const ny=(bz-az)*(cx-ax)-(bx-ax)*(cz-az);
    const nz=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
    if (nx*nx+ny*ny+nz*nz > 1e-8) p2=i;
  }
  if (p2<0) return [];
  for (let i=0; i<n&&p3<0; i++) {
    if (i===p0||i===p1||i===p2) continue;
    if (Math.abs(orient(p0,p1,p2,i)) > 1e-8) p3=i;
  }
  if (p3<0) return [];

  const [f0,f1,f2,f3] = orient(p0,p1,p2,p3) > 0
    ? [addF(p0,p1,p2), addF(p0,p3,p1), addF(p0,p2,p3), addF(p1,p3,p2)]
    : [addF(p0,p2,p1), addF(p0,p1,p3), addF(p0,p3,p2), addF(p1,p2,p3)];

  link(f0,0,f1,2); link(f0,1,f3,2); link(f0,2,f2,0);
  link(f1,0,f2,2); link(f1,1,f3,0); link(f2,1,f3,1);

  // ── Step 2: Build initial conflict lists ─────────────────────────────────
  const pConfl = new Map();
  const order  = Array.from({length:n},(_,i)=>i)
    .filter(i=>i!==p0&&i!==p1&&i!==p2&&i!==p3)
    .sort(()=>Math.random()-0.5);

  for (const pt of order) {
    pConfl.set(pt, new Set());
    for (const fi of [f0,f1,f2,f3]) if (visible(fi,pt)) { F(fi).pts.add(pt); pConfl.get(pt).add(fi); }
  }

  // ── Step 3: Insert points ────────────────────────────────────────────────
  for (const pt of order) {
    const visFids = [...pConfl.get(pt)].filter(fi=>F(fi).alive && visible(fi,pt));
    if (!visFids.length) continue;

    const horizon = [];
    for (const fi of visFids) {
      const {v,adj} = F(fi);
      for (let e=0; e<3; e++) {
        const fAdj=adj[e];
        if (fAdj<0 || !visFids.includes(fAdj)) horizon.push({u:v[e], v:v[(e+1)%3], fAdj});
      }
    }

    const newFids = horizon.map(({u,v}) => addF(pt,u,v));
    for (let i=0; i<horizon.length; i++) {
      const next=(i+1)%horizon.length;
      link(newFids[i],1, newFids[next],2);
      const fAdj=horizon[i].fAdj;
      if (fAdj>=0) {
        const e=edgeOf(fAdj,horizon[i].v,horizon[i].u);
        if (e>=0) link(newFids[i],0,fAdj,e);
      }
    }

    for (let i=0; i<horizon.length; i++) {
      const fi=newFids[i];
      let fVisPts=new Set();
      for (const fv of visFids) { if (edgeOf(fv,horizon[i].u,horizon[i].v)>=0) { fVisPts=F(fv).pts; break; } }
      const cands = horizon[i].fAdj>=0 ? new Set([...fVisPts, ...F(horizon[i].fAdj).pts]) : fVisPts;
      for (const q of cands) {
        if (q!==pt && pConfl.has(q) && visible(fi,q)) {
          F(fi).pts.add(q); pConfl.get(q).add(fi);
        }
      }
    }

    for (const fv of visFids) {
      for (const q of F(fv).pts) { if (q!==pt && pConfl.has(q)) pConfl.get(q).delete(fv); }
      F(fv).alive=false;
    }
    pConfl.delete(pt);
  }

  return hull.filter(f=>f.alive).map(f=>f.v.slice());
}

// ── Spherical Delaunay triangulation ─────────────────────────────────────────
function _delaunay(seedList, seedXYZ) {
  const n        = seedList.length;
  const cellVerts = Array.from({ length: n }, () => []);
  const adjSets   = Array.from({ length: n }, () => new Set());

  for (const [i,j,k] of _convexHull3D(seedXYZ)) {
    const a=seedXYZ[i], b=seedXYZ[j], c=seedXYZ[k];
    const nx=(b[1]-a[1])*(c[2]-a[2])-(b[2]-a[2])*(c[1]-a[1]);
    const ny=(b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]);
    const nz=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    const len=Math.sqrt(nx*nx+ny*ny+nz*nz);
    if (len<1e-10) continue;
    const v=[nx/len, ny/len, nz/len];
    cellVerts[i].push(v); cellVerts[j].push(v); cellVerts[k].push(v);
    adjSets[i].add(j); adjSets[i].add(k);
    adjSets[j].add(i); adjSets[j].add(k);
    adjSets[k].add(i); adjSets[k].add(j);
  }

  const adjacency = new Map();
  for (let si=0; si<n; si++) {
    adjacency.set(seedList[si].id, [...adjSets[si]].map(ti => seedList[ti].id));
  }
  return { cellVerts, adjacency };
}

// ── Spherical geometry helpers ───────────────────────────────────────────────
function _toXYZ(lon, lat) {
  const φ = lat * Math.PI / 180, λ = lon * Math.PI / 180;
  return [Math.cos(φ)*Math.cos(λ), Math.cos(φ)*Math.sin(λ), Math.sin(φ)];
}

function _fromXYZ(x, y, z) {
  return [Math.atan2(y, x) * 180/Math.PI, Math.asin(z) * 180/Math.PI];
}

/** Subdivide polygon edges along great circle arcs (≤ maxDeg° per segment). */
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

// ── Voronoi cells from Delaunay output ────────────────────────────────────────
//
// Called once on first render() with world.regions as input.
function _buildGeo(regions) {
  const seeds   = new Map(regions.map(r => [_toKey(r.id), r]));
  const geoKeys = [...seeds.keys()].filter(k => !k.startsWith('sea_'));

  const seedList = [...seeds.values()];
  const seedXYZ  = seedList.map(r => _toXYZ(r.lon, r.lat));

  const { cellVerts, adjacency } = _delaunay(seedList, seedXYZ);

  const geoCells = {};
  for (let si = 0; si < seedList.length; si++) {
    const key   = _toKey(seedList[si].id);
    const verts = cellVerts[si];
    if (verts.length < 3) continue;

    const s = seedXYZ[si];
    let ux, uy, uz;
    if (Math.abs(s[2]) < 0.99) { ux = -s[1]; uy = s[0]; uz = 0; }
    else                        { ux = 1;      uy = 0;    uz = 0; }
    const uLen = Math.sqrt(ux*ux + uy*uy + uz*uz);
    ux /= uLen; uy /= uLen; uz /= uLen;
    const wx = s[1]*uz - s[2]*uy;
    const wy = s[2]*ux - s[0]*uz;
    const wz = s[0]*uy - s[1]*ux;

    verts.sort((p, q) => {
      const ap = Math.atan2(p[0]*wx+p[1]*wy+p[2]*wz, p[0]*ux+p[1]*uy+p[2]*uz);
      const aq = Math.atan2(q[0]*wx+q[1]*wy+q[2]*wz, q[0]*ux+q[1]*uy+q[2]*uz);
      return ap - aq;
    });

    geoCells[key] = _subdividePoly(verts.map(([vx, vy, vz]) => _fromXYZ(vx, vy, vz)));
  }

  return { seeds, geoKeys, geoCells, adjacency };
}

// ── Faction influence ────────────────────────────────────────────────────────
function dominantFaction(region) {
  const inf = region.faction_influence ?? {};
  let best = null, bestVal = -1;
  for (const [fid, val] of Object.entries(inf)) {
    if (val > bestVal) { best = fid; bestVal = val; }
  }
  return best;
}

// ── Colour helpers ───────────────────────────────────────────────────────────
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

/** Convert any CSS colour string to rgba(…, alpha). */
function _withAlpha(color, alpha) {
  if (!color) return `rgba(26,32,48,${alpha})`;
  if (color.startsWith('#') && color.length >= 7) {
    const r = parseInt(color.slice(1,3), 16);
    const g = parseInt(color.slice(3,5), 16);
    const b = parseInt(color.slice(5,7), 16);
    if (!isNaN(r)) return `rgba(${r},${g},${b},${alpha})`;
  }
  return color;   // pass through rgb/rgba
}

// ── MapView ───────────────────────────────────────────────────────────────────

export class MapView {
  /**
   * @param {HTMLElement} container  — div that globe.gl will render into
   * @param {Function}    onSelect   — called with (region|null) on click
   */
  constructor(container, onSelect) {
    this._container     = container;
    this.onSelect       = onSelect;
    this._world         = null;
    this._seeds         = null;
    this._geoKeys       = null;
    this._geoCells      = null;
    this._adjacency     = null;
    this._features      = [];
    this._regById       = {};
    this._factionColors = {};
    this._selected      = null;
    this._hovered       = null;
    this._view          = 'political';

    const G = window.Globe;
    if (!G) throw new Error('globe.gl not loaded (window.Globe is undefined)');

    // Solid-colour texture for the ocean sphere
    const texCanvas = Object.assign(document.createElement('canvas'), { width: 2, height: 2 });
    texCanvas.getContext('2d').fillStyle = COL_OCEAN;
    texCanvas.getContext('2d').fillRect(0, 0, 2, 2);

    this._globe = G({ animateIn: false })(container);
    this._globe
      .width(container.clientWidth  || 600)
      .height(container.clientHeight || 400)
      .backgroundColor('rgba(0,0,0,0)')
      .globeImageUrl(texCanvas.toDataURL())
      .showAtmosphere(true)
      .atmosphereColor('#1a3a6c')
      .atmosphereAltitude(0.12)
      // Polygons
      .polygonsData([])
      .polygonCapColor(d => this._capColor(d))
      .polygonSideColor(() => 'rgba(0,0,0,0.3)')
      .polygonStrokeColor(d => this._strokeColor(d))
      .polygonAltitude(d => d.properties?.id === this._selected ? 0.012 : 0.001)
      .polygonLabel(d => this._tooltip(d))
      .onPolygonClick(polygon => {
        if (!polygon) return;
        const region = this._regById[polygon.properties.id];
        if (region) {
          this._selected = region.id;
          this._refresh();
          this.onSelect(region);
        }
      })
      .onPolygonHover(polygon => {
        const id = polygon?.properties?.id ?? null;
        if (id !== this._hovered) {
          this._hovered = id;
          this._refresh();
        }
      })
      .onGlobeClick(() => {
        if (this._selected !== null) {
          this._selected = null;
          this._refresh();
          this.onSelect(null);
        }
      })
      // Labels
      .labelsData([])
      .labelLat(d => d.lat)
      .labelLng(d => d.lng)
      .labelText(d => d.name)
      .labelSize(0.35)
      .labelColor(() => 'rgba(212,212,232,0.85)')
      .labelDotRadius(0)
      .labelResolution(2)
      .labelAltitude(0.003)
      // HTML badges (armies, heroes)
      .htmlElementsData([])
      .htmlElement(d => {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;gap:3px;pointer-events:none';
        if (d.armies) {
          const s = document.createElement('span');
          s.style.cssText = 'background:#e74c3c;color:#fff;font:bold 9px system-ui;padding:1px 4px;border-radius:3px';
          s.textContent = `⚔${d.armies}`;
          wrap.appendChild(s);
        }
        if (d.heroes) {
          const s = document.createElement('span');
          s.style.cssText = 'background:#f39c12;color:#fff;font:bold 9px system-ui;padding:1px 4px;border-radius:3px';
          s.textContent = `★${d.heroes}`;
          wrap.appendChild(s);
        }
        return wrap;
      })
      .htmlLat(d => d.lat)
      .htmlLng(d => d.lng)
      .htmlAltitude(0.05);

    // Keep globe sized to container
    this._ro = new ResizeObserver(() => {
      this._globe
        .width(container.clientWidth)
        .height(container.clientHeight);
    });
    this._ro.observe(container);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  render(world) {
    this._world         = world;
    this._regById       = {};
    this._factionColors = {};
    for (const r of (world.regions  ?? [])) this._regById[r.id] = r;
    for (const f of (world.factions ?? [])) {
      this._factionColors[f.id] = FACTION_COLORS[f.type] ?? COL_LAND_DEF;
    }

    if (!this._seeds) {
      const { seeds, geoKeys, geoCells, adjacency } = _buildGeo(world.regions ?? []);
      this._seeds     = seeds;
      this._geoKeys   = geoKeys;
      this._geoCells  = geoCells;
      this._adjacency = adjacency;

      // Build GeoJSON features once — geometry never changes
      this._features = geoKeys
        .filter(key => geoCells[key])
        .map(key => {
          const region = seeds.get(key);
          const ring   = geoCells[key];
          // GeoJSON Polygon rings must be closed (first === last)
          const coords = [...ring, ring[0]];
          return {
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [coords] },
            properties: { key, id: region.id, name: region.name },
          };
        });

      // One label per land region
      this._globe.labelsData(
        geoKeys.map(key => {
          const r = seeds.get(key);
          return { lat: r.lat, lng: r.lon, name: r.name };
        }),
      );
    }

    // Sync current game-state into feature properties
    for (const f of this._features) {
      const r = this._regById[f.properties.id];
      if (r) {
        f.properties.faction_influence = r.faction_influence ?? {};
        f.properties.population        = r.population ?? 0;
        f.properties.unrest            = r.unrest      ?? 0;
        f.properties.prosperity        = r.prosperity  ?? 0;
      }
    }
    this._globe.polygonsData(this._features);
    this._updateBadges();
  }

  /** Returns full region IDs adjacent to regionId (from Delaunay triangulation). */
  getAdjacentIds(regionId) {
    return this._adjacency?.get(regionId) ?? [];
  }

  deselect() {
    this._selected = null;
    this._refresh();
  }

  setView(mode) {
    if (!['political','population','unrest','prosperity'].includes(mode)) return;
    this._view = mode;
    this._refresh();
  }

  /** Select a region by game ID and fly the camera to it. */
  selectById(regionId) {
    const region = this._regById[regionId];
    if (!region) return;
    this._selected = regionId;
    this._refresh();
    this.onSelect(region);
    this._globe.pointOfView({ lat: region.lat, lng: region.lon, altitude: 1.5 }, 800);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /** Trigger globe.gl to re-evaluate colour and altitude accessors. */
  _refresh() {
    this._globe
      .polygonCapColor(d => this._capColor(d))
      .polygonStrokeColor(d => this._strokeColor(d))
      .polygonAltitude(d => d.properties?.id === this._selected ? 0.012 : 0.001);
  }

  _capColor(d) {
    const p     = d.properties;
    const isSel = p.id === this._selected;
    const isHov = p.id === this._hovered;
    const alpha = isSel || isHov ? 0.95 : 0.72;

    switch (this._view) {
      case 'population': {
        const pop = p.population ?? 0;
        return _withAlpha(
          heatColor(Math.log10(Math.max(pop, 1)), 0, Math.log10(1400), '#1a3a5c', '#00d4ff'),
          alpha,
        );
      }
      case 'unrest':
        return _withAlpha(
          threeStopColor(p.unrest ?? 0, 0, 40, 80, '#27ae60', '#e67e22', '#c0392b'),
          alpha,
        );
      case 'prosperity':
        return _withAlpha(
          threeStopColor(p.prosperity ?? 0, 0, 50, 100, '#c0392b', '#e67e22', '#27ae60'),
          alpha,
        );
      default: { // political
        const fid  = dominantFaction({ faction_influence: p.faction_influence ?? {} });
        const base = this._factionColors[fid] ?? COL_LAND_DEF;
        return _withAlpha(base, alpha);
      }
    }
  }

  _strokeColor(d) {
    const id = d.properties?.id;
    if (id === this._selected) return COL_BORDER_SEL;
    if (id === this._hovered)  return COL_BORDER_HOV;
    return COL_BORDER;
  }

  _tooltip(d) {
    const r = this._regById[d.properties?.id];
    if (!r) return d.properties?.name ?? '';
    const pop = (r.population ?? 0) >= 1000
      ? `${((r.population) / 1000).toFixed(1)}B`
      : `${r.population ?? 0}M`;
    return `
      <div style="font:12px system-ui;color:#d4d4e8;
                  background:rgba(10,10,20,0.92);
                  padding:6px 10px;border-radius:4px;
                  border:1px solid #2e2e42;white-space:nowrap">
        <b>${r.name ?? r.id}</b><br>
        Pop: ${pop} · Unrest: ${r.unrest ?? 0}%${r.prosperity != null ? ` · Pros: ${r.prosperity}%` : ''}
      </div>`;
  }

  _updateBadges() {
    const counts = {};
    for (const a of (this._world?.armies ?? [])) {
      counts[a.region_id] ??= { armies: 0, heroes: 0 };
      counts[a.region_id].armies++;
    }
    for (const h of (this._world?.heroes ?? [])) {
      counts[h.region_id] ??= { armies: 0, heroes: 0 };
      counts[h.region_id].heroes++;
    }
    const badges = Object.entries(counts).flatMap(([id, c]) => {
      const r = this._regById[id];
      return r?.lat != null ? [{ lat: r.lat, lng: r.lon, ...c }] : [];
    });
    this._globe.htmlElementsData(badges);
  }
}
