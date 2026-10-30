/* Property Price Map — multi-city prototype.
 *
 * Everything city-specific is read from data/<city>/ (built by tools/ingest.py from the
 * city's CSV files): manifest.json, levels/*.geojson, areas.json, points.json,
 * societies.json, places.json and heights/.
 *
 * Rates are stored in Rs per sq ft (Rs per sq ft per month for rent) and converted to the
 * chosen unit only for display.
 */
(() => {
  'use strict';

  // ---------- Constants ----------
  const STYLES = {
    light: 'https://tiles.openfreemap.org/styles/positron',
    dark: 'https://tiles.openfreemap.org/styles/dark',
  };
  const PALETTE = ['#3060a8', '#3b82c4', '#4ea3cc', '#6fc0c4', '#9fd3b0',
    '#d9dd8f', '#f4c36a', '#f09a52', '#e06c42', '#c23f36'];
  const THEME_COLORS = {
    light: { low: '#c9ccd1', bldg: '#e6e5df', line: 'rgba(255,255,255,0.95)', ink: '#16191d', accent: '#2458d3', halo: 'rgba(255,255,255,0.92)', text: '#2a2f36' },
    dark: { low: '#3d424a', bldg: '#24272c', line: 'rgba(10,10,10,0.85)', ink: '#eceef1', accent: '#7aa2ff', halo: 'rgba(12,12,12,0.9)', text: '#dfe3e8' },
  };
  const UNITS = { yd: { f: 9, label: 'sq yd' }, ft: { f: 1, label: 'sq ft' }, m: { f: 10.7639, label: 'sq m' } };
  const SOURCE_COLORS = ['#6b7cff', '#17a673', '#e0912f', '#c2569b', '#3aa3c8', '#8a6d3b', '#7b8794', '#d14b4b'];
  const PIN_LAYERS = ['clusters', 'cluster-count', 'pt', 'pt-label'];

  const $ = (id) => document.getElementById(id);
  const isMobile = () => window.matchMedia('(max-width: 820px)').matches;
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };

  // ---------- Which city ----------
  function requestedCity() {
    const seg = location.pathname.split('/').filter(Boolean)[0];
    const q = new URLSearchParams(location.search).get('city');
    return (q || seg || store.get('bpm-city') || 'bengaluru').toLowerCase();
  }
  const cityHref = (id) => (isLocal ? `/?city=${id}` : `/${id}`);

  // ---------- State ----------
  const S = {
    type: 0, deal: 0, sizeMin: 0, sizeMax: 0, src: [], bhk: new Set(),
    unit: 'yd', is3d: true, theme: initialTheme(),
    layers: { zones: true, pins: true, buildings: true },
    sel: null, hover: null, searchHl: null,
  };
  let M = null;            // manifest
  let CITY = '';
  let POLY = [];           // polygon level configs, top to bottom
  let PT = null;           // point level config (areas)
  let LEAF = null;         // most detailed polygon level (colour scale)
  const A = {};            // areas per level key; 'soc' for societies
  const rowsBy = {};       // all rows per area per level
  const stats = {};        // stats for current filters
  const confident = {};    // sorted confident medians per level
  let rows = [];
  let pts = null;          // raw points.json (sources, bhk, urls)
  let places = { landmarks: [], colonies: [] };
  let cities = [];
  let thresholds = [];
  let latestDate = '';
  let grid = null;
  let assigned = new Map();
  let ready = false;

  function initialTheme() {
    const saved = store.get('bpm-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = S.theme;

  // ---------- Formatting ----------
  const nf = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  const trim = (x, d) => x.toFixed(d).replace(/\.0+$/, '').replace(/(\.\d*?[1-9])0+$/, '$1');
  const inr = (v) => '₹' + nf.format(Math.round(v));
  function inrShort(v) {
    // Thresholds sit just below each step so 99,800 reads "₹1 L", not "₹100K".
    if (v >= 0.995e7) return '₹' + trim(v / 1e7, v >= 1e8 ? 1 : 2) + ' Cr';
    if (v >= 99500) return '₹' + trim(v / 1e5, v >= 1e6 ? 1 : 2) + ' L';
    if (v >= 999.5) return '₹' + trim(v / 1e3, v >= 1e4 ? 0 : 1) + 'K';
    return '₹' + trim(v, v < 100 ? 1 : 0);
  }
  const conv = (rate) => rate * UNITS[S.unit].f;
  const unitLabel = () => UNITS[S.unit].label;
  const perUnit = () => '/' + unitLabel() + (S.deal ? '/mo' : '');
  const sizeIn = (sqft) => sqft / UNITS[S.unit].f;
  const sizeText = (sqft) => (sqft > 0 ? nf.format(Math.round(sizeIn(sqft))) + ' ' + unitLabel() : 'size n/a');
  const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const tc = () => THEME_COLORS[S.theme];
  const curType = () => M.types[S.type];
  const typeWord = (t = curType()) => t.name.toLowerCase();
  const typeOfRow = (r) => M.types.find((t) => t.index === r.t);
  const plural = (n, word, many = word + 's') => `${nf.format(n)} ${n === 1 ? word : many}`;

  // ---------- Stats ----------
  function quant(a, q) {
    if (!a.length) return null;
    const pos = (a.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }
  function bucket(v) {
    let b = 0;
    for (const t of thresholds) if (v >= t) b++;
    return b;
  }
  function passes(r) {
    const t = curType();
    if (r.t !== t.index || r.d !== S.deal || !S.src[r.src]) return false;
    if (r.size > 0 && (r.size < S.sizeMin || r.size > S.sizeMax)) return false;
    if (S.bhk.size && !t.land && !S.bhk.has(r.bhk)) return false;
    return true;
  }

  // With societies, an area's median is the median of its societies' medians and
  // confidence counts societies, so one big project can't dominate or fake coverage.
  function summarize(list) {
    const a = list.map((r) => r.rate).sort((x, y) => x - y);
    const n = a.length;
    let latest = '';
    const src = new Array(pts.sources.length).fill(0);
    for (const r of list) { if (r.date > latest) latest = r.date; src[r.src]++; }
    let median = quant(a, 0.5), groups = n;
    if (M.societies && n) {
      const by = new Map();
      list.forEach((r) => { const k = r.soc >= 0 ? 's' + r.soc : 'r' + r.idx; if (!by.has(k)) by.set(k, []); by.get(k).push(r.rate); });
      const meds = [...by.values()].map((v) => quant(v.sort((x, y) => x - y), 0.5)).sort((x, y) => x - y);
      median = quant(meds, 0.5);
      groups = meds.length;
    }
    return {
      n, groups, rows: list, sorted: a, latest, src, median,
      min: a[0], max: a[n - 1], p25: quant(a, 0.25), p75: quant(a, 0.75),
      low: M.societies ? groups < 3 : n < 5,
    };
  }
  const lowText = () => (M.societies ? 'fewer than 3 societies' : 'fewer than 5 data points');

  function compute() {
    latestDate = '';
    const keys = Object.keys(A);
    const per = {};
    keys.forEach((k) => { per[k] = A[k].map(() => []); });
    const filtered = [];
    for (const r of rows) {
      if (!passes(r)) continue;
      filtered.push(r);
      for (const k of keys) { const i = k === 'soc' ? r.soc : r.lv[k]; if (i >= 0) per[k][i].push(r); }
      if (r.date > latestDate) latestDate = r.date;
    }
    keys.forEach((k) => {
      stats[k] = per[k].map(summarize);
      confident[k] = stats[k].filter((s) => !s.low && s.n).map((s) => s.median).sort((a, b) => a - b);
    });
    // One colour scale for every level, set by the most detailed polygon level
    // (or by societies when that level has too few confident areas).
    const base = confident[LEAF.key].length >= 8 ? confident[LEAF.key] : (confident.soc && confident.soc.length ? confident.soc : confident[LEAF.key]);
    thresholds = base.length ? [1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => quant(base, k / 10)) : [];
    return filtered;
  }
  const colorOf = (s) => (!s || s.low || !s.n ? tc().low : PALETTE[bucket(s.median)]);

  // ---------- Geometry ----------
  const polysOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
  function bboxOf(g) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of polysOf(g)) for (const [x, y] of p[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0, y0, x1, y1];
  }
  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const inGeom = (x, y, g) => polysOf(g).some((p) => inRing(x, y, p[0]) && !p.slice(1).some((h) => inRing(x, y, h)));
  function buildGrid() {
    const cell = 0.01;
    const g = { cell, x0: M.bbox[0], y0: M.bbox[1], cells: new Map() };
    A[LEAF.key].forEach((w, i) => {
      const [x0, y0, x1, y1] = w.bbox;
      for (let cx = Math.floor((x0 - g.x0) / cell); cx <= Math.floor((x1 - g.x0) / cell); cx++) {
        for (let cy = Math.floor((y0 - g.y0) / cell); cy <= Math.floor((y1 - g.y0) / cell); cy++) {
          const k = cx + ',' + cy;
          if (!g.cells.has(k)) g.cells.set(k, []);
          g.cells.get(k).push(i);
        }
      }
    });
    return g;
  }
  function areaAt(key, lon, lat) {
    if (key === LEAF.key) {
      const cand = grid.cells.get(Math.floor((lon - grid.x0) / grid.cell) + ',' + Math.floor((lat - grid.y0) / grid.cell));
      if (!cand) return -1;
      for (const i of cand) if (inGeom(lon, lat, A[key][i].geometry)) return i;
      return -1;
    }
    for (let i = 0; i < A[key].length; i++) {
      const [x0, y0, x1, y1] = A[key][i].bbox;
      if (lon >= x0 && lon <= x1 && lat >= y0 && lat <= y1 && inGeom(lon, lat, A[key][i].geometry)) return i;
    }
    return -1;
  }

  // Which drawn boundary contains this point? Most detailed level first.
  function boundaryGeomAt(lon, lat) {
    for (let i = POLY.length - 1; i >= 0; i--) {
      const id = areaAt(POLY[i].key, lon, lat);
      if (id >= 0) return A[POLY[i].key][id].geometry;
    }
    return null;
  }
  function applySearchBoundary() {
    if (!map || !map.getSource('search-hl')) return;
    map.getSource('search-hl').setData(S.searchHl
      ? { type: 'Feature', geometry: S.searchHl, properties: {} }
      : { type: 'FeatureCollection', features: [] });
  }
  function setSearchBoundary(geom) {
    S.searchHl = geom || null;
    applySearchBoundary();
  }
  function clearSearchBoundary() {
    if (S.searchHl) setSearchBoundary(null);
  }
  function kmBetween(lon1, lat1, lon2, lat2) {
    const dx = (lon2 - lon1) * 111.32 * Math.cos((lat1 * Math.PI) / 180), dy = (lat2 - lat1) * 110.57;
    return Math.hypot(dx, dy);
  }
  function nearest(list, lon, lat, maxKm, ok = () => true) {
    let best = -1, bd = maxKm;
    list.forEach((l, i) => {
      if (Math.abs(l.lat - lat) > 0.025 || Math.abs(l.lon - lon) > 0.025 || !ok(i)) return;
      const d = kmBetween(lon, lat, l.lon, l.lat);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  // Many societies share a locality centroid. Fan the duplicates on a golden-angle spiral
  // for display only, so each pin can be clicked; s.lon/s.lat stay exact for search and fly-to.
  function spreadSocietyPins() {
    if (!M.societies || !M.pinSpread) return;
    A.soc.forEach((s) => { s.px = s.lon; s.py = s.lat; });
    const groups = new Map();
    A.soc.forEach((s, i) => {
      const k = s.lon + ',' + s.lat;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    });
    groups.forEach((ids) => {
      ids.forEach((id, k) => {
        if (!k) return;
        const s = A.soc[id];
        const rKm = Math.min(0.3, 0.03 * Math.sqrt(k));
        const a = k * 2.399963229728653;
        s.px = s.lon + (rKm * Math.cos(a)) / (111.32 * Math.cos((s.lat * Math.PI) / 180));
        s.py = s.lat + (rKm * Math.sin(a)) / 110.57;
      });
    });
  }
  const switchZoom = (i) => POLY[i].from;
  function levelAtZoom(z) {
    let k = 0;
    POLY.forEach((lv, i) => { if (z >= switchZoom(i)) k = i; });
    return POLY[k].key;
  }

  // ---------- Map ----------
  let map = null;
  let tip = null;
  let ptPopup = null;
  const firstSymbolId = () => (map.getStyle().layers.find((x) => x.type === 'symbol') || {}).id;

  function areaColorExpr() {
    return ['case',
      ['boolean', ['feature-state', 'low'], true], tc().low,
      ['match', ['coalesce', ['feature-state', 'b'], -1],
        0, PALETTE[0], 1, PALETTE[1], 2, PALETTE[2], 3, PALETTE[3], 4, PALETTE[4],
        5, PALETTE[5], 6, PALETTE[6], 7, PALETTE[7], 8, PALETTE[8], 9, PALETTE[9], tc().low]];
  }
  // Zoom bands: each polygon level fades in around its "from" zoom and out around the next one's.
  function band(i) {
    const fin = i > 0 ? [switchZoom(i) - 0.25, switchZoom(i) + 0.05] : null;
    const fout = i < POLY.length - 1 ? [switchZoom(i + 1) - 0.25, switchZoom(i + 1) + 0.2] : null;
    return { fin, fout, min: fin ? fin[0] : 0, max: fout ? fout[1] : 24 };
  }
  function fade(i, v) {
    const { fin, fout } = band(i);
    const stops = [];
    if (fin) stops.push(fin[0], 0, fin[1], v);
    if (fout) stops.push(fout[0], v, fout[1], 0);
    return stops.length ? ['interpolate', ['linear'], ['zoom'], ...stops] : v;
  }
  function fillOpacity(i) {
    const hov = (a, b) => ['case', ['boolean', ['feature-state', 'hover'], false], a, b];
    if (i < POLY.length - 1) return fade(i, 0); // replaced below; kept for type
    const s = switchZoom(i);
    const B = S.layers.buildings;
    const stops = i > 0 ? [s - 0.15, 0, s + 0.15, hov(0.78, 0.6)] : [s, hov(0.78, 0.6)];
    return ['interpolate', ['linear'], ['zoom'], ...stops, 13, hov(0.55, 0.4),
      14.2, B ? hov(0.14, 0.04) : hov(0.38, 0.24), 15, B ? hov(0.12, 0.03) : hov(0.3, 0.16)];
  }
  function upperFillOpacity(i) {
    const hov = (a, b) => ['case', ['boolean', ['feature-state', 'hover'], false], a, b];
    const { fin, fout } = band(i);
    const stops = [];
    if (fin) stops.push(fin[0], 0, fin[1], hov(0.75, 0.6));
    if (fout) stops.push(fout[0], hov(0.75, 0.6), fout[1], 0);
    return ['interpolate', ['linear'], ['zoom'], ...stops];
  }
  const fillOpacityFor = (i) => (i < POLY.length - 1 ? upperFillOpacity(i) : fillOpacity(i));
  const lifted = (base, hoverLift, selLift) => ['+', base, ['case',
    ['boolean', ['feature-state', 'sel'], false], selLift,
    ['boolean', ['feature-state', 'hover'], false], hoverLift, 0]];
  const labelPaint = () => ({ 'text-color': tc().text, 'text-halo-color': tc().halo, 'text-halo-width': 1.7 });

  function applyAtmosphere() {
    const dark = S.theme === 'dark';
    try {
      map.setSky({
        'sky-color': dark ? '#0d1424' : '#bcd7f0', 'horizon-color': dark ? '#1c2535' : '#eef1ee',
        'fog-color': dark ? '#0c0c0c' : '#f2f3f0', 'sky-horizon-blend': 0.7, 'horizon-fog-blend': 0.8,
        'fog-ground-blend': 0.55, 'atmosphere-blend': 0,
      });
    } catch (e) { /* older renderer: skip the sky */ }
    map.setLight({ anchor: 'viewport', color: '#ffffff', intensity: dark ? 0.32 : 0.45, position: [1.5, 210, 32] });
  }

  function addLayers() {
    const before = firstSymbolId();
    assigned = new Map();
    applyAtmosphere();

    POLY.forEach((lv) => {
      map.addSource(lv.key, { type: 'geojson', data: { type: 'FeatureCollection', features: A[lv.key].map((a) => a.feature) }, promoteId: 'id' });
      map.addSource(lv.key + '-labels', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    });
    map.addSource('areas', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('pts', {
      type: 'geojson', data: { type: 'FeatureCollection', features: [] },
      cluster: true, clusterMaxZoom: 15, clusterRadius: 46, clusterProperties: { sum: ['+', ['get', 'r']] },
    });

    POLY.forEach((lv, i) => {
      const b = band(i);
      map.addLayer({ id: lv.key + '-fill', type: 'fill', source: lv.key, minzoom: b.min, maxzoom: b.max,
        paint: { 'fill-color': areaColorExpr(), 'fill-opacity': fillOpacityFor(i) } }, before);
    });
    POLY.forEach((lv, i) => {
      const b = band(i);
      const last = i === POLY.length - 1;
      map.addLayer({ id: lv.key + '-line', type: 'line', source: lv.key, minzoom: b.min, maxzoom: b.max,
        paint: {
          'line-color': tc().line,
          'line-width': last ? ['interpolate', ['linear'], ['zoom'], 11, 0.6, 13, 1.2, 16, 2] : i === 0 ? 2.2 : 1.6,
          'line-opacity': fade(i, 0.9),
        } }, before);
    });

    // 3D blocks per level; the most detailed level's blocks sink as buildings rise.
    const h = ['coalesce', ['feature-state', 'h'], 0];
    POLY.forEach((lv, i) => {
      const b = band(i);
      const last = i === POLY.length - 1;
      const s = switchZoom(i);
      const height = last
        ? ['interpolate', ['linear'], ['zoom'], Math.max(s, 10), lifted(h, 160, 280), Math.max(s, 10) + 1.4, ['*', 0.3, lifted(h, 160, 280)], Math.max(s, 10) + 2.2, 0]
        : lifted(h, i === 0 ? 260 : 220, i === 0 ? 420 : 360);
      map.addLayer({ id: lv.key + '-3d', type: 'fill-extrusion', source: lv.key, minzoom: b.min, maxzoom: last ? Math.max(s, 10) + 2.3 : b.max,
        paint: { 'fill-extrusion-color': areaColorExpr(), 'fill-extrusion-height': height, 'fill-extrusion-opacity': fade(i, 0.93), 'fill-extrusion-vertical-gradient': true } });
    });

    if (map.getLayer('building')) map.setLayoutProperty('building', 'visibility', 'none');
    map.addLayer({ id: 'bldg', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13,
      filter: ['!=', ['get', 'hide_3d'], true],
      paint: {
        'fill-extrusion-color': bldgColorExpr(), 'fill-extrusion-height': bldgHeight(), 'fill-extrusion-base': bldgBase(),
        'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 13.6, 0.94],
      } });

    POLY.forEach((lv, i) => {
      const b = band(i);
      map.addLayer({ id: lv.key + '-hl', type: 'line', source: lv.key, minzoom: b.min, maxzoom: b.max,
        paint: {
          'line-color': ['case', ['boolean', ['feature-state', 'sel'], false], tc().accent, tc().ink],
          'line-width': ['case', ['boolean', ['feature-state', 'sel'], false], 3, ['boolean', ['feature-state', 'hover'], false], 2, 0],
        } });
    });

    // Search result boundary, drawn above fills and 3D blocks so it stays visible.
    map.addSource('search-hl', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'search-hl-halo', type: 'line', source: 'search-hl',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 7.5, 'line-opacity': 0.9, 'line-blur': 0.6 } });
    map.addLayer({ id: 'search-hl-line', type: 'line', source: 'search-hl',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': tc().accent, 'line-width': 3.5, 'line-opacity': 0.98 } });
    applySearchBoundary();

    const fmt = (a, b) => ['format', ['get', 'name'], { 'font-scale': a }, '\n', {}, ['get', 'price'], { 'font-scale': b }];
    POLY.forEach((lv, i) => {
      const last = i === POLY.length - 1;
      const b = band(i);
      if (last) {
        const s = switchZoom(i);
        map.addLayer({ id: lv.key + '-label', type: 'symbol', source: lv.key + '-labels', minzoom: s + 0.7, maxzoom: PT ? PT.from + 0.2 : 15,
          layout: { 'text-field': fmt(0.92, 1.08), 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-max-width': 9, 'text-padding': 6 },
          paint: labelPaint() });
      } else {
        const op = [];
        if (b.fin) op.push(b.fin[0] + 0.15, 0, b.fin[1] + 0.1, 1);
        if (b.fout) op.push(b.fout[0], 1, b.fout[0] + 0.25, 0);
        map.addLayer({ id: lv.key + '-label', type: 'symbol', source: lv.key + '-labels', minzoom: b.min, maxzoom: b.max,
          layout: { 'text-field': fmt(1, 1.12), 'text-font': ['Noto Sans Regular'], 'text-size': i === 0 ? 14 : 13, 'text-max-width': 10, 'text-allow-overlap': true },
          paint: { ...labelPaint(), 'text-opacity': ['interpolate', ['linear'], ['zoom'], ...op] } });
      }
    });

    if (PT) {
      const from = PT.from, to = PT.to;
      map.addLayer({ id: 'area-dot', type: 'circle', source: 'areas', minzoom: from, maxzoom: to,
        paint: {
          'circle-color': ['get', 'c'], 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 6, 15, 8],
          'circle-stroke-width': 2.5, 'circle-stroke-color': '#ffffff',
          'circle-opacity': ['interpolate', ['linear'], ['zoom'], from, 0, from + 0.3, 1, to - 0.4, 1, to, 0],
          'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], from, 0, from + 0.3, 1, to - 0.4, 1, to, 0],
        } });
      map.addLayer({ id: 'area-sel', type: 'circle', source: 'areas', minzoom: from, maxzoom: to, filter: ['==', ['get', 'id'], -1],
        paint: { 'circle-color': 'rgba(0,0,0,0)', 'circle-radius': 13, 'circle-stroke-width': 3, 'circle-stroke-color': tc().accent } });
      map.addLayer({ id: 'area-label', type: 'symbol', source: 'areas', minzoom: from, maxzoom: to,
        layout: {
          'text-field': fmt(0.95, 1.1), 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-anchor': 'top',
          'text-offset': [0, 0.9], 'text-max-width': 9, 'text-padding': 4,
        },
        paint: labelPaint() });
    }

    const pinFrom = M.pinsFrom;
    map.addLayer({ id: 'clusters', type: 'circle', source: 'pts', minzoom: pinFrom, filter: ['has', 'point_count'],
      paint: {
        'circle-color': clusterColorExpr(), 'circle-radius': ['step', ['get', 'point_count'], 13, 10, 17, 30, 21, 80, 25],
        'circle-stroke-width': 2.5, 'circle-stroke-color': '#ffffff', 'circle-opacity': 0.95,
      } });
    map.addLayer({ id: 'cluster-count', type: 'symbol', source: 'pts', minzoom: pinFrom, filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-allow-overlap': true },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.25)', 'text-halo-width': 1 } });
    map.addLayer({ id: 'pt', type: 'circle', source: 'pts', minzoom: pinFrom, filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': ['get', 'c'],
        'circle-radius': M.societies
          ? ['interpolate', ['linear'], ['zoom'], 14, ['min', 9, ['+', 5, ['*', 0.6, ['get', 'n']]]], 17, ['min', 13, ['+', 7, ['*', 0.8, ['get', 'n']]]]]
          : ['interpolate', ['linear'], ['zoom'], 14, 5, 17, 8],
        'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff',
        'circle-opacity': ['case', ['==', ['get', 'p'], 0], 0.7, 1],
      } });
    map.addLayer({ id: 'pt-label', type: 'symbol', source: 'pts', minzoom: pinFrom + 0.8, filter: ['!', ['has', 'point_count']],
      layout: {
        'text-field': M.societies ? ['format', ['get', 'name'], { 'font-scale': 0.88 }, '\n', {}, ['get', 'l'], { 'font-scale': 1 }] : ['get', 'l'],
        'text-font': ['Noto Sans Regular'], 'text-size': 11.5, 'text-offset': [0, -1.25], 'text-anchor': 'bottom',
        'text-padding': 2, 'text-max-width': 10,
      },
      paint: labelPaint() });

    applyAll();
  }

  function bldgHeight() {
    if (!S.is3d) return 0;
    return ['interpolate', ['linear'], ['zoom'], 13, 0, 14.2,
      ['coalesce', ['get', 'render_height'], ['feature-state', 'hh'],
        ['+', 6, ['*', 3.2, ['%', ['to-number', ['id'], 0], 5]]]]];
  }
  function bldgBase() {
    if (!S.is3d) return 0;
    return ['interpolate', ['linear'], ['zoom'], 13, 0, 14.2, ['coalesce', ['get', 'render_min_height'], 0]];
  }
  function clusterColorExpr() {
    if (!thresholds.length) return PALETTE[4];
    const expr = ['step', ['/', ['get', 'sum'], ['get', 'point_count']], PALETTE[0]];
    thresholds.forEach((t, i) => expr.push(t, PALETTE[i + 1]));
    return expr;
  }
  function mix(hex, toward, t) {
    const a = parseInt(hex.slice(1), 16), b = parseInt(toward.slice(1), 16);
    const ch = (v, sh) => (v >> sh) & 255;
    const m = (sh) => Math.round(ch(a, sh) + (ch(b, sh) - ch(a, sh)) * t);
    return '#' + ((1 << 24) | (m(16) << 16) | (m(8) << 8) | m(0)).toString(16).slice(1);
  }
  const bldgPalette = () => PALETTE.map((c) => (S.theme === 'dark' ? mix(c, '#1a1d22', 0.28) : mix(c, '#f4f2ec', 0.38)));
  function bldgColorExpr() {
    const ramp = ['interpolate', ['linear'], ['feature-state', 'v']];
    bldgPalette().forEach((c, i) => ramp.push(i, c));
    return ['case', ['<', ['coalesce', ['feature-state', 'v'], -1], 0], tc().bldg, ramp];
  }
  const priceLabel = (s) => (s.n === 0 ? 'no data' : s.low ? 'few data points' : inrShort(conv(s.median)));

  // ---------- Apply filters to the map ----------
  function applyAll() {
    if (!map.getSource(LEAF.key)) return;
    const filtered = compute();
    POLY.forEach((lv, i) => {
      const H = i === 0 ? [420, 260] : i === POLY.length - 1 ? [160, 230] : [320, 230];
      A[lv.key].forEach((a, j) => {
        const s = stats[lv.key][j];
        map.setFeatureState({ source: lv.key, id: j }, { low: s.low || !s.n, b: s.low || !s.n ? -1 : bucket(s.median), h: s.low || !s.n ? 30 : H[0] + bucket(s.median) * H[1] });
      });
      map.getSource(lv.key + '-labels').setData({
        type: 'FeatureCollection',
        features: A[lv.key].map((a, j) => ({
          type: 'Feature', geometry: { type: 'Point', coordinates: a.center },
          properties: { name: a.props.short || a.name, price: priceLabel(stats[lv.key][j]) },
        })),
      });
    });

    if (PT) {
      map.getSource('areas').setData({
        type: 'FeatureCollection',
        features: A.area.map((l, i) => ({
          type: 'Feature', geometry: { type: 'Point', coordinates: [l.lon, l.lat] },
          properties: { id: i, name: l.name, price: priceLabel(stats.area[i]), c: colorOf(stats.area[i]) },
        })).filter((f, i) => stats.area[i].n > 0),
      });
    }

    let pinFeatures;
    if (M.societies) {
      pinFeatures = A.soc.map((s, i) => {
        const st = stats.soc[i];
        if (!st.n) return null;
        return { type: 'Feature', geometry: { type: 'Point', coordinates: [s.px != null ? s.px : s.lon, s.py != null ? s.py : s.lat] },
          properties: { kind: 'soc', i, r: st.median, n: st.n, p: s.p || 0, name: s.name, c: thresholds.length ? PALETTE[bucket(st.median)] : PALETTE[4], l: inrShort(conv(st.median)) } };
      }).filter(Boolean);
    } else {
      pinFeatures = filtered.map((r) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
        properties: { kind: 'row', i: r.idx, r: r.rate, n: 1, c: thresholds.length ? PALETTE[bucket(r.rate)] : PALETTE[4], l: inrShort(conv(r.rate)) },
      }));
    }
    map.getSource('pts').setData({ type: 'FeatureCollection', features: pinFeatures });
    map.setPaintProperty('clusters', 'circle-color', clusterColorExpr());
    buildSurface(filtered);
    scheduleAssign();
    POLY.forEach((lv, i) => map.setPaintProperty(lv.key + '-fill', 'fill-opacity', fillOpacityFor(i)));

    applyVisibility();
    renderLegend();
    restoreStates();
    if (S.sel) renderPanel();
    updateCrumbs();
  }

  function restoreStates() {
    if (S.hover && POLY.some((l) => l.key === S.hover.level)) map.setFeatureState({ source: S.hover.level, id: S.hover.id }, { hover: true });
    if (S.sel && POLY.some((l) => l.key === S.sel.level)) map.setFeatureState({ source: S.sel.level, id: S.sel.id }, { sel: true });
    if (PT) map.setFilter('area-sel', ['==', ['get', 'id'], S.sel && S.sel.level === 'area' ? S.sel.id : -1]);
  }
  function vis(id, on) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
  function applyVisibility() {
    const L = S.layers;
    POLY.forEach((lv) => {
      vis(lv.key + '-fill', L.zones);
      vis(lv.key + '-line', L.zones);
      vis(lv.key + '-hl', L.zones || L.buildings);
      vis(lv.key + '-label', L.zones);
      vis(lv.key + '-3d', L.zones && S.is3d);
    });
    ['area-dot', 'area-label', 'area-sel'].forEach((id) => vis(id, L.zones));
    PIN_LAYERS.forEach((id) => vis(id, L.pins));
    vis('bldg', L.buildings);
    if (map.getLayer('building')) vis('building', !L.buildings);
  }

  // ---------- Local price surface ----------
  // A ~220–350 m grid (city-configurable); each cell blends data points within 1 km
  // (Gaussian weights, in log space). Cells with fewer than SURF_MIN points nearby stay
  // empty and their buildings stay grey.
  let SURF = null;
  const SURF_R = 1.0, SURF_SIGMA = 0.45, SURF_MIN = 4;
  let surf, surfVal, surfN, surfVer = 0;
  function initSurface() {
    const step = M.surfaceStep || 0.002;
    SURF = { west: M.bbox[0], north: M.bbox[3], step, cols: Math.ceil((M.bbox[2] - M.bbox[0]) / step), rows: Math.ceil((M.bbox[3] - M.bbox[1]) / step) };
    surf = new Float32Array(SURF.cols * SURF.rows).fill(-1);
    surfVal = new Float32Array(SURF.cols * SURF.rows);
    surfN = new Uint16Array(SURF.cols * SURF.rows);
  }
  function palettePos(x) {
    const m = confident[LEAF.key].length >= 8 ? confident[LEAF.key] : (confident.soc && confident.soc.length ? confident.soc : confident[LEAF.key]);
    if (!m.length) return -1;
    const stops = [m[0], ...thresholds, m[m.length - 1]];
    if (x <= stops[0]) return 0;
    for (let i = 0; i < stops.length - 1; i++) {
      if (x < stops[i + 1]) return Math.min(9, Math.max(0, i + (x - stops[i]) / Math.max(1e-9, stops[i + 1] - stops[i]) - 0.5));
    }
    return 9;
  }
  function buildSurface(filtered) {
    const bins = new Map();
    for (const r of filtered) {
      const k = Math.floor(r.lon * 100) + ',' + Math.floor(r.lat * 100);
      if (!bins.has(k)) bins.set(k, []);
      bins.get(k).push(r);
    }
    const lat0 = (M.bbox[1] + M.bbox[3]) / 2;
    const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180), ky = 110.57, two = 2 * SURF_SIGMA * SURF_SIGMA;
    for (let row = 0; row < SURF.rows; row++) {
      const lat = SURF.north - (row + 0.5) * SURF.step;
      for (let col = 0; col < SURF.cols; col++) {
        const lon = SURF.west + (col + 0.5) * SURF.step;
        const bx = Math.floor(lon * 100), by = Math.floor(lat * 100);
        let ws = 0, wl = 0, n = 0;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const list = bins.get((bx + dx) + ',' + (by + dy));
            if (!list) continue;
            for (const r of list) {
              const ex = (r.lon - lon) * kx, ey = (r.lat - lat) * ky, d2 = ex * ex + ey * ey;
              if (d2 > SURF_R * SURF_R) continue;
              const w = Math.exp(-d2 / two);
              ws += w; wl += w * r.lr; n++;
            }
          }
        }
        const i = row * SURF.cols + col;
        surfN[i] = Math.min(n, 65535);
        if (n >= SURF_MIN && ws > 0) { const v = Math.exp(wl / ws); surfVal[i] = v; surf[i] = palettePos(v); } else { surfVal[i] = 0; surf[i] = -1; }
      }
    }
    surfVer++;
  }
  function surfCell(lon, lat) {
    const col = Math.floor((lon - SURF.west) / SURF.step), row = Math.floor((SURF.north - lat) / SURF.step);
    if (col < 0 || row < 0 || col >= SURF.cols || row >= SURF.rows) return -1;
    return row * SURF.cols + col;
  }

  // ---------- Real building heights (tiles loaded only where you look) ----------
  const HGT = { meta: null, tiles: new Map(), loading: new Set() };
  async function loadHeightIndex() {
    if (!M.heights) return;
    try { HGT.meta = await fetch(`/data/${CITY}/${M.heights}`).then((r) => r.json()); } catch (e) { HGT.meta = null; }
  }
  function heightTileKey(lon, lat) {
    const m = HGT.meta;
    const col = Math.floor((lon - m.west) / m.step), row = Math.floor((m.north - lat) / m.step);
    if (col < 0 || row < 0 || col >= m.width || row >= m.height) return null;
    return { key: Math.floor(row / m.tile) + '_' + Math.floor(col / m.tile), r: row % m.tile, c: col % m.tile };
  }
  async function loadHeightTile(key) {
    if (HGT.loading.has(key)) return;
    HGT.loading.add(key);
    try {
      const blob = await fetch(`/data/${CITY}/heights/${key}.png`).then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); });
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width; canvas.height = bmp.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const rgba = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      const data = new Uint8Array(bmp.width * bmp.height);
      for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = rgba[j];
      HGT.tiles.set(key, { data, w: bmp.width });
      assigned.forEach((rec) => { if (rec.tile === key) rec.h = false; });
      scheduleAssign();
    } catch (e) {
      HGT.tiles.set(key, null); // missing tile (no buildings there)
    }
  }
  // Returns metres, 0 if no building, or null while the tile is still loading.
  function heightAt(lon, lat) {
    if (!HGT.meta) return 0;
    const t = heightTileKey(lon, lat);
    if (!t || !HGT.meta.tiles.includes(t.key)) return 0;
    const tile = HGT.tiles.get(t.key);
    if (tile === undefined) { loadHeightTile(t.key); return null; }
    if (!tile) return 0;
    return tile.data[t.r * tile.w + t.c];
  }
  function buildingHeight(ring, cx, cy) {
    let h = heightAt(cx, cy);
    if (h === null) return null;
    if (!h) {
      for (let i = 0; i < ring.length; i += Math.max(1, Math.floor(ring.length / 6))) {
        const v = heightAt(ring[i][0], ring[i][1]);
        if (v) h = Math.max(h, v);
      }
    }
    return h >= 3 ? h : 0;
  }

  let assignTimer = null;
  const scheduleAssign = () => { clearTimeout(assignTimer); assignTimer = setTimeout(assignBuildings, 120); };
  function assignBuildings() {
    if (!map.getLayer('bldg') || map.getZoom() < 13) return;
    for (const f of map.querySourceFeatures('openmaptiles', { sourceLayer: 'building' })) {
      if (f.id == null) continue;
      let rec = assigned.get(f.id);
      if (rec && rec.ver === surfVer && (rec.h || !HGT.meta)) continue;
      const g = f.geometry;
      const ring = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null;
      if (!ring || !ring.length) continue;
      if (!rec) {
        let sx = 0, sy = 0;
        for (const [x, y] of ring) { sx += x; sy += y; }
        rec = { cx: sx / ring.length, cy: sy / ring.length, cell: -1, ver: -1, h: false, tile: null };
        rec.cell = surfCell(rec.cx, rec.cy);
        if (HGT.meta) { const t = heightTileKey(rec.cx, rec.cy); rec.tile = t && t.key; }
        assigned.set(f.id, rec);
      }
      const state = {};
      if (rec.ver !== surfVer) { state.v = rec.cell >= 0 ? surf[rec.cell] : -1; rec.ver = surfVer; }
      if (HGT.meta && !rec.h) {
        const h = buildingHeight(ring, rec.cx, rec.cy);
        if (h !== null) { if (h) state.hh = h; rec.h = true; }
      }
      if (Object.keys(state).length) map.setFeatureState({ source: 'openmaptiles', sourceLayer: 'building', id: f.id }, state);
    }
  }

  // ---------- Legend ----------
  function renderLegend() {
    $('legend-title').textContent = `Median ${typeWord()} ${S.deal ? 'rent' : 'price'}`;
    $('legend-unit').textContent = `₹ / ${unitLabel()}${S.deal ? ' / month' : ''}`;
    $('legend-bar').innerHTML = PALETTE.map((c) => `<span style="background:${c}"></span>`).join('');
    const m = confident[LEAF.key].length ? confident[LEAF.key] : (confident.soc || []);
    $('legend-ticks').innerHTML = m.length
      ? `<span>${inrShort(conv(m[0]))}</span><span>${inrShort(conv(quant(m, 0.5)))}</span><span>${inrShort(conv(m[m.length - 1]))}</span>`
      : '<span>No areas have enough data for these filters</span>';
    $('legend-low').textContent = `${lowText().replace(/^f/, 'F')} (low confidence)`;
    const on = pts.sources.filter((_, i) => S.src[i]);
    $('legend-source').innerHTML = `Source: ${M.sample ? 'sample data · ' : ''}${esc(on.length > 2 ? on.length + ' sources' : on.join(', ') || 'none selected')} · latest ${fmtDate(latestDate)} · <button class="link-btn" data-open-about>About the data</button>`;
  }

  // ---------- Breadcrumb ----------
  function updateCrumbs() {
    if (!ready) return;
    const c = map.getCenter(), z = map.getZoom();
    const parts = [`<span class="crumb crumb-root">${esc(M.name)}</span>`];
    const leafId = areaAt(LEAF.key, c.lng, c.lat);
    POLY.forEach((lv, i) => {
      if (i > 0 && z < switchZoom(i)) return;
      let id = lv.key === LEAF.key ? leafId : (leafId >= 0 ? A[LEAF.key][leafId].props.parents[lv.key] : areaAt(lv.key, c.lng, c.lat));
      if (id == null || id < 0) id = areaAt(lv.key, c.lng, c.lat);
      if (id >= 0) parts.push(`<button class="crumb" data-level="${lv.key}" data-id="${id}">${esc(A[lv.key][id].props.short || A[lv.key][id].name)}</button>`);
    });
    if (PT && z >= PT.from) {
      const a = nearest(A.area, c.lng, c.lat, 1.5, (i) => stats.area[i] && stats.area[i].n > 0);
      if (a >= 0) parts.push(`<button class="crumb" data-level="area" data-id="${a}">${esc(A.area[a].name)}</button>`);
    }
    const cur = levelAtZoom(z);
    const ci = POLY.findIndex((l) => l.key === cur);
    let showing, next;
    if (ci < POLY.length - 1) { showing = POLY[ci].plural; next = `zoom in for ${POLY[ci + 1].plural}`; }
    else if (PT && z < PT.from) { showing = LEAF.plural; next = `zoom in for ${PT.plural}`; }
    else if (z < M.pinsFrom) { showing = PT ? PT.plural : LEAF.plural; next = `zoom in for ${M.societies ? 'societies' : 'individual prices'}`; }
    else { showing = M.societies ? 'societies' : 'individual prices'; next = 'click a pin'; }
    $('crumbs').innerHTML = `<div class="crumb-path">${parts.join('<span class="crumb-sep">›</span>')}</div><div class="crumb-level">Showing ${showing} · ${next}</div>`;
  }
  $('crumbs').addEventListener('click', (e) => {
    const b = e.target.closest('button.crumb');
    if (b) openArea(b.dataset.level, +b.dataset.id, { fly: true });
  });

  // ---------- Detail panel ----------
  const levelCfg = (key) => (key === 'soc' ? { key: 'soc', name: 'Society', plural: 'societies' } : key === 'area' ? PT : POLY.find((l) => l.key === key));
  const areaName = (level, id) => {
    const a = A[level][id];
    return level === 'area' || level === 'soc' ? a.name : (a.props.short || a.name);
  };
  function parentsOf(level, id) {
    if (level === 'soc') {
      const s = A.soc[id];
      return s.area >= 0 ? [['area', s.area], ...parentsOf('area', s.area)] : [];
    }
    const p = level === 'area' ? A.area[id].parents : A[level][id].props.parents;
    return POLY.filter((l) => l.key !== level && p && p[l.key] != null && p[l.key] >= 0).map((l) => [l.key, p[l.key]]).reverse();
  }
  function kickerOf(level, id) {
    if (level === 'soc') return `Society${A.soc[id].area >= 0 ? ' · ' + A.area[A.soc[id].area].name : ''}`;
    if (level === 'area') return `${PT.name} · ${M.name}`;
    const a = A[level][id];
    return `${levelCfg(level).name}${a.props.code && a.props.code !== a.name ? ' ' + a.props.code : ''} · ${M.name}`;
  }
  function gvOf(level, id) {
    if (level === 'soc') { const s = A.soc[id]; return s.area >= 0 ? gvOf('area', s.area) : {}; }
    const p = level === 'area' ? A.area[id] : A[level][id].props;
    return { rates: p.gv || {}, date: p.gvDate };
  }
  function childrenOf(level, id) {
    const i = POLY.findIndex((l) => l.key === level);
    if (i >= 0 && i < POLY.length - 1) {
      const next = POLY[i + 1];
      return { level: next.key, ids: A[next.key].map((a, j) => (a.props.parents[level] === id ? j : -1)).filter((j) => j >= 0), title: `${next.plural[0].toUpperCase() + next.plural.slice(1)} in this ${levelCfg(level).name.toLowerCase()}` };
    }
    if (i === POLY.length - 1 && PT) {
      return { level: 'area', ids: A.area.map((a, j) => (a.parents[level] === id ? j : -1)).filter((j) => j >= 0), title: `${PT.plural[0].toUpperCase() + PT.plural.slice(1)} in this ${levelCfg(level).name.toLowerCase()}` };
    }
    if (level === 'area' && M.societies) {
      return { level: 'soc', ids: A.soc.map((s, j) => (s.area === id ? j : -1)).filter((j) => j >= 0), title: 'Societies in this area' };
    }
    return null;
  }

  function setSelState(on) {
    if (!S.sel || !map.getSource(LEAF.key)) return;
    if (S.sel.level === 'area') map.setFilter('area-sel', ['==', ['get', 'id'], on ? S.sel.id : -1]);
    else if (S.sel.level !== 'soc') map.setFeatureState({ source: S.sel.level, id: S.sel.id }, { sel: on });
  }
  function openArea(level, id, opts = {}) {
    if (!ready || id == null || id < 0 || !A[level] || !A[level][id]) return;
    if (!opts.keepSearchHl) clearSearchBoundary();
    setSelState(false);
    S.sel = { level, id };
    setSelState(true);
    $('panel').hidden = false;
    document.body.classList.add('panel-open');
    renderPanel();
    $('panel-body').scrollTop = 0;
    if (opts.fly) flyToArea(level, id);
  }
  function closePanel() {
    setSelState(false);
    S.sel = null;
    clearSearchBoundary();
    $('panel').hidden = true;
    document.body.classList.remove('panel-open');
  }
  const panelOffset = () => (isMobile() ? [0, -Math.round(window.innerHeight * 0.22)] : [-40, 0]);
  function flyToArea(level, id) {
    if (level === 'area' || level === 'soc') {
      const l = A[level][id];
      map.flyTo({ center: [l.lon, l.lat], zoom: level === 'soc' ? 16.2 : Math.max(PT.from + 1.2, 14), pitch: S.is3d ? 58 : 0, offset: panelOffset(), duration: 1500 });
      return;
    }
    const pad = isMobile()
      ? { top: 120, bottom: Math.round(window.innerHeight * 0.55), left: 30, right: 30 }
      : { top: 100, bottom: 90, left: 340, right: 420 };
    const [x0, y0, x1, y1] = A[level][id].bbox;
    map.fitBounds([[x0, y0], [x1, y1]], { padding: pad, maxZoom: levelCfg(level).fit || 14, pitch: S.is3d ? 55 : 0, bearing: S.is3d ? map.getBearing() : 0, duration: 1400 });
  }

  function stripSVG(s, color) {
    const W = 340, H = 54, P = 8;
    const lo = s.min, hi = s.max === s.min ? s.min + 1 : s.max;
    const x = (v) => P + ((v - lo) / (hi - lo)) * (W - 2 * P);
    const step = Math.max(1, Math.floor(s.sorted.length / 220));
    let dots = '';
    s.sorted.forEach((v, i) => {
      if (i % step) return;
      const jitter = ((i * 37) % 11) - 5;
      dots += `<circle cx="${x(v).toFixed(1)}" cy="${(27 + jitter * 1.6).toFixed(1)}" r="3.2" fill="${color}" fill-opacity="${s.n > 120 ? 0.35 : 0.55}"/>`;
    });
    return `<svg class="strip" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <line x1="${P}" x2="${W - P}" y1="27" y2="27" stroke="currentColor" stroke-opacity="0.15"/>
      <rect x="${x(s.p25).toFixed(1)}" y="12" width="${Math.max(2, x(s.p75) - x(s.p25)).toFixed(1)}" height="30" rx="6" fill="currentColor" fill-opacity="0.07" stroke="currentColor" stroke-opacity="0.18"/>
      ${dots}
      <line x1="${x(s.median).toFixed(1)}" x2="${x(s.median).toFixed(1)}" y1="6" y2="48" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
    </svg>`;
  }
  function srcLine(s) {
    const parts = s.src.map((c, i) => (c ? `${c} from ${pts.sources[i]}` : '')).filter(Boolean);
    return `Source: ${M.sample ? 'sample · ' : ''}${esc(parts.length > 2 ? parts.slice(0, 2).join(' · ') + ' · …' : parts.join(' · '))} · latest ${fmtDate(s.latest)}`;
  }
  function filterChips() {
    const t = curType();
    const chips = [`<span class="chip">${esc(t.name)}</span>`, `<span class="chip">${S.deal ? 'Rent' : 'Sale'}</span>`];
    if (t.sizeMax > t.sizeMin) chips.push(`<span class="chip">${nf.format(Math.round(sizeIn(S.sizeMin)))}–${nf.format(Math.round(sizeIn(S.sizeMax)))} ${unitLabel()}</span>`);
    if (S.bhk.size && !t.land) chips.push(`<span class="chip">${[...S.bhk].map((b) => pts.bhk[b]).join(', ')}</span>`);
    const off = S.src.filter((x) => !x).length;
    if (off) chips.push(`<span class="chip">${S.src.length - off} of ${S.src.length} sources</span>`);
    return chips.join('');
  }

  function renderPanel() {
    const { level, id } = S.sel;
    if (level === 'soc') { renderSociety(id); return; }
    const s = stats[level][id];
    const parents = parentsOf(level, id);
    let html = `
      <div class="p-kicker">${esc(kickerOf(level, id))}</div>
      <div class="p-title">${esc(A[level][id].name)}</div>
      ${parents.length ? `<div class="p-parents">${parents.map(([l, i]) => `<button class="parent-chip" data-area="${l}:${i}">${esc(levelCfg(l).name)}: ${esc(areaName(l, i))}</button>`).join('')}</div>` : ''}
      <div class="p-context">${filterChips()}</div>`;

    if (s.n === 0) {
      html += `<div class="p-empty">No data points match these filters here.<br>Try a wider size range, another property type, or more sources.</div>`;
      html += refsHTML(level, id) + childrenHTML(level, id) + otherTypesHTML(level, id) + footHTML(level);
      $('panel-body').innerHTML = html;
      return;
    }
    const color = colorOf(s);
    const sizes = s.rows.map((r) => r.size).filter((v) => v > 0).sort((a, b) => a - b);
    const typicalSize = quant(sizes, 0.5);
    html += `
      <div class="p-hero" style="--hero-color:${color}">
        <div class="p-hero-label">Median ${typeWord()} ${S.deal ? 'rent' : 'price'} ${curType().land ? '(land rate)' : '(built-up rate)'}</div>
        <div class="p-hero-value">${inr(conv(s.median))} <small>${perUnit()}</small></div>
        ${typicalSize ? `<div class="p-hero-sub">≈ ${inrShort(s.median * typicalSize)}${S.deal ? '/month' : ''} for a typical ${sizeText(typicalSize)} ${typeWord()}</div>` : ''}
        <div class="p-hero-src">${srcLine(s)}</div>
      </div>`;
    if (s.low) {
      html += `<div class="p-warn"><span>⚠</span><span>Low confidence: ${M.societies ? plural(s.groups, 'society', 'societies') : plural(s.n, 'data point')} only. Shown in grey on the map instead of a price colour.</span></div>`;
    } else {
      const pool = confident[level];
      const below = pool.filter((m) => m < s.median).length;
      const pct = Math.round((below / Math.max(1, pool.length - 1)) * 100);
      const pl = levelCfg(level).plural;
      html += `
        <div class="p-rank">
          <div class="p-rank-row"><span>${pct >= 50 ? `Pricier than ${pct}% of ${pl}` : `Cheaper than ${100 - pct}% of ${pl}`}</span><span>${pool.length} compared</span></div>
          <div class="p-rank-bar">${PALETTE.map((c) => `<span style="background:${c}"></span>`).join('')}<i class="p-rank-marker" style="left:${Math.min(99, Math.max(1, pct))}%"></i></div>
        </div>`;
    }
    html += `
      <div class="p-section">
        <div class="p-section-title"><span>Price range</span><span>${plural(s.n, 'data point')}</span></div>
        <div style="color:var(--ink)">${stripSVG(s, color)}</div>
        <div class="strip-labels"><span>Min <b>${inrShort(conv(s.min))}</b></span><span>Median <b>${inrShort(conv(s.median))}</b></span><span>Max <b>${inrShort(conv(s.max))}</b></span></div>
      </div>
      <div class="p-section">
        <div class="stats">
          <div class="stat"><div class="stat-label">${M.societies ? 'Societies' : 'Data points'}</div><div class="stat-value">${nf.format(M.societies ? s.groups : s.n)}</div></div>
          <div class="stat"><div class="stat-label">Last updated</div><div class="stat-value">${fmtDate(s.latest)}</div></div>
          <div class="stat"><div class="stat-label">Middle 50%</div><div class="stat-value">${inrShort(conv(s.p25))}–${inrShort(conv(s.p75)).replace('₹', '')}</div></div>
        </div>
      </div>`;
    html += sourcesHTML(s) + guidanceHTML(level, id, s, color) + refsHTML(level, id) + childrenHTML(level, id) + otherTypesHTML(level, id) + recentHTML(s) + footHTML(level);
    $('panel-body').innerHTML = html;
  }

  function sourcesHTML(s) {
    return `
      <div class="p-section">
        <div class="p-section-title"><span>Where these numbers come from</span></div>
        <div class="p-rank-bar" style="height:8px">${s.src.map((c, i) => (c ? `<span style="flex:${c};background:${SOURCE_COLORS[i % 8]}"></span>` : '')).join('')}</div>
        <div class="p-context" style="margin-top:8px">${s.src.map((c, i) => (c ? `<span class="chip"><span class="src-dot inline" style="background:${SOURCE_COLORS[i % 8]}"></span>${esc(pts.sources[i])} · ${c}</span>` : '')).join('')}</div>
      </div>`;
  }
  function guidanceHTML(level, id, s, color) {
    const label = M.guidance.label;
    const gv = gvOf(level, id);
    const g = gv.rates ? gv.rates[curType().id] : null;
    if (S.deal) return '';
    if (!g) return `<div class="p-section"><div class="p-section-title"><span>Market vs ${esc(label.toLowerCase())}</span></div><div class="gv"><div class="gv-note" style="margin:0">No ${esc(label.toLowerCase())} for ${esc(typeWord())}s here yet.</div></div></div>`;
    const gap = (s.median - g) / g;
    const maxv = Math.max(g, s.median);
    return `
      <div class="p-section">
        <div class="p-section-title"><span>Market vs ${esc(label.toLowerCase())}</span></div>
        <div class="gv">
          <div class="gv-row"><span>Market median</span><div class="gv-bar"><span style="width:${(s.median / maxv) * 100}%;background:${color}"></span></div><span class="gv-val">${inrShort(conv(s.median))}</span></div>
          <div class="gv-row"><span>${esc(label)}</span><div class="gv-bar"><span style="width:${(g / maxv) * 100}%;background:var(--muted)"></span></div><span class="gv-val">${inrShort(conv(g))}</span></div>
          <div class="gv-gap"><span>Market is ${gap >= 0 ? 'above' : 'below'} it by</span><strong style="color:${gap >= 0 ? 'var(--good)' : 'var(--warn)'}">${gap >= 0 ? '+' : ''}${Math.round(gap * 100)}%</strong></div>
          <div class="gv-note">${esc(label)}: ${esc(M.guidance.source || '')}${gv.date ? ', ' + fmtDate(gv.date) : ''}${level === 'area' || level === 'soc' ? '' : ', median of its areas'}, converted to ${unitLabel()}. Market figures are mostly asking prices, so the gap may be overstated.</div>
        </div>
      </div>`;
  }
  function refsHTML(level, id) {
    if (level !== 'area' && level !== 'soc') return '';
    const a = level === 'soc' ? (A.soc[id].area >= 0 ? A.area[A.soc[id].area] : null) : A.area[id];
    const refs = (a && a.refs || []).filter((r) => !r.type || r.type === curType().id);
    if (!refs.length || S.deal) return '';
    return `
      <div class="p-section">
        <div class="p-section-title"><span>Other published averages</span></div>
        <div class="children">${refs.slice(0, 8).map((r) => `
          <div class="child-row ref-row" title="${esc(r.note || '')}">
            <span class="child-dot" style="background:var(--muted)"></span>
            <span class="child-name">${esc(r.label)}<small> · ${esc(r.source)}</small></span>
            <span class="child-n">${fmtDate(r.date)}</span>
            <span class="child-v">${inrShort(conv(r.rate))}</span>
          </div>`).join('')}</div>
      </div>`;
  }
  function childrenHTML(level, id) {
    const ch = childrenOf(level, id);
    if (!ch || !ch.ids.length) return '';
    const items = ch.ids.map((i) => ({ i, s: stats[ch.level][i] })).filter((x) => ch.level !== 'soc' || x.s.n > 0)
      .sort((a, b) => (!a.s.n - !b.s.n) || (a.s.low - b.s.low) || ((b.s.median || 0) - (a.s.median || 0)));
    if (!items.length) return '';
    return `
      <div class="p-section">
        <div class="p-section-title"><span>${esc(ch.title)}</span><span>${items.length}</span></div>
        <div class="children">
          ${items.map(({ i, s }) => `
            <button class="child-row" data-area="${ch.level}:${i}">
              <span class="child-dot" style="background:${colorOf(s)}"></span>
              <span class="child-name">${esc(areaName(ch.level, i))}</span>
              <span class="child-n">${s.n} pts</span>
              <span class="child-v">${s.n ? inrShort(conv(s.median)) : '—'}</span>
            </button>`).join('')}
        </div>
      </div>`;
  }
  function otherTypesHTML(level, id) {
    if (M.types.length < 2 && !M.types.some((t) => t.rent)) return '';
    const listAll = level === 'soc' ? rowsBy.soc[id] : rowsBy[level][id];
    const list = listAll.filter((r) => S.src[r.src] && r.d === S.deal);
    const rowsHTML = M.types.map((t, ti) => {
      if (S.deal === 1 && !t.rent) return `<div class="type-row" style="opacity:.55"><div><div class="t-name">${esc(t.name)}</div><div class="t-n">${t.land ? 'Plots are sold, not rented' : 'No rent data yet'}</div></div><span class="t-v">—</span></div>`;
      const v = list.filter((r) => r.t === t.index).map((r) => r.rate).sort((a, b) => a - b);
      const med = quant(v, 0.5);
      return `<button class="type-row${ti === S.type ? ' current' : ''}" data-switch-type="${ti}">
        <div><div class="t-name">${esc(t.name)}${t.land ? ' · land' : ' · built-up'}</div><div class="t-n">${plural(v.length, 'data point')}, all sizes</div></div>
        <span class="t-v">${med == null ? '—' : inrShort(conv(med)) + perUnit()}</span>
      </button>`;
    }).join('');
    return `<div class="p-section"><div class="p-section-title"><span>By property type</span><span>${S.deal ? 'Rent' : 'Sale'}</span></div><div class="types">${rowsHTML}</div></div>`;
  }
  function recentHTML(s) {
    const recent = s.rows.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 6);
    return `
      <div class="p-section">
        <div class="p-section-title"><span>Latest data points</span></div>
        <div class="recent">
          ${recent.map((r) => {
            const where = r.soc >= 0 ? A.soc[r.soc].name : (r.lv.area >= 0 && A.area ? A.area[r.lv.area].name : '');
            const what = `${r.bhk >= 0 ? pts.bhk[r.bhk] + ' · ' : ''}${sizeText(r.size)} ${typeWord(typeOfRow(r))}`;
            return `
            <button class="recent-row" data-pt="${r.idx}">
              <span class="r-what">${esc(what)}${where ? ` · ${esc(where)}` : ''}</span>
              <span class="r-rate">${inr(conv(r.rate))}<span class="r-unit">${perUnit()}</span></span>
              <span class="r-meta"><span class="src-dot" style="background:${SOURCE_COLORS[r.src % 8]}"></span>${esc(pts.sources[r.src])} · ${fmtDate(r.date)}</span>
              <span class="r-total">${r.size ? inrShort(r.rate * r.size) + (S.deal ? '/mo' : '') + ' total' : ''}</span>
            </button>`;
          }).join('')}
        </div>
      </div>`;
  }
  function footHTML(level) {
    const where = level === 'soc' || level === 'area' ? '' : ` ${levelCfg(level).name} boundary: see About for sources.`;
    const data = M.sample
      ? 'All prices for this city are generated sample data, not real market prices.'
      : `Prices: ${esc(M.dataLabel)}, as of ${fmtDate(M.asOf)}. Listings are asking prices, not registered deal values.`;
    return `<div class="p-foot">${data}${where} Plot and built-up rates are kept separate. Areas with ${lowText()} are marked low confidence.</div>`;
  }

  // Society panel: every configuration listed for one society.
  function renderSociety(id) {
    const so = A.soc[id];
    const s = stats.soc[id];
    const parents = parentsOf('soc', id);
    const t = curType();
    const all = rowsBy.soc[id].filter((r) => r.t === t.index && r.d === S.deal)
      .sort((a, b) => (a.bhk - b.bhk) || (a.size - b.size));
    let html = `
      <div class="p-kicker">${esc(kickerOf('soc', id))}</div>
      <div class="p-title">${esc(so.name)}</div>
      ${parents.length ? `<div class="p-parents">${parents.map(([l, i]) => `<button class="parent-chip" data-area="${l}:${i}">${esc(levelCfg(l).name)}: ${esc(areaName(l, i))}</button>`).join('')}</div>` : ''}
      <div class="p-context">${filterChips()}</div>`;
    if (so.p === 0) html += `<div class="gv-note">Location is a locality centroid, not the exact building.</div>`;
    if (!s.n) {
      const noPrice = !rowsBy.soc[id].length;
      html += `<div class="p-empty">${noPrice ? 'No price data for this society yet. It is listed in the data, but no configuration has a usable price.' : 'No configurations here match these filters.'}</div>`;
    } else {
      const color = colorOf(s);
      html += `
        <div class="p-hero" style="--hero-color:${PALETTE[bucket(s.median)]}">
          <div class="p-hero-label">Median ${typeWord()} ${S.deal ? 'rent' : 'price'} in this society</div>
          <div class="p-hero-value">${inr(conv(s.median))} <small>${perUnit()}</small></div>
          <div class="p-hero-sub">${plural(s.n, 'configuration')} · ${inrShort(s.min * (s.rows[0].size || 0)) === '₹0' ? '' : 'from ' + inrShort(Math.min(...s.rows.map((r) => r.rate * r.size)))}${s.rows.length > 1 ? ' to ' + inrShort(Math.max(...s.rows.map((r) => r.rate * r.size))) : ''}</div>
          <div class="p-hero-src">${srcLine(s)}</div>
        </div>`;
      html += guidanceHTML('soc', id, s, color);
    }
    if (all.length) {
      html += `
        <div class="p-section">
          <div class="p-section-title"><span>Configurations</span><span>${all.length}</span></div>
          <div class="cfg-table">
            <div class="cfg-row cfg-head"><span>Type</span><span>Size</span><span>Price</span><span>${esc(perUnit().slice(1))}</span></div>
            ${all.map((r) => `
              <div class="cfg-row${passes(r) ? '' : ' dim'}">
                <span>${r.bhk >= 0 ? esc(pts.bhk[r.bhk]) : esc(typeOfRow(r).name)}</span>
                <span>${sizeText(r.size)}</span>
                <span>${r.size ? inrShort(r.rate * r.size) + (S.deal ? '/mo' : '') : '—'}</span>
                <span>${inrShort(conv(r.rate))}</span>
              </div>`).join('')}
          </div>
          ${so.npr ? `<div class="gv-note">${plural(so.npr, 'more configuration')} listed without a price.</div>` : ''}
          ${all.some((r) => !passes(r)) ? '<div class="gv-note">Greyed rows are outside your current size or configuration filter.</div>' : ''}
        </div>`;
    }
    if (so.url) {
      html += `<div class="p-section"><a class="source-link" href="${esc(so.url)}" target="_blank" rel="noopener noreferrer">View the source listing ↗</a><div class="gv-note">${esc(so.url.replace(/^https?:\/\//, '').slice(0, 70))}…</div></div>`;
    }
    html += refsHTML('soc', id) + footHTML('soc');
    $('panel-body').innerHTML = html;
  }

  $('panel-body').addEventListener('click', (e) => {
    const area = e.target.closest('[data-area]');
    if (area) { const [l, i] = area.dataset.area.split(':'); openArea(l, +i, { fly: true }); return; }
    const t = e.target.closest('[data-switch-type]');
    if (t) { setType(+t.dataset.switchType); return; }
    const p = e.target.closest('[data-pt]');
    if (p) {
      const r = rows[+p.dataset.pt];
      if (r.soc >= 0) { openArea('soc', r.soc, { fly: true }); return; }
      map.flyTo({ center: [r.lon, r.lat], zoom: 16.2, pitch: S.is3d ? 58 : 0, duration: 1400 });
      map.once('moveend', () => showPoint(r, [r.lon, r.lat]));
    }
  });

  // ---------- Hover and click ----------
  const qLayers = (ids) => ids.filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
  function setHover(h) {
    const same = h && S.hover && h.level === S.hover.level && h.id === S.hover.id;
    if (same || (!h && !S.hover)) return;
    if (S.hover && POLY.some((l) => l.key === S.hover.level)) map.setFeatureState({ source: S.hover.level, id: S.hover.id }, { hover: false });
    S.hover = h;
    if (h && POLY.some((l) => l.key === h.level)) map.setFeatureState({ source: h.level, id: h.id }, { hover: true });
  }
  function localHTML(lngLat) {
    if (map.getZoom() < 13.5 || !S.layers.buildings) return '';
    const i = surfCell(lngLat.lng, lngLat.lat);
    if (i < 0 || surf[i] < 0) return '<div class="tip-local">Right here: not enough nearby data</div>';
    return `<div class="tip-local">Right here: about <b>${inrShort(conv(surfVal[i]))}${perUnit()}</b>, from ${surfN[i]} points within 1 km</div>`;
  }
  function tipHTML(level, id, lngLat) {
    const s = stats[level][id];
    let body;
    if (s.n === 0) body = '<div class="tip-low">No matching data</div>';
    else {
      body = `<div class="tip-price">${inr(conv(s.median))}<span class="tip-meta"> ${perUnit()}</span></div>`;
      body += s.low ? `<div class="tip-low">Low confidence · ${M.societies ? plural(s.groups, 'society', 'societies') : plural(s.n, 'point')}</div>`
        : `<div class="tip-meta">Median of ${M.societies ? plural(s.groups, 'society', 'societies') : plural(s.n, 'point')} · click for details</div>`;
      body += `<div class="tip-src">${srcLine(s)}</div>`;
    }
    return `<div class="tip-kicker">${esc(levelCfg(level).name)}</div><div class="tip-name">${esc(areaName(level, id))}</div>${body}${lngLat ? localHTML(lngLat) : ''}`;
  }
  function hitArea(e) {
    if (PT) {
      const a = map.queryRenderedFeatures(e.point, { layers: qLayers(['area-dot', 'area-label']) })[0];
      if (a) return { level: 'area', id: a.properties.id };
    }
    const L = levelAtZoom(map.getZoom());
    const id = areaAt(L, e.lngLat.lng, e.lngLat.lat);
    return id >= 0 ? { level: L, id } : null;
  }
  function wireMapEvents() {
    map.on('mousemove', (e) => {
      if (!ready) return;
      const pin = map.queryRenderedFeatures(e.point, { layers: qLayers(['clusters', 'pt']) })[0];
      if (pin) {
        map.getCanvas().style.cursor = 'pointer';
        setHover(null);
        if (pin.properties.kind === 'soc' && !isMobile()) {
          const st = stats.soc[pin.properties.i];
          tip.setLngLat(e.lngLat).setHTML(`<div class="tip-kicker">Society</div><div class="tip-name">${esc(A.soc[pin.properties.i].name)}</div><div class="tip-price">${inr(conv(st.median))}<span class="tip-meta"> ${perUnit()}</span></div><div class="tip-meta">${plural(st.n, 'configuration')} · click for details</div>`).addTo(map);
        } else tip.remove();
        return;
      }
      const hit = (S.layers.zones || S.layers.buildings) ? hitArea(e) : null;
      if (hit) {
        setHover(hit);
        map.getCanvas().style.cursor = 'pointer';
        if (!isMobile()) tip.setLngLat(e.lngLat).setHTML(tipHTML(hit.level, hit.id, e.lngLat)).addTo(map);
      } else {
        setHover(null);
        map.getCanvas().style.cursor = '';
        tip.remove();
      }
    });
    map.getCanvas().addEventListener('mouseleave', () => { setHover(null); tip.remove(); });
    map.on('click', async (e) => {
      if (!ready) return;
      const c = map.queryRenderedFeatures(e.point, { layers: qLayers(['clusters']) })[0];
      if (c) {
        const zoom = await map.getSource('pts').getClusterExpansionZoom(c.properties.cluster_id);
        map.easeTo({ center: c.geometry.coordinates, zoom: Math.min(zoom + 0.3, 17), duration: 700 });
        return;
      }
      const p = map.queryRenderedFeatures(e.point, { layers: qLayers(['pt']) })[0];
      if (p) {
        if (p.properties.kind === 'soc') { tip.remove(); openArea('soc', p.properties.i); }
        else showPoint(rows[p.properties.i], p.geometry.coordinates);
        return;
      }
      const hit = hitArea(e);
      if (hit) { tip.remove(); openArea(hit.level, hit.id); }
    });
    map.on('sourcedata', (e) => { if (e.sourceId === 'openmaptiles' && S.layers.buildings) scheduleAssign(); });
    map.on('moveend', () => { if (S.layers.buildings) scheduleAssign(); updateCrumbs(); });
    map.on('style.load', () => { if (ready && !map.getSource(LEAF.key)) addLayers(); });
    ['mousedown', 'touchstart', 'wheel'].forEach((ev) => map.on(ev, (e) => { if (T.on && e.originalEvent) pauseTour(); }));
  }
  function showPoint(r, coords) {
    clearSearchBoundary();
    tip.remove();
    const where = r.lv.area >= 0 && A.area ? A.area[r.lv.area].name : '';
    ptPopup.setLngLat(coords).setHTML(`
      <div class="pt-type">${esc(typeOfRow(r).name)} · ${r.d ? 'Rent' : 'Sale'}</div>
      <div class="pt-rate">${inr(conv(r.rate))}<span class="tip-meta"> ${'/' + unitLabel() + (r.d ? '/mo' : '')}</span></div>
      <div class="pt-grid">
        ${r.bhk >= 0 ? `<span>Configuration</span><span>${esc(pts.bhk[r.bhk])}</span>` : ''}
        <span>Size</span><span>${sizeText(r.size)}</span>
        <span>${r.d ? 'Monthly rent' : 'Total price'}</span><span>${r.size ? inrShort(r.rate * r.size) : '—'}</span>
        <span>Date</span><span>${fmtDate(r.date)}</span>
        <span>Source</span><span>${esc(pts.sources[r.src])}</span>
        ${where ? `<span>${esc(PT.name)}</span><span>${esc(where)}</span>` : ''}
        ${r.lv[LEAF.key] >= 0 ? `<span>${esc(LEAF.name)}</span><span>${esc(areaName(LEAF.key, r.lv[LEAF.key]))}</span>` : ''}
      </div>`).addTo(map);
  }

  // ---------- Controls ----------
  function setSeg(segId, attr, value) {
    $(segId).querySelectorAll('button').forEach((b) => {
      const on = b.dataset[attr] === String(value);
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on);
    });
  }
  function dealAvailable(d, t = curType()) { return d === 0 ? t.sale > 0 : t.rent > 0; }
  function syncDeal() {
    const t = curType();
    if (!dealAvailable(S.deal)) S.deal = dealAvailable(0) ? 0 : 1;
    setSeg('deal-seg', 'deal', S.deal);
    $('deal-seg').querySelector('[data-deal="0"]').disabled = !dealAvailable(0);
    $('deal-seg').querySelector('[data-deal="1"]').disabled = !dealAvailable(1);
    const hint = $('deal-hint');
    if (!t.rent) { hint.hidden = false; hint.textContent = t.land ? 'Plots are sold, not rented.' : `No rent data for ${t.name.toLowerCase()}s in ${M.name} yet.`; }
    else hint.hidden = true;
  }
  function setType(ti) {
    S.type = ti;
    const t = curType();
    S.sizeMin = t.sizeMin; S.sizeMax = t.sizeMax;
    setSeg('type-seg', 'type', ti);
    syncDeal();
    $('type-hint').textContent = t.land ? 'Land rate. Plots and built-up homes are never mixed on one map.' : 'Built-up rate, per unit of built-up area.';
    $('bhk-field').hidden = !(M.bhk && !t.land);
    setupSize();
    if (ready) applyAll();
  }
  function setDeal(d) {
    if (!dealAvailable(d)) return;
    S.deal = d;
    setSeg('deal-seg', 'deal', d);
    if (ready) applyAll();
  }
  function buildControls() {
    $('type-seg').innerHTML = M.types.map((t, i) => `<button data-type="${i}">${esc(t.name)}</button>`).join('');
    $('type-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setType(+b.dataset.type); });
    $('deal-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled) setDeal(+b.dataset.deal); });
    $('deal-seg').addEventListener('pointerdown', (e) => {
      const b = e.target.closest('button');
      if (b && b.disabled) toast($('deal-hint').textContent || 'No data for this yet.');
    });
    // Sources
    S.src = pts.sources.map(() => true);
    $('source-checks').innerHTML = pts.sources.map((s, i) => `<label><input type="checkbox" data-src="${i}" checked><span class="src-dot" style="background:${SOURCE_COLORS[i % 8]}"></span>${esc(s)}</label>`).join('');
    $('source-checks').addEventListener('change', (e) => { S.src[+e.target.dataset.src] = e.target.checked; applyAll(); });
    // BHK chips
    if (M.bhk) {
      $('bhk-chips').innerHTML = `<button class="chip-btn active" data-bhk="all">All</button>` +
        M.bhk.map((b) => `<button class="chip-btn" data-bhk="${pts.bhk.indexOf(b.id)}">${esc(b.id)}</button>`).join('');
      $('bhk-chips').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.bhk === 'all') S.bhk.clear();
        else { const v = +b.dataset.bhk; if (S.bhk.has(v)) S.bhk.delete(v); else S.bhk.add(v); }
        $('bhk-chips').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x.dataset.bhk === 'all' ? !S.bhk.size : S.bhk.has(+x.dataset.bhk)));
        applyAll();
      });
    }
    $('pins-label').textContent = M.societies ? 'Society pins' : 'Price pins';
    // Cities
    $('city-seg').innerHTML = cities.map((c) => `<button data-city="${c.id}" class="${c.id === CITY ? 'active' : ''}">${esc(c.name)}</button>`).join('');
    $('city-seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b.dataset.city !== CITY) location.href = cityHref(b.dataset.city); });
    $('city-menu').innerHTML = cities.map((c) => `<li><a role="option" href="${cityHref(c.id)}" class="${c.id === CITY ? 'current' : ''}"><span>${esc(c.name)}</span><small>${c.sample ? 'sample prices' : 'real data'}</small></a></li>`).join('');
    $('city-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const open = $('city-menu').hidden;
      $('city-menu').hidden = !open;
      $('city-btn').setAttribute('aria-expanded', open);
    });
    document.addEventListener('click', () => { $('city-menu').hidden = true; $('city-btn').setAttribute('aria-expanded', false); });
  }

  $('unit-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.unit = b.dataset.unit;
    setSeg('unit-seg', 'unit', S.unit);
    updateSizeLabel();
    if (ready) applyAll();
  });
  function setupSize() {
    const t = curType();
    const has = t.sizeMax > t.sizeMin;
    $('size-range').parentElement.hidden = !has;
    if (!has) { S.sizeMin = 0; S.sizeMax = Infinity; return; }
    for (const id of ['size-min', 'size-max']) { const el = $(id); el.min = t.sizeMin; el.max = t.sizeMax; el.step = 50; }
    $('size-min').value = S.sizeMin;
    $('size-max').value = S.sizeMax;
    updateSizeLabel();
  }
  function updateSizeLabel() {
    const t = curType();
    if (!t || !(t.sizeMax > t.sizeMin)) return;
    const lo = t.sizeMin, hi = t.sizeMax;
    $('size-value').textContent = `${nf.format(Math.round(sizeIn(S.sizeMin)))} – ${nf.format(Math.round(sizeIn(S.sizeMax)))} ${unitLabel()}`;
    $('size-fill').style.left = ((S.sizeMin - lo) / (hi - lo)) * 100 + '%';
    $('size-fill').style.right = (100 - ((S.sizeMax - lo) / (hi - lo)) * 100) + '%';
  }
  let sizeTimer = null;
  function onSize(which) {
    let a = +$('size-min').value, b = +$('size-max').value;
    if (a > b) { if (which === 'min') a = b; else b = a; }
    $('size-min').value = a; $('size-max').value = b;
    // The ends of the slider mean "no limit", so outliers beyond the 2-98% range still count.
    const t = curType();
    S.sizeMin = a <= t.sizeMin ? 0 : a;
    S.sizeMax = b >= t.sizeMax ? Infinity : b;
    updateSizeLabelRaw(a, b);
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(applyAll, 60);
  }
  function updateSizeLabelRaw(a, b) {
    const t = curType();
    $('size-value').textContent = `${nf.format(Math.round(sizeIn(a)))}${a <= t.sizeMin ? '' : ''} – ${nf.format(Math.round(sizeIn(b)))}${b >= t.sizeMax ? '+' : ''} ${unitLabel()}`;
    $('size-fill').style.left = ((a - t.sizeMin) / (t.sizeMax - t.sizeMin)) * 100 + '%';
    $('size-fill').style.right = (100 - ((b - t.sizeMin) / (t.sizeMax - t.sizeMin)) * 100) + '%';
  }
  $('size-min').addEventListener('input', () => onSize('min'));
  $('size-max').addEventListener('input', () => onSize('max'));

  document.querySelectorAll('[data-layer]').forEach((el) => {
    el.addEventListener('change', () => {
      S.layers[el.dataset.layer] = el.checked;
      if (el.dataset.layer === 'buildings' && el.checked && map.getZoom() < 13) toast('Zoom in to see buildings tinted by price');
      if (el.dataset.layer === 'pins' && el.checked && map.getZoom() < M.pinsFrom) toast(`Zoom in to see ${M.societies ? 'society' : 'price'} pins`);
      POLY.forEach((lv, i) => map.setPaintProperty(lv.key + '-fill', 'fill-opacity', fillOpacityFor(i)));
      applyVisibility();
      if (el.dataset.layer === 'buildings' && el.checked) scheduleAssign();
    });
  });
  $('filters-head').addEventListener('click', () => {
    const f = $('filters');
    f.classList.toggle('collapsed');
    $('filters-head').setAttribute('aria-expanded', !f.classList.contains('collapsed'));
  });

  function setView(is3d) {
    S.is3d = is3d;
    document.body.classList.toggle('is-2d', !is3d);
    if (is3d) {
      map.dragRotate.enable(); map.touchPitch.enable(); map.touchZoomRotate.enableRotation();
      map.easeTo({ pitch: M.view.pitch, bearing: M.view.bearing, duration: 1000 });
    } else {
      map.dragRotate.disable(); map.touchPitch.disable(); map.touchZoomRotate.disableRotation();
      map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
    }
    if (map.getLayer('bldg')) {
      map.setPaintProperty('bldg', 'fill-extrusion-height', bldgHeight());
      map.setPaintProperty('bldg', 'fill-extrusion-base', bldgBase());
      applyVisibility();
    }
  }
  $('view-toggle').addEventListener('click', () => setView(!S.is3d));
  const homeView = () => ({ center: M.view.center, zoom: isMobile() ? M.view.mobileZoom : M.view.zoom, pitch: S.is3d ? M.view.pitch : 0, bearing: S.is3d ? M.view.bearing : 0 });
  function resetView() {
    if (T.on) endTour();
    closePanel();
    ptPopup.remove();
    map.flyTo({ ...homeView(), duration: 1600 });
  }
  $('home-btn').addEventListener('click', resetView);
  $('theme-toggle').addEventListener('click', () => {
    S.theme = S.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = S.theme;
    store.set('bpm-theme', S.theme);
    S.hover = null;
    map.setStyle(STYLES[S.theme], { diff: false });
  });

  // ---------- Search ----------
  let searchItems = [];
  let activeIdx = -1;
  let remoteHits = [];
  let remoteTimer = null;
  let remoteAbort = null;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const AREA_KINDS = () => [...POLY.map((l) => l.key), 'area', 'soc'];
  function buildSearch() {
    const item = (o) => ({ ...o, key: norm(o.name) });
    searchItems = [];
    POLY.forEach((lv, li) => A[lv.key].forEach((a, i) => searchItems.push(item({ kind: lv.key, name: a.props.short || a.name, id: i, rank: li === POLY.length - 1 ? 0 : 3 }))));
    if (PT) A.area.forEach((a, i) => searchItems.push(item({ kind: 'area', name: a.name, id: i, rank: 1 })));
    if (M.societies) A.soc.forEach((s, i) => searchItems.push(item({ kind: 'soc', name: s.name, id: i, rank: 2 })));
    places.landmarks.forEach((l) => searchItems.push(item({ kind: 'landmark', name: l.name, lon: l.lon, lat: l.lat, rank: 4 })));
    places.colonies.forEach((c) => searchItems.push(item({ kind: 'colony', name: c.name, lon: c.lon, lat: c.lat, rank: 5 })));
  }
  function iconFor(it) {
    if (AREA_KINDS().includes(it.kind)) {
      const s = stats[it.kind][it.id];
      const lv = levelCfg(it.kind);
      const label = it.kind === LEAF.key ? (A[it.kind][it.id].props.code || 'W').toString().slice(0, 3) : lv.name[0];
      return `<span class="sr-icon" style="background:${colorOf(s)}">${esc(label)}</span>`;
    }
    return `<span class="sr-icon other">${{ landmark: '◆', colony: '◇', place: '⌖' }[it.kind]}</span>`;
  }
  function subFor(it) {
    if (it.kind === 'soc') { const s = A.soc[it.id]; return `Society${s.area >= 0 ? ' · ' + esc(A.area[s.area].name) : ''}`; }
    if (it.kind === 'area') { const p = parentsOf('area', it.id).find(([l]) => l === LEAF.key); return `${esc(PT.name)}${p ? ' · ' + esc(areaName(p[0], p[1])) : ''}`; }
    if (AREA_KINDS().includes(it.kind)) return esc(levelCfg(it.kind).name);
    if (it.kind === 'landmark') return 'Landmark';
    if (it.kind === 'colony') return 'Neighbourhood';
    return esc(it.sub || 'Place') + ' · OpenStreetMap';
  }
  function renderResults() {
    const q = norm($('search').value);
    const ul = $('search-results');
    if (!q) { ul.hidden = true; return; }
    const local = searchItems.filter((it) => it.key.includes(q))
      .sort((a, b) => (b.key.startsWith(q) - a.key.startsWith(q)) || (a.rank - b.rank) || a.name.length - b.name.length)
      .slice(0, 8);
    const names = new Set(local.map((x) => x.key));
    const remote = remoteHits.filter((r) => !names.has(r.key)).slice(0, Math.max(0, 10 - local.length));
    const hits = [...local, ...remote];
    activeIdx = hits.length ? 0 : -1;
    let html = '';
    hits.forEach((it, i) => {
      if (i === local.length && remote.length) html += '<li class="sr-heading">More places from OpenStreetMap</li>';
      let price = '';
      if (AREA_KINDS().includes(it.kind)) { const s = stats[it.kind][it.id]; price = `<span class="sr-price">${s.n ? inrShort(conv(s.median)) : '—'}</span>`; }
      html += `<li role="option" data-i="${i}" class="${i === 0 ? 'active' : ''}">${iconFor(it)}<div class="sr-main"><div class="sr-name">${esc(it.name)}</div><div class="sr-sub">${subFor(it)}</div></div>${price}</li>`;
    });
    if (!hits.length) html = `<li class="sr-empty">${remoteTimer ? 'Searching…' : 'No matches. Try an area, society, street or landmark.'}</li>`;
    ul.innerHTML = html;
    ul.hidden = false;
    ul._hits = hits;
  }
  function runSearch() {
    if (!ready) return;
    remoteHits = [];
    renderResults();
    clearTimeout(remoteTimer);
    if (remoteAbort) remoteAbort.abort();
    const q = $('search').value.trim();
    if (q.length < 3) { remoteTimer = null; return; }
    remoteTimer = setTimeout(async () => {
      remoteAbort = new AbortController();
      try {
        const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&bbox=${M.bbox.join(',')}&limit=6&lang=en`;
        const json = await fetch(url, { signal: remoteAbort.signal }).then((r) => r.json());
        remoteHits = (json.features || []).map((f) => {
          const p = f.properties;
          const sub = [p.osm_value && p.osm_value.replace(/_/g, ' '), p.district || p.locality || p.city].filter(Boolean).join(' · ');
          return { kind: 'place', name: p.name || p.street || 'Unnamed place', sub, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], key: norm(p.name || '') };
        });
      } catch (err) { remoteHits = []; }
      remoteTimer = null;
      if (document.activeElement === $('search')) renderResults();
    }, 320);
  }
  function chooseResult(it) {
    $('search-results').hidden = true;
    $('search').value = it.name;
    $('search').blur();
    if (AREA_KINDS().includes(it.kind)) {
      openArea(it.kind, it.id, { fly: true, keepSearchHl: true });
      if (POLY.some((l) => l.key === it.kind)) setSearchBoundary(A[it.kind][it.id].geometry);
      else if (it.kind === 'area') setSearchBoundary(boundaryGeomAt(A.area[it.id].lon, A.area[it.id].lat));
      else if (it.kind === 'soc') setSearchBoundary(boundaryGeomAt(A.soc[it.id].lon, A.soc[it.id].lat));
      return;
    }
    map.flyTo({ center: [it.lon, it.lat], zoom: 15.4, pitch: S.is3d ? 58 : 0, duration: 1600 });
    const soc = M.societies ? nearest(A.soc, it.lon, it.lat, 0.25, (i) => stats.soc[i].n > 0) : -1;
    const area = PT ? nearest(A.area, it.lon, it.lat, 1.5, (i) => stats.area[i].n > 0) : -1;
    const leaf = areaAt(LEAF.key, it.lon, it.lat);
    if (soc >= 0) openArea('soc', soc, { keepSearchHl: true });
    else if (area >= 0) openArea('area', area, { keepSearchHl: true });
    else if (leaf >= 0) openArea(LEAF.key, leaf, { keepSearchHl: true });
    else toast(`This place is outside the areas covered for ${M.name}`);
    let geom = null;
    if (soc >= 0) geom = boundaryGeomAt(A.soc[soc].lon, A.soc[soc].lat);
    else if (area >= 0) geom = boundaryGeomAt(A.area[area].lon, A.area[area].lat);
    else if (leaf >= 0) geom = A[LEAF.key][leaf].geometry;
    else geom = boundaryGeomAt(it.lon, it.lat);
    setSearchBoundary(geom);
  }
  $('search').addEventListener('input', runSearch);
  $('search').addEventListener('focus', () => { if ($('search').value) renderResults(); });
  $('search').addEventListener('keydown', (e) => {
    const ul = $('search-results');
    const hits = ul._hits || [];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!hits.length) return;
      e.preventDefault();
      activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
      ul.querySelectorAll('li[data-i]').forEach((li) => li.classList.toggle('active', +li.dataset.i === activeIdx));
    } else if (e.key === 'Enter' && hits[activeIdx]) chooseResult(hits[activeIdx]);
    else if (e.key === 'Escape') { ul.hidden = true; $('search').blur(); }
  });
  $('search-results').addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) { e.preventDefault(); chooseResult($('search-results')._hits[+li.dataset.i]); }
  });
  $('search').addEventListener('blur', () => setTimeout(() => { $('search-results').hidden = true; }, 120));

  // ---------- About / welcome ----------
  function renderAbout() {
    const r = M.report;
    const lvls = M.levels.map((l) => plural(l.count, l.name.toLowerCase(), l.plural)).join(' → ');
    $('about-title').textContent = `${M.name} Property Price Map`;
    $('about-lead').textContent = `What property costs across ${M.name}, from ${M.levels[0].plural} down to individual ${M.societies ? 'societies' : 'streets'}. Built for brokers, developers, banks, valuers and investors.`;
    $('about-warn').innerHTML = M.sample
      ? `All prices for ${esc(M.name)} are <b>sample data</b>, generated in the client's data format to show how the product works. Boundaries and place names are real.`
      : `Prices for ${esc(M.name)} are <b>real data</b>: ${esc(M.dataLabel)}, as of ${fmtDate(M.asOf)}. Coverage is partial, and listings are asking prices, not registered deal values.${M.coordNote ? `<br>${esc(M.coordNote)}` : ''}`;
    $('howto-zoom').innerHTML = `<b>Zoom to go deeper.</b> ${esc(lvls)} → individual ${M.societies ? 'societies' : 'prices'}.`;
    $('howto-click').innerHTML = `<b>Click any area${M.societies ? ' or society' : ''}</b> for its median price, range, ${esc(M.guidance.label.toLowerCase())} gap and latest data points.`;
    const typeNames = M.types.map((t) => t.name.toLowerCase());
    $('howto-filters').innerHTML = `<b>Switch the view</b> with the filters: ${esc(typeNames.join(', '))}${M.types.some((t) => t.rent) ? ', sale or rent' : ''}${M.bhk ? ', BHK' : ''} and size.`;
    const skipped = r.skipped || {};
    const sum = (pred) => Object.entries(skipped).filter(([k]) => pred(k)).reduce((a, [, v]) => a + v, 0);
    const bad = sum((k) => k.includes('duplicate') || k.includes('outlier'));
    // Everything that is neither a point nor a duplicate/outlier: government/reference
    // area rows, summaries already counted, and rows without a price or usable coordinates.
    const usedElsewhere = Math.max(0, r.rowsRead - r.pointsUsed - bad);
    $('about-data').innerHTML = `
      <div class="pipe">
        <div class="pipe-step"><b>${nf.format(r.rowsRead)}</b><span>rows in ${plural(r.files.length, 'file')}</span></div>
        <div class="pipe-arrow">→</div>
        <div class="pipe-step minus"><b>−${nf.format(usedElsewhere)}</b><span>${r.governmentRates ? `${nf.format(r.governmentRates)} ${esc(M.guidance.label.toLowerCase())} rows used separately, ` : ''}summaries already counted, rows without a price or usable coordinates</span></div>
        <div class="pipe-arrow">→</div>
        <div class="pipe-step minus"><b>−${nf.format(bad)}</b><span>duplicates and outliers (same home twice, typos)</span></div>
        <div class="pipe-arrow">→</div>
        <div class="pipe-step good"><b>${nf.format(r.pointsUsed)}</b><span>data points on the map${M.societies ? ` in ${nf.format(r.societies)} societies` : ''}</span></div>
      </div>`;
    const rules = [
      M.societies
        ? `Every area shows the <b>median of its societies</b>, so one large project with many configurations can't dominate.`
        : 'Every area shows the <b>median</b> (not the average), so a few extreme listings can\'t skew it.',
      M.types.some((t) => t.land) && M.types.some((t) => !t.land) ? 'Plot (land) rates and built-up rates are <b>never mixed</b> on one map.' : '',
      `Areas with <b>${lowText()}</b> are greyed out as low confidence.`,
      'Colours use <b>10 percentile steps</b>, so both cheap and premium areas show contrast.',
      `Up close, each <b>building is coloured by prices within about 1 km</b>${M.heights ? ' and stands at its <b>real height</b> from satellite data' : ''}.`,
      M.pinSpread ? 'Where several societies share one locality coordinate, their pins are <b>spread slightly</b> so each can be clicked.' : '',
      M.societies && r.societiesListed > r.societies ? `${nf.format(r.societiesListed - r.societies)} more societies are listed without prices and can be found in search.` : '',
      `Every number shows its <b>source and date</b>. New data files are added with one command (see README).`,
    ].filter(Boolean);
    $('about-rules').innerHTML = rules.map((x) => `<li>${x}</li>`).join('');
    $('about-credits').textContent = [...M.credits, M.heights ? 'Building heights: Google Open Buildings 2.5D Temporal, 2023 (CC BY 4.0)' : '', 'Map: © OpenStreetMap contributors, OpenFreeMap, OpenMapTiles'].filter(Boolean).join('. ') + '.';
  }
  function openAbout() { renderAbout(); $('about').hidden = false; $('about-close').focus(); }
  function closeAbout() { $('about').hidden = true; store.set('bpm-welcomed-' + CITY, '1'); }
  $('about-btn').addEventListener('click', openAbout);
  $('about-close').addEventListener('click', closeAbout);
  $('about-go').addEventListener('click', closeAbout);
  $('about').addEventListener('click', (e) => { if (e.target === $('about')) closeAbout(); });
  document.addEventListener('click', (e) => { if (e.target.closest('[data-open-about]')) openAbout(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== $('search') && $('about').hidden) { e.preventDefault(); $('search').focus(); }
    if (e.key === 'Escape' && document.activeElement !== $('search')) {
      if (!$('about').hidden) closeAbout();
      else if (T.on) endTour();
      else { closePanel(); ptPopup && ptPopup.remove(); }
    }
  });
  $('panel-close').addEventListener('click', closePanel);

  let toastTimer = null;
  function toast(msg, ms = 3200) {
    const t = $('hint-toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ---------- Guided tour (built from the city's own data) ----------
  const T = { on: false, i: 0, timer: null, orbitTimer: null, paused: false, token: 0, steps: [] };
  const TOUR_FLY = 2600, TOUR_DWELL = 5200;
  const mz = (z) => (isMobile() ? z - 0.6 : z);
  function priciest(level, ids, minGroups = 0) {
    let best = -1, bv = -1;
    ids.forEach((i) => { const s = stats[level][i]; if (s && s.n && !s.low && s.groups >= minGroups && s.median > bv) { bv = s.median; best = i; } });
    return best;
  }
  const tourOffset = () => (isMobile() || !S.sel ? [0, 0] : panelOffset());
  function buildTour() {
    const steps = [];
    const firstType = 0;
    const reset = () => {
      S.src = pts.sources.map(() => true);
      document.querySelectorAll('#source-checks input').forEach((el) => { el.checked = true; });
      S.bhk.clear();
      document.querySelectorAll('#bhk-chips button').forEach((x) => x.classList.toggle('active', x.dataset.bhk === 'all'));
      ['zones', 'pins', 'buildings'].forEach((n) => { S.layers[n] = true; const el = document.querySelector(`[data-layer="${n}"]`); if (el) el.checked = true; });
      setType(firstType);
    };
    const tw = M.types[firstType].name.toLowerCase();
    POLY.forEach((lv, i) => {
      const last = i === POLY.length - 1;
      const z = last ? switchZoom(i) + 0.6 : (POLY[i + 1] ? switchZoom(i + 1) - (i === 0 ? 0.45 : 0.3) : M.view.zoom);
      steps.push({
        title: last ? `${plural(lv.count, lv.name.toLowerCase(), lv.plural)} in 3D` : plural(lv.count, lv.name.toLowerCase(), lv.plural)[0].toUpperCase() + plural(lv.count, lv.name.toLowerCase(), lv.plural).slice(1),
        text: i === 0 ? `${M.name} is split into ${plural(lv.count, lv.name.toLowerCase(), lv.plural)}. Each block's height and colour show its median ${tw} price.`
          : last ? `Blocks rise with price: cool blue is cheaper, warm red is pricier. Grey means ${lowText()}.`
            : `Zoom in and ${lv.plural} appear. One colour scale runs across every level, so any two areas can be compared.`,
        setup: i === 0 ? () => { reset(); closePanel(); } : null,
        cam: () => ({ center: M.view.center, zoom: mz(z), pitch: 52 + i * 3, bearing: [-32, -10, -6][i] || -6 }),
        orbit: 18,
      });
    });
    steps.push({
      title: 'Click any area for details',
      text: '', // filled at run time
      setup() {
        const i = priciest(LEAF.key, A[LEAF.key].map((_, j) => j));
        this.leaf = i;
        this.text = `${areaName(LEAF.key, i)}: median price, full range, where the numbers come from, and the gap to the ${M.guidance.label.toLowerCase()}.`;
        if (!isMobile()) openArea(LEAF.key, i); else closePanel();
      },
      cam() { const a = A[LEAF.key][this.leaf]; return { center: a.center, zoom: 13.1, pitch: 55, bearing: 25, offset: tourOffset() }; },
      orbit: 14,
    });
    if (PT) {
      steps.push({
        title: `Named ${PT.plural}`,
        text: '',
        setup() {
          const leafStep = steps.find((s) => s.leaf != null);
          const ids = A.area.map((a, j) => (a.parents[LEAF.key] === leafStep.leaf ? j : -1)).filter((j) => j >= 0);
          let i = priciest('area', ids);
          if (i < 0) i = priciest('area', A.area.map((_, j) => j));
          this.area = i;
          this.text = `Zoom in and ${PT.plural} appear, each with its own median. ${A.area[i].name} is one of the priciest.`;
          if (!isMobile()) openArea('area', i); else closePanel();
        },
        cam() { const l = A.area[this.area]; return { center: [l.lon, l.lat], zoom: Math.max(PT.from + 1.2, 14), pitch: 60, bearing: 40, offset: tourOffset() }; },
        orbit: 22,
      });
    }
    steps.push(M.societies ? {
      title: 'Society level',
      text: '',
      setup() {
        const areaStep = steps.find((s) => s.area != null);
        const ids = A.soc.map((s, j) => (areaStep && s.area === areaStep.area ? j : -1)).filter((j) => j >= 0);
        let i = -1, bv = -1;
        ids.forEach((j) => { const st = stats.soc[j]; if (st.n >= 2 && st.median > bv) { bv = st.median; i = j; } });
        if (i < 0) ids.concat(A.soc.map((_, j) => j)).some((j) => { if (stats.soc[j].n >= 2) { i = j; return true; } return false; });
        this.soc = i;
        this.text = `Every pin is a society, sized by how many configurations it lists. ${A.soc[i].name}: each configuration, its price and the source listing.`;
        if (!isMobile()) openArea('soc', i); else closePanel();
      },
      cam() { const s = A.soc[this.soc]; return { center: [s.lon, s.lat], zoom: 16.1, pitch: 63, bearing: 65, offset: tourOffset() }; },
      orbit: 45,
    } : {
      title: 'Street level',
      text: `Each building is coloured by prices within about 1 km${M.heights ? ' and stands at its real height from satellite data' : ''}. Every pin is one listing or deal.`,
      setup() { closePanel(); },
      cam() { const areaStep = steps.find((s) => s.area != null); const l = areaStep ? A.area[areaStep.area] : { lon: M.view.center[0], lat: M.view.center[1] }; return { center: [l.lon, l.lat], zoom: 16.2, pitch: 63, bearing: 65 }; },
      orbit: 50,
    });
    // Show a different type or rent, if the city has data for it.
    const alt = M.types.map((t, i) => ({ t, i })).filter(({ t, i }) => i !== firstType && (t.sale || t.rent));
    const rentType = M.types.findIndex((t) => t.rent > 0);
    if (alt.length || rentType >= 0) {
      const ti = rentType >= 0 ? rentType : alt[0].i;
      const rent = rentType >= 0;
      steps.push({
        title: `${M.types[ti].name} ${rent ? 'rents' : 'prices'}`,
        text: 'Switch property type or deal and the whole city re-colours. Land rates and built-up rates are never mixed.',
        setup() { closePanel(); setType(ti); if (rent) setDeal(1); },
        cam: () => ({ center: M.view.center, zoom: mz(M.view.zoom - 0.1), pitch: 56, bearing: -22 }),
        orbit: 16,
      });
    }
    steps.push({
      title: 'Your turn',
      text: `Search any area, ${M.societies ? 'society, ' : ''}street or landmark, or click anything on the map. Switch city from the title.${M.sample ? ' Prices here are sample data.' : ''}`,
      setup() { setType(firstType); },
      cam: () => homeView(),
      last: true,
    });
    T.steps = steps;
  }
  function runStep() {
    const st = T.steps[T.i];
    const token = ++T.token;
    clearTimeout(T.timer); clearTimeout(T.orbitTimer);
    T.paused = false;
    $('tour-pause').textContent = 'Pause';
    if (!S.is3d) setView(true);
    if (st.setup) st.setup.call(st);
    const cam = st.cam.call(st);
    map.flyTo({ offset: [0, 0], ...cam, duration: TOUR_FLY, curve: 1.3, essential: true });
    if (st.orbit) {
      T.orbitTimer = setTimeout(() => {
        if (T.on && token === T.token) map.easeTo({ bearing: cam.bearing + st.orbit, duration: TOUR_DWELL, easing: (t) => t, offset: cam.offset || [0, 0] });
      }, TOUR_FLY + 60);
    }
    $('tour-step').textContent = `${T.i + 1} / ${T.steps.length}`;
    $('tour-title').textContent = st.title;
    $('tour-text').textContent = st.text;
    $('tour-prev').disabled = T.i === 0;
    $('tour-next').textContent = st.last ? 'Finish' : 'Next';
    $('tour-pause').hidden = !!st.last;
    const bar = $('tour-progress');
    bar.style.transition = 'none';
    bar.style.width = '0%';
    void bar.offsetWidth;
    if (st.last) bar.style.width = '100%';
    else {
      bar.style.transition = `width ${TOUR_FLY + TOUR_DWELL}ms linear`;
      bar.style.width = '100%';
      T.timer = setTimeout(() => { if (T.on && token === T.token) nextStep(); }, TOUR_FLY + TOUR_DWELL);
    }
  }
  function nextStep() { if (T.i >= T.steps.length - 1) { endTour(); return; } T.i++; runStep(); }
  function prevStep() { if (T.i > 0) { T.i--; runStep(); } }
  function pauseTour() {
    if (!T.on || T.paused) return;
    T.paused = true; T.token++;
    clearTimeout(T.timer); clearTimeout(T.orbitTimer);
    map.stop();
    const bar = $('tour-progress');
    const w = getComputedStyle(bar).width;
    bar.style.transition = 'none';
    bar.style.width = w;
    $('tour-pause').textContent = 'Resume';
  }
  function startTour() {
    if (!ready) return;
    closeAbout(); ptPopup.remove(); tip.remove();
    buildTour();
    T.on = true; T.i = 0;
    document.body.classList.add('touring');
    $('tour').hidden = false;
    $('tour-btn').classList.add('active');
    runStep();
  }
  function endTour() {
    T.on = false; T.token++;
    clearTimeout(T.timer); clearTimeout(T.orbitTimer);
    map.stop();
    document.body.classList.remove('touring');
    $('tour').hidden = true;
    $('tour-btn').classList.remove('active');
  }
  $('tour-btn').addEventListener('click', () => (T.on ? endTour() : startTour()));
  $('about-tour').addEventListener('click', startTour);
  $('tour-next').addEventListener('click', nextStep);
  $('tour-prev').addEventListener('click', prevStep);
  $('tour-exit').addEventListener('click', endTour);
  $('tour-pause').addEventListener('click', () => (T.paused ? runStep() : pauseTour()));
  document.addEventListener('keydown', (e) => {
    if (!T.on || document.activeElement === $('search')) return;
    if (e.key === 'ArrowRight') nextStep();
    else if (e.key === 'ArrowLeft') prevStep();
    else if (e.key === ' ') { e.preventDefault(); if (T.paused) runStep(); else pauseTour(); }
  });

  // ---------- Boot ----------
  async function loadCity() {
    const get = (f) => fetch(`/data/${CITY}/${f}`).then((r) => { if (!r.ok) throw new Error(f + ' ' + r.status); return r.json(); });
    M = await get('manifest.json');
    // A property type with only a handful of rows would just render grey everywhere.
    M.types = M.types.filter((t) => t.sale + t.rent >= 20);
    POLY = M.levels.filter((l) => l.kind === 'polygon');
    PT = M.levels.find((l) => l.kind === 'point') || null;
    LEAF = POLY.find((l) => l.colorScale) || POLY[POLY.length - 1];
    const jobs = POLY.map((lv) => get(`levels/${lv.key}.geojson`));
    jobs.push(get('points.json'), get('places.json'), PT ? get('areas.json') : Promise.resolve([]), M.societies ? get('societies.json') : Promise.resolve([]));
    const res = await Promise.all(jobs);
    POLY.forEach((lv, i) => {
      A[lv.key] = res[i].features.map((f) => ({ feature: f, props: f.properties, name: f.properties.name, geometry: f.geometry, bbox: bboxOf(f.geometry), center: [f.properties.cx, f.properties.cy] }));
    });
    pts = res[POLY.length];
    places = res[POLY.length + 1];
    if (PT) A.area = res[POLY.length + 2];
    if (M.societies) { A.soc = res[POLY.length + 3]; spreadSocietyPins(); }
    // Rows as objects, reading columns by name.
    const F = {};
    pts.fields.forEach((f, i) => { F[f] = i; });
    const lvKeys = M.levels.map((l) => l.key);
    rows = pts.rows.map((r, idx) => {
      const lv = {};
      lvKeys.forEach((k) => { lv[k] = r[F[k]]; });
      return { idx, lon: r[F.lon], lat: r[F.lat], t: r[F.type], d: r[F.deal], size: r[F.size], rate: r[F.rate], lr: Math.log(r[F.rate]), date: r[F.date], src: r[F.src], bhk: r[F.bhk], soc: r[F.soc], url: r[F.url], lv };
    });
    Object.keys(A).forEach((k) => { rowsBy[k] = A[k].map(() => []); });
    rows.forEach((r) => {
      Object.keys(A).forEach((k) => { const i = k === 'soc' ? r.soc : r.lv[k]; if (i >= 0) rowsBy[k][i].push(r); });
    });
    grid = buildGrid();
    initSurface();
    await loadHeightIndex();
  }

  async function boot() {
    try {
      cities = await fetch('/data/cities.json').then((r) => r.json());
    } catch (e) { cities = [{ id: 'bengaluru', name: 'Bengaluru', sample: true }]; }
    const want = requestedCity();
    CITY = cities.some((c) => c.id === want) ? want : cities[0].id;
    store.set('bpm-city', CITY);
    const cityName = cities.find((c) => c.id === CITY).name;
    $('loader-text').textContent = `Loading ${cityName}…`;
    $('brand-city').textContent = cityName;
    document.title = `${cityName} Price Map`;
    if (isMobile()) $('filters').classList.add('collapsed');

    await loadCity();
    S.unit = M.defaultUnit || 'yd';
    setSeg('unit-seg', 'unit', S.unit);
    $('demo-pill').textContent = M.sample ? 'Prototype · sample prices' : `Prototype · real data, ${fmtDate(M.asOf)}`;
    $('demo-pill').classList.toggle('real', !M.sample);
    buildControls();
    setType(0);

    map = new maplibregl.Map({
      container: 'map', style: STYLES[S.theme],
      center: M.view.center, zoom: (isMobile() ? M.view.mobileZoom : M.view.zoom) - 0.9, pitch: 0, bearing: 0,
      minZoom: 8.5, maxZoom: 18, maxPitch: 70,
      maxBounds: [[M.bbox[0] - 0.35, M.bbox[1] - 0.3], [M.bbox[2] + 0.35, M.bbox[3] + 0.3]],
      attributionControl: false, antialias: true,
    });
    map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: `${M.sample ? 'Prices: sample data' : 'Prices: ' + esc(M.dataLabel)}${M.heights ? ' · Heights: Google Open Buildings 2.5D (CC BY 4.0)' : ''} · Boundaries: see About`,
    }), 'bottom-right');
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'tip', offset: 12, maxWidth: '290px' });
    ptPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, offset: 10, maxWidth: '270px' });
    wireMapEvents();
    await new Promise((res) => map.once('load', res));

    ready = true;
    addLayers();
    buildSearch();
    updateCrumbs();
    $('loader').classList.add('done');
    document.querySelectorAll('.maplibregl-ctrl-attrib.maplibregl-compact-show').forEach((el) => {
      el.classList.remove('maplibregl-compact-show');
      el.removeAttribute('open');
    });
    map.easeTo({ ...homeView(), duration: 2600, essential: true });
    if (store.get('bpm-welcomed-' + CITY) !== '1') setTimeout(openAbout, 900);
    else setTimeout(() => toast(isMobile() ? 'Tap an area for details. Two-finger drag to tilt.' : 'Click any area for details · Right-drag to tilt and rotate', 4200), 2700);
  }

  boot().catch((err) => {
    console.error(err);
    $('loader-text').textContent = 'Could not load the map data. Run a local web server (see README).';
  });

  // Exposed for debugging in the browser console.
  window.__bpm = { S, A, stats, get map() { return map; }, get M() { return M; }, openArea, assigned: () => assigned, heights: () => !!HGT.meta };
})();
