/* ============================================================
   Woods Hole · wind, tide & current
   All data is fetched client-side from public CORS-enabled APIs:
     - NOAA CO-OPS (tides, water/air temp, current predictions,
                    New Bedford & Woods Hole gauges for bay–sound setup)
     - Open-Meteo   (wind + temperature forecast grid, sun times)
     - Google Weather API (optional wind, temperature and rain via a secret-backed Worker)
     - NWS          (marine alerts) · Weather Underground (WHYC live wind)
     - NECOFS       (optional data/necofs.json, refreshed nightly by a
                     GitHub Action — model surface currents for the sounds)
   The water itself is rendered as a WebGL texture whose motion and
   color show the current; wind is a particle layer with its own ramp.
   ============================================================ */
'use strict';

/* ------------------------------ config ------------------------------ */

const FIT_BOUNDS = [[41.490139, -70.714958], [41.547455, -70.628103]];
// pan/zoom stays inside the baked-geography region (tools/bake_geo.py), so
// the rendered land always has full-resolution static data under it
// wide view: all of Martha's Vineyard plus a margin ring of coast. The
// forecast fields (flow/wind/tide) stop at the baked OUTER box; beyond it
// the chart alone carries the map.
const MAX_BOUNDS = [[41.200, -71.050], [41.700, -70.300]];
const DATA_BOX = { la0: 41.200, la1: 41.700, lo0: -71.05, lo1: -70.30 };
const CENTER = { lat: 41.5205, lng: -70.6770 };          // middle of the Hole

const TIDE_STATION = '8447930';                          // NOAA, on the WHOI dock
const NB_STATION = '8447636';                            // New Bedford Harbor (Buzzards Bay side)

const CURRENT_STATIONS = [
  // wx = response of this station to the observed bay–sound head difference (kn per adjusted kn)
  { id: 'COD0911', name: 'Woods Hole — the Strait', short: 'the Strait', lat: 41.5193, lng: -70.6829, kind: 'H', primary: true, wx: 1.0 },
  { id: 'COD0910', name: 'Woods Hole — north end',  short: 'north end',  lat: 41.5230, lng: -70.6930, kind: 'H', wx: 0.85 },
  { id: 'COD0912', name: 'Juniper Point',           short: 'Juniper Pt', lat: 41.5159, lng: -70.6717, kind: 'H', wx: 0.7 },
  { id: 'ACT1821', name: 'Nobska Point · 1.8 mi E', short: 'E of Nobska', lat: 41.5183, lng: -70.6183, kind: 'S' },
  { id: 'ACT1831', name: 'Nobska Point · 1 mi SE',  short: 'SE of Nobska', lat: 41.5017, lng: -70.6433, kind: 'S' },
  { id: 'COD0913', name: 'Robinsons Hole — Naushon Pt', short: 'Robinsons Hole', lat: 41.4497, lng: -70.8067, kind: 'H', wx: 0.7 },
  { id: 'COD0915', name: 'Canapitsit Channel', short: 'Canapitsit', lat: 41.4241, lng: -70.9079, kind: 'H', wx: 0.6 },
  { id: 'ACT1956', name: 'Quissett Harbor entrance', short: 'Quissett',  lat: 41.5400, lng: -70.6633, kind: 'S' },
  { id: 'ACT1951', name: 'Weepecket Island, south of', short: 'Weepecket', lat: 41.5067, lng: -70.7383, kind: 'S' },
];

// Wind background grid (row-major, lats × lngs), ~4.5 km spacing; the
// -70.675 column and 41.525 row pass through the harbor
const GRID_LATS = [41.400, 41.4417, 41.4833, 41.525, 41.5667, 41.6083, 41.650];
const GRID_LNGS = [-70.900, -70.84375, -70.7875, -70.73125, -70.675, -70.61875, -70.5625, -70.50625, -70.450];
// REGIONAL constraint stations: open marine anemometers whose ratio to the
// sheltered background sets the driving amplitude, spread by distance
// kernels. h10 = published-anemometer-height log correction to 10 m.
const WIND_CONS_STATIONS = [
  // truly marine platforms only. Wharf-sited town gauges (Newport,
  // Nantucket CO-OPS) carry unresolvable town shelter outside the atlas
  // and once read 0.4x the regional wind into the average: excluded.
  { id: 'BUZM3', name: 'Buzzards Bay tower', lat: 41.396, lng: -71.033, src: 'nws', h10: 0.922 },   // 24.8 m
  { id: '44020', name: 'Nantucket Sound buoy', lat: 41.497, lng: -70.283, src: 'erddap', h10: 1.088 }, // 4.1 m
];
// EXACT stations: in-village sensors pinned exactly through their baked
// influence patches (wind_g.png). The map equals these at their location.
// regional: waterfront sitings the solved atlas resolves (open shore, no
// sub-cell obstacles) ALSO constrain the driving amplitude through their
// own transfer; a village-garden siting (Mill Pond) stays local-only.
// Tempest stations activate when a token is stored (localStorage whTempest).
const WIND_EXACT_STATIONS = [
  { id: 'KMAWOODS477', lat: 41.52745, lng: -70.67577, src: 'whyc', regional: true },
  { id: 'tempest81687', lat: 41.53953, lng: -70.66666, src: 'tempest', dev: 81687, regional: true },
  { id: 'tempest23779', lat: 41.52765, lng: -70.67119, src: 'tempest', dev: 23779 },
];
// display/fallback METAR sites (constraints no longer: HRRR already
// assimilates airports; their siting is land boundary layer)
const WIND_OBS_STATIONS = [
  { id: 'KFMH', lat: 41.658, lng: -70.521 },   // Otis / Joint Base Cape Cod
  { id: 'KMVY', lat: 41.393, lng: -70.615 },   // Martha's Vineyard airport
  { id: 'KEWB', lat: 41.676, lng: -70.957 },   // New Bedford
  { id: 'BUZM3', lat: 41.396, lng: -71.033 },  // Buzzards Bay tower — THE SW-wind reference
];

const HOURS_FWD = 72, HOURS_BACK = 6;
const COOPS = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?';
const MARINE_ZONES = 'ANZ233,ANZ234';                    // Vineyard Sound, Buzzards Bay

// Woods Hole Yacht Club weather station on Great Harbor (Weather Underground).
// The apiKey below is the public web-client key wunderground.com ships in its own
// frontend — if WU rotates it someday this fetch fails gracefully and Otis/KFMH takes over.
const WU_URL = 'https://api.weather.com/v2/pws/observations/current?stationId=KMAWOODS477'
  + '&format=json&units=e&numericPrecision=decimal&apiKey=e1f10a1e78da46f5b10a1e78da96f525';
const MPH_KN = 0.868976;

const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOBILE_MAP = matchMedia('(pointer: coarse)').matches;

function runWhenIdle(fn, timeout = 4000) {
  if ('requestIdleCallback' in window) requestIdleCallback(() => fn(), { timeout });
  else setTimeout(fn, Math.min(timeout, 1500));
}

/* --- color ramps (shared by the WebGL shader, particle layer, and legend bars) --- */

/* Water color is aesthetic — a gentle Cape blue that deepens slightly with
   speed. Magnitude is carried by the arrow field, not the hue. */
const WATER_RAMP = [                 // [kn, [r, g, b, alpha]]
  [0.0, [175, 207, 223, 0.55]],
  [0.6, [140, 186, 211, 0.63]],
  [1.4, [104, 164, 199, 0.71]],
  [2.4, [76, 145, 187, 0.77]],
  [3.5, [56, 128, 176, 0.81]],
];
const WATER_KN_MAX = 3.5;

// dynamic display scales (updated by fillLegend from the 72-h window)
let curScaleMax = 3;                 // in-frame autoscale, floor 3 kn
let windScaleMax = 10;               // in-frame autoscale, with a 10 kn floor

function rampLookup(stops, kn) {
  if (kn <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (kn <= stops[i][0]) {
      const [k0, c0] = stops[i - 1], [k1, c1] = stops[i];
      const f = (kn - k0) / (k1 - k0);
      return c0.map((v, j) => v + (c1[j] - v) * f);
    }
  }
  return stops[stops.length - 1][1];
}

/* ------------------------------ state ------------------------------ */

const S = {
  tNow: Date.now(),
  tMin: 0, tMax: 0,
  tScrub: Date.now(),
  live: true,
  playing: false,
  tide: null,            // {times:[], vals:[]}
  hilo: [],              // [{t, v, type}]
  wind: null,            // grid {times, u[p][], v[p][], g[p][]}
  centerWx: null,        // {times, temp}
  sun: [],               // [{rise, set}]
  currents: [],          // per station: {cfg, floodDir, ebbDir, fn(t), events}
  head: null,            // observed New Bedford − Woods Hole residual (ft): {times, vals, tLast, last}
  necofs: null,          // model surface currents from data/necofs.json
  obs: {},               // {wl, wtemp, atemp, wlT}
  whyc: null,            // live wind at the Yacht Club
  kfmh: null,            // fallback live wind (Otis)
  alerts: [],
};

/* ------------------------------ utils ------------------------------ */

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const KTS = 0.539957;    // km/h → kn

const fmtT   = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const fmtDW  = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
const fmtDWd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric' });
const fmtClk = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

const COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

function parseGmt(s) { return Date.parse(s.replace(' ', 'T') + 'Z'); }        // "2026-07-12 17:24" (gmt)
function beginDateUTC(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  // rounded to the hour so cache keys repeat between reloads
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())} ${p(d.getUTCHours())}:00`;
}
function coopsURL(params) {
  return COOPS + new URLSearchParams(Object.assign({
    application: 'bezialemma.com-WoodsHole', time_zone: 'gmt', units: 'english', format: 'json',
  }, params)).toString();
}

// linear interpolation into a sorted time series
function interp(times, vals, t) {
  const n = times.length;
  if (!n) return null;
  if (t <= times[0]) return vals[0];
  if (t >= times[n - 1]) return vals[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; (times[m] <= t) ? lo = m : hi = m; }
  const f = (t - times[lo]) / (times[hi] - times[lo]);
  return vals[lo] + f * (vals[hi] - vals[lo]);
}

// freshness ledger: the newest moment we actually obtained live data —
// when it ages (offline on the water), the readout says so quietly
function noteDataAge(t, url) {
  if (url.charAt(0) !== 'h') return;           // remote live endpoints only
  if (!S.dataAsOf || t > S.dataAsOf) S.dataAsOf = t;
}

// drop cached responses older than maxAgeMs (also the quota-pressure valve)
function pruneCache(maxAgeMs) {
  try {
    const now = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('wh1:')) continue;
      const v = JSON.parse(localStorage.getItem(k) || '{}');
      if (!v.t || now - v.t > maxAgeMs) localStorage.removeItem(k);
    }
  } catch (e) {}
}

// hourly begin_date / 3-h necofs bucket rotate the URL: without eviction the
// dead siblings accrete until the origin quota kills every later write
const rotStem = (k) => k.replace(/(begin_date=)[^&]*/, '$1').replace(/([?&]b=)[^&]*/, '$1');
function evictCacheSiblings(key) {
  const stem = rotStem(key);
  if (stem === key) return;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k !== key && k.startsWith('wh1:') && rotStem(k) === stem) localStorage.removeItem(k);
    }
  } catch (e) {}
}

// cached fetch: TTL-fresh from localStorage, falls back to stale copy on failure
async function fetchJSON(url, ttl) {
  const key = 'wh1:' + url.slice(0, 400);
  const now = Date.now();
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) {}
  if (cached && now - cached.t < ttl) { noteDataAge(cached.t, url); return cached.d; }
  try {
    const opts = {};
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(20000);
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error('http ' + r.status);
    const d = await r.json();
    // NOAA answers 200 with {error:{...}} when a product is down — that is
    // a failure, not data: never cache it, fall through to the stale copy
    if (d && typeof d === 'object' && d.error && Object.keys(d).length === 1) {
      throw new Error('api error body');
    }
    // the service worker answers a dead network with an old cached 200: date
    // the data by the response's own Date header, not by when we received it
    let obsT = Date.parse(r.headers.get('date') || '') || now;
    if (obsT > now) obsT = now;
    evictCacheSiblings(key);
    try { localStorage.setItem(key, JSON.stringify({ t: obsT, d })); } catch (e) {
      pruneCache(6 * 3600e3);
      try { localStorage.setItem(key, JSON.stringify({ t: obsT, d })); } catch (e2) {}
    }
    noteDataAge(obsT, url);
    return d;
  } catch (err) {
    if (cached) { noteDataAge(cached.t, url); return cached.d; }
    throw err;
  }
}

/* ------------------------------ data loaders ------------------------------ */

async function loadTide() {
  const begin = beginDateUTC(S.tNow - 14 * 3600e3);
  const [pred, hilo] = await Promise.all([
    fetchJSON(coopsURL({ product: 'predictions', datum: 'MLLW', station: TIDE_STATION, begin_date: begin, range: 104, interval: 6 }), 3 * 3600e3),
    fetchJSON(coopsURL({ product: 'predictions', datum: 'MLLW', station: TIDE_STATION, begin_date: begin, range: 104, interval: 'hilo' }), 3 * 3600e3),
  ]);
  S.tide = { times: pred.predictions.map(p => parseGmt(p.t)), vals: pred.predictions.map(p => +p.v) };
  S.hilo = hilo.predictions.map(p => ({ t: parseGmt(p.t), v: +p.v, type: p.type }));
}

/* Haight 1936 survey stations (C&GS SP 208, transcribed from Tables 10-12):
   ninety-year-old lead-line current measurements, but the tide doesn't age —
   each station gives flood/ebb strength, true direction and timing referenced
   to Boston high/low water. Reconstructed per-station as an event ladder
   (slack → max flood → slack → max ebb) with cosine easing, then blended into
   the model field as gaussian-weighted local truth. This is real surveyed
   structure (the Hedge Fence flood-axis flip, the West Chop acceleration)
   that two streamfunction modes cannot know. */
async function loadHaight() {
  const hiloReq = (station) => fetchJSON(coopsURL({ product: 'predictions', datum: 'MLLW', station,
    begin_date: beginDateUTC(S.tNow - 20 * 3600e3), range: 110, interval: 'hilo' }), 3 * 3600e3);
  const [d, hilo, hiloNB] = await Promise.all([
    fetchJSON('data/haight.json?v=3', 24 * 3600e3),
    hiloReq('8443970'),                 // Boston — Sound-table reference
    hiloReq('8447636'),                 // New Bedford — Buzzards-table (Clark Pt) reference
  ]);
  const evs = (h) => (h && h.predictions ? h.predictions.map((x) => ({ t: parseGmt(x.t), type: x.type })) : []);
  S.haight = { stations: d.stations, boston: evs(hilo), nb: evs(hiloNB) };
  buildHaightField();
}

let haightF = null;   // [{lat,lng,fDirU,eDirU,events:[{t,v}]}] with v signed (+flood)

/* --- L1 Vineyard Sound Lightship: true harmonic prediction ---------------
   SP 208 Table 16 gives M2 + M4 velocity components (58 days, 1913, pole at
   7 ft) with GREENWICH epochs; components are along MAGNETIC axes (var 13 W).
   v_N(t) = sum f·H·cos(V(t) + u − G) per constituent, rotated to true.
   The equilibrium argument uses V(M2) = 2·(GMST − s): its rate is exactly
   the M2 speed 28.9841 deg/h. M4 doubles everything; f,u from the lunar
   node (Schureman). The other constituents were never reduced for L1, so
   springs/neaps ride on the same live strait-derived factor as the rest of
   the survey blend. --- */
const HARM_L1 = {
  lat: 41.379, lng: -70.948,
  comps: [
    { mul: 1, N: [0.449, 295], E: [0.169, 34] },     // M2: H kn, G deg
    { mul: 2, N: [0.034, 16], E: [0.029, 183] },     // M4
  ],
};
function harmonicV(t) {
  const d = (t - Date.UTC(2000, 0, 1, 12)) / 86400e3;   // days since J2000
  const T = d / 36525;
  const s = 218.3164477 + 481267.88123421 * T;          // mean lunar longitude
  const N = (125.04452 - 1934.13626197 * T) * Math.PI / 180;
  const gmst = 280.46061837 + 360.98564736629 * d;
  const V2 = 2 * (gmst - s);                            // M2 equilibrium argument
  const u2 = -2.14 * Math.sin(N);
  const f2 = 1.0004 - 0.0373 * Math.cos(N);
  let vN = 0, vE = 0;
  for (const c of HARM_L1.comps) {
    const arg = (c.mul * (V2 + u2)) * Math.PI / 180;
    const f = Math.pow(f2, c.mul);
    vN += f * c.N[0] * Math.cos(arg - c.N[1] * Math.PI / 180);
    vE += f * c.E[0] * Math.cos(arg - c.E[1] * Math.PI / 180);
  }
  // magnetic axes -> true (variation 13 W in 1913): mag-north points 347 true
  const cD = 0.97437, sD = -0.22495;
  return [cD * vE + sD * vN, -sD * vE + cD * vN];       // [east, north] kn
}

// today's tide range vs the mean: SP 208 velocities are means, and springs/
// perigean each run ~20% above them (p.83) — scale by the live strait cycle
let haightSpringCache = { t: 0, k: 1 };
function haightSpring(t) {
  if (Math.abs(t - haightSpringCache.t) < 30 * 60e3) return haightSpringCache.k;
  const st = S.currents && S.currents.find((x) => x.cfg.id === 'COD0911');
  let k = 1;
  if (st) {
    let mx = 0;
    for (let dt = -6; dt <= 6; dt += 0.75) {
      mx = Math.max(mx, Math.abs(stationV(st, t + dt * 3600e3)));
    }
    if (mx > 0.5) k = clamp(mx / 3.4, 0.75, 1.35);
  }
  haightSpringCache = { t, k };
  return k;
}
function buildHaightField() {
  const H = S.haight;
  if (!H || !H.boston || !H.boston.length) { haightF = null; return; }
  const out = [];
  for (const st of H.stations) {
    const fu = (deg) => [Math.sin(deg * Math.PI / 180), Math.cos(deg * Math.PI / 180)];
    const events = [];
    if (st.ref === 'nb') {
      // Buzzards Bay tables: all four hours count from HIGH water at Clark
      // Point (New Bedford) — a different clock from the Boston-keyed Sound
      // tables, hours apart across the Hole
      if (!H.nb || !H.nb.length) continue;
      for (const b of H.nb) {
        if (b.type !== 'H') continue;
        events.push({ t: b.t + st.sF * 3600e3, v: 0 });
        events.push({ t: b.t + st.fT * 3600e3, v: st.fK });
        events.push({ t: b.t + st.sE * 3600e3, v: 0 });
        events.push({ t: b.t + st.eT * 3600e3, v: -st.eK });
      }
    } else {
      for (const b of H.boston) {
        if (b.type === 'L') {
          events.push({ t: b.t + st.sF * 3600e3, v: 0 });
          events.push({ t: b.t + st.fT * 3600e3, v: st.fK });
        } else {
          events.push({ t: b.t + st.sE * 3600e3, v: 0 });
          events.push({ t: b.t + st.eT * 3600e3, v: -st.eK });
        }
      }
    }
    events.sort((a, b) => a.t - b.t);
    out.push({ lat: st.lat, lng: st.lng, fDir: fu(st.fD), eDir: fu(st.eD), events });
  }
  // the lightship rides along as a continuous harmonic pseudo-station
  out.push({ lat: HARM_L1.lat, lng: HARM_L1.lng, harm: true });
  haightF = out;
}

// signed speed at time t from the station's event ladder (cosine easing,
// same shape the NOAA subordinate stations use)
function haightV(st, t) {
  const ev = st.events;
  if (!ev.length || t < ev[0].t || t > ev[ev.length - 1].t) return 0;
  let lo = 0, hi = ev.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ev[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = ev[lo], b = ev[hi];
  const f = (t - a.t) / Math.max(1, b.t - a.t);
  return a.v + (b.v - a.v) * (1 - Math.cos(Math.PI * f)) / 2;
}

async function loadObs() {
  const get = (product, extra) =>
    fetchJSON(coopsURL(Object.assign({ product, station: TIDE_STATION, date: 'latest' }, extra)), 4 * 60e3)
      .then(d => d.data && d.data[0]).catch(() => null);
  const [wl, wt, at] = await Promise.all([
    get('water_level', { datum: 'MLLW' }), get('water_temperature'), get('air_temperature'),
  ]);
  if (wl) { S.obs.wl = +wl.v; S.obs.wlT = parseGmt(wl.t); }
  if (wt) S.obs.wtemp = +wt.v;
  if (at) S.obs.atemp = +at.v;
  try {
    const wu = await fetchJSON(WU_URL, 4 * 60e3);
    const o = wu.observations && wu.observations[0];
    if (o && o.imperial && o.imperial.windSpeed != null) {
      S.whyc = {
        t: (o.epoch || 0) * 1000 || Date.parse(o.obsTimeUtc),
        dir: o.winddir,
        spd: o.imperial.windSpeed * MPH_KN,
        gst: o.imperial.windGust != null ? o.imperial.windGust * MPH_KN : null,
        temp: o.imperial.temp,
        lat: typeof o.lat === 'number' ? o.lat : null,
        lng: typeof o.lon === 'number' ? o.lon : null,
      };
      if (windMk.KMAWOODS477 && S.whyc.lat) windMk.KMAWOODS477.setLatLng([S.whyc.lat, S.whyc.lng]);
      try { recalcWindCons(); } catch (e2) {}
    }
  } catch (e) {}
  try {
    const k = await fetchJSON('https://api.weather.gov/stations/KFMH/observations/latest', 8 * 60e3);
    const p = k.properties;
    if (p && p.windSpeed && p.windSpeed.value != null) {
      S.kfmh = {
        t: Date.parse(p.timestamp),
        spd: p.windSpeed.value * KTS,
        gst: p.windGust && p.windGust.value != null ? p.windGust.value * KTS : null,
        dir: p.windDirection ? p.windDirection.value : null,
      };
    }
  } catch (e) {}
}

/* Observed (not predicted) sea-level difference New Bedford − Woods Hole.
   Wind setup across Buzzards Bay shows up here and drives day-scale current
   anomalies through the Hole — the part of the flow that "doesn't follow
   the tides". Smoothed ~2.5 h to isolate the subtidal signal. */
async function loadResiduals() {
  const begin = beginDateUTC(S.tNow - 30 * 3600e3);
  const get = async (sta) => {
    const [o, p] = await Promise.all([
      fetchJSON(coopsURL({ product: 'water_level', datum: 'MLLW', station: sta, begin_date: begin, range: 31 }), 8 * 60e3),
      fetchJSON(coopsURL({ product: 'predictions', datum: 'MLLW', station: sta, begin_date: begin, range: 31, interval: 6 }), 3 * 3600e3),
    ]);
    const om = new Map((o.data || []).map(d => [d.t, +d.v]));
    const ts = [], r = [];
    for (const pr of (p.predictions || [])) {
      const ov = om.get(pr.t);
      if (ov != null && isFinite(ov)) { ts.push(parseGmt(pr.t)); r.push(ov - +pr.v); }
    }
    return { ts, r };
  };
  const [nb, wh] = await Promise.all([get(NB_STATION), get(TIDE_STATION)]);
  if (!nb.ts.length || !wh.ts.length) return;
  const times = [], vals = [];
  for (let i = 0; i < wh.ts.length; i++) {
    const rn = interp(nb.ts, nb.r, wh.ts[i]);
    if (rn == null) continue;
    times.push(wh.ts[i]);
    vals.push(rn - wh.r[i]);
  }
  const HW = 12;                       // ±12 six-minute samples ≈ 2.4 h boxcar
  const sm = vals.map((_, i) => {
    let s = 0, n = 0;
    for (let k = -HW; k <= HW; k++) { const j = i + k; if (j >= 0 && j < vals.length) { s += vals[j]; n++; } }
    return s / n;
  });
  if (times.length) S.head = { times, vals: sm, tLast: times[times.length - 1], last: sm[sm.length - 1] };
}

// bay–sound setup → passage current anomaly, in kn (flood positive).
// Gain: the ~1.5–2 ft tidal head drives ~2.5–3.5 kn, so ≈1.2 kn per ft.
function headDiffKn(t) {
  const H = S.head;
  if (!H) return 0;
  const dh = (t <= H.tLast)
    ? interp(H.times, H.vals, t)
    : H.last * Math.exp(-(t - H.tLast) / (18 * 3600e3));   // decay toward 0 in the forecast
  return clamp((dh || 0) * 1.2, -1.6, 1.6);
}

/* ---- astronomical current prediction (baked NOAA harmonic fit) ----
   data/current_harmonics.json holds, per station, constituent amplitude
   and phase fitted against a year of official predictions (holdout RMS
   0.03-0.10 kn). The app predicts currents offline, indefinitely; the
   live NOAA series is a cross-check, not a dependency. */
let HARM = null;
async function loadCurrentHarmonics() {
  try { HARM = await fetchJSON('data/current_harmonics.json?v=3', 24 * 3600e3); } catch (e) {}
}

function harmAstro(th) {               // mean longitudes (deg) at th hours past 1899-12-31 12:00 GMT
  const T = th / 876600.0, T2 = T * T;
  return [
    (277.0248 + 481267.8906 * T + 0.0011 * T2) % 360,
    (280.1895 + 36000.7689 * T + 0.0003 * T2) % 360,
    (334.3853 + 4069.0340 * T - 0.0103 * T2) % 360,
    (259.1568 - 1934.1420 * T + 0.0021 * T2) % 360,
    (281.2209 + 1.7192 * T) % 360,
  ];
}

const _nodalMemo = new Map();
function harmNodal(fid, N) {           // [f, u_deg]
  const key = fid + '|' + N.toFixed(2);
  const hit = _nodalMemo.get(key);
  if (hit) return hit;
  const out = _harmNodal(fid, N);
  if (_nodalMemo.size > 400) _nodalMemo.clear();
  _nodalMemo.set(key, out);
  return out;
}
function _harmNodal(fid, N) {
  const Nr = N * Math.PI / 180;
  const c1 = Math.cos(Nr), c2 = Math.cos(2 * Nr), s1 = Math.sin(Nr), s2 = Math.sin(2 * Nr);
  const fM2 = 1.0004 - 0.0373 * c1 + 0.0002 * c2, uM2 = -2.14 * s1;
  switch (fid) {
    case 1: return [fM2, uM2];
    case 2: return [1.0089 + 0.1871 * c1 - 0.0147 * c2, 10.80 * s1 - 1.34 * s2];
    case 3: return [1.0060 + 0.1150 * c1 - 0.0088 * c2, -8.86 * s1 + 0.68 * s2];
    case 4: return [1.0241 + 0.2863 * c1 + 0.0083 * c2, -17.74 * s1 + 0.68 * s2];
    case 5: return [1.0129 + 0.1676 * c1 - 0.0170 * c2, -12.94 * s1 + 1.34 * s2];
    case 6: return [1.1027 + 0.6504 * c1 + 0.0317 * c2, -36.68 * s1 + 4.02 * s2];
    case 7: return [Math.pow(fM2, 1.5), 1.5 * uM2];
    case 11: return [fM2 * fM2, 2 * uM2];
    case 111: return [fM2 * fM2 * fM2, 3 * uM2];
    case 13: { const k = _harmNodal(3, N); return [fM2 * k[0], uM2 + k[1]]; }
    case 112: { const k = _harmNodal(3, N); return [fM2 * fM2 * k[0], 2 * uM2 - k[1]]; }
    default: return [1, 0];
  }
}

const HARM_EPOCH = Date.UTC(1899, 11, 31, 12, 0, 0);
function harmV(h, t) {                 // signed kn from the baked constituent set
  const th = (t - HARM_EPOCH) / 3600e3;
  const a = harmAstro(th);
  const tau = ((15 * th) % 360 + 180 - a[0] + a[1]);
  let v = h.mean_kn;
  for (const c of h.consts) {
    const d = c.d;
    const V = d[0] * tau + d[1] * a[0] + d[2] * a[1] + d[3] * a[2] + d[4] * a[3] + d[5] * a[4] + c.k * 90;
    const fu = harmNodal(c.f, a[3]);
    v += fu[0] * c.a * Math.cos((V + fu[1] - c.p) * Math.PI / 180);
  }
  return v;
}

function stationV(st, t) {             // signed kn at a station, incl. weather adjustment
  // astronomical base (the book, computed); live NOAA series only as
  // fallback when the harmonic pack is missing
  const h = HARM && HARM[st.cfg.id];
  let v = h ? harmV(h, t) : (st.fn(t) || 0);
  if (st.cfg.wx) v += headDiffKn(t) * st.cfg.wx;
  return v;
}

function stationLiveV(st, t) {         // the NOAA series, for cross-check display
  return st.fn ? st.fn(t) : null;
}

// The endpoint contains no key; the Worker keeps credentials and forecasts off GitHub.
const GOOGLE_WEATHER_ENDPOINT = document.querySelector('meta[name="google-weather-endpoint"]')?.content.trim() || '';
let googleWeatherBase = null, googleWeatherExpiry = 0, googleWeatherTimer = null;
function refreshForecastDisplay() {
  recalcWindCons();
  buildTimeline();
  fillLegend();
  if (waterGL) { waterGL.flowDirty(); waterGL._reset(); }
  if (windArrows) windArrows.notifyTime();
  requestReadout();
}
function clearGoogleWeather(redraw = false) {
  clearTimeout(googleWeatherTimer);
  if (!googleWeatherBase) return;
  S.wind = googleWeatherBase.wind;
  S.centerWx = googleWeatherBase.wx;
  googleWeatherBase = null;
  googleWeatherExpiry = 0;
  const attribution = $('google-weather-attribution');
  if (attribution) attribution.hidden = true;
  if (redraw) refreshForecastDisplay();
}
async function loadWeatherSources() {
  clearGoogleWeather();
  const google = async () => {
    if (!GOOGLE_WEATHER_ENDPOINT) return null;
    // Deliberately bypass fetchJSON, localStorage, and offline service-worker caches.
    const response = await fetch(GOOGLE_WEATHER_ENDPOINT, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('Google forecast unavailable');
    return response.json();
  };
  const results = await Promise.allSettled([loadWind(), loadCenterWx(), google()]);
  const data = results[2].status === 'fulfilled' ? results[2].value : null;
  const merged = WoodsHoleGoogle.merge(S.wind, S.centerWx, data, GRID_LATS, GRID_LNGS);
  if (!merged) return; // Open-Meteo remains available when Google fails or is incomplete.
  googleWeatherBase = { wind: S.wind, wx: S.centerWx };
  S.wind = merged.wind;
  S.centerWx = merged.wx;
  googleWeatherExpiry = merged.expiresAt;
  $('google-weather-attribution').hidden = false;
  googleWeatherTimer = setTimeout(() => clearGoogleWeather(true), Math.max(0, googleWeatherExpiry - Date.now()));
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && googleWeatherBase && Date.now() >= googleWeatherExpiry) clearGoogleWeather(true);
});

async function loadWind() {
  const lats = [], lngs = [];
  for (const la of GRID_LATS) for (const lo of GRID_LNGS) { lats.push(la); lngs.push(lo); }
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lats.join(',')}&longitude=${lngs.join(',')}`
    + '&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m'
    + '&wind_speed_unit=kn&timeformat=unixtime&timezone=UTC&past_days=1&forecast_days=5';
  const arr = await fetchJSON(url, 25 * 60e3);
  const pts = Array.isArray(arr) ? arr : [arr];
  const times = pts[0].hourly.time.map(t => t * 1000);
  const u = [], v = [], g = [];
  for (const p of pts) {
    const spd = p.hourly.wind_speed_10m, dir = p.hourly.wind_direction_10m;
    const uu = new Array(times.length), vv = new Array(times.length);
    for (let k = 0; k < times.length; k++) {
      const r = (dir[k] || 0) * Math.PI / 180, s = spd[k] || 0;
      uu[k] = -s * Math.sin(r);          // eastward, kn
      vv[k] = -s * Math.cos(r);          // northward, kn
    }
    u.push(uu); v.push(vv); g.push(p.hourly.wind_gusts_10m);
  }
  S.wind = { times, u, v, g, nx: GRID_LNGS.length, ny: GRID_LATS.length };
}

async function loadCenterWx() {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${CENTER.lat}&longitude=${CENTER.lng}`
    + '&hourly=temperature_2m,precipitation,weather_code&temperature_unit=fahrenheit'
    + '&daily=sunrise,sunset&timeformat=unixtime&timezone=America%2FNew_York&past_days=1&forecast_days=5';
  const d = await fetchJSON(url, 60 * 60e3);
  S.centerWx = {
    times: d.hourly.time.map(t => t * 1000),
    temp: d.hourly.temperature_2m,
    rain: d.hourly.precipitation || [],           // mm/h
    wcode: d.hourly.weather_code || [],           // WMO: 95-99 thunderstorm
  };
  S.sun = d.daily.sunrise.map((r, i) => ({ rise: r * 1000, set: d.daily.sunset[i] * 1000 }));
}

function mkCurStation(cfg, series, events) {
  const evRaw = (events && events.current_predictions && events.current_predictions.cp) || [];
  if (!evRaw.length && !series) return null;
  const meta = evRaw[0] || (series.current_predictions.cp[0] || {});
  const st = {
    cfg,
    floodDir: +meta.meanFloodDir,
    ebbDir: +meta.meanEbbDir,
    events: evRaw.map(e => ({ t: parseGmt(e.Time), v: +e.Velocity_Major, type: e.Type })),
  };
  if (series) {
    const cp = series.current_predictions.cp;
    const times = cp.map(e => parseGmt(e.Time)), vals = cp.map(e => +e.Velocity_Major);
    st.fn = (t) => interp(times, vals, t);
    st.series = { times, vals };
  } else {
    // subordinate station: cosine-ease between slack / max events
    const ev = st.events;
    st.fn = (t) => {
      if (!ev.length) return 0;
      if (t <= ev[0].t) return ev[0].v;
      if (t >= ev[ev.length - 1].t) return ev[ev.length - 1].v;
      let lo = 0;
      while (lo + 1 < ev.length && ev[lo + 1].t <= t) lo++;
      const a = ev[lo], b = ev[Math.min(lo + 1, ev.length - 1)];
      const f = (t - a.t) / Math.max(1, b.t - a.t);
      return a.v + (b.v - a.v) * (1 - Math.cos(Math.PI * f)) / 2;
    };
  }
  return st;
}

async function loadCurrents() {
  const begin = beginDateUTC(S.tNow - 14 * 3600e3);
  const jobs = CURRENT_STATIONS.map(async (cfg) => {
    // a full WEEK of predictions per fetch: when NOAA's currents service
    // goes down (2026-07-17 it did), the salvage tier then has days of
    // real tables in cache before the tide-driven estimate is ever needed
    const base = { product: 'currents_predictions', station: cfg.id, begin_date: begin, range: 182 };
    try {
      const wantSeries = cfg.kind === 'H';
      const [series, events] = await Promise.all([
        wantSeries ? fetchJSON(coopsURL(Object.assign({ interval: 30 }, base)), 3 * 3600e3) : null,
        fetchJSON(coopsURL(Object.assign({ interval: 'MAX_SLACK' }, base)), 3 * 3600e3),
      ]);
      return mkCurStation(cfg, series, events);
    } catch (e) { return null; }
  });
  S.currents = (await Promise.all(jobs)).filter(Boolean);
  S.curSource = S.currents.length ? 'live' : 'none';
  if (!S.currents.length) {
    // NOAA currents down (2026-07-17 it was, region-wide): salvage any
    // earlier day's cached predictions — the astronomy doesn't change, and
    // yesterday's table covers today with room to spare
    const salvaged = [];
    try {
    for (const cfg of CURRENT_STATIONS) {
      let bestSeries = null, bestEvents = null;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.slice(0, 4).startsWith('wh1') || !k.includes('currents_predictions')
          || !k.includes('station=' + cfg.id)) continue;
        let c = null;
        try { c = JSON.parse(localStorage.getItem(k)); } catch (e) { continue; }
        if (!c || !c.d || c.d.error || !c.d.current_predictions) continue;
        if (k.includes('interval=30')) {
          if (!bestSeries || c.t > bestSeries.t) bestSeries = c;
        } else if (!bestEvents || c.t > bestEvents.t) bestEvents = c;
      }
      const st = mkCurStation(cfg, bestSeries && bestSeries.d, bestEvents && bestEvents.d);
      // only trust a salvage that still covers NOW
      if (st && st.events.length && st.events[st.events.length - 1].t > S.tNow + 2 * 3600e3) {
        salvaged.push(st);
      }
    }
    } catch (e) {}   // storage blocked (Safari): the harmonic tier below still runs
    if (salvaged.length) { S.currents = salvaged; S.curSource = 'salvaged'; }
  }
  // harmonic tier: the baked astronomy pack synthesizes any station the
  // live and salvage tiers could not supply — the field never lacks its
  // calibration stations again
  if (HARM) {
    const have = new Set(S.currents.map((c2) => c2.cfg.id));
    for (const cfg of CURRENT_STATIONS) {
      const h = HARM[cfg.id];
      if (!h || have.has(cfg.id)) continue;
      S.currents.push({ cfg, floodDir: h.fd, ebbDir: h.ed, events: [], harmOnly: true });
    }
    if (S.curSource === 'none' && S.currents.length) S.curSource = 'harmonic';
  }
}

/* Real topobathy (one-time bake of NCEI DEMs → data/bathy.json): water depth
   at MLLW on the two solver grids. Feeds the solver's conductance, converts
   transport to tide-dependent speed, and moves the rendered waterline. */
// web-mercator vertical coordinate (all baked rasters are mercator-linear)
function mercY(lat) { return Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)); }
function latOfMercG(my) { return (2 * Math.atan(Math.exp(my)) - Math.PI / 2) * 180 / Math.PI; }

// depth at MLLW everywhere the page can look — read from the baked geo
// rasters (12.8 m core / 25 m outer), which also feed the shader
function depthMLLW(lat, lng) {
  return geoDepth(lat, lng);
}

function tideM(t) {
  if (!S.tide) return 0.55;
  const ft = interp(S.tide.times, S.tide.vals, t);
  let m = (ft == null ? 1.8 : ft) * 0.3048;
  // storm surge / rain-swollen-bay setup: the OBSERVED water level rarely
  // matches the astronomical prediction exactly — carry the measured residual
  // into the waterline, fading as the scrub leaves the observation window.
  // (This feeds everything level-driven: drying flats, stage weights, H(x,t).)
  if (S.obs && S.obs.wl != null && S.obs.wlT) {
    const pred = interp(S.tide.times, S.tide.vals, S.obs.wlT);
    if (pred != null) {
      const resid = (S.obs.wl - pred) * 0.3048;
      const fade = clamp(1 - Math.abs(t - S.obs.wlT) / (6 * 3600e3), 0, 1);
      m += clamp(resid, -0.6, 0.9) * fade;
    }
  }
  return m;
}

/* --- spatial tide atlas: Buzzards Bay runs ~2x the range on a clock hours
   apart from the Sound; the baked atlas carries each pixel's range ratio +
   phase lag vs Woods Hole, and the live WH curve (with surge) drives it --- */
let TIDEA = null;
async function loadTideAtlas() {
  try {
    const meta = await fetchJSON('data/tide.json?v=2', 24 * 3600e3);
    if (!meta || !meta.w || !meta.h) return;
    // NOT img.decode(): its promise can starve forever in a background tab,
    // and this await sits inside boot's allSettled — a never-settling promise
    // here would stall the whole page. onload always fires.
    const img = new Image();
    const loaded = new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('tide.png failed'));
      setTimeout(() => rej(new Error('tide.png timeout')), 15000);
    });
    img.src = 'data/tide.png?v=2';
    await loaded;
    const cv = document.createElement('canvas');
    cv.width = meta.w; cv.height = meta.h;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, meta.w, meta.h).data;
    const n = meta.w * meta.h;
    const ratio = new Float32Array(n), phase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      ratio[i] = (d[i * 4] / 255) * 2;
      phase[i] = (d[i * 4 + 1] / 255) * 9 - 4.5;
    }
    TIDEA = {
      lo0: meta.lo0, lo1: meta.lo1,
      myN: mercY(meta.la1), myS: mercY(meta.la0),
      w: meta.w, h: meta.h, ratio, phase, cnv: cv,
    };
    if (waterGL) waterGL._applyGeo();
  } catch (e) { console.warn('[tide-atlas]', e); }
}

function tideAtlasAt(lat, lng) {
  const A = TIDEA;
  if (!A) return null;
  const fx = clamp((lng - A.lo0) / (A.lo1 - A.lo0), 0, 1) * (A.w - 1);
  const fy = clamp((mercY(lat) - A.myN) / (A.myS - A.myN), 0, 1) * (A.h - 1);
  const i0 = Math.min(A.w - 2, Math.floor(fx)), j0 = Math.min(A.h - 2, Math.floor(fy));
  const ax = fx - i0, ay = fy - j0;
  const g = (arr) => {
    const q = j0 * A.w + i0;
    return arr[q] * (1 - ax) * (1 - ay) + arr[q + 1] * ax * (1 - ay)
      + arr[q + A.w] * (1 - ax) * ay + arr[q + A.w + 1] * ax * ay;
  };
  return { r: g(A.ratio), p: g(A.phase) };
}

// tide height above local MLLW at any point: ratio x the WH curve read at the
// local phase (the surge residual inside tideM rides along, which is right —
// a swollen bay is swollen everywhere on roughly the same clock)
function localTideM(lat, lng, t) {
  const a = tideAtlasAt(lat, lng);
  if (!a) return tideM(t);
  return a.r * tideM(t - a.p * 3600e3);
}

async function loadNecofs() {
  try {
    const bucket = Math.floor(Date.now() / (3600e3 * 3));
    const d = await fetchJSON('data/necofs.json?b=' + bucket, 3 * 3600e3);
    if (!d || !d.times || !d.pts || !d.pts.length) return;
    S.necofs = { times: d.times.map(t => t * 1000), pts: d.pts, u: d.u, v: d.v };
    buildNecofsBins(S.necofs);
    if (d.wtimes && d.wpts && d.hs) {
      S.necofs.wtimes = d.wtimes.map(t => t * 1000);
      S.necofs.wpts = d.wpts;
      S.necofs.hs = d.hs;
      if (d.wdir) S.necofs.wdir = d.wdir;      // deg, waves-FROM (SWAN)
      if (d.tp) S.necofs.tp = d.tp;            // peak period, deciseconds
    }
  } catch (e) {}
}

// coarse spatial index so dense arrow grids can sample the model field quickly
function buildNecofsBins(N) {
  const G = 14;
  let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
  for (const p of N.pts) {
    la0 = Math.min(la0, p[0]); la1 = Math.max(la1, p[0]);
    lo0 = Math.min(lo0, p[1]); lo1 = Math.max(lo1, p[1]);
  }
  const cells = Array.from({ length: G * G }, () => []);
  const dla = (la1 - la0) / G || 1e-9, dlo = (lo1 - lo0) / G || 1e-9;
  N.pts.forEach((p, i) => {
    const r = clamp(Math.floor((p[0] - la0) / dla), 0, G - 1);
    const c = clamp(Math.floor((p[1] - lo0) / dlo), 0, G - 1);
    cells[r * G + c].push(i);
  });
  N.bins = { G, la0, lo0, dla, dlo, cells };
}

/* ---- observed seas: buoy 44020 (Nantucket Sound) via the IOOS ERDDAP —
   the only CORS-open NDBC mirror. The measured wave height bias-corrects
   the NECOFS forecast (same philosophy as the wind-obs blend): full trust
   at observation time, fading back to the pure model 12 h out. ---- */
let seasObs = null;                    // { ft, t, ratio }
const SEAS_BUOY = { lat: 41.443, lng: -70.279 };
let seasBuoyIdx = -1;
async function loadSeasObs() {
  try {
    const url = 'https://erddap.sensors.ioos.us/erddap/tabledap/gov-ndbc-44020.json'
      + '?time%2Csea_surface_wave_significant_height&time%3E=now-4hours';
    const opts = {};
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(20000);
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error('http ' + r.status);
    const d = await r.json();
    const rows = (d.table && d.table.rows) || [];
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i][1] != null && isFinite(rows[i][1])) {
        seasObs = { ft: rows[i][1] * 3.28084, t: Date.parse(rows[i][0]), ratio: null };
        break;
      }
    }
  } catch (e) {}
}
function necofsHsFtRaw(t) {            // model at the buoy, bias-free
  const N = S.necofs;
  if (!N || !N.hs || N.wtimes.length < 2) return null;
  if (seasBuoyIdx < 0) {
    let bd = Infinity;
    for (let i = 0; i < N.wpts.length; i++) {
      const dy = N.wpts[i][0] - SEAS_BUOY.lat, dx = (N.wpts[i][1] - SEAS_BUOY.lng) * 0.74;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; seasBuoyIdx = i; }
    }
  }
  const step = N.wtimes[1] - N.wtimes[0];
  const k = clamp(Math.floor((t - N.wtimes[0]) / step), 0, N.wtimes.length - 2);
  const a = clamp((t - N.wtimes[k]) / step, 0, 1);
  return (N.hs[k][seasBuoyIdx] * (1 - a) + N.hs[k + 1][seasBuoyIdx] * a) * 0.0328084;
}
function seasBias(t) {
  const o = seasObs;
  if (!o || Date.now() - o.t > 4 * 3600e3) return 1;
  if (o.ratio == null) {
    const m = necofsHsFtRaw(o.t);
    if (m == null || m < 0.12) return 1;
    o.ratio = clamp(o.ft / m, 0.5, 2.2);
  }
  const fade = clamp(1 - (t - S.tNow) / (12 * 3600e3), 0, 1);
  return 1 + (o.ratio - 1) * fade;
}

// significant wave height (ft) from the NECOFS/SWAN forecast, mid Vineyard Sound
const WAVE_SPOT = { lat: 41.505, lng: -70.655 };
let waveSpotIdx = -1;
function waveFt(t) {
  const N = S.necofs;
  if (!N || !N.hs || N.wtimes.length < 2) return null;
  if (waveSpotIdx < 0) {
    let bd = Infinity;
    for (let i = 0; i < N.wpts.length; i++) {
      const dy = N.wpts[i][0] - WAVE_SPOT.lat, dx = N.wpts[i][1] - WAVE_SPOT.lng;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; waveSpotIdx = i; }
    }
  }
  const step = N.wtimes[1] - N.wtimes[0];
  const k = clamp(Math.floor((t - N.wtimes[0]) / step), 0, N.wtimes.length - 2);
  const a = clamp((t - N.wtimes[k]) / step, 0, 1);
  const cm = N.hs[k][waveSpotIdx] * (1 - a) + N.hs[k + 1][waveSpotIdx] * a;
  return cm * 0.0328084 * seasBias(t);
}

// mean wave direction (deg, waves-FROM) at the same mid-Sound spot — SWAN's
// wdir lets the swell train run on its TRUE bearing, not the wind's
function waveDirFrom(t) {
  const N = S.necofs;
  if (!N || !N.wdir || !N.wtimes || N.wtimes.length < 2 || waveSpotIdx < 0) return null;
  const step = N.wtimes[1] - N.wtimes[0];
  const k = clamp(Math.round((t - N.wtimes[0]) / step), 0, N.wtimes.length - 1);
  const d = N.wdir[k] && N.wdir[k][waveSpotIdx];
  return typeof d === 'number' ? d : null;
}

// SWAN's peak period at the same spot — the TRUE wave spacing via deep-water
// dispersion, lambda = g T^2 / 2 pi, instead of a height-derived guess
function waveTp(t) {
  const N = S.necofs;
  if (!N || !N.tp || !N.wtimes || N.wtimes.length < 2 || waveSpotIdx < 0) return null;
  const step = N.wtimes[1] - N.wtimes[0];
  const k = clamp(Math.round((t - N.wtimes[0]) / step), 0, N.wtimes.length - 1);
  const p = N.tp[k] && N.tp[k][waveSpotIdx];
  return typeof p === 'number' && p > 2 ? p / 10 : null;   // deciseconds → s
}

async function loadAlerts() {
  try {
    const d = await fetchJSON('https://api.weather.gov/alerts/active?zone=' + MARINE_ZONES, 8 * 60e3);
    const seen = new Set();
    const SEV = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 };
    S.alerts = (d.features || []).map(f => f.properties)
      // NWS routinely issues test messages (e.g. monthly Tsunami Warning comms
      // tests) — only real, active alerts belong on the banner
      .filter(p => p.status === 'Actual' && (p.messageType === 'Alert' || p.messageType === 'Update'))
      .filter(p => { const k = p.event + (p.ends || p.expires); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => (SEV[a.severity] ?? 9) - (SEV[b.severity] ?? 9));
  } catch (e) { S.alerts = []; }
}

/* ------------------------------ wind field ------------------------------
   Three stages, textbook order (about.html §10):
   1. background: Open-Meteo 10 m grid, hourly.
   2. regional driving correction: through-transfer ratios at open MARINE
      stations, height-normalized, spread by distance kernels whose scale
      is the station geometry itself. Sheltered village sensors do NOT
      enter here (that was the old bug: the damped PWS dragged the field).
   3. exact pinning: in-village sensors are equalities. Their residual
      rides the baked influence patch G_s (wind_g.png), which the solver
      says dies over u/lambda: across harbor water, not through woods.  */

let windCons = null;   // { ratios:[{lat,lng,rot,ratio}], patchC:[{st,cu,cv}] }

async function loadWindObs() {
  const nws = Promise.allSettled(WIND_OBS_STATIONS.map((st) =>
    fetchJSON(`https://api.weather.gov/stations/${st.id}/observations/latest`, 5 * 60e3)
      .then((d) => ({ st, p: d && d.properties }))));
  const cons = Promise.allSettled(WIND_CONS_STATIONS.map((st) => fetchConsObs(st)));
  const token = (() => { try { return localStorage.getItem('whTempest'); } catch (e) { return null; } })();
  const exact = Promise.allSettled(WIND_EXACT_STATIONS.map((st) => fetchExactObs(st, token)));
  const [r1, r2, r3] = await Promise.all([nws, cons, exact]);
  S.windObs = r1.filter((r) => r.status === 'fulfilled' && r.value.p).map((r) => r.value);
  S.consObs = r2.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
  S.exactObs = r3.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
  recalcWindCons();
  if (map) buildWindMarkers();
}

async function fetchConsObs(st) {
  const KN_MS = 1.94384;
  if (st.src === 'nws') {
    const d = await fetchJSON(`https://api.weather.gov/stations/${st.id}/observations/latest`, 5 * 60e3);
    const p = d && d.properties;
    if (!p || !p.windSpeed || p.windSpeed.value == null) return null;
    return { st, kn: p.windSpeed.value * 0.539957 * st.h10,
      dir: p.windDirection ? p.windDirection.value : null, t: Date.parse(p.timestamp) };
  }
  if (st.src === 'erddap') {
    const url = 'https://erddap.sensors.ioos.us/erddap/tabledap/gov-ndbc-44020.json'
      + '?time%2Cwind_speed%2Cwind_from_direction%2Cwind_speed_of_gust&orderByMax(%22time%22)';
    const d = await fetchJSON(url, 10 * 60e3);
    const cols = d.table.columnNames, row = d.table.rows[0];
    const ws = row[cols.indexOf('wind_speed')], wd = row[cols.indexOf('wind_from_direction')];
    if (ws == null || ws < -100) return null;
    return { st, kn: ws * KN_MS * st.h10, dir: wd, t: Date.parse(row[cols.indexOf('time')]) };
  }
  if (st.src === 'coops') {
    const d = await fetchJSON(COOPS + `station=${st.id}&product=wind&date=latest&units=english&time_zone=gmt&format=json`, 8 * 60e3);
    const r = d.data && d.data[0];
    if (!r || r.s === '' || r.s == null) return null;
    return { st, kn: parseFloat(r.s) * st.h10, dir: parseFloat(r.d), t: parseGmt(r.t) };
  }
  return null;
}

async function fetchExactObs(st, token) {
  if (st.src === 'whyc') {
    if (!S.whyc || S.whyc.spd == null || S.whyc.dir == null) return null;
    return { st, kn: S.whyc.spd, dir: S.whyc.dir, t: S.whyc.t,
      lat: S.whyc.lat || st.lat, lng: S.whyc.lng || st.lng };
  }
  if (st.src === 'tempest' && token) {
    const d = await fetchJSON(`https://swd.weatherflow.com/swd/rest/observations/station/${st.dev}?token=${token}`, 4 * 60e3);
    const o = d.obs && d.obs[0];
    if (!o || o.wind_avg == null) return null;
    return { st, kn: o.wind_avg * 1.94384, dir: o.wind_direction, t: o.timestamp * 1000,
      lat: st.lat, lng: st.lng };
  }
  return null;
}

// through-transfer innovation: obs vs the SHELTERED background at the station
function windModelAt(lat, lng, t, useFill) {
  const m = sampleWindModel(lat, lng, t);
  let u = m[0], v = m[1];
  if (useFill && WLAP.rho) {
    const rr = windFillAt(lat, lng);
    const cs = Math.cos(rr[1]), sn = Math.sin(rr[1]);
    const u2 = (u * cs + v * sn) * rr[0], v2 = (-u * sn + v * cs) * rr[0];
    u = u2; v = v2;
  }
  return windTransfer(lat, lng, u, v);
}

/* The smooth fill: the amplitude correction rho(x) and rotation dth(x)
   are the SIMPLEST fields consistent with the data, the minimizers of
   the Dirichlet energy integral of |grad rho|^2, i.e. solutions of
   Laplace's equation. Interior conditions: each station's
   through-transfer innovation, held at its cell. Edge condition: the
   forecast (rho = 1, dth = 0). No length constants, no weights: the
   equation decides how far each measurement reaches. Solved by SOR on a
   coarse grid at every observation refresh, sampled bilinearly. */
const WLAP = {
  nx: 72, ny: 56, rho: null, rot: null,
  lo0: -70.9025, lo1: -70.4525, la0: 41.650, la1: 41.390, myN: 0, myS: 0,
};

function solveWindFill(cons) {
  if (!cons.length) { WLAP.rho = null; WLAP.rot = null; return; }
  const { nx, ny } = WLAP;
  WLAP.myN = mercY(WLAP.la0); WLAP.myS = mercY(WLAP.la1);
  const rho = new Float32Array(nx * ny).fill(1);
  const rot = new Float32Array(nx * ny);
  const fixed = new Uint8Array(nx * ny);
  for (let x = 0; x < nx; x++) { fixed[x] = 1; fixed[(ny - 1) * nx + x] = 1; }
  for (let y = 0; y < ny; y++) { fixed[y * nx] = 1; fixed[y * nx + nx - 1] = 1; }
  for (const o of cons) {
    const fx = (o.lng - WLAP.lo0) / (WLAP.lo1 - WLAP.lo0) * (nx - 1);
    const fy = (mercY(o.lat) - WLAP.myN) / (WLAP.myS - WLAP.myN) * (ny - 1);
    const i = Math.round(clamp(fy, 1, ny - 2)) * nx + Math.round(clamp(fx, 1, nx - 2));
    fixed[i] = 1; rho[i] = o.ratio; rot[i] = o.rot;
  }
  const OM = 1.9;                        // SOR over-relaxation
  for (let it = 0; it < 1400; it++) {
    let md = 0;
    for (let y = 1; y < ny - 1; y++) {
      for (let x = 1; x < nx - 1; x++) {
        const i = y * nx + x;
        if (fixed[i]) continue;
        const dr = 0.25 * (rho[i - 1] + rho[i + 1] + rho[i - nx] + rho[i + nx]) - rho[i];
        const dt = 0.25 * (rot[i - 1] + rot[i + 1] + rot[i - nx] + rot[i + nx]) - rot[i];
        rho[i] += OM * dr; rot[i] += OM * dt;
        const a = Math.abs(dr);
        if (a > md) md = a;
      }
    }
    if (it % 25 === 24 && md < 5e-5) break;
  }
  WLAP.rho = rho; WLAP.rot = rot;
}

function windFillAt(lat, lng) {
  if (!WLAP.rho) return [1, 0];
  const { nx, ny } = WLAP;
  const fx = clamp((lng - WLAP.lo0) / (WLAP.lo1 - WLAP.lo0), 0, 1) * (nx - 1);
  const fy = clamp((mercY(lat) - WLAP.myN) / (WLAP.myS - WLAP.myN), 0, 1) * (ny - 1);
  const x0 = Math.min(nx - 2, fx | 0), y0 = Math.min(ny - 2, fy | 0);
  const dx = fx - x0, dy = fy - y0;
  const bil = (f) => f[y0 * nx + x0] * (1 - dx) * (1 - dy) + f[y0 * nx + x0 + 1] * dx * (1 - dy)
    + f[(y0 + 1) * nx + x0] * (1 - dx) * dy + f[(y0 + 1) * nx + x0 + 1] * dx * dy;
  return [bil(WLAP.rho), bil(WLAP.rot)];
}

function recalcWindCons() {
  if (!S.wind) { windCons = null; return; }
  // in-village sensors, pulled live (see below); built first because
  // waterfront-sited ones also join the regional stage
  const exacts = (S.exactObs || []).filter((o) => o && o.st.src !== 'whyc');
  if (S.whyc && S.whyc.spd != null && S.whyc.dir != null) {
    const st0 = WIND_EXACT_STATIONS[0];
    exacts.push({ st: st0, kn: S.whyc.spd, dir: S.whyc.dir, t: S.whyc.t,
      lat: S.whyc.lat || st0.lat, lng: S.whyc.lng || st0.lng });
  }
  const ratios = [];
  // like-for-like in time: the innovation compares the observation with
  // the model AT THE OBSERVATION TIME, so an hour-old reading is not
  // ratioed against a background that has since strengthened
  const pushRatio = (lat, lng, kn, dir, tObs) => {
    const age = S.tNow - tObs;
    if (kn == null || dir == null || age > 2.5 * 3600e3 || kn < 1) return;
    const m = windModelAt(lat, lng, tObs, false);
    const mkn = Math.hypot(m[0], m[1]);
    if (mkn < 1.5) return;
    const mdir = Math.atan2(-m[0], -m[1]);
    let rot = dir * Math.PI / 180 - mdir;
    while (rot > Math.PI) rot -= 2 * Math.PI;
    while (rot < -Math.PI) rot += 2 * Math.PI;
    ratios.push({ lat, lng, rot: clamp(rot, -0.7, 0.7), ratio: clamp(kn / mkn, 0.4, 2.8) });
  };
  for (const o of (S.consObs || [])) pushRatio(o.st.lat, o.st.lng, o.kn, o.dir, o.t);
  for (const o of exacts) if (o.st.regional) pushRatio(o.lat, o.lng, o.kn, o.dir, o.t);
  solveWindFill(ratios);
  // exact pinning: residual at each in-village sensor -> patch amplitudes
  const patchC = [];
  const act = exacts.filter((o) => o && WINDG && WINDG.st[o.st.id]
    && (S.tNow - o.t) < 50 * 60e3 && o.kn != null && o.dir != null);
  if (act.length) {
    const n = act.length;
    const A = [], eu = [], ev = [];
    for (let i = 0; i < n; i++) {
      const oi = act[i];
      const m = windModelAt(oi.lat, oi.lng, S.tNow, true);
      const rad = oi.dir * Math.PI / 180;
      eu.push(-oi.kn * Math.sin(rad) - m[0]);
      ev.push(-oi.kn * Math.cos(rad) - m[1]);
      const row = [];
      for (let j = 0; j < n; j++) {
        row.push(i === j ? 1 : windGAt(act[j].st.id, oi.lat, oi.lng, m[0], m[1]));
      }
      A.push(row);
    }
    const cu = gaussSolve(A.map((r) => r.slice()), eu.slice());
    const cv = gaussSolve(A.map((r) => r.slice()), ev.slice());
    if (cu && cv) for (let i = 0; i < n; i++) {
      patchC.push({ id: act[i].st.id, cu: cu[i], cv: cv[i] });
    }
  }
  windCons = { ratios: ratios.length ? ratios : null, patchC };
}

function gaussSolve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-9) return null;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

function sampleWindModel(lat, lng, t) {
  const W = S.wind;
  if (!W) return [0, 0, 0];
  const { times, u, v, g, nx, ny } = W;
  let k = clamp(Math.floor((t - times[0]) / 3600e3), 0, times.length - 2);
  const a = clamp((t - times[k]) / 3600e3, 0, 1);
  const fx = clamp((lng - GRID_LNGS[0]) / (GRID_LNGS[nx - 1] - GRID_LNGS[0]), 0, 1) * (nx - 1);
  const fy = clamp((lat - GRID_LATS[0]) / (GRID_LATS[ny - 1] - GRID_LATS[0]), 0, 1) * (ny - 1);
  const i0 = Math.min(nx - 2, Math.floor(fx)), j0 = Math.min(ny - 2, Math.floor(fy));
  const dx = fx - i0, dy = fy - j0;
  const idx = (j, i) => j * nx + i;
  const bl = (arr) => {
    const tval = (p) => arr[p][k] * (1 - a) + arr[p][k + 1] * a;
    const v00 = tval(idx(j0, i0)), v10 = tval(idx(j0, i0 + 1)),
          v01 = tval(idx(j0 + 1, i0)), v11 = tval(idx(j0 + 1, i0 + 1));
    return v00 * (1 - dx) * (1 - dy) + v10 * dx * (1 - dy) + v01 * (1 - dx) * dy + v11 * dx * dy;
  };
  return [bl(u), bl(v), bl(g)];
}

function sampleWind(lat, lng, t) {
  const m = sampleWindModel(lat, lng, t);
  let u = m[0], v = m[1], g = m[2];
  const C = windCons;
  // measured-vs-model error holds fully NOW and decays LINEARLY to zero 12 h
  // out: trust the sensors for today, the forecast for tomorrow
  const fade = clamp(1 - Math.abs(t - S.tNow) / (12 * 3600e3), 0, 1);
  if (C && C.ratios && WLAP.rho && fade > 0.02) {
    const rr = windFillAt(lat, lng);
    const ratio = 1 + (rr[0] - 1) * fade;
    const rot = rr[1] * fade;
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const u2 = (u * cs + v * sn) * ratio, v2 = (-u * sn + v * cs) * ratio;
    u = u2; v = v2; g *= ratio;
  }
  const tw = windTransfer(lat, lng, u, v);
  let wu = tw[0], wv = tw[1];
  if (C && C.patchC.length && fade > 0.02 && WINDG && WINDG.near(lat, lng)) {
    for (const p of C.patchC) {
      const gv = windGAt(p.id, lat, lng, wu, wv);
      if (gv > 0.004) { wu += p.cu * gv * fade; wv += p.cv * gv * fade; }
    }
  }
  return [wu, wv, g];
}

/* baked station influence patches: G_s(x, theta) in [0,1], unit at the
   station, advected/decayed by the solved base flow */
let WINDG = null;
async function loadWindG() {
  try {
    const meta = S.geoMeta && S.geoMeta.windG;
    if (!meta) return;
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('wind_g failed')); img.src = 'data/wind_g.png?v=1'; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    const P = meta.patch, ND = meta.ndir;
    const st = {};
    meta.stations.forEach((s, is) => {
      const tiles = [];
      for (let k = 0; k < ND; k++) {
        const f = new Float32Array(P * P);
        const t0 = (is * ND + k) * P;
        for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
          f[y * P + x] = d[((t0 + y) * P + x) * 4] / 255;
        }
        tiles.push(f);
      }
      st[s.id] = { lat: s.lat, lng: s.lng, tiles };
    });
    const half = (P - 1) / 2;
    WINDG = {
      st, P, ND, half, mppx: meta.mppx, mppy: meta.mppy,
      near(lat, lng) {
        for (const id in st) {
          if (Math.abs(lat - st[id].lat) < 0.012 && Math.abs(lng - st[id].lng) < 0.016) return true;
        }
        return false;
      },
    };
    recalcWindCons();
  } catch (e) { console.warn('[windG]', e); }
}

function windGAt(id, lat, lng, u, v) {
  const W = WINDG;
  const s = W && W.st[id];
  if (!s) return 0;
  const fx = W.half + (lng - s.lng) * M_LNG / W.mppx;
  const fy = W.half + (s.lat - lat) * M_LAT / W.mppy;
  if (fx < 0 || fy < 0 || fx > W.P - 1 || fy > W.P - 1) return 0;
  let br = Math.atan2(-u, -v) / (2 * Math.PI) * W.ND;
  br = ((br % W.ND) + W.ND) % W.ND;
  const k0 = br | 0, k1 = (k0 + 1) % W.ND, tt = br - k0;
  const x0 = Math.min(W.P - 2, fx | 0), y0 = Math.min(W.P - 2, fy | 0);
  const dx = fx - x0, dy = fy - y0;
  const bil = (f) => f[y0 * W.P + x0] * (1 - dx) * (1 - dy) + f[y0 * W.P + x0 + 1] * dx * (1 - dy)
    + f[(y0 + 1) * W.P + x0] * (1 - dx) * dy + f[(y0 + 1) * W.P + x0 + 1] * dx * dy;
  return bil(s.tiles[k0]) * (1 - tt) + bil(s.tiles[k1]) * tt;
}

/* ------------------------------ water current field ------------------------------
   A hand-drawn skeleton of flow centerlines through the waterways. Each channel is
   tied to a NOAA current station; the station's signed prediction (flood +, ebb −,
   plus the live bay–sound weather adjustment) sets the amplitude, the polyline
   tangent sets the direction, and a gaussian falloff confines flow to the channel.
   Where the channels fade out, NECOFS model currents (if data/necofs.json exists)
   fill in the sounds. Channel sign is auto-aligned to the station's published
   flood direction at load time.

   TODO(plates): the 1930s C&GS survey (Haight, SP 168) and the hourly "Tidal
   Current Charts — Narragansett Bay to Nantucket Sound" plates can be digitized
   into PLATE_VECTORS = [{phaseHr, lat, lng, dirDeg, knSpring}] keyed to the
   Strait's cycle, and blended here for surveyed eddy/branch structure.        */


/* every overlay canvas overdraws a margin beyond the viewport so a pan
   reveals painted field, not blank strips; the margin adapts down on
   small screens to cap the pixel cost */
function syncCanvasZoom(layer, m) {
  if (!layer._canvas || !layer._nw || layer._drawZoom == null) return;
  const scale = m.getZoomScale(m.getZoom(), layer._drawZoom);
  const pos = m.latLngToLayerPoint(layer._nw);
  L.DomUtil.setTransform(layer._canvas, pos, scale);
}

function releaseCanvasZoom(layer, m) {
  if (!layer._onCanvasZoom) return;
  m.off('zoom', layer._onCanvasZoom);
  layer._onCanvasZoom = null;
}

function padReset(layer, m, dprMax) {
  const size = m.getSize();
  if (size.x < 50 || size.y < 50) return null;
  const P = Math.min(200, Math.round(Math.min(size.x, size.y) * 0.35));
  layer._canvas.style.transformOrigin = '0 0';
  L.DomUtil.setPosition(layer._canvas, m.containerPointToLayerPoint([-P, -P]));
  const dpr = clamp(devicePixelRatio || 1, 1, MOBILE_MAP ? Math.min(1.5, dprMax) : dprMax);
  const w = size.x + 2 * P, h = size.y + 2 * P;
  layer._w = w; layer._h = h; layer._pad = P;
  layer._canvas.width = Math.round(w * dpr);
  layer._canvas.height = Math.round(h * dpr);
  layer._canvas.style.width = w + 'px';
  layer._canvas.style.height = h + 'px';
  layer._nw = m.containerPointToLatLng([-P, -P]);
  layer._se = m.containerPointToLatLng([size.x + P, size.y + P]);
  layer._drawZoom = m.getZoom();
  if (!layer._onCanvasZoom) {
    layer._onCanvasZoom = () => syncCanvasZoom(layer, m);
    // Leaflet's chart tiles transform continuously during a pinch. These
    // hand-drawn canvases must follow the same fractional zoom every frame.
    m.on('zoom', layer._onCanvasZoom);
  }
  return { size, dpr };
}

const M_LAT = 110574;                                    // meters per degree latitude
const M_LNG = 111320 * Math.cos(41.52 * Math.PI / 180);  // meters per degree longitude
const mx = (lng) => (lng + 70.68) * M_LNG;
const my = (lat) => (lat - 41.52) * M_LAT;

const CHANNELS = [
  // Woods Hole passage: Buzzards Bay → north end → the Strait → out to Vineyard Sound
  { sta: 'COD0911', sigma: 230, pts: [[41.5290, -70.7000], [41.5250, -70.6950], [41.5235, -70.6925], [41.5210, -70.6870], [41.5197, -70.6845], [41.5188, -70.6795], [41.5158, -70.6740], [41.5122, -70.6680], [41.5088, -70.6598]] },
  // Broadway — the southern branch of the passage, along Nonamesset
  { sta: 'COD0911', sigma: 150, amp: 0.85, pts: [[41.5162, -70.6905], [41.5150, -70.6868], [41.5146, -70.6824], [41.5152, -70.6779], [41.5162, -70.6748]] },
  // Buzzards Bay approach to the Hole
  { sta: 'COD0910', sigma: 420, pts: [[41.5470, -70.7130], [41.5380, -70.7040], [41.5300, -70.6975], [41.5245, -70.6932]] },
  // Great Harbor mouth, past Juniper Point into the Sound
  { sta: 'COD0912', sigma: 250, pts: [[41.5220, -70.6698], [41.5185, -70.6706], [41.5158, -70.6716], [41.5120, -70.6688], [41.5085, -70.6635]] },
  // Vineyard Sound, main axis
  { sta: 'ACT1821', sigma: 1500, pts: [[41.4900, -70.7280], [41.4990, -70.7000], [41.5070, -70.6720], [41.5150, -70.6400], [41.5230, -70.6050]] },
  // Vineyard Sound, inshore lane below Nobska
  { sta: 'ACT1831', sigma: 800, pts: [[41.4950, -70.6850], [41.5010, -70.6640], [41.5070, -70.6420], [41.5130, -70.6220]] },
  // Buzzards Bay, south of the Weepeckets
  { sta: 'ACT1951', sigma: 1200, pts: [[41.5200, -70.7660], [41.5120, -70.7420], [41.5065, -70.7180], [41.5040, -70.7010]] },
];

let waterReady = false;

function buildWaterField() {
  const byId = {};
  for (const st of S.currents) byId[st.cfg.id] = st;
  for (const ch of CHANNELS) {
    ch.st = byId[ch.sta] || null;
    ch.seg = [];
    for (let i = 0; i < ch.pts.length - 1; i++) {
      const x1 = mx(ch.pts[i][1]), y1 = my(ch.pts[i][0]);
      const x2 = mx(ch.pts[i + 1][1]), y2 = my(ch.pts[i + 1][0]);
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      ch.seg.push({ x1, y1, dx, dy, len2: len * len, tx: dx / len, ty: dy / len });
    }
    ch.sign = 0;
    if (ch.st && isFinite(ch.st.floodDir)) {
      // tangent nearest the station vs. the station's flood set direction
      const sx = mx(ch.st.cfg.lng), sy = my(ch.st.cfg.lat);
      let best = ch.seg[0], bd = Infinity;
      for (const s of ch.seg) {
        const tt = clamp(((sx - s.x1) * s.dx + (sy - s.y1) * s.dy) / s.len2, 0, 1);
        const px = s.x1 + tt * s.dx - sx, py = s.y1 + tt * s.dy - sy;
        const d = px * px + py * py;
        if (d < bd) { bd = d; best = s; }
      }
      const fr = ch.st.floodDir * Math.PI / 180;
      ch.sign = (best.tx * Math.sin(fr) + best.ty * Math.cos(fr)) >= 0 ? 1 : -1;
    }
  }
  waterReady = CHANNELS.some(c => c.sign !== 0);
}

// inverse-distance sample of the NECOFS model field (kn east/north), or null
function necofsUV(lat, lng, t) {
  const N = S.necofs;
  if (!N || N.times.length < 2) return null;
  const step = N.times[1] - N.times[0];
  const k = clamp(Math.floor((t - N.times[0]) / step), 0, N.times.length - 2);
  const a = clamp((t - N.times[k]) / step, 0, 1);
  let b1 = -1, b2 = -1, b3 = -1, d1 = 1e18, d2 = 1e18, d3 = 1e18;
  let list = null;
  if (N.bins) {
    const B = N.bins;
    const r = clamp(Math.floor((lat - B.la0) / B.dla), 0, B.G - 1);
    const c = clamp(Math.floor((lng - B.lo0) / B.dlo), 0, B.G - 1);
    list = [];
    for (let rr = Math.max(0, r - 1); rr <= Math.min(B.G - 1, r + 1); rr++)
      for (let cc = Math.max(0, c - 1); cc <= Math.min(B.G - 1, c + 1); cc++)
        for (const i of B.cells[rr * B.G + cc]) list.push(i);
    if (!list.length) return null;
  }
  const n = list ? list.length : N.pts.length;
  for (let j = 0; j < n; j++) {
    const i = list ? list[j] : j;
    const dy = (N.pts[i][0] - lat) * M_LAT, dx = (N.pts[i][1] - lng) * M_LNG;
    const d = dx * dx + dy * dy;
    if (d < d1) { d3 = d2; b3 = b2; d2 = d1; b2 = b1; d1 = d; b1 = i; }
    else if (d < d2) { d3 = d2; b3 = b2; d2 = d; b2 = i; }
    else if (d < d3) { d3 = d; b3 = i; }
  }
  if (b1 < 0 || d1 > 2500 * 2500) return null;
  let su = 0, sv = 0, sw = 0;
  for (const [b, d] of [[b1, d1], [b2, d2], [b3, d3]]) {
    if (b < 0) continue;
    const w = 1 / (d + 1e4);
    su += w * (N.u[k][b] * (1 - a) + N.u[k + 1][b] * a);
    sv += w * (N.v[k][b] * (1 - a) + N.v[k + 1][b] * a);
    sw += w;
  }
  const CMS_KN = 0.019438445;
  return [su / sw * CMS_KN, sv / sw * CMS_KN];
}

// bilinear of the transport modes over one stage grid's water cells
function stageBil(F, lat, lng) {
  const bil = (G) => {
    const gx = (lng - G.lo0) / (G.lo1 - G.lo0) * (G.nx - 1);
    const gy = (mercY(lat) - G.my0) / (G.my1 - G.my0) * (G.ny - 1);
    if (gx < 0 || gy < 0 || gx > G.nx - 1 || gy > G.ny - 1) return null;
    const x0 = Math.min(G.nx - 2, Math.floor(gx)), y0 = Math.min(G.ny - 2, Math.floor(gy));
    const dx = gx - x0, dy = gy - y0;
    let su = 0, sv = 0, tu = 0, tv = 0, cu = 0, cv = 0, wsum = 0;
    const hasC = !!G.uC;
    const corners = [[0, 0, (1 - dx) * (1 - dy)], [1, 0, dx * (1 - dy)], [0, 1, (1 - dx) * dy], [1, 1, dx * dy]];
    for (const [ox, oy, wgt] of corners) {
      const i = (y0 + oy) * G.nx + (x0 + ox);
      if (!G.water[i]) continue;
      su += G.uA[i] * wgt; sv += G.vA[i] * wgt;
      tu += G.uB[i] * wgt; tv += G.vB[i] * wgt;
      if (hasC) { cu += G.uC[i] * wgt; cv += G.vC[i] * wgt; }
      wsum += wgt;
    }
    return { su, sv, tu, tv, cu, cv, wsum };
  };
  if (F.fine) {
    const FF = F.fine;
    const fgx = (lng - FF.lo0) / (FF.lo1 - FF.lo0) * (FF.nx - 1);
    const fgy = (mercY(lat) - FF.my0) / (FF.my1 - FF.my0) * (FF.ny - 1);
    if (fgx >= 1 && fgy >= 1 && fgx <= FF.nx - 2 && fgy <= FF.ny - 2) return bil(FF);
  }
  return bil(F);
}

// returns [east_kn, north_kn, envelope 0..1]. Streamfunction transport lerped
// between the low/high tide stage solves, converted to speed through the water
// column at this tide; falls back to the channel skeleton until solved.
// bare mode-superposition velocity (no survey blend, drift, or clamps) —
// the cheap probe the inertial-jet march uses to look upstream
function flowBaseAt(lat, lng, t) {
  if (!(flowField && flowField.lo)) return [0, 0];
  const W = flowField;
  const w = clamp((localTideM(lat, lng, t) - W.hLo) / (W.hHi - W.hLo), 0, 1);
  const rL = stageBil(W.lo, lat, lng);
  const rH = W.hi === W.lo ? rL : stageBil(W.hi, lat, lng);
  // normalize each stage by its OWN water fraction before mixing — dividing
  // a lerp by a lerp hands drying cells the full hi-stage transport at any w
  const norm = (r2, k) => (r2 && r2.wsum > 0.03 ? r2[k] / r2.wsum : 0);
  const mix = (k) => norm(rL, k) * (1 - w) + norm(rH, k) * w;
  const wMix = (rL ? rL.wsum : 0) * (1 - w) + (rH ? rH.wsum : 0) * w;
  if (wMix <= 0.03) return [0, 0];
  const aA = W.alphaA(t), aB = W.alphaB(t), aC = W.alphaC ? W.alphaC(t) : 0;
  const h0v = depthMLLW(lat, lng);
  const H = (h0v == null ? 6 : h0v) + localTideM(lat, lng, t);
  if (H <= 0.12) return [0, 0];
  const Hf = Math.max(H, 0.6);
  return [(aA * mix('su') + aB * mix('tu') + aC * mix('cu')) / Hf,
          (aA * mix('sv') + aB * mix('tv') + aC * mix('cv')) / Hf];
}

function sampleWater(lat, lng, t, windUV) {
  let ve = 0, vn = 0, env = 0, Hcol = 6;
  if (flowField && flowField.lo) {
    const W = flowField;
    // stage mix follows the LOCAL tide (drying-controlled conductance is a
    // local phenomenon); the mode amplitudes stay on the station clock
    const w = clamp((localTideM(lat, lng, t) - W.hLo) / (W.hHi - W.hLo), 0, 1);
    const rL = stageBil(W.lo, lat, lng);
    const rH = W.hi === W.lo ? rL : stageBil(W.hi, lat, lng);
    // normalize each stage by its OWN water fraction before mixing — dividing
    // a lerp by a lerp hands drying cells the full hi-stage transport at any w
    const norm = (r2, k) => (r2 && r2.wsum > 0.03 ? r2[k] / r2.wsum : 0);
    const mix = (k) => norm(rL, k) * (1 - w) + norm(rH, k) * w;
    const wMix = (rL ? rL.wsum : 0) * (1 - w) + (rH ? rH.wsum : 0) * w;
    if (wMix > 0.03) {
      const aA = W.alphaA(t), aB = W.alphaB(t), aC = W.alphaC ? W.alphaC(t) : 0;
      ve = aA * mix('su') + aB * mix('tu') + aC * mix('cu');
      vn = aA * mix('sv') + aB * mix('tv') + aC * mix('cv');
      env = Math.min(1, wMix * 1.25);
      // transport → speed through the water column at this tide;
      // ground above the waterline carries no current at all
      if (ve !== 0 || vn !== 0) {
        const h0v = depthMLLW(lat, lng);
        const H = (h0v == null ? 6 : h0v) + localTideM(lat, lng, t);
        if (H <= 0.12) { ve = 0; vn = 0; env = 0; }
        else {
          // floor the column so a near-drying sliver can't divide a whole
          // cell's transport into a fantasy jet
          const Hf = Math.max(H, 0.6);
          ve /= Hf; vn /= Hf;
          Hcol = Hf;
        }
      }
      // shed vorticity (the eddies) rides on top of the potential transport —
      // scaled by the local base flow, so sheltered pockets (Rams Head /
      // Devil's Foot lee) stay as calm as they really are
      if (EDDIES_ON && eddy && eddy.ready && env > 0 && !eddySampling) {
        const r2 = eddyVel(lat, lng);
        if (r2) {
          const ef = clamp((Math.hypot(ve, vn) - 0.12) / 0.55, 0, 1);
          ve += r2[0] * ef; vn += r2[1] * ef;
        }
      }
      // THE MOMENTUM SOLVE governs the fine box: jets, tongues, and their
      // flood/ebb asymmetry from the shallow-water equations. Phase comes
      // from the live calibration amplitudes, the point on the amplitude
      // response surface from the measured strait half-cycle peak —
      // measurement keeps authority, physics keeps shape.
      if (SWE) {
        const thA = Math.atan2(W.alphaB(t), W.alphaA(t));
        const sw3 = sweAt(lat, lng, thA, sweAmpFrac(t));
        if (sw3 && sw3[2] > 0) {
          let g3 = 1;
          if (_g3m.t !== t) {
            _g3m.t = t;
            _g3m.st = S.currents.length
              ? (S.currents.find((c2) => c2.cfg.primary) || S.currents[0]) : null;
            _g3m.v = _g3m.st ? Math.abs(stationV(_g3m.st, t)) : 0;
          }
          const stS = _g3m.st;
          if (stS && sw3[3] > 0.15) {
            // residual only: the surface already carries springs/neaps
            const gClamp = SWE.amps.length > 1 ? 1.6 : 3;
            g3 = clamp(_g3m.v / sw3[3], 1 / gClamp, gClamp);
          }
          const wB = sw3[2];
          ve = ve * (1 - wB) + sw3[0] * g3 * wB;
          vn = vn * (1 - wB) + sw3[1] * g3 * wB;
        }
      }
    }
  } else {
    const c = sampleWaterChannels(lat, lng, t);
    ve = c[0]; vn = c[1]; env = c[2];
  }
  // surveyed-station correction: near a Haight/Hicks station the measured
  // current (phase-shifted to now via Boston tides) overrides the model,
  // tapering off over ~1.5 km; the springs/neaps scale rides on the live
  // strait prediction so the 1930s means breathe with today's tide
  if (haightF && env > 0.02) {
    let wsum2 = 0, ue2 = 0, un2 = 0;
    for (const st of haightF) {
      const dy = (lat - st.lat) * M_LAT, dx = (lng - st.lng) * M_LNG;
      const d2 = dx * dx + dy * dy;
      if (st.harm) {
        // continuous rotary prediction; wider reach (it sits off the corner)
        if (d2 > 4.2e7) continue;
        const w = Math.exp(-d2 / (2 * 2500 * 2500));
        const hv = harmonicV(t);
        const sc = haightSpring(t);
        ue2 += w * hv[0] * sc;
        un2 += w * hv[1] * sc;
        wsum2 += w;
        continue;
      }
      if (d2 > 2.1e7) continue;                       // beyond ~4.5 km: no influence
      const w = Math.exp(-d2 / (2 * 1500 * 1500));
      const v = haightV(st, t) * haightSpring(t);
      const dir = v >= 0 ? st.fDir : st.eDir;
      const sp = Math.abs(v);
      ue2 += w * sp * dir[0];
      un2 += w * sp * dir[1];
      wsum2 += w;
    }
    if (wsum2 > 0.02) {
      let trust = Math.min(1, wsum2);
      // the Hole itself belongs to the fine solve + live NOAA stations —
      // feather the survey's influence to zero approaching the nest box
      const dxE = (lng - (-70.660)) * M_LNG, dxW = ((-70.706) - lng) * M_LNG;
      const dyN = (41.534 - lat) * M_LAT, dyS = (lat - 41.508) * M_LAT;
      if (dxE > 0 || dxW > 0 || dyN < 0 || dyS < 0) {
        const dOut = Math.max(dxE, dxW, dyN < 0 ? -dyN : 0, dyS < 0 ? -dyS : 0);
        trust *= clamp(dOut / 1500, 0, 1);
      } else {
        trust = 0;                                    // inside the nest box
      }
      ve = ve * (1 - trust) + (ue2 / wsum2) * trust;
      vn = vn * (1 - trust) + (un2 / wsum2) * trust;
      env = Math.max(env, trust);
    }
  }
  // friction-limited speed: over a shared surface slope, attainable velocity
  // scales like √depth (Chezy) — the deep strait runs fast, a meter-deep
  // rocky margin physically cannot sustain a jet no matter what transport
  // the frictionless solve would like to route through it
  // Chezy limit at the steepest LOCAL slope this coast produces (~1e-3 at
  // constrictions — the Penzance neck is a spillway, and six knots over two
  // meters of water is exactly what Chezy gives there). Fantasy margin jets
  // are handled by the shoreline damp, not by starving real rapids.
  const umax = Math.min(6.5, 3.3 * Math.sqrt(Math.max(Hcol, 0.25)));
  const vmag = Math.hypot(ve, vn);
  if (vmag > umax) { ve *= umax / vmag; vn *= umax / vmag; }
  // wind-driven surface drift: the top of the column moves at ~2.5% of the
  // LOCAL wind (terrain-sheltered), veered 15° right of it (shallow-water
  // Ekman) — a real current for a hull, and the only one in light-tide
  // corners of the map. Added after the station blend so surveyed tidal
  // truth stays pure; trimmed by the same shoreline treatment below.
  if (S.wind) {
    // hot loops (the flow texture) pass their already-interpolated local
    // wind; everyone else pays for one sampleWind
    const wv = windUV || sampleWind(lat, lng,
      clamp(t, S.wind.times[0], S.wind.times[S.wind.times.length - 1]));
    const dre = wv[0] * 0.9659 + wv[1] * 0.2588;
    const drn = -wv[0] * 0.2588 + wv[1] * 0.9659;
    const dm = Math.hypot(dre, drn);
    if (dm > 0.5) {
      // drift is a TRANSPORT: where the water cannot escape along the
      // drift line (an enclosed pond, a beach dead ahead) the wind piles
      // water until a return flow cancels it — the depth mean goes to
      // zero. March both ways; each blocked end cancels most of it.
      let open = 1;
      const uxd = dre / dm, uyd = drn / dm;
      for (const sgn of [1, -1]) {
        if (!isWaterAt(lat + sgn * uyd * 450 / M_LAT, lng + sgn * uxd * 450 / M_LNG)) open *= 0.3;
      }
      ve += dre * 0.025 * open;
      vn += drn * 0.025 * open;
    }
  }
  // sub-grid touch-up at the shoreline (the solver honors land at ~100 m scale;
  // this handles the last few pixels near the beach)
  if ((ve !== 0 || vn !== 0) && GEO) {
    const sv2 = shoreVec(lat, lng);
    if (sv2 && sv2.w < 0.78) {
      const gm = Math.hypot(sv2.gx, sv2.gy);
      if (gm > 1e-6) {
        const nx = sv2.gx / gm, ny = sv2.gy / gm;
        const vin = ve * nx + vn * ny;
        if (vin < 0) {
          const g = clamp((0.78 - sv2.w) / 0.33, 0, 1);
          ve -= nx * vin * g;
          vn -= ny * vin * g;
        }
      }
      // no magnitude damp: the no-flux projection above is the physics; the
      // beach-jet artifacts the damp once papered over are fixed at their
      // source (the nest-ring Dirichlet bake fix), and the damp was crushing
      // genuinely shallow fast channels like the Penzance neck
    }
  }
  return [ve, vn, env];
}

function sampleWaterChannels(lat, lng, t) {
  let ve = 0, vn = 0, W = 0;
  if (waterReady) {
    const x = mx(lng), y = my(lat);
    for (const ch of CHANNELS) {
      if (!ch.sign) continue;
      let bd = Infinity, bs = null;
      for (const s of ch.seg) {
        const tt = clamp(((x - s.x1) * s.dx + (y - s.y1) * s.dy) / s.len2, 0, 1);
        const px = s.x1 + tt * s.dx - x, py = s.y1 + tt * s.dy - y;
        const d = px * px + py * py;
        if (d < bd) { bd = d; bs = s; }
      }
      const w = Math.exp(-bd / (ch.sigma * ch.sigma));
      if (w < 0.002) continue;
      const v = stationV(ch.st, t) * ch.sign * (ch.amp || 1);
      ve += w * bs.tx * v;
      vn += w * bs.ty * v;
      W += w;
    }
    const norm = Math.max(W, 1);
    ve /= norm; vn /= norm;
  }
  // model currents fill in where the channel skeleton fades
  const fillW = 1 - Math.min(1, W);
  if (fillW > 0.05 && S.necofs) {
    const nv = necofsUV(lat, lng, t);
    if (nv) {
      ve += fillW * nv[0];
      vn += fillW * nv[1];
      W = Math.max(W, 0.5);
    }
  }
  return [ve, vn, Math.min(1, W)];
}

/* ------------------------------ static geography ------------------------------
   All land/water geometry comes from ONE baked file (data/geo.png, made by
   tools/bake_geo.py from CUDEM topobathy + NOAA ENC classification). Nothing
   geographic is fetched at runtime: the whole region lives in memory and on
   the GPU, so panning/zooming never waits on a network request and the
   rendered land can never drift out of registration with the chart.
   Channels: R = depth at MLLW ((h+5)/45), G = blurred water, B = navigable. */

let GEO = null, GEO2 = null, GEO3 = null, WINDT = null;  // geo regions + baked wind transfer atlas
async function loadGeo() {
  const decode = async (m, url) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error(url + ' failed')); img.src = url; });
    // dimensions come from the IMAGE, not the meta: the half-res boot
    // rasters share each tier's box at a quarter of the pixels
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    return {
      d: cx.getImageData(0, 0, c.width, c.height).data,
      w: c.width, h: c.height, lo0: m.lo0, lo1: m.lo1,
      myN: mercY(m.la0), myS: mercY(m.la1), cnv: c,
    };
  };
  try {
    // (bump the ?v when re-baking)
    let meta = await fetchJSON('data/geo.json?v=19', 6 * 3600e3);
    if (!meta || !meta.core || !meta.flow || !meta.depth16) {
      // a stale/foreign shape got cached — bypass every cache and retry
      meta = await (await fetch('data/geo.json?v=19', { cache: 'reload' })).json();
      try { localStorage.setItem('wh1:data/geo.json?v=19', JSON.stringify({ t: Date.now(), d: meta })); } catch (e2) {}
    }
    if (!meta || !meta.core) throw new Error('geo.json has no core region');
    if (!meta.depth16) console.warn('[geo] expected 16-bit depth rasters');
    S.geoMeta = meta;
    // one-time blurred-water field per region (shoreVec needs it; the raster
    // G channel now carries the depth low byte instead)
    const blurNav = (M2) => {
      const w = M2.w, h = M2.h, n = w * h;
      let a = new Float32Array(n), b = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = M2.d[i * 4 + 2] > 127 ? 1 : 0;
      const r = 6, div = 2 * r + 1;
      for (let pass = 0; pass < 2; pass++) {
        for (let y = 0; y < h; y++) {
          const o = y * w;
          let acc = 0;
          for (let x = -r; x <= r; x++) acc += a[o + clamp(x, 0, w - 1)];
          for (let x = 0; x < w; x++) {
            b[o + x] = acc / div;
            acc += a[o + Math.min(x + r + 1, w - 1)] - a[o + Math.max(x - r, 0)];
          }
        }
        for (let x = 0; x < w; x++) {
          let acc = 0;
          for (let y = -r; y <= r; y++) acc += b[clamp(y, 0, h - 1) * w + x];
          for (let y = 0; y < h; y++) {
            a[y * w + x] = acc / div;
            acc += b[Math.min(y + r + 1, h - 1) * w + x] - b[Math.max(y - r, 0) * w + x];
          }
        }
      }
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = a[i] * 255;
      M2.gb = out;
    };
    // the dredged Eel Pond channel reads far too shallow in the lidar (the
    // drawbridge deck and moored boats contaminate the return) — enforce the
    // charted dredged depth along the channel and its harbor approach
    const stampEel = (M) => {
      const path = [
        [41.5226, -70.6738], [41.5234, -70.6746], [41.5241, -70.6751],
        [41.5249, -70.6752], [41.5257, -70.6751], [41.5264, -70.6749],
        [41.5269, -70.6746],
      ];
      const v16min = Math.round(((3.0 + 5) / 45) * 65535);
      const pxM = Math.abs(M.lo1 - M.lo0) * M_LNG / Math.max(1, M.w - 1);
      const stampR = pxM > 15 ? 1 : 2;
      const stamp = (la, lo) => {
        const x = Math.round((lo - M.lo0) / (M.lo1 - M.lo0) * (M.w - 1));
        const y = Math.round((mercY(la) - M.myN) / (M.myS - M.myN) * (M.h - 1));
        for (let dy = -stampR; dy <= stampR; dy++) {
          for (let dx = -stampR; dx <= stampR; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= M.w || yy >= M.h) continue;
            const q = (yy * M.w + xx) * 4;
            if (M.d[q] * 256 + M.d[q + 1] < v16min) {
              M.d[q] = v16min >> 8;
              M.d[q + 1] = v16min & 255;
            }
            M.d[q + 2] = 255;
          }
        }
      };
      for (let i = 0; i < path.length - 1; i++) {
        for (let tt = 0; tt <= 1; tt += 0.2) {
          stamp(path[i][0] + (path[i + 1][0] - path[i][0]) * tt,
                path[i][1] + (path[i + 1][1] - path[i][1]) * tt);
        }
      }
      M.cnv.getContext('2d').putImageData(new ImageData(M.d, M.w, M.h), 0, 0);
    };
    const push = () => { if (waterGL && waterGL._gl) waterGL._applyGeo(); };

    // PHASE 1 — a phone boots on a quarter-linear core raster (0.61 MB);
    // desktop starts at half resolution. Both preserve the packed depth and
    // navigability channels exactly enough for their display scale.
    try {
      GEO = await decode(meta.core, MOBILE_MAP ? 'data/geom.png?v=1' : 'data/geoh.png?v=1');
    } catch (e1) {
      GEO = await decode(meta.core, 'data/geoh.png?v=1')
        .catch(() => decode(meta.core, 'data/geo.png?v=7'));
    }
    stampEel(GEO);
    // The baked flow mask already obeys the coast. Desktop can afford the
    // optional last-pixel shoreline correction at boot; phones build it only
    // with the close-zoom full-resolution upgrade below.
    if (!MOBILE_MAP) blurNav(GEO);
    push();
    if (chartTintLayer) chartTintLayer.redraw();

    if (MOBILE_MAP && GEO.w < Math.ceil(meta.core.w / 2)) {
      const upgradeCoreHalf = async () => {
        try {
          const g = await decode(meta.core, 'data/geoh.png?v=1');
          if (GEO && GEO.w >= g.w) return;
          stampEel(g);
          GEO = g;
          push();
          if (chartTintLayer) chartTintLayer.redraw();
          if (curArrows) curArrows.requestRedraw();
        } catch (e2) { console.warn('[geo] half-res refinement failed:', e2); }
      };
      setTimeout(() => runWhenIdle(upgradeCoreHalf, 5000), 1200);
    }

    const loadOuterGeo = async () => {
      try {
        GEO2 = await decode(meta.outer, 'data/geo2h.png?v=1')
          .catch(() => decode(meta.outer, 'data/geo2.png?v=7'));
        // The baked flow already follows the outer coastline. The extra
        // client-side shoreline correction is useful on desktop, but its
        // multi-pass raster blur is not worth blocking a phone's first paint.
        if (!MOBILE_MAP) blurNav(GEO2);
      } catch (e2) { console.warn('[geo] outer region missing:', e2); }
      if (meta.far) {
        // FAR tier: coarse but spans the map's full bounds, so wide views
        // render sea to every edge (no blur field — never seen close)
        try {
          GEO3 = await decode(meta.far, 'data/geo3h.png?v=1')
            .catch(() => decode(meta.far, 'data/geo3.png?v=1'));
        } catch (e4) { console.warn('[geo] far region missing:', e4); }
      }
      push();
      if (chartTintLayer) chartTintLayer.redraw();
    };
    if (MOBILE_MAP) {
      // The default phone viewport lies fully inside the core raster. Let it
      // become interactive on that single 2.2 MB image, then extend coverage.
      setTimeout(() => runWhenIdle(loadOuterGeo, 6000), 2500);
    } else {
      await loadOuterGeo();
    }

    // PHASE 2 — desktop streams full resolution behind the live map. Phones
    // stay on the already-sharp half-resolution rasters until a close zoom
    // actually benefits from the extra ~17 MB of images and decoded pixels.
    const upgradeGeo = async () => {
      try {
        if (GEO.w < meta.core.w) {
          const g = await decode(meta.core, 'data/geo.png?v=7');
          if (!GEO || GEO.w < g.w) {
            stampEel(g); blurNav(g); GEO = g; push();
          }
        }
        if (!MOBILE_MAP && GEO2 && GEO2.w < meta.outer.w) {
          const g = await decode(meta.outer, 'data/geo2.png?v=7');
          blurNav(g); GEO2 = g; push();
        }
        if (!MOBILE_MAP && meta.far && GEO3 && GEO3.w < meta.far.w) {
          const g = await decode(meta.far, 'data/geo3.png?v=1');
          blurNav(g); GEO3 = g;
          push();
        }
      } catch (e5) { console.warn('[geo] full-res upgrade failed:', e5); }
    };
    let geoUpgradeStarted = false;
    const startGeoUpgrade = () => {
      if (geoUpgradeStarted) return;
      geoUpgradeStarted = true;
      runWhenIdle(upgradeGeo, 2500);
    };
    if (MOBILE_MAP && map) {
      const maybeUpgradeGeo = () => {
        if (map.getZoom() < 15) return;
        map.off('zoomend', maybeUpgradeGeo);
        startGeoUpgrade();
      };
      map.on('zoomend', maybeUpgradeGeo);
      maybeUpgradeGeo();
    } else {
      startGeoUpgrade();
    }

    const loadWindAtlas = async () => {
      if (!meta.wind || WINDT) return;
      try {
        const wm = meta.wind;
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('wind.png failed')); img.src = 'data/wind.png?v=7'; });
        const c = document.createElement('canvas');
        c.width = wm.w * wm.grid[0]; c.height = wm.h * wm.grid[1];
        const cx = c.getContext('2d', { willReadFrequently: true });
        cx.drawImage(img, 0, 0);
        WINDT = Object.assign({ d: cx.getImageData(0, 0, c.width, c.height).data, gw: c.width, myN: mercY(wm.la0), myS: mercY(wm.la1) }, wm);
        if (windArrows) windArrows.notifyTime();
      } catch (e3) { console.warn('[geo] wind atlas missing:', e3); }
    };
    if (MOBILE_MAP) {
      // Give the visible map and controls the connection first; terrain
      // shelter detail can refine the already-live wind field afterwards.
      setTimeout(() => runWhenIdle(loadWindAtlas, 6000), 3500);
    } else {
      await loadWindAtlas();
    }
  } catch (e) {
    console.warn('[geo] baked geography failed to load:', e);
  }
}

/* Baked wind transfer: the landscape's whole effect on the live wind —
   log-profile land-cover exposure, canopy/terrain sheltering, crest speed-up
   and deflection — precomputed offline for 16 incoming directions
   (tools/bake_flow.py) and applied here as one bilinear atlas lookup. The
   WEATHER stays live; only the geometry's transfer function is baked. */
function windTransfer(lat, lng, u, v) {
  const M = WINDT;
  const spd = Math.hypot(u, v);
  if (!M || spd < 0.3) return [u, v];
  const fx = (lng - M.lo0) / (M.lo1 - M.lo0);
  const fy = (mercY(lat) - M.myN) / (M.myS - M.myN);
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return [u, v];
  let br = Math.atan2(-u, -v) / (2 * Math.PI) * M.ndir;   // wind-FROM bearing, slice units
  br = ((br % M.ndir) + M.ndir) % M.ndir;
  const k0 = br | 0, k1 = (k0 + 1) % M.ndir, tt = br - k0;
  const px = fx * (M.w - 1), py = fy * (M.h - 1);
  const x0 = Math.min(M.w - 2, px | 0), y0 = Math.min(M.h - 2, py | 0);
  const dx = px - x0, dy = py - y0;
  const read = (k, ch) => {
    const ox = (k % M.grid[0]) * M.w, oy = ((k / M.grid[0]) | 0) * M.h;
    const at = (x, y) => M.d[((oy + y0 + y) * M.gw + ox + x0 + x) * 4 + ch];
    return at(0, 0) * (1 - dx) * (1 - dy) + at(1, 0) * dx * (1 - dy)
         + at(0, 1) * (1 - dx) * dy + at(1, 1) * dx * dy;
  };
  const lerp = (a, b) => a * (1 - tt) + b * tt;
  const factor = lerp(read(k0, 0), read(k1, 0)) / 255 * M.factorScale;
  const defl = (lerp(read(k0, 1), read(k1, 1)) / 255) * 2 * M.deflRange - M.deflRange;
  const cs = Math.cos(defl), sn = Math.sin(defl);          // bearing delta → clockwise
  return [(u * cs + v * sn) * factor, (-u * sn + v * cs) * factor];
}

// which region covers this point? (core preferred — it is 2x sharper)
function geoAt(lat, lng) {
  for (const M of [GEO, GEO2, GEO3]) {
    if (!M) continue;
    const fx = (lng - M.lo0) / (M.lo1 - M.lo0);
    const fy = (mercY(lat) - M.myN) / (M.myS - M.myN);
    if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) return { M, fx, fy };
  }
  return null;
}



// water fraction (blurred mask) and its gradient — the outward shore normal
function shoreVec(lat, lng) {
  const hit = geoAt(lat, lng);
  if (!hit || !hit.M.gb) return null;
  const { M, fx, fy } = hit;
  if (fx < 0.01 || fx > 0.99 || fy < 0.01 || fy > 0.99) return null;
  const px = fx * (M.w - 1), py = fy * (M.h - 1);
  // blurred-water field is computed client-side at load (the raster's G
  // channel now carries the depth low byte)
  const R = (x, y) => M.gb[Math.round(clamp(y, 0, M.h - 1)) * M.w + Math.round(clamp(x, 0, M.w - 1))] / 255;
  const st = 2;                                     // ~9 m at bake resolution
  return {
    w: R(px, py),
    gx: R(px + st, py) - R(px - st, py),         // east
    gy: -(R(px, py + st) - R(px, py - st)),      // north (rows run southward)
  };
}

function isWaterAt(lat, lng) {
  if (!GEO && !GEO2) return true;
  const hit = geoAt(lat, lng);
  if (!hit) return true;
  const { M, fx, fy } = hit;
  const px = Math.round(fx * (M.w - 1)), py = Math.round(fy * (M.h - 1));
  return M.d[(py * M.w + px) * 4 + 2] > 127;        // B = navigable water
}

// Same lookup for raster-style loops that already share one Mercator y per
// scanline. Avoiding tens of thousands of tan/log conversions makes the
// chart palette's first mobile draw substantially cheaper.
function isWaterAtMerc(my0, lng) {
  if (!GEO && !GEO2) return true;
  for (const M of [GEO, GEO2, GEO3]) {
    if (!M) continue;
    const fx = (lng - M.lo0) / (M.lo1 - M.lo0);
    const fy = (my0 - M.myN) / (M.myS - M.myN);
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) continue;
    const px = Math.round(fx * (M.w - 1)), py = Math.round(fy * (M.h - 1));
    return M.d[(py * M.w + px) * 4 + 2] > 127;
  }
  return true;
}

// depth at MLLW from the baked raster (finer than the solver bathy grids).
// 16-bit: v = 256R + G, so the old 0.18 m terracing is gone (0.7 mm steps)
function geoDepth(lat, lng) {
  const hit = geoAt(lat, lng);
  if (!hit) return null;
  const { M, fx, fy } = hit;
  const px = Math.round(fx * (M.w - 1)), py = Math.round(fy * (M.h - 1));
  const q = (py * M.w + px) * 4;
  return (M.d[q] * 256 + M.d[q + 1]) / 65535 * 45 - 5;
}

/* Local wind exposure: march ~1.4 km upwind and accumulate land-cover roughness
   (classified from the map tiles: open water = full exposure, open/built land =
   medium, trees/vegetation = roughest). This is what breaks the coarse model
   field into local 0–30 ft structure — lee shelter behind the wooded shore,
   full fetch over the sounds. Building-level roughness would need an OSM bake
   (future nightly-action work); vegetation vs. open cover is real data today. */



/* ------------------------------ WebGL water layer ------------------------------ */

const GLWater = L.Layer.extend({
  onAdd(m) {
    this._map = m;
    const c = this._canvas = document.createElement('canvas');
    // gl-water tag: the dark-basemap variants dim THIS canvas via CSS
    // without touching the mark canvases that share the pane
    c.className = 'flow-canvas gl-water';
    m.getPane('waterPane').appendChild(c);
    this._gl = c.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false, depth: false, stencil: false })
            || c.getContext('experimental-webgl', { alpha: true, premultipliedAlpha: false });
    if (!this._gl) { this._dead = true; if (this._onDead) this._onDead(); return; }
    // a lost context otherwise blanks the water for good while _tick keeps
    // drawing into it; preventDefault opts into the browser's restore path
    c.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this._hasMask = false; });
    c.addEventListener('webglcontextrestored', () => {
      this._initGL();
      this._geoUpFor = this._geo2UpFor = this._geo3UpFor = null;
      this._tideUp = false; this._flowTexBuilt = false;
      this._reset();
    });
    this._initGL();
    if (this._dead) { if (this._onDead) this._onDead(); return; }
    // microtask-coalesced: Leaflet fires zoomend+moveend (and moveend+resize
    // on invalidateSize) in one task — one reset, still before paint
    this._onMoveEnd = () => {
      if (this._rsQ) return;
      this._rsQ = true;
      Promise.resolve().then(() => { this._rsQ = false; this._reset(); });
    };
    m.on('moveend zoomend resize', this._onMoveEnd);
    this._reset();
    this._running = true;
    this._flowStamp = 0;
    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  },
  onRemove(m) {
    this._running = false;
    m.off('moveend zoomend resize', this._onMoveEnd);
    releaseCanvasZoom(this, m);
    this._canvas.remove();
  },
  setPaused(p) { this._paused = p; },
  flowDirty() { this._flowDirtyFlag = true; },
  _initGL() {
    const gl = this._gl;
    const vs = `attribute vec2 p; varying vec2 vUV;
      void main(){ vUV = vec2(p.x*0.5+0.5, 0.5-p.y*0.5); gl_Position = vec4(p,0.,1.); }`;
    const fs = `
      // fp16 "mediump" (a real thing on phone GPUs, unlike desktop) cannot
      // hold the 16-bit depth decode or kilometer world coordinates — use
      // highp wherever the hardware offers it (every phone since ~2014)
      #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
      #else
      precision mediump float;
      #endif

      varying vec2 vUV;
      uniform sampler2D uMask, uMask2, uMask3, uFlow, uNoise, uTideA, uWindT;
      uniform vec2 uRes, uWindDir, uSwellDir;
      uniform vec4 uMaskXf, uMaskXf2, uMaskXf3, uTideXf, uWorld;
      uniform float uTime, uTide, uChart, uWindKn, uWaveLen, uSeaFt, uWaves, uSwellAmp;
      uniform vec2 uTexel, uTexel2;
      uniform float uTideS[9];
      float hAt(sampler2D s, vec2 uv, float td) {
        vec4 t = texture2D(s, uv);
        return (t.r * 65280.0 + t.g * 255.0) / 65535.0 * 45.0 - 5.0 + td;
      }
      void main(){
        vec2 muv = vUV * uMaskXf.xy + uMaskXf.zw;
        vec2 m2v = vUV * uMaskXf2.xy + uMaskXf2.zw;
        vec2 m3v = vUV * uMaskXf3.xy + uMaskXf3.zw;
        vec4 mk;
        float tier = 0.0;                        // 0 core, 1 outer ring, 2 far
        if (muv.x >= 0.0 && muv.x <= 1.0 && muv.y >= 0.0 && muv.y <= 1.0) {
          mk = texture2D(uMask, muv);            // high-res core region
        } else if (m2v.x >= 0.0 && m2v.x <= 1.0 && m2v.y >= 0.0 && m2v.y <= 1.0) {
          mk = texture2D(uMask2, m2v);           // outer ring
          tier = 1.0;
        } else {
          if (uMaskXf3.x == 0.0 || m3v.x < 0.0 || m3v.x > 1.0 || m3v.y < 0.0 || m3v.y > 1.0) discard;
          mk = texture2D(uMask3, m3v);           // far tier: the full bounds
          tier = 2.0;
        }
        float m = smoothstep(0.32, 0.72, mk.b);
        if (m < 0.04) discard;
        // 16-bit depth: v = 256R + G is linear in (R, G), so the GPU's
        // bilinear filtering reconstructs the smooth field exactly —
        // no terracing, no dither needed
        float h0 = (mk.r * 65280.0 + mk.g * 255.0) / 65535.0 * 45.0 - 5.0;
        // LOCAL tide: the atlas carries each pixel's range ratio + phase lag
        // vs Woods Hole; uTideS[] samples the live WH curve hourly t-4h..t+4h,
        // so Buzzards Bay floods on its own clock, ~2x the Sound's range
        float tide = uTide;
        vec2 tuv = vUV * uTideXf.xy + uTideXf.zw;
        if (uTideXf.x != 0.0 && tuv.x >= 0.0 && tuv.x <= 1.0 && tuv.y >= 0.0 && tuv.y <= 1.0) {
          vec4 tk = texture2D(uTideA, tuv);
          float uu = clamp(4.0 - (tk.g * 9.0 - 4.5), 0.0, 7.999);
          float acc = uTide;
          for (int i = 0; i < 8; i++) {
            float fi = float(i);
            if (uu >= fi && uu < fi + 1.0) acc = mix(uTideS[i], uTideS[i + 1], uu - fi);
          }
          tide = acc * (tk.r * 2.0);
        }
        float H = h0 + tide;                    // water depth at this moment
        vec2 px = vUV * uRes;
        float Hd = H;                           // 16-bit depth is already smooth
        // enclosed-puddle fill v2: a pocket ringed by dry flat is mud with a
        // film on it, not open water. Twelve taps on two rings + diagonals;
        // a channel is PROTECTED whenever either opposite pair of near
        // neighbors is wet (the Eel Pond cut keeps its along-axis pair).
        if (Hd > 0.0 && Hd < 2.0 && tier < 1.5) {
          vec2 tx = tier < 0.5 ? uTexel : uTexel2;
          vec2 uu = tier < 0.5 ? muv : m2v;
          float hN = 0.0, hS = 0.0, hE = 0.0, hW = 0.0, dcnt = 0.0;
          for (int k = 0; k < 12; k++) {
            vec2 o = k == 0 ? vec2(2.5 * tx.x, 0.0)
                   : k == 1 ? vec2(-2.5 * tx.x, 0.0)
                   : k == 2 ? vec2(0.0, 2.5 * tx.y)
                   : k == 3 ? vec2(0.0, -2.5 * tx.y)
                   : k == 4 ? vec2(5.0 * tx.x, 0.0)
                   : k == 5 ? vec2(-5.0 * tx.x, 0.0)
                   : k == 6 ? vec2(0.0, 5.0 * tx.y)
                   : k == 7 ? vec2(0.0, -5.0 * tx.y)
                   : k == 8 ? vec2(2.5 * tx.x, 2.5 * tx.y)
                   : k == 9 ? vec2(-2.5 * tx.x, 2.5 * tx.y)
                   : k == 10 ? vec2(2.5 * tx.x, -2.5 * tx.y)
                   : vec2(-2.5 * tx.x, -2.5 * tx.y);
            float hn = tier < 0.5 ? hAt(uMask, uu + o, tide) : hAt(uMask2, uu + o, tide);
            if (k == 0) hE = hn;
            if (k == 1) hW = hn;
            if (k == 2) hS = hn;
            if (k == 3) hN = hn;
            if (hn < 0.03) dcnt += 1.0;
          }
          float channel = max(step(0.03, hN) * step(0.03, hS),
                              step(0.03, hE) * step(0.03, hW));
          if (channel < 0.5 && dcnt >= 8.0) Hd = -0.02;   // join the flat
        }
        if (Hd <= 0.03) {
          // ground above this tide: exposed flat, clearly WET near the
          // waterline and drying toward tan higher up — visibly different
          // from the cream land so the shoreline breathes with the tide
          float sn = texture2D(uNoise, px / 150.0).g;
          float dry = clamp(-Hd / 0.5, 0.0, 1.0);
          vec3 wetSand = vec3(0.55, 0.52, 0.42);
          vec3 drySand = vec3(0.78, 0.73, 0.58);
          vec3 sand = mix(wetSand, drySand, dry) * (0.94 + (sn - 0.5) * 0.14);
          if (uChart > 0.5) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
          } else {
            gl_FragColor = vec4(sand, 0.96 * m);
          }
        } else {
          vec4 flc = texture2D(uFlow, vUV);
          vec2 fl = flc.rg * 16.0 - 8.0;
          float spd = length(fl);
          float chop = flc.b;                   // wind-against-tide + overfalls

          // ONE water color — depth belongs to the chart, speed to the arrows.
          // The surface itself carries only what a surface shows: waves and foam.
          // Waves live in WORLD meters (uWorld maps the view onto the earth), so
          // they are pinned to the water they ride — never sliding over land,
          // never swimming when the map pans.
          //
          // ---- a sampled DIRECTIONAL SPECTRUM (how real renderers do it):
          // five pure plane-wave trains drawn from a cos^2 spread about the
          // wind, each with its own wavelength and TRUE dispersion speed
          // omega = sqrt(g k), plus a long swell train on the model's swell
          // direction. Every component keeps a constant direction — variety
          // comes from interference, so topological defects cannot form.
          vec2 wpos = uWorld.xy + vUV * uWorld.zw;
          // LOCAL WIND EVERYWHERE: the simulation's own wind field (terrain
          // transfer + live obs) rides in a small texture over the view.
          // A plane wave's phase cannot follow a per-pixel direction (the
          // lever-arm defect), so the local wind STEERS A BASIS instead:
          // eight fixed-direction wave systems, every 45 degrees, each a
          // globally valid field, amplitude-blended per pixel by how closely
          // they bracket the wind blowing at that spot.
          vec4 wtex = texture2D(uWindT, vUV);
          vec2 wvec = (wtex.rg - 0.5) * 88.0;           // local wind u,v (kn)
          float wKn = length(wvec);
          vec2 dirF;
          if (wKn > 0.5) {
            dirF = vec2(wvec.x, -wvec.y) / wKn;
          } else {                                      // no wind data yet
            dirF = normalize(uWindDir + vec2(1.0e-4, 0.0));
            wKn = uWindKn;
          }
          float thL = atan(dirF.x, -dirF.y);            // travel-toward angle
          vec2 dS = normalize(uSwellDir + vec2(1.0e-4, 0.0));

          // FETCH: five soft wetness taps marching upwind (the LOCAL upwind),
          // cumulatively shadowed — a continuous field, no drawn borders.
          vec2 uvPerM = (tier < 0.5 ? uMaskXf.xy : tier < 1.5 ? uMaskXf2.xy : uMaskXf3.xy) / uWorld.zw;
          vec2 buv = tier < 0.5 ? muv : tier < 1.5 ? m2v : m3v;
          float openAcc = 1.0, fetchN = 0.0;
          for (int k = 0; k < 5; k++) {
            float dM = k == 0 ? 60.0 : k == 1 ? 150.0 : k == 2 ? 350.0
                     : k == 3 ? 800.0 : 1800.0;
            float wgt = k == 0 ? 0.12 : k == 1 ? 0.14 : k == 2 ? 0.20
                      : k == 3 ? 0.26 : 0.28;
            vec2 suv = buv - dirF * dM * uvPerM;
            float hh = tier < 0.5 ? hAt(uMask, suv, tide)
                     : tier < 1.5 ? hAt(uMask2, suv, tide) : hAt(uMask3, suv, tide);
            openAcc *= smoothstep(0.0, 0.45, hh);
            fetchN += wgt * openAcc;
          }
          float fF = clamp(pow(fetchN, 0.55), 0.12, 1.0);

          // a wave cannot outsize its water (depth-limited height); long-fetch
          // waves rear up over shoals (Nobska); rips steepen what arrives
          float depthAtt = smoothstep(0.06, 1.1, H);
          // anti-alias: when a wavelength falls under ~5 screen pixels the
          // sin field can only alias into false mega-stripes — fade the
          // waves to calm tint instead (you can't see 100 m waves from 10 km)
          float pxWave = uWaveLen / max(uWorld.z / uRes.x, 1.0);
          float aaF = smoothstep(3.5, 7.5, pxWave);
          float shoal = 1.0 + 0.45 * (1.0 - smoothstep(3.0, 12.0, H)) * smoothstep(0.45, 0.72, fetchN);
          // gust patchiness: the wind sea is streaky (cat's paws, gust
          // darkening) — a drifting km-scale amplitude field breaks any
          // large-area alignment into patches. Amplitude-only, defect-safe.
          float patch = 0.70 + 0.60 * texture2D(uNoise, wpos / 15000.0 + dirF * (uTime * 0.001)).g;
          float seaW = (0.30 + 0.70 * smoothstep(5.0, 18.0, wKn)) * fF;
          seaW = min(1.25, seaW * shoal + chop * 0.55) * patch * depthAtt * uWaves * aaF;
          float swA = uSwellAmp * clamp(pow(fetchN, 0.4), 0.25, 1.0);
          swA = min(0.9, swA * shoal) * depthAtt * uWaves * aaF;

          float k0 = 6.2832 / uWaveLen;
          float kS = k0 / 2.6;
          float warp = (texture2D(uNoise, wpos / (uWaveLen * 7.0)).r - 0.5) * 1.6;
          float wrp2 = (texture2D(uNoise, wpos / (uWaveLen * 3.1) + vec2(0.37, 0.11)).g - 0.5) * 1.1;
          // long-wave phase decorrelation: rows a few km apart drift out of
          // register, so the sea never reads as one map-wide grating; when
          // the rendered wavelength saturates wide (a texture, not literal
          // waves) the decorrelation deepens so no corduroy sheet can form
          float warpL = (texture2D(uNoise, wpos / 5200.0).b - 0.5) * 2.6
                      * (1.0 + 1.2 * smoothstep(120.0, 500.0, uWaveLen));
          float wS = sqrt(9.81 * kS);
          float phS = dot(wpos, dS) * kS - wS * uTime + warp * 0.5 + warpL * 0.5;
          float cS = pow(0.5 + 0.5 * sin(phS), 2.5);

          // THE STEERED BASIS: eight complete wave systems at fixed 45-deg
          // headings (main train + two 25-deg obliques each, true dispersion).
          // Hat weights pick the two systems bracketing the LOCAL wind and
          // fade between them — direction varies pixel by pixel, yet every
          // phase field in the sum stays a perfect plane wave. Adjacent
          // headings flip warpL sign and oblique handedness, so where two
          // systems meet the blend gains texture instead of doubling up.
          float crestW = 0.0, litW = 0.0, shdW = 0.0;
          for (int k = 0; k < 8; k++) {
            float th = float(k) * 0.7853982;
            float dth = abs(mod(thL - th + 3.1415926, 6.2831853) - 3.1415926);
            float wgt = clamp(1.0 - dth / 0.7853982, 0.0, 1.0);
            if (wgt > 0.001) {
              bool ev = mod(th, 1.5707963) < 0.5;
              vec2 D = vec2(sin(th), -cos(th));
              // WIDE obliques (+-33 deg) and a wavelength split between
              // neighbouring headings: three different k vectors interfere
              // into short cells instead of one long ridge
              vec2 D1 = vec2(D.x * 0.839 - D.y * 0.545, D.x * 0.545 + D.y * 0.839);
              vec2 D2 = vec2(D.x * 0.839 + D.y * 0.545, -D.x * 0.545 + D.y * 0.839);
              float kk = k0 * (ev ? 1.0 : 1.13);
              float kq = kk / 0.72;
              float wk0 = sqrt(9.81 * kk), wk1 = sqrt(9.81 * kq);
              float wl = warpL * (ev ? 1.0 : -1.0);
              float ph0 = dot(wpos, D) * kk - wk0 * uTime + warp + wl;
              float ph1 = dot(wpos, D1) * kq - wk1 * uTime + wrp2 + wl;
              float ph2 = dot(wpos, D2) * kq - wk1 * uTime - wrp2 + wl;
              crestW += wgt * (pow(0.5 + 0.5 * sin(ph0), 3.0) * 0.34
                             + pow(0.5 + 0.5 * sin(ph1), 3.0) * 0.27
                             + pow(0.5 + 0.5 * sin(ph2), 3.0) * 0.27);
              litW += wgt * (pow(0.5 + 0.5 * sin(ph0 + 0.85), 3.0) * 0.34
                           + pow(0.5 + 0.5 * sin(ph1 + 0.85), 3.0) * 0.30);
              shdW += wgt * (pow(0.5 + 0.5 * sin(ph0 - 0.85), 3.0) * 0.34
                           + pow(0.5 + 0.5 * sin(ph1 - 0.85), 3.0) * 0.30);
            }
          }
          // SHORT-CRESTEDNESS: real crests live only a few wavelengths
          // before dying — an amplitude cell field at ~2.7 wavelengths
          // (drifting downwind) chops every ridge into dashes. Amplitude
          // only, so it can never create a phase defect.
          float shortC = 0.48 + 1.04 * texture2D(uNoise,
            wpos / (uWaveLen * 2.7) + vec2(0.53, 0.21) + dirF * (uTime * 0.006)).r;
          crestW *= shortC; litW *= shortC; shdW *= shortC;

          // SHORE ROLLERS: near land the phase comes from the DEPTH FIELD
          // itself — crests are iso-depth contours marching shoreward.
          // Zeroth-order refraction: the reason beach waves always roll IN.
          float rollAtt = smoothstep(0.04, 0.5, H);
          float wSh = (1.0 - smoothstep(1.8, 5.0, H)) * clamp((fetchN - 0.25) / 0.45, 0.0, 1.0);
          // +t: constant-phase crests march to SMALLER depth — toward shore,
          // the way real waves always arrive at a beach
          float phSh = 14.5 * sqrt(max(H, 0.05)) + 1.25 * uTime + warp * 0.6;
          float cSh = pow(0.5 + 0.5 * sin(phSh), 3.0);
          float ampSh = (seaW * 0.5 + swA * 0.7) * rollAtt;

          float sig = mix(crestW * seaW + cS * swA, cSh * ampSh, wSh);

          // 3-D: lit and shadowed flanks (litW/shdW accumulated in the basis)
          float litS = pow(0.5 + 0.5 * sin(phS + 0.85), 2.5);
          float shdS = pow(0.5 + 0.5 * sin(phS - 0.85), 2.5);
          float litH = pow(0.5 + 0.5 * sin(phSh + 0.85), 2.5);
          float shdH = pow(0.5 + 0.5 * sin(phSh - 0.85), 2.5);
          float relief = mix((litW - shdW) * seaW + (litS - shdS) * swA,
                             (litH - shdH) * ampSh, wSh);

          // Exact requested flat ocean color: rgb(0, 127, 255).
          vec3 base = vec3(0.0, 0.498039, 1.0);
          vec3 rgb = base * (1.0 + relief * 0.36 - sig * 0.10);

          // whitecaps: local U10 (layer mean x 1.11) with fetch, the rips,
          // and SHORE BREAK — whitewater where the arriving sea outsizes the
          // remaining depth ("waves landing into the land")
          float foamN = texture2D(uNoise, wpos / (uWaveLen * 0.55) + dirF * (uTime * 0.02)).g;
          float w10 = wKn * 1.11;
          float capF = clamp((fetchN - 0.28) / 0.55, 0.0, 1.0);
          float brk = wSh * (seaW * 0.6 + swA * 0.8) * capF
                    * (1.0 - smoothstep(0.3, 1.2, H)) * 0.9;
          float capDrive = clamp(smoothstep(10.0, 23.0, w10) * capF * 0.75
                                 + chop * 1.2 + brk, 0.0, 1.4) * uWaves;
          float cap = smoothstep(0.88 - 0.45 * capDrive, 1.28, sig + foamN * 0.35);
          rgb = mix(rgb, vec3(0.97, 0.985, 1.0), clamp(cap, 0.0, 1.0) * 0.95);

          // thin film over a flat: read as wet sand, not a crisp puddle
          float film = 1.0 - smoothstep(0.03, 0.30, Hd);
          rgb = mix(rgb, vec3(0.55, 0.52, 0.42), film * 0.72 * uWaves);

          float alpha;
          if (uChart > 0.5) {
            // A dedicated shoreline-masked canvas owns both chart colors.
            alpha = 0.0;
          } else {
            alpha = m;
          }
          gl_FragColor = vec4(rgb, clamp(alpha, 0.0, 1.0));
        }
      }`;
    const sh = (type, src) => {
      const h = gl.createShader(type);
      gl.shaderSource(h, src); gl.compileShader(h);
      if (!gl.getShaderParameter(h, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(h)); this._dead = true; }
      return h;
    };
    const prog = this._prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this._u = {};
    for (const n of ['uMask', 'uMask2', 'uMask3', 'uFlow', 'uNoise', 'uTideA', 'uRes', 'uTime', 'uMaskXf', 'uMaskXf2', 'uMaskXf3', 'uTideXf', 'uWorld', 'uWindDir', 'uSwellDir', 'uWindT', 'uTide', 'uChart', 'uWindKn', 'uWaveLen', 'uSeaFt', 'uWaves', 'uSwellAmp', 'uTexel', 'uTexel2']) this._u[n] = gl.getUniformLocation(prog, n);
    this._u.uTideS = gl.getUniformLocation(prog, 'uTideS[0]') || gl.getUniformLocation(prog, 'uTideS');
    gl.uniform1f(this._u.uTide, 0.55);
    gl.uniform4f(this._u.uTideXf, 0, 0, 9, 9);    // disabled until the atlas lands
    gl.uniform2f(this._u.uWindDir, 0.7, -0.4);
    gl.uniform1f(this._u.uWindKn, 8);
    gl.uniform1f(this._u.uWaveLen, 45);
    gl.uniform1f(this._u.uChart, 0);
    gl.uniform1f(this._u.uSeaFt, 0);
    gl.uniform1f(this._u.uWaves, 0);
    gl.uniform2f(this._u.uSwellDir, 0.7, -0.4);
    gl.uniform1f(this._u.uSwellAmp, 0);

    const mkTex = (unit) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this._texMask = mkTex(0);
    this._texFlow = mkTex(1);
    this._texMask2 = mkTex(3);
    this._texTide = mkTex(4);
    this._texWindG = mkTex(5);        // local wind field (u, v, hs) per view
    this._texMask3 = mkTex(6);        // far tier: full map bounds, coarse
    // tiling noise — value noise via progressively upscaled random canvases
    this._texNoise = mkTex(2);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, makeNoiseCanvas(256));
    gl.uniform1i(this._u.uMask, 0);
    gl.uniform1i(this._u.uFlow, 1);
    gl.uniform1i(this._u.uNoise, 2);
    gl.uniform1i(this._u.uMask2, 3);
    gl.uniform1i(this._u.uTideA, 4);
    gl.uniform1i(this._u.uWindT, 5);
    gl.uniform1i(this._u.uMask3, 6);
    gl.uniform4f(this._u.uMaskXf2, 0, 0, 9, 9);   // degenerate until geo2 uploads
    gl.uniform4f(this._u.uMaskXf3, 0, 0, 9, 9);   // degenerate until geo3 uploads
  },
  _reset() {
    // no map yet: the layer's onAdd is deferred until the map gets its first
    // view (page opened in a background tab) — onAdd will call us again
    if (this._dead || !this._map) return;
    const m = this._map;
    const r = padReset(this, m, 1.5);
    if (!r) {
      clearTimeout(this._retryT);
      this._retryT = setTimeout(() => this._reset(), 150);
      return;
    }
    const gl = this._gl;
    gl.viewport(0, 0, this._canvas.width, this._canvas.height);
    gl.useProgram(this._prog);
    gl.uniform2f(this._u.uRes, this._w, this._h);
    // reposition + uniforms are per-frame cheap and run synchronously with
    // the tiles; only the CPU flow resample is debounced
    if (!this._flowTexBuilt) this._updateFlowTex();
    else this._flowTexSoon();
    this._applyGeo();
  },
  // The whole region's geography lives in one static texture (uploaded once);
  // a pan/zoom only remaps which sub-rectangle the shader samples — pure
  // uniform math, no fetches, so the land can never lag the basemap or chart.
  _applyGeo() {
    if (!GEO || this._dead || !this._nw) return;   // padReset has not succeeded yet
    const gl = this._gl;
    // per-raster upload tracking: the three tiers finish decoding at
    // different times — a single "uploaded" latch would freeze out
    // whichever tier lost the race (its empty texture samples black,
    // which the shader reads as "no water" and discards to void)
    if (this._geoUpFor !== GEO.cnv) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._texMask);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, GEO.cnv);
      this._geoUpFor = GEO.cnv;
      this._hasMask = true;
      if (curArrows) curArrows.requestRedraw();
      if (windArrows) windArrows.notifyTime();
    }
    if (GEO2 && this._geo2UpFor !== GEO2.cnv) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this._texMask2);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, GEO2.cnv);
      this._geo2UpFor = GEO2.cnv;
    }
    if (GEO3 && this._geo3UpFor !== GEO3.cnv) {
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D, this._texMask3);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, GEO3.cnv);
      this._geo3UpFor = GEO3.cnv;
    }
    if (TIDEA && !this._tideUp) {
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this._texTide);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, TIDEA.cnv);
      this._tideUp = true;
    }
    const myn = mercY(this._nw.lat), mys = mercY(this._se.lat);
    const xf = (M) => [
      (this._se.lng - this._nw.lng) / (M.lo1 - M.lo0),
      (mys - myn) / (M.myS - M.myN),
      (this._nw.lng - M.lo0) / (M.lo1 - M.lo0),
      (myn - M.myN) / (M.myS - M.myN),
    ];
    gl.uniform4f(this._u.uMaskXf, ...xf(GEO));
    gl.uniform2f(this._u.uTexel, 1 / GEO.w, 1 / GEO.h);
    if (GEO2) {
      gl.uniform4f(this._u.uMaskXf2, ...xf(GEO2));
      gl.uniform2f(this._u.uTexel2, 1 / GEO2.w, 1 / GEO2.h);
    }
    if (GEO3) gl.uniform4f(this._u.uMaskXf3, ...xf(GEO3));
    if (this._tideUp) gl.uniform4f(this._u.uTideXf, ...xf(TIDEA));
    // world-meter mapping for the wave field (equirect about 41.52 N; the
    // origin is the outer box's NW corner so coordinates stay small)
    const MPLNG = 83345, MPMY = 4777155, MYREF = mercY(41.650);
    // ORIGINAL sign convention (world y north-positive, direction vectors
    // screen-convention). KNOWN OPEN ITEM: this pairing mirrors wave travel
    // north-south; both algebraically equivalent corrections (flip world y,
    // or flip the direction vectors) blank the water entirely, so some other
    // shader term depends on this pairing — fixing the mirror needs a full
    // audit of every wpos consumer, not a sign patch.
    const wx0 = (this._nw.lng + 70.9025) * MPLNG;
    const wy0 = (myn - MYREF) * MPMY;
    const ww = (this._se.lng - this._nw.lng) * MPLNG;
    const wh = (mys - myn) * MPMY;
    gl.uniform4f(this._u.uWorld, wx0, wy0, ww, wh);
    // wave SPACING: physically sized from the forecast sea where the screen
    // can resolve it; clamped to [6.5, 26] screen px so it never aliases
    // into mega-stripes at wide zoom (fine corduroy instead — what a sea
    // looks like from altitude) and never engulfs a cove at high zoom.
    // Per-frame sea-state modulation happens in _tick.
    this._mpp = ww / Math.max(1, this._w);
    gl.uniform1f(this._u.uWaveLen, clamp(64, this._mpp * 6.5, this._mpp * 26));
  },
  _flowTexSoon() {
    clearTimeout(this._ftT);
    this._ftT = setTimeout(() => this._updateFlowTex(), 250);
  },
  _updateFlowTex() {
    if (!this._nw) return;                          // padReset has not succeeded yet
    this._flowTexBuilt = true;
    const gl = this._gl, FW = 72, FH = 54;
    const buf = this._flowBuf || (this._flowBuf = new Uint8Array(FW * FH * 4));
    const t = clamp(S.tScrub, S.tMin, S.tMax);
    // coarse wind subgrid — wind varies smoothly, no need to sample per texel
    const WX = 13, WY = 10;
    const wg = this._windBuf || (this._windBuf = new Float32Array(WX * WY * 2));
    const hg = this._hsBuf || (this._hsBuf = new Float32Array(WX * WY));
    const wT = S.wind ? clamp(t, S.wind.times[0], S.wind.times[S.wind.times.length - 1]) : t;
    const N = S.necofs;
    const hsOk = N && N.hs && N.wtimes && N.wtimes.length > 1;
    let hk = 0, ha = 0;
    const sB = seasBias(t);            // buoy-measured correction, one per pass
    if (hsOk) {
      const step = N.wtimes[1] - N.wtimes[0];
      hk = clamp(Math.floor((t - N.wtimes[0]) / step), 0, N.wtimes.length - 2);
      ha = clamp((t - N.wtimes[hk]) / step, 0, 1);
    }
    for (let j = 0; j < WY; j++) {
      const la = this._nw.lat + (this._se.lat - this._nw.lat) * (j / (WY - 1));
      for (let i = 0; i < WX; i++) {
        const lo = this._nw.lng + (this._se.lng - this._nw.lng) * (i / (WX - 1));
        const w = S.wind ? sampleWind(la, lo, wT) : [0, 0];
        wg[(j * WX + i) * 2] = w[0];
        wg[(j * WX + i) * 2 + 1] = w[1];
        // significant wave height (ft) from the nearest NECOFS/SWAN node —
        // opposition chop needs an existing sea to steepen
        let hs = 2;
        if (hsOk) {
          let bd = Infinity, bi = 0;
          for (let p = 0; p < N.wpts.length; p++) {
            const dy = N.wpts[p][0] - la, dx = (N.wpts[p][1] - lo) * 0.74;
            const d = dx * dx + dy * dy;
            if (d < bd) { bd = d; bi = p; }
          }
          hs = (N.hs[hk][bi] * (1 - ha) + N.hs[hk + 1][bi] * ha) * 0.0328084 * sB;
        }
        hg[j * WX + i] = hs;
      }
    }
    for (let j = 0; j < FH; j++) {
      const lat = this._nw.lat + (this._se.lat - this._nw.lat) * ((j + 0.5) / FH);
      for (let i = 0; i < FW; i++) {
        const lng = this._nw.lng + (this._se.lng - this._nw.lng) * ((i + 0.5) / FW);
        // chop intensity: wind blowing AGAINST the current stands the sea up;
        // fast flow over a shallow bar (Froude) makes overfalls even in calm.
        // The LOCAL (terrain-sheltered) wind speed rides in the alpha channel
        // so whitecaps follow the wind the harbor actually feels.
        let chop = 0;
        const fx = (i / (FW - 1)) * (WX - 1), fy = (j / (FH - 1)) * (WY - 1);
        const i0 = Math.min(WX - 2, Math.floor(fx)), j0 = Math.min(WY - 2, Math.floor(fy));
        const ax = fx - i0, ay = fy - j0;
        const gw = (k) => {
          const q = (j0 * WX + i0) * 2 + k;
          return wg[q] * (1 - ax) * (1 - ay) + wg[q + 2] * ax * (1 - ay)
            + wg[q + WX * 2] * (1 - ax) * ay + wg[q + WX * 2 + 2] * ax * ay;
        };
        const wu = gw(0), wv = gw(1);
        const ws = Math.hypot(wu, wv);
        // the subgrid wind doubles as the drift input — no per-texel resample
        const [u, v] = sampleWater(lat, lng, t, S.wind ? [wu, wv] : null);
        const o = (j * FW + i) * 4;
        buf[o] = clamp((u + 8) / 16, 0, 1) * 255;
        buf[o + 1] = clamp((v + 8) / 16, 0, 1) * 255;
        const cs = Math.hypot(u, v);
        if (cs > 0.45) {
          if (ws > 7) {
            const opp = -(u * wu + v * wv) / (cs * ws);
            if (opp > 0.25) {
              // scale by the forecast sea state: a current opposing 2 ft of
              // running sea makes rips; opposing 6 in of chop makes texture
              const q = (j0 * WX + i0);
              const hs = hg[q] * (1 - ax) * (1 - ay) + hg[q + 1] * ax * (1 - ay)
                + hg[q + WX] * (1 - ax) * ay + hg[q + WX + 1] * ax * ay;
              const seaScale = clamp(0.35 + hs / 3.0, 0.4, 1.5);
              chop = clamp((cs - 0.45) / 1.6, 0, 1) * clamp((ws - 7) / 9, 0, 1)
                * Math.pow(opp, 1.4) * seaScale;
            }
          }
          const h0v = depthMLLW(lat, lng);
          if (h0v != null) {
            const Hn = Math.max(h0v + localTideM(lat, lng, t), 0.3);
            const fr = cs * 0.514444 / Math.sqrt(9.81 * Hn);
            chop += clamp((fr - 0.30) / 0.4, 0, 1) * clamp((cs - 1.7) / 1.5, 0, 1) * 0.85;
          }
        }
        buf[o + 2] = clamp(chop, 0, 1) * 255;
        buf[o + 3] = S.wind ? clamp(ws / 40, 0.025, 1) * 255 : 0;   // local wind kn / 40
      }
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._texFlow);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, FW, FH, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // ship the same wind subgrid to the GPU: every pixel's waves steer by
    // the wind THERE (u, v in +-44 kn; B carries forecast hs, ft/12)
    const wtb = this._windTexBuf || (this._windTexBuf = new Uint8Array(WX * WY * 4));
    for (let q = 0; q < WX * WY; q++) {
      wtb[q * 4] = clamp(wg[q * 2] / 88 + 0.5, 0, 1) * 255;
      wtb[q * 4 + 1] = clamp(wg[q * 2 + 1] / 88 + 0.5, 0, 1) * 255;
      wtb[q * 4 + 2] = clamp(hg[q] / 12, 0, 1) * 255;
      wtb[q * 4 + 3] = 255;
    }
    if (!S.wind) for (let q = 0; q < WX * WY; q++) { wtb[q * 4] = 128; wtb[q * 4 + 1] = 128; }
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this._texWindG);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, WX, WY, 0, gl.RGBA, gl.UNSIGNED_BYTE, wtb);
    this._flowDirtyFlag = false;
    this._flowStamp = performance.now();
  },
  _tick(now) {
    if (!this._running) return;
    requestAnimationFrame(this._tick);
    if (this._dead || !this._hasMask) return;
    if (this._paused || document.hidden) return;
    if (this._flowDirtyFlag && now - this._flowStamp > 90) this._updateFlowTex();
    const gl = this._gl;
    gl.useProgram(this._prog);
    gl.uniform1f(this._u.uTime, REDUCED_MOTION ? 0 : now / 1000);
    if (S.wind) {
      const tw = clamp(S.tScrub, S.wind.times[0], S.wind.times[S.wind.times.length - 1]);
      const s = sampleWind(CENTER.lat, CENTER.lng, tw);
      const mgn = Math.hypot(s[0], s[1]);
      if (mgn > 0.3) gl.uniform2f(this._u.uWindDir, s[0] / mgn, -s[1] / mgn);
      gl.uniform1f(this._u.uWindKn, mgn);
    }
    gl.uniform1f(this._u.uChart, this._chartMode ? 1 : 0);
    gl.uniform1f(this._u.uWaves, 0);
    const tb = clamp(S.tScrub, S.tMin, S.tMax);
    const sf = waveFt(tb);
    gl.uniform1f(this._u.uSeaFt, sf == null ? 0 : sf);
    gl.uniform1f(this._u.uSwellAmp, 0);
    // wave SPACING: the forecast sea sets a PHYSICAL peak wavelength
    // (~24 m ripple chop up to ~104 m storm sea); the screen clamp keeps it
    // drawable — floor 6.5 px (fine corduroy at wide zoom, in place of the
    // old giant map-spanning stripes), cap 26 px (coves stay coves)
    if (this._mpp) {
      const Tp = waveTp(tb);
      const lamSea = Tp != null
        ? clamp(1.56 * Tp * Tp, 14, 260)               // lambda = g T^2 / 2 pi
        : 24 + 20 * clamp(sf == null ? 2 : sf, 0, 4);  // height guess fallback
      gl.uniform1f(this._u.uWaveLen, clamp(lamSea, this._mpp * 6.5, this._mpp * 26));
    }
    // swell: true SWAN direction when the model provides it, else downwind
    const sdF = waveDirFrom(tb);
    if (sdF != null) {
      const tt = ((sdF + 180) % 360) * Math.PI / 180;   // travel-toward bearing
      gl.uniform2f(this._u.uSwellDir, Math.sin(tt), -Math.cos(tt));
    } else if (S.wind) {
      const sw = sampleWind(CENTER.lat, CENTER.lng, clamp(tb, S.wind.times[0], S.wind.times[S.wind.times.length - 1]));
      const mg = Math.hypot(sw[0], sw[1]);
      if (mg > 0.3) gl.uniform2f(this._u.uSwellDir, sw[0] / mg, -sw[1] / mg);
    }
    gl.uniform1f(this._u.uTide, tideM(tb));
    if (this._tideUp && this._u.uTideS) {
      const ts = this._tideS || (this._tideS = new Float32Array(9));
      for (let i = 0; i < 9; i++) ts[i] = tideM(tb + (i - 4) * 3600e3);
      gl.uniform1fv(this._u.uTideS, ts);
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  },
});

function makeNoiseCanvas(N) {
  const out = document.createElement('canvas');
  out.width = N; out.height = N;
  const octx = out.getContext('2d');
  // three independent channels of smooth tiling-ish noise
  const layer = (cells) => {
    const c = document.createElement('canvas');
    c.width = cells; c.height = cells;
    const cc = c.getContext('2d');
    const im = cc.createImageData(cells, cells);
    for (let i = 0; i < im.data.length; i += 4) {
      const v = Math.random() * 255;
      im.data[i] = im.data[i + 1] = im.data[i + 2] = v;
      im.data[i + 3] = 255;
    }
    cc.putImageData(im, 0, 0);
    const big = document.createElement('canvas');
    big.width = N; big.height = N;
    const bc = big.getContext('2d');
    bc.imageSmoothingEnabled = true;
    // draw 2x2 so the edges blend (approximately tiling after smoothing)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) bc.drawImage(c, dx * N, dy * N, N, N);
    return bc.getImageData(0, 0, N, N).data;
  };
  const a = layer(24), b = layer(48), c3 = layer(16);
  const im = octx.createImageData(N, N);
  for (let i = 0; i < N * N; i++) {
    im.data[i * 4] = a[i * 4];
    im.data[i * 4 + 1] = b[i * 4];
    im.data[i * 4 + 2] = c3[i * 4];
    im.data[i * 4 + 3] = 255;
  }
  octx.putImageData(im, 0, 0);
  return out;
}

/* ------------------------------ wind particle layer ------------------------------ */

const FlowLayer = L.Layer.extend({
  initialize(cfg) { this._cfg = cfg; },
  onAdd(m) {
    this._map = m;
    const c = this._canvas = document.createElement('canvas');
    c.className = 'flow-canvas';
    m.getPane(this._cfg.pane).appendChild(c);
    this._ctx = c.getContext('2d');
    this._onMove = () => { this._moving = true; };
    this._onMoveEnd = () => {
      this._moving = false;
      if (this._rsQ) return;
      this._rsQ = true;
      Promise.resolve().then(() => { this._rsQ = false; this._reset(); });
    };
    m.on('movestart zoomstart', this._onMove);
    m.on('moveend zoomend resize', this._onMoveEnd);
    this._reset();
    this._running = true;
    this._last = performance.now();
    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  },
  onRemove(m) {
    this._running = false;
    m.off('movestart zoomstart', this._onMove);
    m.off('moveend zoomend resize', this._onMoveEnd);
    releaseCanvasZoom(this, m);
    this._canvas.remove();
  },
  setPaused(p) { this._paused = p; },
  _reset() {
    if (!this._map) return;                      // onAdd deferred (background tab)
    const m = this._map, size = m.getSize();
    if (size.x < 50 || size.y < 50) {
      clearTimeout(this._retryT);
      this._retryT = setTimeout(() => this._reset(), 150);
      return;
    }
    const r = padReset(this, m, 1.75);
    if (!r) return;
    const dpr = r.dpr;
    this._dpr = dpr;
    const cfg = this._cfg;
    const n = REDUCED_MOTION ? 0 : Math.round(clamp(r.size.x * r.size.y / cfg.density, cfg.minCount, cfg.maxCount));
    this._parts = Array.from({ length: n }, () => this._spawn({}));
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._ctx.clearRect(0, 0, this._w, this._h);
    if (REDUCED_MOTION) this._drawStatic();
  },
  _spawn(p) {
    p.x = Math.random() * this._w;
    p.y = Math.random() * this._h;
    p.age = Math.random() * this._cfg.maxAge;
    return p;
  },
  _ll(x, y) {
    return [
      this._nw.lat + (this._se.lat - this._nw.lat) * (y / this._h),
      this._nw.lng + (this._se.lng - this._nw.lng) * (x / this._w),
    ];
  },
  redrawStatic() {
    if (REDUCED_MOTION && this._w) { this._ctx.clearRect(0, 0, this._w, this._h); this._drawStatic(); }
  },
  _drawStatic() {
    const ctx = this._ctx, cfg = this._cfg, step = cfg.staticStep;
    if (cfg.ready && !cfg.ready()) return;
    for (let x = step / 2; x < this._w; x += step) {
      for (let y = step / 2; y < this._h; y += step) {
        const [lat, lng] = this._ll(x, y);
        const [u, v, env] = cfg.sample(lat, lng, S.tScrub);
        const spd = Math.hypot(u, v);
        if (spd < cfg.minSpd || env < 0.12) continue;
        const [color, width] = cfg.style(spd);
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width;
        const len = clamp(8 + spd * cfg.staticLen, 9, 30);
        const dx = u / spd, dy = -v / spd;
        ctx.beginPath();
        ctx.moveTo(x - dx * len / 2, y - dy * len / 2);
        ctx.lineTo(x + dx * len / 2, y + dy * len / 2);
        ctx.stroke();
        const hx = x + dx * len / 2, hy = y + dy * len / 2;
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(hx - dx * 5 - dy * 3, hy - dy * 5 + dx * 3);
        ctx.lineTo(hx - dx * 5 + dy * 3, hy - dy * 5 - dx * 3);
        ctx.fill();
      }
    }
  },
  _tick(now) {
    if (!this._running) return;
    requestAnimationFrame(this._tick);
    if (!this._w) { this._reset(); return; }
    if (REDUCED_MOTION || this._paused || this._moving || document.hidden) return;
    const cfg = this._cfg;
    if (cfg.ready && !cfg.ready()) return;
    const dt = clamp((now - this._last) / 1000, 0, 0.05);
    this._last = now;
    if (cfg.dart) { this._tickDarts(dt); return; }
    const ctx = this._ctx;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0,0,0,${cfg.fade})`;
    ctx.fillRect(0, 0, this._w, this._h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    const t = S.tScrub;
    for (const p of this._parts) {
      const [lat, lng] = this._ll(p.x, p.y);
      const [u, v, env] = cfg.sample(lat, lng, t);
      const spd = Math.hypot(u, v);
      p.age += 1;
      if (spd < cfg.minSpd || env < 0.1) {
        p.age += 7;
        if (p.age > cfg.maxAge) this._spawn(p);
        continue;
      }
      const px = clamp(cfg.pxBase + spd * cfg.pxPerKn, cfg.pxBase, cfg.pxMax) * dt;
      const nx2 = p.x + (u / spd) * px;
      const ny2 = p.y - (v / spd) * px;
      const [color, width] = cfg.style(spd);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(nx2, ny2);
      ctx.stroke();
      p.x = nx2; p.y = ny2;
      if (p.age > cfg.maxAge || p.x < -24 || p.x > this._w + 24 || p.y < -24 || p.y > this._h + 24) this._spawn(p);
    }
  },
  // sparse drifting chevrons — an explicit direction cue over the water texture
  _tickDarts(dt) {
    const ctx = this._ctx, cfg = this._cfg;
    ctx.clearRect(0, 0, this._w, this._h);
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const t = S.tScrub;
    for (const p of this._parts) {
      const [lat, lng] = this._ll(p.x, p.y);
      const [u, v, env] = cfg.sample(lat, lng, t);
      const spd = Math.hypot(u, v);
      p.age += 1;
      if (spd < cfg.minSpd || env < 0.1) {
        p.age += 9;
        if (p.age > cfg.maxAge) this._spawn(p);
        continue;
      }
      const px = clamp(cfg.pxBase + spd * cfg.pxPerKn, cfg.pxBase, cfg.pxMax) * dt;
      p.x += (u / spd) * px;
      p.y -= (v / spd) * px;
      const fade = Math.sin(Math.PI * clamp(p.age / cfg.maxAge, 0, 1));
      const sz = 4.5 + spd * 1.5;
      ctx.strokeStyle = spd > 1.6
        ? `rgba(240,252,255,${(0.62 * fade).toFixed(2)})`
        : `rgba(9,44,78,${(0.5 * fade).toFixed(2)})`;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.atan2(-v, u));
      ctx.beginPath();
      ctx.moveTo(-sz * 0.55, -sz * 0.5);
      ctx.lineTo(sz * 0.45, 0);
      ctx.lineTo(-sz * 0.55, sz * 0.5);
      ctx.stroke();
      ctx.restore();
      if (p.age > cfg.maxAge || p.x < -24 || p.x > this._w + 24 || p.y < -24 || p.y > this._h + 24) this._spawn(p);
    }
  },
});

/* ------------------------------ tidal flow field ------------------------------
   The current is two incompressible 2-D MODES on the real waterway geometry —
   streamfunction solves with depth conductance (mode A: through-the-Hole
   transport, mainland ψ=0 / Elizabeth chain ψ=1; mode B: along-Sound
   transport, southern boundary driven; islets float). Because coasts are
   ψ-contours, no water ever flows into land, and constrictions accelerate the
   flow by continuity.

   The SHAPES are pure geometry, so they are solved OFFLINE by
   tools/bake_flow.py (coarse domain + a ~12.5 m nest over the Hole, two tide
   stages, tighter convergence than a browser could afford) and shipped as
   int16 rasters. Everything weather-dependent stays live: NOAA predictions,
   the observed New Bedford–Woods Hole head difference, and the eddy layer set
   the mode AMPLITUDES every moment.                                          */

let flowField = null;              // assembled two-mode field (baked shapes, live amplitudes)
/* ---- the nonlinear shallow-water cycle (tools/bake_swe.py) ----
   Inside the fine box the currents come from a REAL momentum solve: one
   baked M2 cycle at 24 phases. The live stations still hold authority —
   they set the phase (via the calibration amplitudes) and the amplitude
   (via the strait ratio); the equations set the spatial structure. */
let SWE = null;
const _g3m = { t: NaN, st: null, v: 0 };   // per-instant memo for the hot loop
async function loadSwe() {
  try {
    const meta = S.geoMeta && S.geoMeta.swe;
    if (!meta) return;
    const B = meta.box;
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('swe.png failed')); img.src = 'data/swe.png?v=4'; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    const n = B.nx * B.ny;
    const NP = meta.nphase;
    const amps = meta.amps || [meta.aRef || 0.55];
    const nA = amps.length;
    const U = [], V = [], hodo = [];
    if (meta.amps) {
      // int8 response surface: tile ia*NP+k, u in R, v in G, per-tile scales
      for (let ia = 0; ia < nA; ia++) {
        const Ua = [], Va = [];
        for (let k = 0; k < NP; k++) {
          const ti = ia * NP + k;
          const su = meta.uScales[ti] * 1.94384 / 127, sv = meta.vScales[ti] * 1.94384 / 127;
          const fu = new Float32Array(n), fv = new Float32Array(n);
          for (let i = 0; i < n; i++) {
            const q = (ti * n + i) * 4;
            fu[i] = (d[q] - 128) * su;                              // m/s → kn
            fv[i] = (d[q + 1] - 128) * sv;
          }
          Ua.push(fu); Va.push(fv);
        }
        U.push(Ua); V.push(Va);
        hodo.push(meta.strait[ia].map(([u, v]) => Math.hypot(u, v) * 1.94384));
      }
    } else {
      // legacy single-amplitude int16 pack (cache-skew tolerance)
      const Ua = [], Va = [];
      for (let k = 0; k < NP; k++) {
        for (const [arr, ti] of [[Ua, 2 * k], [Va, 2 * k + 1]]) {
          const f = new Float32Array(n);
          const sc = meta.scales[ti];
          for (let i = 0; i < n; i++) {
            const q = (ti * n + i) * 4;
            f[i] = (((d[q] << 8) | d[q + 1]) - 32768) / sc * 1.94384;
          }
          arr.push(f);
        }
      }
      U.push(Ua); V.push(Va);
      hodo.push(meta.strait.map(([u, v]) => Math.hypot(u, v) * 1.94384));
    }
    // water mask for shore-aware sampling: dry cells are baked as exact
    // zeros, so a cell is wet if ANY phase of the strongest member moves
    // water there
    const wet = new Uint8Array(n);
    {
      const Uw = U[nA - 1], Vw = V[nA - 1];
      for (let k = 0; k < NP; k++) {
        const fu = Uw[k], fv = Vw[k];
        for (let i = 0; i < n; i++) if (fu[i] !== 0 || fv[i] !== 0) wet[i] = 1;
      }
    }
    SWE = {
      B, NP, amps, U, V, hodo, wet,
      hodoMax: hodo.map((h) => Math.max(...h)),
      myN: mercY(B.la0), myS: mercY(B.la1),
    };
  } catch (e) { console.warn('[swe]', e); }
}

// piecewise-linear inverse of an ascending array: value → fractional index
function invMono(arr, val) {
  if (arr.length < 2 || val <= arr[0]) return 0;
  for (let i = 1; i < arr.length; i++) {
    if (val <= arr[i]) return i - 1 + (val - arr[i - 1]) / (arr[i] - arr[i - 1]);
  }
  return arr.length - 1;
}

/* Which point on the response surface? The measured strait peak over the
   current half-cycle, inverted through the baked hodograph maxima. This
   is unit-free: springs/neaps AND the daily flood/ebb inequality enter
   through the one measured channel, with no convention to get wrong.
   Memoized per 5 min — it sits inside the per-pixel sampling loop. */
function sweAmpFrac(t) {
  const W = SWE;
  if (!W || W.amps.length < 2) return 0;
  const key = Math.floor(t / 300000);
  if (W._amp && W._amp.key === key) return W._amp.af;
  let af = invMono(W.amps, 0.55);            // default: the mean cycle
  const stS = S.currents.length
    ? (S.currents.find((c) => c.cfg.primary) || S.currents[0]) : null;
  if (stS) {
    let pk = 0;
    for (let dm = -200; dm <= 200; dm += 20) {
      pk = Math.max(pk, Math.abs(stationV(stS, t + dm * 60000)));
    }
    if (pk > 0.3) af = invMono(W.hodoMax, pk);
  }
  // tide-only fallback keeps the mean cycle: its alphas' absolute scale
  // is not pinned to the bake's amplitude axis, and guessing would be a
  // tuned constant. The tide-only g factor still scales magnitudes.
  W._amp = { key, af };
  return af;
}

// (phase, amplitude)-bilinear sample of the response surface, in knots
// (east, north); af is the fractional amplitude index; null outside
function sweAt(lat, lng, th, af) {
  const W = SWE;
  if (!W) return null;
  const B = W.B;
  const fx = (lng - B.lo0) / (B.lo1 - B.lo0) * (B.nx - 1);
  const fy = (mercY(lat) - W.myN) / (W.myS - W.myN) * (B.ny - 1);
  if (fx < 0 || fy < 0 || fx > B.nx - 1 || fy > B.ny - 1) return null;
  const ph = ((th / (2 * Math.PI)) * W.NP % W.NP + W.NP) % W.NP;
  const k0 = Math.floor(ph) % W.NP, k1 = (k0 + 1) % W.NP, fk = ph - Math.floor(ph);
  const a = clamp(af || 0, 0, W.amps.length - 1);
  const ia0 = Math.min(W.amps.length - 1, Math.floor(a)), ia1 = Math.min(W.amps.length - 1, ia0 + 1), fa = a - ia0;
  const x0 = Math.min(B.nx - 2, Math.floor(fx)), y0 = Math.min(B.ny - 2, Math.floor(fy));
  const dx = fx - x0, dy = fy - y0;
  // shore-aware bilinear: land corners are baked zeros and must not drag
  // nearshore water toward 0 — weight by wetness and renormalize; with no
  // wet corner at all there is no SWE information, hand back to the continuum
  const i00 = y0 * B.nx + x0, i10 = i00 + 1, i01 = i00 + B.nx, i11 = i01 + 1;
  const wet = W.wet;
  const w00 = (1 - dx) * (1 - dy) * (wet ? wet[i00] : 1), w10 = dx * (1 - dy) * (wet ? wet[i10] : 1);
  const w01 = (1 - dx) * dy * (wet ? wet[i01] : 1), w11 = dx * dy * (wet ? wet[i11] : 1);
  const ws = w00 + w10 + w01 + w11;
  if (ws < 0.05) return null;
  const bil = (f) => (f[i00] * w00 + f[i10] * w10 + f[i01] * w01 + f[i11] * w11) / ws;
  const mixA = (fs) => bil(fs[ia0][k0]) * (1 - fk) * (1 - fa) + bil(fs[ia0][k1]) * fk * (1 - fa)
    + bil(fs[ia1][k0]) * (1 - fk) * fa + bil(fs[ia1][k1]) * fk * fa;
  const u = mixA(W.U);
  const v = mixA(W.V);
  const hodo = (W.hodo[ia0][k0] * (1 - fk) + W.hodo[ia0][k1] * fk) * (1 - fa)
    + (W.hodo[ia1][k0] * (1 - fk) + W.hodo[ia1][k1] * fk) * fa;
  // edge weight: crossfade to the continuum over ~12 cells at the ring
  const m = Math.min(fx, fy, B.nx - 1 - fx, B.ny - 1 - fy);
  return [u, v, clamp((m - 2) / 12, 0, 1), hodo];
}
let FLOWDATA = null;
async function loadFlowData() {
  try {
    const meta = S.geoMeta && S.geoMeta.flow;
    if (!meta) return;
    const dec = async (url, G) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error(url + ' failed')); img.src = url; });
      const c = document.createElement('canvas');
      c.width = G.nx; c.height = G.ny * 8;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0);
      return cx.getImageData(0, 0, G.nx, G.ny * 8).data;
    };
    const NF = meta.nf || 4;                     // fields per stage (6 with mode C)
    const [df, dc] = await Promise.all([
      dec('data/flow_fine.png?v=13', { nx: meta.fine.nx, ny: meta.fine.ny * NF / 4 }),
      dec('data/flow_coarse.png?v=13', { nx: meta.coarse.nx, ny: meta.coarse.ny * NF / 4 }),
    ]);
    const unpack = (d, G, scales) => {
      const n = G.nx * G.ny;
      const stages = [];
      for (let s = 0; s < 2; s++) {
        const st = { water: new Uint8Array(n) };
        const names = ['uA', 'vA', 'uB', 'vB', 'uC', 'vC'].slice(0, NF);
        for (let f = 0; f < NF; f++) {
          const tile = s * NF + f;
          const arr = new Float32Array(n);
          const sc = scales[tile];
          for (let i = 0; i < n; i++) {
            const q = (tile * n + i) * 4;
            arr[i] = (((d[q] << 8) | d[q + 1]) - 32768) / sc;
            if (f === 0) st.water[i] = d[q + 2] > 127 ? 1 : 0;
          }
          st[names[f]] = arr;
        }
        stages.push(st);
      }
      return stages;
    };
    FLOWDATA = {
      meta,
      fine: unpack(df, meta.fine, meta.fineScales),
      coarse: unpack(dc, meta.coarse, meta.coarseScales),
    };
  } catch (e) {
    console.warn('[flow] baked flow field failed to load — channel skeleton only:', e);
  }
}

const TIDE_LO = 0.10, TIDE_HI = 1.10;        // stage tide levels, meters above MLLW

async function buildFlowField() {
  (S._flowDbg = S._flowDbg || []).push(Date.now() % 1e7 + ' build: FLOWDATA=' + !!FLOWDATA + ' currents=' + (S.currents || []).length);
  if (!FLOWDATA) { console.warn('[flow] pack not decoded yet — field build deferred'); return; }
  const meta = FLOWDATA.meta;
  const byId = {};
  for (const st of S.currents) byId[st.cfg.id] = st;
  const stStrait = byId['COD0911'];
  // no live/salvaged stations at all → the TIDE-DRIVEN backup below
  const tideOnly = !stStrait || !isFinite(stStrait.floodDir);
  const fu = (deg) => [Math.sin(deg * Math.PI / 180), Math.cos(deg * Math.PI / 180)];
  const vecsAt = (si) => {
    const m = {};
    for (const sv of meta.stationVectors) m[sv.id] = sv.stages[si];
    return m;
  };
  const C = meta.coarse, FB = meta.fine;
  const mkStage = (si) => {
    const vecs = vecsAt(si);
    const st = Object.assign({
      lo0: C.lo0, lo1: C.lo1, my0: mercY(C.la0), my1: mercY(C.la1),
      nx: C.nx, ny: C.ny,
      fine: Object.assign({
        lo0: FB.lo0, lo1: FB.lo1, my0: mercY(FB.la0), my1: mercY(FB.la1),
        nx: FB.nx, ny: FB.ny,
      }, FLOWDATA.fine[si]),
    }, FLOWDATA.coarse[si]);
    if (tideOnly) {
      st.calib = { sA: 1, sB: 0, sC: 0, cA: 0, cB: 1, cC: 0, rA: 0, rB: 0, rC: 0, soundId: null };
      return st;
    }
    // calibration couplings from baked mode vectors + LIVE flood directions
    const [fax, fay] = fu(stStrait.floodDir);
    const vS = vecs['COD0911'] || { A: [0, 0], B: [0, 0] };
    const dotd = (vv, key, x, y) => (vv && vv[key] ? vv[key][0] * x + vv[key][1] * y : 0);
    const sA = dotd(vS, 'A', fax, fay);
    const sB = dotd(vS, 'B', fax, fay);
    const sC = dotd(vS, 'C', fax, fay);
    let soundId = null, cA = 0, cB = 0, cC = 0;
    for (const id of ['ACT1831', 'ACT1821']) {
      const stn = byId[id];
      const vv = vecs[id];
      if (!stn || !isFinite(stn.floodDir) || !vv) continue;
      const [fbx, fby] = fu(stn.floodDir);
      const cb = dotd(vv, 'B', fbx, fby);
      if (Math.abs(cb) > Math.abs(cB)) {
        soundId = id; cB = cb;
        cA = dotd(vv, 'A', fbx, fby);
        cC = dotd(vv, 'C', fbx, fby);
      }
    }
    // third row: Robinsons Hole pins the Elizabeth-chain cascade (mode C)
    let rA = 0, rB = 0, rC = 0;
    const stRob = byId['COD0913'], vR = vecs['COD0913'];
    if (stRob && isFinite(stRob.floodDir) && vR) {
      const [frx, fry] = fu(stRob.floodDir);
      rA = dotd(vR, 'A', frx, fry);
      rB = dotd(vR, 'B', frx, fry);
      rC = dotd(vR, 'C', frx, fry);
    }
    st.calib = { sA, sB, sC, cA, cB, cC, rA, rB, rC, soundId };
    return st;
  };
  const lo = mkStage(0), hi = mkStage(1);
  const W = {
    lo, hi, hLo: meta.stages[0], hHi: meta.stages[1],
    lo0: lo.lo0, lo1: lo.lo1, my0: lo.my0, my1: lo.my1,
    nx: lo.nx, ny: lo.ny, fine: hi.fine,
  };
  const wOf = (t) => clamp((tideM(t) - W.hLo) / (W.hHi - W.hLo), 0, 1);
  W.wOf = wOf;
  if (tideOnly) {
    // THE CONTINUUM THEORY'S STATION-FREE MODE. The baked fields are the
    // responses to the boundary tide's in-phase and quadrature patterns,
    // so their amplitudes ARE the Woods Hole tide signal and its
    // quadrature: alpha1 = g·P(t), alpha2 = g·Q(t). One gain g is fit
    // against the 1930s survey-harmonic reconstruction of the Strait
    // (which needs only the Boston tide clock — independent of the
    // currents API). Currents survive a NOAA outage at full spatial
    // structure, flagged as an estimate.
    const msl = (S.tide && S.tide.vals && S.tide.vals.length)
      ? S.tide.vals.reduce((a, b) => a + b, 0) / S.tide.vals.length * 0.3048
      : 0.55;
    const OM2 = 2 * Math.PI / (12.4206 * 3600);
    const P = (t) => tideM(t) - msl;
    const Q = (t) => -((tideM(t + 1800e3) - tideM(t - 1800e3)) / 3600) / OM2;
    const sv = meta.stationVectors.find((v) => v.id === 'COD0911');
    let g = 1;
    if (sv && sv.stages && sv.stages[0]) {
      const A = [(sv.stages[0].A[0] + sv.stages[1].A[0]) / 2, (sv.stages[0].A[1] + sv.stages[1].A[1]) / 2];
      const B = [(sv.stages[0].B[0] + sv.stages[1].B[0]) / 2, (sv.stages[0].B[1] + sv.stages[1].B[1]) / 2];
      const am = Math.hypot(A[0], A[1]) || 1;
      const ax = A[0] / am, ay = A[1] / am;
      const h0s = depthMLLW(41.5193, -70.6829);
      let num = 0, den = 0;
      for (let hh = 0; hh <= 12.5; hh += 0.5) {
        const t = S.tNow + hh * 3600e3;
        const Hs = Math.max(0.5, (h0s == null ? 6 : h0s) + tideM(t));
        const ref = sampleWaterChannels(41.5193, -70.6829, t);
        const mu = (P(t) * A[0] + Q(t) * B[0]) / Hs;
        const mv = (P(t) * A[1] + Q(t) * B[1]) / Hs;
        const rp = ref[0] * ax + ref[1] * ay;
        const mp = mu * ax + mv * ay;
        num += rp * mp; den += mp * mp;
      }
      if (den > 1e-9) g = clamp(num / den, 0.05, 50);
    }
    W.tideOnly = true;
    W.alphaA = (t) => g * P(t);
    W.alphaB = (t) => g * Q(t);
    W.alphaC = () => 0;
    flowField = W;
    initEddies();
    return;
  }
  const lerpC = (k) => (t) => W.lo.calib[k] + (W.hi.calib[k] - W.lo.calib[k]) * wOf(t);
  const sAt = lerpC('sA'), sBt = lerpC('sB'), cAt = lerpC('cA'), cBt = lerpC('cB');
  const sCt = lerpC('sC'), cCt = lerpC('cC');
  const rAt = lerpC('rA'), rBt = lerpC('rB'), rCt = lerpC('rC');
  const hDep = (st, dflt) => {
    const v = depthMLLW(st.cfg.lat, st.cfg.lng);
    return v == null ? dflt : Math.max(0.5, v);
  };
  const hStrait = hDep(stStrait, 6);
  const HS = (t) => Math.max(0.5, hStrait + tideM(t));
  const stSound = byId[W.hi.calib.soundId] || byId[W.lo.calib.soundId];
  const stRob = byId['COD0913'];
  const robOk = stRob && isFinite(stRob.floodDir)
    && Math.abs(W.hi.calib.rC) > 1e-9 && Math.abs(W.lo.calib.rC) > 1e-9;
  // all stations constrain all modes (joint solve): mode B carries real
  // transport through the Hole and mode C leaks through every chain hole,
  // so anchoring each mode at "its" station alone would let the others ride
  if (stSound && robOk) {
    const hSnd = hDep(stSound, 15);
    const HB = (t) => Math.max(0.5, hSnd + tideM(t));
    const hRob = hDep(stRob, 8);
    const HR = (t) => Math.max(0.5, hRob + localTideM(stRob.cfg.lat, stRob.cfg.lng, t));
    const solve = (t) => {
      const m = [
        [sAt(t), sBt(t), sCt(t)],
        [cAt(t), cBt(t), cCt(t)],
        [rAt(t), rBt(t), rCt(t)],
      ];
      const r = [
        stationV(stStrait, t) * HS(t),
        stationV(stSound, t) * HB(t),
        stationV(stRob, t) * HR(t),
      ];
      // gaussian elimination w/ partial pivoting; on a sick pivot fall back
      // to the proven 2x2 (alphaC = 0) rather than amplifying noise
      for (let c = 0; c < 3; c++) {
        let p = c;
        for (let rr = c + 1; rr < 3; rr++) if (Math.abs(m[rr][c]) > Math.abs(m[p][c])) p = rr;
        if (Math.abs(m[p][c]) < 1e-10) {
          const sA = sAt(t), sB = sBt(t), cA = cAt(t), cB = cBt(t);
          const det = sA * cB - sB * cA;
          if (Math.abs(det) < 1e-12) return [Math.abs(sA) > 1e-9 ? r[0] / sA : 0, 0, 0];
          return [(r[0] * cB - r[1] * sB) / det, (r[1] * sA - r[0] * cA) / det, 0];
        }
        if (p !== c) { [m[c], m[p]] = [m[p], m[c]]; [r[c], r[p]] = [r[p], r[c]]; }
        for (let rr = c + 1; rr < 3; rr++) {
          const f = m[rr][c] / m[c][c];
          for (let cc = c; cc < 3; cc++) m[rr][cc] -= f * m[c][cc];
          r[rr] -= f * r[c];
        }
      }
      const a2 = r[2] / m[2][2];
      const a1 = (r[1] - m[1][2] * a2) / m[1][1];
      const a0 = (r[0] - m[0][1] * a1 - m[0][2] * a2) / m[0][0];
      return [a0, a1, a2];
    };
    // one solve per timestep — every texel in a frame shares the same t
    let mT = NaN, mA = [0, 0, 0];
    const solveM = (t) => { if (t !== mT) { mT = t; mA = solve(t); } return mA; };
    W.alphaA = (t) => solveM(t)[0];
    W.alphaB = (t) => solveM(t)[1];
    W.alphaC = (t) => solveM(t)[2];
  } else if (stSound) {
    const hSnd = hDep(stSound, 15);
    const HB = (t) => Math.max(0.5, hSnd + tideM(t));
    const solve = (t) => {
      const sA = sAt(t), sB = sBt(t), cA = cAt(t), cB = cBt(t);
      const det = sA * cB - sB * cA;
      const r1 = stationV(stStrait, t) * HS(t);
      const r2 = stationV(stSound, t) * HB(t);
      if (Math.abs(det) < 1e-12) {
        return [Math.abs(sA) > 1e-9 ? r1 / sA : 0, 0];
      }
      return [(r1 * cB - r2 * sB) / det, (r2 * sA - r1 * cA) / det];
    };
    W.alphaA = (t) => solve(t)[0];
    W.alphaB = (t) => solve(t)[1];
    W.alphaC = () => 0;
  } else {
    W.alphaA = (t) => {
      const s = sAt(t);
      return Math.abs(s) > 1e-9 ? stationV(stStrait, t) * HS(t) / s : 0;
    };
    W.alphaB = () => 0;
    W.alphaC = () => 0;
  }
  flowField = W;
  initEddies();
}



/* ------------------------------ shed-vorticity (eddy) layer ------------------------------
   The rotational physics the potential solve lacks: a live ω–ψ evolution on the
   fine grid. Shoreline shear injects vorticity, the flow advects it off the
   points (semi-Lagrangian), bottom friction spins it down, and ∇²ψr = −ω gives
   the swirl velocity added to the transport field — back-eddies and wakes form
   behind Devil's Foot, Rams Island, and Penzance at speed. Runs on an
   accelerated clock; the forcing follows the scrubbed time.                   */

const EDDIES_ON = false;   // parameterized eddies retired; real rotation comes from the momentum solves
let eddy = null, eddySampling = false, eddyLoopOn = false;

function initEddies() {
  if (!EDDIES_ON) return;
  if (REDUCED_MOTION || !flowField || !flowField.fine) { eddy = null; return; }
  const G = flowField.fine;
  // the eddy layer runs its own grid capped at ~18k cells (~25 m) — the baked
  // fine field is 2x denser than the per-frame ω–ψ churn needs
  const ds = Math.max(1, Math.round(Math.sqrt((G.nx * G.ny) / 18000)));
  const enx = Math.max(32, Math.floor(G.nx / ds)), eny = Math.max(32, Math.floor(G.ny / ds));
  const n = enx * eny;
  eddy = {
    nx: enx, ny: eny, lo0: G.lo0, lo1: G.lo1, my0: G.my0, my1: G.my1,
    cellM: (G.lo1 - G.lo0) * M_LNG / enx,
    om: new Float32Array(n), om2: new Float32Array(n),
    baseOm: new Float32Array(n),
    psi: new Float32Array(n),
    uR: new Float32Array(n), vR: new Float32Array(n),
    fu: new Float32Array(n), fv: new Float32Array(n),
    wet: new Uint8Array(n),
    shed: new Float32Array(n),
    fT: -1e18, lastF: 0, ready: false, paused: false,
    last: performance.now(), frame: 0,
  };
  if (!eddyLoopOn) {
    eddyLoopOn = true;
    requestAnimationFrame(eddyTick);
  }
}

function eddyRefreshForcing() {
  const E = eddy;
  eddySampling = true;
  for (let gy = 0; gy < E.ny; gy++) {
    const lat = latOfMercG(E.my0 + (E.my1 - E.my0) * (gy + 0.5) / E.ny);
    for (let gx = 0; gx < E.nx; gx++) {
      const i = gy * E.nx + gx;
      const lng = E.lo0 + (E.lo1 - E.lo0) * (gx + 0.5) / E.nx;
      const s = sampleWater(lat, lng, S.tScrub);
      E.fu[i] = s[0];
      E.fv[i] = s[1];
      E.wet[i] = s[2] > 0.05 ? 1 : 0;
    }
  }
  eddySampling = false;
  // free-shear vorticity of the base flow: the jet edges and the
  // deceleration fan downstream of the strait — the SURFACE expression of
  // the Hole's plunge-and-boil turbulence (the 3-D downwelling itself is
  // outside a depth-integrated model; its swirl signature is not)
  const cmv = E.cellM / 0.514444;               // kn/cell → 1/s scaling
  for (let gy = 1; gy < E.ny - 1; gy++) {
    for (let gx = 1; gx < E.nx - 1; gx++) {
      const i = gy * E.nx + gx;
      if (!E.wet[i]) { E.baseOm[i] = 0; continue; }
      const dv = E.fv[i + 1] - E.fv[i - 1];
      const du = E.fu[i + E.nx] - E.fu[i - E.nx];
      E.baseOm[i] = (dv + du) / (2 * cmv);
    }
  }
  // separation weight: a boundary layer sheds where the coast TURNS.
  // Each wall cell's outward normal is compared with the normals of wall
  // cells a couple of cells along the shore; straight beach = aligned
  // normals = no shedding, a headland or channel corner = rotated
  // normals = full shedding. Open-water cells advect freely (weight 1).
  const wallN = new Float32Array(2 * E.wet.length);
  const isWall = new Uint8Array(E.wet.length);
  for (let gy = 1; gy < E.ny - 1; gy++) {
    for (let gx = 1; gx < E.nx - 1; gx++) {
      const i = gy * E.nx + gx;
      if (!E.wet[i]) continue;
      let nx0 = 0, ny0 = 0;
      if (!E.wet[i - 1]) nx0 -= 1;
      if (!E.wet[i + 1]) nx0 += 1;
      if (!E.wet[i - E.nx]) ny0 -= 1;
      if (!E.wet[i + E.nx]) ny0 += 1;
      const d0 = Math.hypot(nx0, ny0);
      if (d0 > 0) { isWall[i] = 1; wallN[2 * i] = nx0 / d0; wallN[2 * i + 1] = ny0 / d0; }
    }
  }
  for (let gy = 1; gy < E.ny - 1; gy++) {
    for (let gx = 1; gx < E.nx - 1; gx++) {
      const i = gy * E.nx + gx;
      if (!E.wet[i]) { E.shed[i] = 0; continue; }
      if (!isWall[i]) { E.shed[i] = 1; continue; }
      let turn = 0, cnt = 0;
      for (let dy2 = -2; dy2 <= 2; dy2++) {
        for (let dx2 = -2; dx2 <= 2; dx2++) {
          if (!dx2 && !dy2) continue;
          const j = i + dy2 * E.nx + dx2;
          if (j < 0 || j >= E.wet.length || !isWall[j]) continue;
          const dot = wallN[2 * i] * wallN[2 * j] + wallN[2 * i + 1] * wallN[2 * j + 1];
          turn += Math.acos(clamp(dot, -1, 1));
          cnt++;
        }
      }
      // 40 degrees of mean turning within ~2 cells = full separation
      E.shed[i] = cnt ? clamp((turn / cnt) / 0.7, 0, 1) : 0;
    }
  }
  E.fT = S.tScrub;
  E.lastF = performance.now();
  E.ready = true;
}

function eddyVel(lat, lng) {
  const E = eddy;
  const gx = (lng - E.lo0) / (E.lo1 - E.lo0) * (E.nx - 1);
  const gy = (mercY(lat) - E.my0) / (E.my1 - E.my0) * (E.ny - 1);
  if (gx < 1 || gy < 1 || gx > E.nx - 2 || gy > E.ny - 2) return null;
  const x0 = Math.floor(gx), y0 = Math.floor(gy), dx = gx - x0, dy = gy - y0;
  const b = (a) => a[y0 * E.nx + x0] * (1 - dx) * (1 - dy) + a[y0 * E.nx + x0 + 1] * dx * (1 - dy)
                 + a[(y0 + 1) * E.nx + x0] * (1 - dx) * dy + a[(y0 + 1) * E.nx + x0 + 1] * dx * dy;
  return [b(E.uR), b(E.vR)];
}

function eddyTick(now) {
  requestAnimationFrame(eddyTick);
  const E = eddy;
  if (!E || E.paused || document.hidden || !flowField || !flowField.lo) return;
  const dtR = clamp((now - E.last) / 1000, 0, 0.06);
  E.last = now;
  // forcing follows the scrub, refreshed at most twice a second
  if (Math.abs(S.tScrub - E.fT) > 6 * 60e3 && now - E.lastF > 500) eddyRefreshForcing();
  if (!E.ready) return;
  const dtS = dtR * 240;                    // accelerated eddy clock (sim seconds)
  const nx = E.nx, ny = E.ny, cm = E.cellM;
  const toPx = 0.514444 * dtS / cm;
  // 1) advect ω with the total flow (semi-Lagrangian, unconditionally stable)
  for (let y = 1; y < ny - 1; y++) {
    for (let x = 1; x < nx - 1; x++) {
      const i = y * nx + x;
      if (!E.wet[i]) { E.om2[i] = 0; continue; }
      const sx = clamp(x - (E.fu[i] + E.uR[i]) * toPx, 1, nx - 2);
      const sy = clamp(y + (E.fv[i] + E.vR[i]) * toPx, 1, ny - 2);
      const x1 = Math.floor(sx), y1 = Math.floor(sy), fx = sx - x1, fy = sy - y1;
      E.om2[i] = E.om[y1 * nx + x1] * (1 - fx) * (1 - fy) + E.om[y1 * nx + x1 + 1] * fx * (1 - fy)
               + E.om[(y1 + 1) * nx + x1] * (1 - fx) * fy + E.om[(y1 + 1) * nx + x1 + 1] * fx * fy;
    }
  }
  // 2) shoreline shear injection + bottom-friction decay
  for (let y = 1; y < ny - 1; y++) {
    for (let x = 1; x < nx - 1; x++) {
      const i = y * nx + x;
      if (!E.wet[i]) { E.om[i] = 0; continue; }
      let nxv = 0, nyv = 0, wall = false;
      if (!E.wet[i - 1]) { nxv += 1; wall = true; }
      if (!E.wet[i + 1]) { nxv -= 1; wall = true; }
      if (!E.wet[i - nx]) { nyv -= 1; wall = true; }
      if (!E.wet[i + nx]) { nyv += 1; wall = true; }
      let om = E.om2[i];
      if (wall) {
        const gm = Math.hypot(nxv, nyv) || 1;
        const ww = ((nxv / gm) * E.fv[i] - (nyv / gm) * E.fu[i]) * 0.514444 / cm;
        om += (ww * 1.5 * E.shed[i] - om) * clamp(dtS / 10, 0, 0.5);
      }
      const bo = E.baseOm[i];
      if (bo > 0.002 || bo < -0.002) {
        om += (bo * 1.1 - om) * clamp(dtS / 16, 0, 0.35);
      }
      const spd = Math.hypot(E.fu[i] + E.uR[i], E.fv[i] + E.vR[i]);
      om *= Math.exp(-(0.0015 + 0.006 * spd) * dtS);
      E.om[i] = clamp(om, -0.03, 0.03);
    }
  }
  // 3) ψr from ω — warm-started SOR (ψr = 0 on land, dry flats and borders)
  const b2 = cm * cm;
  for (let it = 0; it < 16; it++) {
    for (let y = 1; y < ny - 1; y++) {
      for (let x = 1; x < nx - 1; x++) {
        const i = y * nx + x;
        if (!E.wet[i]) { E.psi[i] = 0; continue; }
        E.psi[i] += 1.6 * ((E.psi[i - 1] + E.psi[i + 1] + E.psi[i - nx] + E.psi[i + nx] + E.om[i] * b2) / 4 - E.psi[i]);
      }
    }
  }
  // 4) swirl velocity (kn), capped for sanity
  for (let y = 1; y < ny - 1; y++) {
    for (let x = 1; x < nx - 1; x++) {
      const i = y * nx + x;
      if (!E.wet[i]) { E.uR[i] = 0; E.vR[i] = 0; continue; }
      E.uR[i] = clamp((E.psi[i - nx] - E.psi[i + nx]) / (2 * cm) / 0.514444, -1.4, 1.4);
      E.vR[i] = clamp(-(E.psi[i + 1] - E.psi[i - 1]) / (2 * cm) / 0.514444, -1.4, 1.4);
    }
  }
  // let the arrows and water breathe with the swirl
  E.frame++;
  if (E.frame % 12 === 0) {
    if (waterGL) waterGL.flowDirty();
    if (curArrows) curArrows.requestRedraw();
  }
}

/* ------------------------------ vector (quiver) layers ------------------------------
   Grid-anchored arrows, redrawn when the time or view changes. Current: a dense
   near-black field over the water, arrow size and opacity carrying the strength.
   Wind: a sparse field fading transparent-white → strong red.                    */

/* The comparison renderer is retired: this is the sole production design. */
const VEC = '0';
// Canonicalize old review links so the address bar no longer advertises
// retired vec variants or internal cache-busting review builds.
try {
  const canonical = new URL(location.href);
  canonical.searchParams.delete('vec');
  canonical.searchParams.delete('build');
  canonical.searchParams.delete('refresh');
  canonical.searchParams.delete('devreload');
  if (canonical.href !== location.href) history.replaceState(null, '', canonical.pathname + canonical.search + canonical.hash);
} catch (e) {}

// deterministic per-cell hash for stable densities (no Math.random in
// static renders: a redraw must never reshuffle the picture)
function hash01(a, b) {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const ArrowLayer = L.Layer.extend({
  initialize(cfg) { this._cfg = cfg; },
  onAdd(m) {
    this._map = m;
    const c = this._canvas = document.createElement('canvas');
    c.className = 'flow-canvas';
    m.getPane(this._cfg.pane).appendChild(c);
    this._ctx = c.getContext('2d');
    this._onMoveEnd = () => {
      if (this._rsQ) return;
      this._rsQ = true;
      Promise.resolve().then(() => { this._rsQ = false; this._reset(); });
    };
    m.on('moveend zoomend resize', this._onMoveEnd);
    this._reset();
  },
  onRemove(m) {
    this._animStop();
    m.off('moveend zoomend resize', this._onMoveEnd);
    releaseCanvasZoom(this, m);
    this._canvas.remove();
  },
  // px → geo and short trajectory integration, shared by variants 1/2/3
  _latAt(y) { return this._nw.lat + (this._se.lat - this._nw.lat) * (y / this._h); },
  _lngAt(x) { return this._nw.lng + (this._se.lng - this._nw.lng) * (x / this._w); },
  _flowPx(x, y, t) {
    const s = this._cfg.sample(this._latAt(y), this._lngAt(x), t);
    return [s[0], -s[1], Math.hypot(s[0], s[1])];   // screen dx, dy (y down), spd
  },
  _integrate(x, y, t, steps, ds, dir) {
    // follow the field from (x,y); stop at shore or stagnation. Advance in
    // ~3 px sub-steps with a water test at EACH: a 7 px stride stepped
    // clean over sand slivers and drew ink across land (user catch,
    // 2026-07-26) — no line may ever touch shore
    const pts = [[x, y, 0]];
    let cx = x, cy = y;
    const nSub = Math.max(2, Math.ceil(ds / 3));
    outer:
    for (let k = 0; k < steps; k++) {
      const [du, dv, sp] = this._flowPx(cx, cy, t);
      if (sp < 0.05) break;
      if (!k) pts[0][2] = sp;
      for (let s2 = 0; s2 < nSub; s2++) {
        cx += dir * (du / sp) * (ds / nSub);
        cy += dir * (dv / sp) * (ds / nSub);
        if (!isWaterAt(this._latAt(cy), this._lngAt(cx))) break outer;
      }
      pts.push([cx, cy, sp]);
    }
    return pts;
  },
  /* ================= the seven compositions (current side) =================
     One rAF loop serves every animated mode; 30 fps, paused in hidden
     tabs, self-terminating if the layer leaves the map, and never
     started under prefers-reduced-motion (each mode draws an equivalent
     static frame instead). */
  _animStop() {
    if (this._araf) cancelAnimationFrame(this._araf);
    this._araf = null;
  },
  _animStart() {
    if (this._araf || REDUCED_MOTION) return;
    this._aT = performance.now();
    const tick = (ts) => {
      this._araf = requestAnimationFrame(tick);
      if (!this._canvas || !this._canvas.isConnected) return this._animStop();
      if ((document.hidden && !S._forceAnim) || !this._w) { this._aT = ts; return; }
      if (ts - (this._aLast || 0) < 30) return;   // ~30 fps on ANY panel
      this._aLast = ts;
      const dt = clamp((ts - this._aT) / 1000, 0.01, 0.15);
      this._aT = ts;
      this._animFrame(dt, ts / 1000);
    };
    this._araf = requestAnimationFrame(tick);
  },
  _animFrame(dt, tsec) {
    const ctx = this._ctx;
    if (VEC === '0') return this._marchFrame(ctx, tsec);
    if (VEC === '1' || VEC === '2' || VEC === '5') return this._bwFrame(ctx, dt);
    if (VEC === '3') return this._chevFrame(ctx, dt);
    if (VEC === '4' || VEC === '6') return this._pFrame(ctx, dt);
    if (VEC === '7') return this._marchFrame(ctx, tsec);
  },
  // label inks per composition: [text color or null(=value color law),
  // halo]. Dark grounds flip to light text over a dark halo.
  _knotInk(spd) {
    if (VEC === '2') return ['rgba(12,12,12,0.95)', 'rgba(255,255,255,0.9)'];
    if (VEC === '3') return ['rgba(255,255,255,0.97)', 'rgba(20,26,34,0.8)'];
    if (VEC === '5') return ['rgba(20,18,14,0.95)', 'rgba(246,241,229,0.92)'];
    // color-ink thresholds sit where the ramp first clears 4.5:1 on the
    // white halo (review: the 1.6-2.2 kn band printed at ~3.3:1)
    if (VEC === '6') return [spd >= 2.2 ? vCol('silk', spd / 4, 0.97) : 'rgba(16,34,47,0.92)', 'rgba(255,255,255,0.88)'];
    if (spd < 2.4) return ['rgba(16,34,47,0.92)', 'rgba(255,255,255,0.88)'];
    // bright ramp ink flips to a DARK halo so peak-flood labels never fade
    return [curCol(spd, 0.97), spd > 2.65 ? 'rgba(20,26,34,0.85)' : 'rgba(255,255,255,0.88)'];
  },
  // Speed belongs to the legend, not labels floating over the map. Keep this
  // no-op because the archived renderers still call it.
  _drawTopKnots(ctx, cells) {
    S._curKnotRects = [];
  },
  /* ---- 2 · B: black cased streamlines, dash-crawl at true rate ---- */
  _bwBuild(ctx, cells, t) {
    // one crawl engine, three personalities: 1 = thermal-colored lines,
    // 2 = black cased lines, 5 = engraving (uniform density, width =
    // speed, short straight strokes)
    const isE = VEC === '5';
    const paths = [];
    for (let i = 0; i < cells.length; i += isE ? 1 : 2) {
      const c = cells[i];
      if (c.spd < 0.15) continue;
      const f = Math.min(1, c.spd / 4);
      const steps = isE ? 2 + Math.round(3 * f) : 4 + Math.round(8 * f);
      const back = this._integrate(c.x, c.y, t, steps, isE ? 5 : 7, -1).reverse();
      const line = back.concat(this._integrate(c.x, c.y, t, steps, isE ? 5 : 7, 1).slice(1));
      if (line.length < 3) continue;
      paths.push({ line, f, spd: c.spd, off: hash01(c.x, c.y) * 17, hd: hash01(c.x + 3, c.y) < 0.25 });
    }
    this._bwPaths = paths;
    this._bwCells = cells;
    this._bwFrame(ctx, 0);
    this._animStart();
  },
  _bwFrame(ctx, dt) {
    ctx.clearRect(0, 0, this._w, this._h);
    ctx.lineCap = 'round';
    const isE = VEC === '5';
    for (const p of this._bwPaths || []) {
      // the crawl rate IS the speed: 8.5 px/s per knot, zero at zero
      p.off += dt * 34 * p.f;
      // WIDTH span must be obvious at arm's length (grade: 'width changes
      // not sufficient'): 1.1 px at slack to 4.7 px in the jet
      const w2 = isE ? 1.1 + 2.7 * p.f : (VEC === '1' ? 1.8 + 2.9 * p.f : 1.1 + 3.6 * p.f);
      const ink = VEC === '1' ? curCol(p.spd, 0.96) : 'rgba(15,15,15,0.95)';
      for (const pass of [0, 1]) {
        if (!pass && isE) continue;          // the engraving is bare ink
        ctx.strokeStyle = pass ? ink : 'rgba(255,255,255,0.85)';
        ctx.lineWidth = pass ? w2 : w2 + 2.4;
        ctx.setLineDash(pass ? (isE ? [8, 6] : [9, 8]) : []);
        ctx.lineDashOffset = -p.off;
        ctx.beginPath();
        ctx.moveTo(p.line[0][0], p.line[0][1]);
        for (let k = 1; k < p.line.length; k++) ctx.lineTo(p.line[k][0], p.line[k][1]);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      if ((REDUCED_MOTION || isE) && p.line.length > 3) {
        // dashes are direction-symmetric: a mid chevron signs EVERY
        // engraving stroke (the crawl alone was the only cue on 75%)
        const mi = p.line.length >> 1;
        const [mx2, my2] = p.line[mi], [nx2, ny2] = p.line[Math.min(mi + 1, p.line.length - 1)];
        const ml = Math.hypot(nx2 - mx2, ny2 - my2) || 1;
        const ux = (nx2 - mx2) / ml, uy = (ny2 - my2) / ml, cs2 = 3 + 2.4 * p.f;
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(mx2 - ux * cs2 - uy * cs2, my2 - uy * cs2 + ux * cs2);
        ctx.lineTo(mx2, my2);
        ctx.lineTo(mx2 - ux * cs2 + uy * cs2, my2 - uy * cs2 - ux * cs2);
        ctx.stroke();
      }
      // BIG cased head (grade: heads too small; the white disc looked
      // like a stray dot and is gone) — engraving heads on a hash subset
      if (!isE || p.hd) {
        const [ex, ey] = p.line[p.line.length - 1], [qx, qy] = p.line[p.line.length - 2];
        const hl = Math.hypot(ex - qx, ey - qy) || 1;
        const hx = (ex - qx) / hl, hy = (ey - qy) / hl;
        if (isWaterAt(this._latAt(ey + hy * 9), this._lngAt(ex + hx * 9))) {
          const hs = isE ? 3 + 2.5 * p.f : 4 + 3.6 * p.f;
          const inkH = VEC === '1' ? curCol(p.spd, 0.96) : 'rgba(15,15,15,0.95)';
          if (!isE) {
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.beginPath();
            ctx.moveTo(ex + hx * (hs * 1.5 + 2.2), ey + hy * (hs * 1.5 + 2.2));
            ctx.lineTo(ex - hy * (hs * 0.62 + 1.6), ey + hx * (hs * 0.62 + 1.6));
            ctx.lineTo(ex + hy * (hs * 0.62 + 1.6), ey - hx * (hs * 0.62 + 1.6));
            ctx.closePath(); ctx.fill();
          }
          ctx.fillStyle = inkH;
          ctx.beginPath();
          ctx.moveTo(ex + hx * hs * 1.5, ey + hy * hs * 1.5);
          ctx.lineTo(ex - hy * hs * 0.62, ey + hx * hs * 0.62);
          ctx.lineTo(ex + hy * hs * 0.62, ey - hx * hs * 0.62);
          ctx.closePath(); ctx.fill();
        }
      }
    }
    this._drawTopKnots(ctx, this._bwCells);
  },
  /* ---- 3 · C: viridis fill on the water + crawling white chevrons ---- */
  _fillBuild(ctx, t, cells) {
    const cs = 12;
    const ow = Math.ceil(this._w / cs), oh = Math.ceil(this._h / cs);
    const oc = this._fillCv = this._fillCv || document.createElement('canvas');
    oc.width = ow; oc.height = oh;
    const octx = oc.getContext('2d');
    const im = octx.createImageData(ow, oh);
    const px = im.data;
    for (let iy = 0; iy < oh; iy++) for (let ix = 0; ix < ow; ix++) {
      const la = this._latAt((iy + 0.5) * cs), lo = this._lngAt((ix + 0.5) * cs);
      if (!isWaterAt(la, lo)) continue;
      const s = this._cfg.sample(la, lo, t);
      const sp2 = Math.hypot(s[0], s[1]);
      const rgb = cmapAt(CM.viridis, sp2 / 4).split(',');
      const q = (iy * ow + ix) * 4;
      px[q] = +rgb[0]; px[q + 1] = +rgb[1]; px[q + 2] = +rgb[2];
      // chart mode: the fill thins so soundings stay readable under it
      px[q + 3] = encOn ? 150 : 232;
    }
    // erode one cell so the bilinear upscale never bleeds pigment ashore
    const A2 = new Uint8Array(ow * oh);
    for (let i2 = 0; i2 < ow * oh; i2++) A2[i2] = px[i2 * 4 + 3];
    for (let iy = 0; iy < oh; iy++) for (let ix = 0; ix < ow; ix++) {
      const i2 = iy * ow + ix;
      if (!A2[i2]) continue;
      if ((ix > 0 && !A2[i2 - 1]) || (ix < ow - 1 && !A2[i2 + 1])
        || (iy > 0 && !A2[i2 - ow]) || (iy < oh - 1 && !A2[i2 + ow])) px[i2 * 4 + 3] = 70;
    }
    octx.putImageData(im, 0, 0);
    // chevron pool: white marks advected downstream at the local rate
    const n = Math.round(clamp((this._w * this._h) / 11000, 120, 300));
    const pool = [];
    for (let tries = 0; pool.length < n && tries < n * 14; tries++) {
      const x = hash01(tries, 7.7) * this._w, y = hash01(3.3, tries) * this._h;
      if (!isWaterAt(this._latAt(y), this._lngAt(x))) continue;
      pool.push({ x, y, age: (tries * 37) % 240 });
    }
    this._chevPool = pool;
    this._fillCells = cells;
    this._chevFrame(ctx, 0);
    this._animStart();
  },
  _chevFrame(ctx, dt) {
    ctx.clearRect(0, 0, this._w, this._h);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this._fillCv, 0, 0, this._fillCv.width, this._fillCv.height, 0, 0, this._w, this._h);
    const t = S.tScrub;
    ctx.lineCap = 'round';
    for (const p of this._chevPool || []) {
      const [du, dv, sp2] = this._flowPx(p.x, p.y, t);
      const f = Math.min(1, sp2 / 4);
      if (dt > 0) {
        p.x += (du / (sp2 || 1)) * (2 + 48 * f) * dt;
        p.y += (dv / (sp2 || 1)) * (2 + 48 * f) * dt;
        p.age += dt * 60;
      }
      // look ~0.5 s ahead: a chevron about to beach or stall fades out
      // through its own envelope instead of vanishing at full ink
      if (dt > 0 && p.age < 220) {
        const lx = p.x + (du / (sp2 || 1)) * 18, ly = p.y + (dv / (sp2 || 1)) * 18;
        if (!isWaterAt(this._latAt(ly), this._lngAt(lx))) p.age = 220;
      }
      if (sp2 < 0.25 || p.age > 260 || !isWaterAt(this._latAt(p.y), this._lngAt(p.x))) {
        for (let k = 0; k < 12; k++) {
          const x = hash01(p.x + k, p.y) * this._w, y = hash01(p.y, p.x + k) * this._h;
          if (isWaterAt(this._latAt(y), this._lngAt(x))) { p.x = x; p.y = y; p.age = 0; break; }
        }
        continue;
      }
      const dxn = du / (sp2 || 1), dyn = dv / (sp2 || 1);
      const ch = 3 + 2.6 * f;
      // fade in/out over age (no popping) and drag a TAIL behind the
      // chevron: a bare arrowhead read as a floating wedge (grade)
      ctx.globalAlpha = clamp(Math.min(p.age, 260 - p.age) / 40, 0.12, 1);
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass ? 'rgba(255,255,255,0.9)' : 'rgba(20,26,34,0.55)';
        ctx.lineWidth = pass ? 1.6 : 3.4;
        ctx.beginPath();
        ctx.moveTo(p.x - dxn * (ch + 9), p.y - dyn * (ch + 9));
        ctx.lineTo(p.x, p.y);
        ctx.moveTo(p.x - dxn * ch - dyn * ch, p.y - dyn * ch + dxn * ch);
        ctx.lineTo(p.x, p.y);
        ctx.lineTo(p.x - dxn * ch + dyn * ch, p.y - dyn * ch - dxn * ch);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    this._drawTopKnots(ctx, this._fillCells);
  },
  /* ---- 4 · D aqua particles / 6 · F flow-grain (shared engine) ---- */
  _pBuild(ctx, cells, t) {
    this._pCells = cells;
    // constant pace and constant ink: motion carries DIRECTION only,
    // color and width carry the speed (streak length no longer pretends
    // to be a magnitude), and long lives with age envelopes kill the pop
    this._pCfg = VEC === '4'
      ? { count: Math.round(clamp((this._w * this._h) / 4400, 300, 1200)), base: 45, gain: 0, fade: 0.05, w: (f) => 1.2 + 1.8 * f, cm: 'thermal', a: () => 0.92, maxAge: 460 }
      : { count: 1850, base: 9, gain: 0, fade: 0.009, w: () => 1.1, cm: 'silk', a: () => 0.85, maxAge: 700 };
    // the static frame draws FIRST in every case: a background tab shows
    // the full field the moment it is opened, and once the animation
    // runs, the trails dissolve this base away frame by frame
    ctx.clearRect(0, 0, this._w, this._h);
    for (const c of cells) {
      if (c.spd < 0.1) continue;
      const f = Math.min(1, c.spd / 4);
      const back = this._integrate(c.x, c.y, t, 4 + Math.round(6 * f), 6, -1).reverse();
      const line = back.concat(this._integrate(c.x, c.y, t, 4 + Math.round(6 * f), 6, 1).slice(1));
      for (let k = 1; k < line.length; k++) {
        const fS = Math.min(1, ((line[k - 1][2] + line[k][2]) / 2) / 4);
        ctx.strokeStyle = vCol(this._pCfg.cm, fS, this._pCfg.a(fS) + 0.1);
        ctx.lineWidth = this._pCfg.w(fS);
        ctx.beginPath();
        ctx.moveTo(line[k - 1][0], line[k - 1][1]);
        ctx.lineTo(line[k][0], line[k][1]);
        ctx.stroke();
      }
      // flood vs ebb must survive the static frame: every line gets a head
      const [ex, ey, es] = line[line.length - 1], [qx, qy] = line[line.length - 2];
      const hl = Math.hypot(ex - qx, ey - qy) || 1;
      const hs = 2 + 2.4 * f;
      if (isWaterAt(this._latAt(ey + (ey - qy) / hl * hs * 1.5), this._lngAt(ex + (ex - qx) / hl * hs * 1.5))) {
        const hx = (ex - qx) / hl, hy = (ey - qy) / hl;
        ctx.fillStyle = vCol(this._pCfg.cm, Math.min(1, es / 4), 0.9);
        ctx.beginPath();
        ctx.moveTo(ex + hx * hs * 1.5, ey + hy * hs * 1.5);
        ctx.lineTo(ex - hy * hs * 0.62, ey + hx * hs * 0.62);
        ctx.lineTo(ex + hy * hs * 0.62, ey - hx * hs * 0.62);
        ctx.closePath(); ctx.fill();
      }
    }
    if (VEC === '6' || VEC === '4') this._grainChevrons(ctx);
    this._drawTopKnots(ctx, cells);
    if (REDUCED_MOTION) return;
    this._pPool = null;                      // reseed for the new view
    this._animStart();
  },
  _pSeedOne(p) {
    for (let k = 0; k < 16; k++) {
      const x = Math.random() * this._w, y = Math.random() * this._h;
      if (isWaterAt(this._latAt(y), this._lngAt(x))) {
        p.x = x; p.y = y; p.age = Math.floor(Math.random() * 6); return;
      }
    }
    p.age = 0;
  },
  _pFrame(ctx, dt) {
    const cfg = this._pCfg, t = S.tScrub;
    if (!this._pPool) {
      this._pPool = [];
      for (let i = 0; i < cfg.count; i++) {
        const p = { x: 0, y: 0, age: 0 };
        this._pSeedOne(p);
        p.age = Math.floor(Math.random() * cfg.maxAge);
        this._pPool.push(p);
      }
    }
    // fade DEBT: 8-bit alpha rounds sub-1.3% erases to zero, which left a
    // permanent ink veil under the slow silk fade — bank it, spend >= 6%
    this._fdebt = (this._fdebt || 0) + (1 - Math.pow(1 - cfg.fade, dt * 30));
    if (this._fdebt >= 0.06) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = `rgba(0,0,0,${this._fdebt.toFixed(3)})`;
      ctx.fillRect(0, 0, this._w, this._h);
      ctx.globalCompositeOperation = 'source-over';
      this._fdebt = 0;
    }
    ctx.lineCap = 'round';
    for (const p of this._pPool) {
      const [du, dv, sp2] = this._flowPx(p.x, p.y, t);
      const f = Math.min(1, sp2 / 4);
      if (sp2 < 0.08 || ++p.age > cfg.maxAge) { this._pSeedOne(p); continue; }
      const step = (cfg.base + cfg.gain * f) * dt;
      // sub-stepped with a water test each ~3 px: a post-stall 10 px
      // stride must not stroke across a sand sliver
      const nSub = Math.max(1, Math.ceil(step / 3));
      let cx = p.x, cy = p.y, dead = false;
      for (let s2 = 0; s2 < nSub; s2++) {
        cx += (du / sp2) * (step / nSub);
        cy += (dv / sp2) * (step / nSub);
        if (!isWaterAt(this._latAt(cy), this._lngAt(cx))) { dead = true; break; }
      }
      if (dead) { this._pSeedOne(p); continue; }
      // ease in and out over the first/last 12% of life: no popping
      const env = clamp(Math.min(p.age, cfg.maxAge - p.age) / (cfg.maxAge * 0.12), 0.05, 1);
      ctx.strokeStyle = vCol(cfg.cm, f, cfg.a(f) * env);
      ctx.lineWidth = cfg.w(f);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(cx, cy); ctx.stroke();
      p.x = cx; p.y = cy;
    }
    if (VEC === '6' || VEC === '4') this._grainChevrons(ctx);
    this._drawTopKnots(ctx, this._pCells);
  },
  // the grain's direction sign: sparse cased CURRENT arrows in the
  // thermal ramp — their color ties them to the current bar, so the
  // legend already explains them (grade: unexplained black marks)
  _grainChevrons(ctx) {
    const t2 = S.tScrub;
    ctx.lineCap = 'round';
    for (let gy = 36; gy < this._h; gy += 72) for (let gx = 36; gx < this._w; gx += 72) {
      const [du, dv, sp2] = this._flowPx(gx, gy, t2);
      if (sp2 < 0.15 || !isWaterAt(this._latAt(gy), this._lngAt(gx))) continue;
      const dxn = du / sp2, dyn = dv / sp2;
      const f = Math.min(1, sp2 / 4);
      const L2 = 9 + 15 * f, head = 3.6 + 3 * f;
      const reach = L2 / 2 + head + 1.5;
      if (!isWaterAt(this._latAt(gy + dyn * reach), this._lngAt(gx + dxn * reach))
        || !isWaterAt(this._latAt(gy - dyn * L2 / 2), this._lngAt(gx - dxn * L2 / 2))) continue;
      const ink6 = VEC === '6' ? vCol('silk', sp2 / 4, 0.95) : curCol(sp2, 0.95);
      drawArrow(ctx, gx, gy, dxn, dyn, L2, 1.8 + 3.4, head + 1.5, 'rgba(255,255,255,0.85)');
      drawArrow(ctx, gx, gy, dxn, dyn, L2, 1.8, head, ink6);
    }
  },
  /* ---- 7 · G: dots marching along pathlines, spacing = speed ---- */
  _marchBuild(ctx, cells, t) {
    const mpp = Math.abs(this._se.lng - this._nw.lng) * M_LNG / this._w;
    this._mMpp = mpp;
    const rawMin = 34 * mpp / (4 * 0.5144) / 60;
    this._mDotSec = 60 * [0.25, 0.5, 1, 2, 3, 5, 8, 13, 21]
      .reduce((b2, v2) => Math.abs(v2 - rawMin) < Math.abs(b2 - rawMin) ? v2 : b2, 21);
    // publish the true pixel gap at 4 kn; the legend tracks re-price
    // whenever the zoom rung changes the ruler
    const gap4 = 4 * 0.5144 * this._mDotSec / mpp;
    if (Math.abs((S._mGap4 || 0) - gap4) > 0.5) {
      S._mGap4 = gap4;
      try { fillLegend(); } catch (e) {}
    }
    const paths = [];
    for (const c of cells) {
      if (c.spd < 0.12) continue;
      const f = Math.min(1, c.spd / 4);

      // pathline with cumulative TIME at each vertex, 3 px substeps
      const pts = [[c.x, c.y, c.spd, 0, 0]];
      let cx = c.x, cy = c.y, tSec = 0, dist = 0;
      for (let it = 0; it < 200 && tSec < this._mDotSec * 4.6; it++) {
        const [du, dv, sp2] = this._flowPx(cx, cy, t + tSec * 1000);
        if (sp2 < 0.08) break;
        cx += (du / sp2) * 3; cy += (dv / sp2) * 3;
        if (!isWaterAt(this._latAt(cy), this._lngAt(cx))) break;
        tSec += 3 * mpp / (sp2 * 0.5144);
        dist += 3;
        pts.push([cx, cy, sp2, tSec, dist]);
      }
      if (pts.length < 3) continue;
      paths.push({ pts, f, spd: c.spd });
    }
    this._mPaths = paths;
    this._mCells = cells;
    this._mPhase = this._mPhase || 0;
    this._marchFrame(ctx, 0);
    this._animStart();
  },
  _mAt(pts, sec) {
    // position + speed at drift-time sec, linear along the stored path
    for (let k = 1; k < pts.length; k++) {
      if (pts[k][3] >= sec) {
        const a2 = pts[k - 1], b2 = pts[k];
        const u = (sec - a2[3]) / ((b2[3] - a2[3]) || 1e-9);
        return [a2[0] + (b2[0] - a2[0]) * u, a2[1] + (b2[1] - a2[1]) * u, a2[2] + (b2[2] - a2[2]) * u];
      }
    }
    return null;
  },
  _mAtDist(pts, dist) {
    // Guaranteed-visible screen motion while remaining exactly on the
    // integrated #7 path. This avoids near-slack dots appearing frozen.
    for (let k = 1; k < pts.length; k++) {
      if (pts[k][4] >= dist) {
        const a = pts[k - 1], b = pts[k];
        const u = (dist - a[4]) / ((b[4] - a[4]) || 1e-9);
        return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
      }
    }
    return null;
  },
  _marchFrame(ctx, tsec) {
    ctx.clearRect(0, 0, this._w, this._h);
    ctx.lineCap = 'round';
    // Put a visible anchor at every sampled water point so the grid never
    // disappears in slack water. Active paths draw over these anchors.
    ctx.fillStyle = 'rgba(0,91,190,0.70)';
    for (const c of this._mCells || []) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.spd < 0.12 ? 2.2 : 1.45, 0, 2 * Math.PI);
      ctx.fill();
    }
    for (const p of this._mPaths || []) {
      ctx.strokeStyle = curCol(p.spd, 0.30);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.pts[0][0], p.pts[0][1]);
      for (let k = 1; k < p.pts.length; k++) ctx.lineTo(p.pts[k][0], p.pts[k][1]);
      ctx.stroke();
      const dEnd = p.pts[p.pts.length - 1][4];
      const gap = clamp(p.spd * 0.5144 * this._mDotSec / (this._mMpp || 1), 8, 40);
      const dotSpeed = 7 + 7 * p.f;
      const phase = REDUCED_MOTION ? 0.45 : ((tsec * dotSpeed / gap) % 1);
      for (let k = 0; k < 7; k++) {
        const dist = (phase + k) * gap;
        const at = this._mAtDist(p.pts, dist);
        if (!at) break;
        const g = Math.min(1, (phase + k) / 3.2);
        let aa = 0.92;
        aa *= clamp((dEnd - dist) / Math.max(6, gap * 0.35), 0, 1);
        if (k === 0) aa *= clamp(phase / 0.3, 0, 1);
        if (aa < 0.03) continue;
        ctx.fillStyle = curCol(at[2], aa);
        ctx.beginPath();
        ctx.arc(at[0], at[1], 1.5 + 1.1 * g, 0, 2 * Math.PI);
        ctx.fill();
      }
      const e = p.pts[p.pts.length - 1], q = p.pts[p.pts.length - 2];
      const hl = Math.hypot(e[0] - q[0], e[1] - q[1]) || 1;
      const hx = (e[0] - q[0]) / hl, hy = (e[1] - q[1]) / hl;
      const hs = 4 + 3.6 * p.f;
      if (isWaterAt(this._latAt(e[1] + hy * (hs * 1.5 + 2)), this._lngAt(e[0] + hx * (hs * 1.5 + 2)))) {
        ctx.fillStyle = curCol(e[2], 0.95);
        ctx.beginPath();
        ctx.moveTo(e[0] + hx * hs * 1.5, e[1] + hy * hs * 1.5);
        ctx.lineTo(e[0] - hy * hs * 0.62, e[1] + hx * hs * 0.62);
        ctx.lineTo(e[0] + hy * hs * 0.62, e[1] - hx * hs * 0.62);
        ctx.closePath(); ctx.fill();
      }
    }
  },
  /* ---- the one current language: an even quiver with marching tail dots ---- */
  _gridBuild(ctx, cells) {
    this._gridCells = cells;
    this._gridFrame(ctx, REDUCED_MOTION ? 0 : performance.now() / 1000);
    this._animStart();
  },
  _gridFrame(ctx, tsec) {
    ctx.clearRect(0, 0, this._w, this._h);
    ctx.lineCap = 'round';
    S._curKnotRects = [];
    const phaseClock = REDUCED_MOTION ? 0.45 : tsec;
    for (const c of this._gridCells || []) {
      const f = clamp(c.spd / 4, 0, 1);
      const len = 13 + 19 * f;
      const head = 3.4 + 2.8 * f;
      const reach = len / 2 + head + 2;
      const tipLat = this._latAt(c.y + c.dyn * reach);
      const tipLng = this._lngAt(c.x + c.dxn * reach);
      const tailLat = this._latAt(c.y - c.dyn * reach);
      const tailLng = this._lngAt(c.x - c.dxn * reach);
      if (!isWaterAt(tipLat, tipLng) || !isWaterAt(tailLat, tailLng)) continue;

      const ink = curColor3(f);
      const tail0 = len / 2 + 7;
      const dotGap = 7.5;
      const phase = (phaseClock * (0.34 + 0.42 * f) + hash01(c.x, c.y)) % 1;
      // The dots travel toward the arrow, so direction is visible before a
      // viewer has decoded the arrowhead. They stay behind the shaft.
      for (let k = 0; k < 3; k++) {
        const d = tail0 + (k + 1 - phase) * dotGap;
        const px = c.x - c.dxn * d, py = c.y - c.dyn * d;
        if (!isWaterAt(this._latAt(py), this._lngAt(px))) continue;
        ctx.fillStyle = `rgba(${cmapAt(CUR3, f)},${(0.42 + 0.34 * (1 - k / 3)).toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(px, py, 1.25 + 0.65 * f, 0, Math.PI * 2);
        ctx.fill();
      }

      // A quiet pale casing preserves the requested blue-to-black ink on the
      // tropical ocean without introducing a third magnitude color.
      drawArrow(ctx, c.x, c.y, c.dxn, c.dyn, len, 4.2, head + 1.45, 'rgba(241,250,252,0.72)');
      drawArrow(ctx, c.x, c.y, c.dxn, c.dyn, len, 1.85, head, ink);
    }
  },
  _reset() {
    if (!this._map) return;                      // onAdd deferred (background tab)
    const m = this._map, size = m.getSize();
    if (size.x < 50 || size.y < 50) {
      clearTimeout(this._retryT);
      this._retryT = setTimeout(() => this._reset(), 150);
      return;
    }
    const r = padReset(this, m, 2);
    if (!r) return;
    this._ctx.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
    this.redraw();
  },
  requestRedraw() {                    // trailing throttle for scrub/play
    if (this._rt) return;
    // playback sweeps the clock continuously — redraw less often then
    this._rt = setTimeout(() => { this._rt = null; this.redraw(); }, S.playing ? 300 : 80);
  },
  redraw() {
    if (!this._w) return;
    const cfg = this._cfg, ctx = this._ctx;
    const vec = cfg.autoscale ? VEC : '0';   // variants apply to the CURRENT layer only
    ctx.clearRect(0, 0, this._w, this._h);
    if (cfg.ready && !cfg.ready()) return;
    ctx.lineCap = 'round';
    const sp = ({ 1: 34, 2: 34, 3: 26, 4: 44, 5: 26, 6: 40, 7: 46 }[vec]) || cfg.spacing;
    const t = S.tScrub;
    // pass 1: sample everything visible, so the arrows can autoscale to the
    // strongest current IN FRAME (never below a 3 kn top)
    const cells = [];
    let mx = 0, row = 0;
    for (let y = sp / 2; y < this._h; y += sp, row++) {
      const lat = this._nw.lat + (this._se.lat - this._nw.lat) * (y / this._h);
      for (let x = sp / 2 + (row % 2) * sp / 2; x < this._w; x += sp) {
        const lng = this._nw.lng + (this._se.lng - this._nw.lng) * (x / this._w);
        const s = cfg.sample(lat, lng, t);
        const spd = Math.hypot(s[0], s[1]);
        const calm = spd < 0.01;
        const dxn = calm ? 0 : s[0] / spd, dyn = calm ? 0 : -s[1] / spd;
        if (cfg.waterGate) {
          // anchor AND tip must be on water so no arrow ever pokes into shore
          const tLat = this._nw.lat + (this._se.lat - this._nw.lat) * ((y + dyn * 13) / this._h);
          const tLng = this._nw.lng + (this._se.lng - this._nw.lng) * ((x + dxn * 13) / this._w);
          if (!isWaterAt(lat, lng) || !isWaterAt(tLat, tLng)) continue;
        }
        if (cfg.filter && !cfg.filter(lat, lng, dxn, dyn, spd)) continue;
        cells.push({ x, y, dxn, dyn, spd, lat, lng });
        if (spd > mx) mx = spd;
      }
    }
    if (cfg.autoscale) {
      // A fixed ruler makes the same current look the same on every redraw.
      curScaleMax = 4;
      // variants draw on an absolute 4 kn anchor: their legend says '4+'
      // and the in-frame autoscale must not overwrite it
      const el = $('lg-cur-max');
      if (el) el.textContent = '4+';
    }
    if (vec === '0') return this._marchBuild(ctx, cells, t);
    if (vec === '1' || vec === '2' || vec === '5') return this._bwBuild(ctx, cells, t);
    if (vec === '3') return this._fillBuild(ctx, t, cells);
    if (vec === '4' || vec === '6') return this._pBuild(ctx, cells, t);
    if (vec === '7') return this._marchBuild(ctx, cells, t);
    for (const c of cells) {
      let lenCap = 1;
      if (cfg.waterGate) {
        // a long arrow must still FIT its waterway: shrink until the tip
        // stays on water, so narrow channels never sprout giant arrows
        const full = 2 + Math.min(1, c.spd / curScaleMax) * 26;
        for (let k = 0; k < 3; k++) {
          const half = (full * lenCap) / 2 + 3;
          const tLat = this._nw.lat + (this._se.lat - this._nw.lat) * ((c.y + c.dyn * half) / this._h);
          const tLng = this._nw.lng + (this._se.lng - this._nw.lng) * ((c.x + c.dxn * half) / this._w);
          if (isWaterAt(tLat, tLng)) break;
          lenCap *= 0.65;
        }
      }
      cfg.draw(ctx, c.x, c.y, c.dxn, c.dyn, c.spd, c.lat, c.lng, lenCap, 1);
    }
  },
});

// the flow canvases are padded well past the viewport so panning never
// shows a blank edge — but printed labels must land where the EYES are,
// not in the hidden margins. Returns [x0, y0, x1, y1] of the visible
// window in a padded layer's own canvas coordinates.
function layerViewBox(l) {
  try {
    const b = l._map.getBounds();
    return [
      (b.getWest() - l._nw.lng) / (l._se.lng - l._nw.lng) * l._w,
      (b.getNorth() - l._nw.lat) / (l._se.lat - l._nw.lat) * l._h,
      (b.getEast() - l._nw.lng) / (l._se.lng - l._nw.lng) * l._w,
      (b.getSouth() - l._nw.lat) / (l._se.lat - l._nw.lat) * l._h,
    ];
  } catch (e) { return [0, 0, l._w || 0, l._h || 0]; }
}

// printed values must not hide behind the UI cards floating over the map
// (key card, rose, passage card, the bottom panel, desktop chips): each
// visible card becomes a no-label rectangle in layer coordinates
function uiExclusions(l) {
  const vb = layerViewBox(l);
  const out = [];
  for (const id of ['transitcard', 'panel', 'chips', 'plancard', 'legend']) {
    const el = document.getElementById(id);
    if (!el || el.hidden) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    out.push([vb[0] + r.left - 8, vb[1] + r.top - 18, vb[0] + r.right + 8, vb[1] + r.bottom + 6]);
  }
  return out;
}
function inExclusion(ex, x, y) {
  return ex.some((r) => x > r[0] && x < r[2] && y > r[1] && y < r[3]);
}

function drawArrow(ctx, x, y, dx, dy, len, width, head, color) {
  const x1 = x + dx * len / 2, y1 = y + dy * len / 2;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x - dx * len / 2, y - dy * len / 2);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1 + dx * head, y1 + dy * head);
  ctx.lineTo(x1 - dy * head * 0.62, y1 + dx * head * 0.62);
  ctx.lineTo(x1 + dy * head * 0.62, y1 - dx * head * 0.62);
  ctx.closePath();
  ctx.fill();
}

const CURRENT_ARROWS = {
  pane: 'waterPane',
  spacing: 32,
  waterGate: true,
  autoscale: true,                     // top of the scale = strongest in frame, ≥3 kn
  ready: () => !!flowField || waterReady,
  // the tide breathing on and off every beach is real, but it is local
  // knowledge, not passage planning: below z14 an arrow earns its pixels
  // only if its water KEEPS GOING — flow that begins or ends on a beach
  // within ~half a kilometer is hidden until you zoom in on it. A channel
  // jet always survives this test (its water continues both ways); a
  // beach spear never does, however far offshore it reaches.
  // Water gating and shore-truncated paths already keep marks out of land.
  // Do not suppress wide-zoom anchors: density must remain useful before
  // the reader has zoomed into the Strait.
  filter: () => true,
  sample: (lat, lng, t) => sampleWater(lat, lng, t),
  // 100% opaque; magnitude is carried by length alone (debuggability first).
  // boost > 1 = variant 4's sparse-glyph mode: fewer arrows, each larger
  draw: (ctx, x, y, dx, dy, spd, lat, lng, lenCap, boost) => {
    // variant 4's sparse glyphs share the wash's ABSOLUTE 4 kn anchor, so
    // the '4+' legend is true for both of its current encodings
    const f = boost && boost > 1 ? Math.min(1, spd / 4) : Math.min(1, spd / curScaleMax);
    if (f < 0.02) return;
    const b = boost || 1;
    const L = (2 + f * 26) * (lenCap || 1) * b;
    // color rides the same in-frame scale as the length: transparent
    // into white, through azure, to black at the frame's strongest water
    drawArrow(ctx, x, y, dx, dy, L, 1.2 * b, Math.min(2.2 + 2.8 * f, 2 + L * 0.18) * b, curColor3(f));
  },
};

function windColor(f, a) {
  // warm pale gray → strong red (pale end stays visible on the cream land)
  return `rgba(${Math.round(213 + 1 * f)},${Math.round(203 - 171 * f)},${Math.round(196 - 164 * f)},${clamp(a, 0, 1).toFixed(2)})`;
}

/* One production color language. Both ramps have their RGB midpoint at
   25% of the scale, so useful color arrives early instead of being saved
   for values the current viewport may never reach. */
const CUR3 = [[0, [0, 127, 255]], [0.25, [0, 64, 128]], [1, [0, 0, 0]]];
const WIND3 = [[0, [255, 255, 255]], [0.25, [250, 209, 176]], [1, [244, 162, 97]]];
const WIND_STREAM_RGB = [244, 162, 97];
let windColorMax = 10;
function curColor3(f) { return `rgba(${cmapAt(CUR3, f)},0.98)`; }
function windColor3(f, a) { return `rgba(${cmapAt(WIND3, f)},${clamp(a == null ? 0.96 : a, 0, 1).toFixed(2)})`; }
function windStreamColor(a) { return `rgba(${WIND_STREAM_RGB.join(',')},${clamp(a, 0, 1).toFixed(2)})`; }
function updateWindBar0() {
  if (VEC !== '0') return;
  const lw = $('lg-wind');
  if (!lw) return;
  const oldTick = document.getElementById('lg-wind-tick');
  if (oldTick) oldTick.remove();
  const stops = WIND3.map(([f, rgb]) => `rgb(${rgb.join(',')}) ${(f * 100).toFixed(1)}%`);
  lw.style.background = `linear-gradient(to top, ${stops.join(', ')})`;
}

/* ONE color language for the whole slate, two perceptually ordered ramps
   (the streamplot tradition: magnitude IS color, the legend just prices
   it — a colorbar with numbers, no prose):
     water 0→4+ kn: seafoam → teal → blue → indigo → deep violet
     air   0→20+ kn: sand → gold → amber → burnt orange → crimson
   The families never collide (cool vs warm), both order by lightness so
   they survive colorblindness, and red still means small-craft weather. */
/* Stops tuned by colorimetric audit (2026-07-27): water stop0 green-shifted
   so slow marks survive deuteranopia against the pale basemap; air stop1
   darkened to even the ramp's perceptual spacing; air's terminal red is a
   deep carmine, ~19 dE00 from the chart's nun-buoy red instead of 2.6. */
/* thermal-ink current ramp for LIGHT grounds: near-black navy at slack
   through indigo, crimson, orange — every stop dark enough to read on
   pale water (no pale entry, no transparency), nonlinear with its knee
   across the 0.7-3 kn band where passage decisions live */
// capped at the audited orange: the gold terminal printed the FASTEST
// water at 1.3:1 on the pale chart (panel L1 autofail); foot lifted off
// the black axis so slack current never shares the wind inks' family
const WATER_CMAP = CUR3;
const AIR_CMAP = [[0, [120, 100, 60]], [0.3, [215, 167, 62]], [0.55, [217, 138, 51]], [0.8, [200, 90, 36]], [1, [138, 14, 54]]];
/* the ONE wind ramp (user law: 'hot' black -> color -> white): near-black
   through deep teal and green to white-hot at 25+, monotone lightness,
   never sharing the current ramp's blue-red axis */
const WIND_CMAP = [[0, [14, 52, 48]], [0.3, [8, 110, 105]], [0.6, [95, 185, 60]], [0.85, [214, 228, 88]], [1, [255, 252, 235]]];
function cmapAt(cm, f) {
  // positioned stops [pos, [r,g,b]] are allowed: ramps may be NONLINEAR,
  // spending their color change where the data varies most
  f = clamp(f, 0, 1);
  if (Array.isArray(cm[0][1])) {
    let i = 0;
    while (i < cm.length - 2 && f > cm[i + 1][0]) i++;
    const u = (f - cm[i][0]) / ((cm[i + 1][0] - cm[i][0]) || 1e-9);
    const a2 = cm[i][1], b2 = cm[i + 1][1], uu = clamp(u, 0, 1);
    return `${Math.round(a2[0] + (b2[0] - a2[0]) * uu)},${Math.round(a2[1] + (b2[1] - a2[1]) * uu)},${Math.round(a2[2] + (b2[2] - a2[2]) * uu)}`;
  }
  const p = f * (cm.length - 1);
  const i = Math.min(cm.length - 2, Math.floor(p)), u = p - i;
  return `${Math.round(cm[i][0] + (cm[i + 1][0] - cm[i][0]) * u)},${Math.round(cm[i][1] + (cm[i + 1][1] - cm[i][1]) * u)},${Math.round(cm[i][2] + (cm[i + 1][2] - cm[i][2]) * u)}`;
}
function curCol(kn, a) { return `rgba(${cmapAt(WATER_CMAP, kn / 4)},${clamp(a, 0, 1).toFixed(2)})`; }
function airCol(kn, a) { return `rgba(${cmapAt(AIR_CMAP, kn / 20)},${clamp(a, 0, 1).toFixed(2)})`; }

/* per-composition ramps (A-G): spectral for the dark chart, the
   weather wash for B, viridis for the C fill, aqua and gold particle
   families for D, silk and hot for F; E is ink plus one vermilion. */
const CM = {
  // wash bands reuse the audited monotone AIR stops: band identity must
  // survive deuteranopia on lightness alone (rainbow bands 2/3 collapsed)
  wash: [[227, 201, 131], [215, 167, 62], [217, 138, 51], [200, 90, 36], [138, 14, 54]],
  viridis: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
  thermal: WATER_CMAP,
  silk: [[0, [40, 80, 90]], [0.3, [46, 127, 143]], [0.6, [28, 58, 110]], [1, [18, 11, 61]]],
  hot: [[255, 209, 102], [244, 132, 95], [195, 60, 84], [138, 14, 54]],
};
function vCol(name, f, a) { return `rgba(${cmapAt(CM[name], f)},${clamp(a, 0, 1).toFixed(2)})`; }

/* Wind side of the seven compositions. The grid spacing also feeds the
   printed-value picker, so even particle modes keep a coarse cell grid. */
/* Seven wind attempts, one PER composition, each paired against its
   current language and each inside the laws: no popping, no faintness,
   no mono-hue ramps, heads big enough to read first.
     1 ink quiver — black cased arrows over the thermal current lines
       (colored water, black air)
     2 hot quiver — the WIND_CMAP spectral arrows over black dashes
       (black water, colored air)
     3 barbs — oversized meteorological staffs beside the viridis fill
     4 wind streamlines — long WIND_CMAP-colored paths over the water's
       thermal particles (smooth air over granular water)
     5 amber quiver — the etching keeps exactly two inks: black water,
       one saturated amber air, speed in SIZE with three sized legend
       samples (no ramp bar, so no mono-ramp lie)
     6 wedge darts — solid filled WIND_CMAP kites over the silk grain
       (area marks over texture)
     7 windsocks — with the cased tip arrow */
const WIND_STYLE = {
  0: { sp: 62, mode: 'unified' },
  1: { sp: 84, mode: 'inkquiver' },
  2: { sp: 84, mode: 'quiver' },
  3: { sp: 108, mode: 'barbs' },
  4: { sp: 96, mode: 'windlines' },
  5: { sp: 88, mode: 'amberquiver' },
  6: { sp: 84, mode: 'wedges' },
  7: { sp: 116, mode: 'socks' },
};
// wind ink is never invisible: floor 0.38, saturating by ~20 kn
function windInkA() { return 0.9; }   // ink is CONSTANT: faintness read as 'no data' (user law)

/* Wind as a static arrow grid — each cell shows the live wind through the
   baked landscape transfer (fetch/roughness/canopy/terrain), so land shelter
   and open-water exposure are visible at a glance. No animation: the field
   itself is the message. */
const WindStreaks = L.Layer.extend({
  onAdd(m) {
    this._map = m;
    const c = this._canvas = document.createElement('canvas');
    c.className = 'flow-canvas';
    m.getPane('windPane').appendChild(c);
    this._ctx = c.getContext('2d');
    this._onMoveEnd = () => {
      if (this._rsQ) return;
      this._rsQ = true;
      Promise.resolve().then(() => { this._rsQ = false; this._reset(); });
    };
    m.on('moveend zoomend resize', this._onMoveEnd);
    this._reset();
  },
  onRemove(m) {
    this._running = false;
    m.off('moveend zoomend resize', this._onMoveEnd);
    releaseCanvasZoom(this, m);
    this._canvas.remove();
  },
  setPaused(p) { this._paused = p; },
  notifyTime() {
    if (this._nt) return;
    this._nt = setTimeout(() => { this._nt = null; this._rebuild(); }, 150);
  },
  _reset() {
    if (!this._map) return;                      // onAdd deferred (background tab)
    const m = this._map, size = m.getSize();
    if (size.x < 50 || size.y < 50) {
      clearTimeout(this._retryT);
      this._retryT = setTimeout(() => this._reset(), 150);
      return;
    }
    const r = padReset(this, m, 2);
    if (!r) return;
    this._dpr = r.dpr;
    this._ctx.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
    this._rebuild();
  },
  _rebuild() {
    if (!this._w || !S.wind) { this._cells = []; return; }
    const sp = (WIND_STYLE[VEC] || WIND_STYLE[0]).sp, raw = [];
    const t = clamp(S.tScrub, S.wind.times[0], S.wind.times[S.wind.times.length - 1]);
    let row = 0, mx = 0;
    for (let y = sp / 2; y < this._h; y += sp, row++) {
      const lat = this._nw.lat + (this._se.lat - this._nw.lat) * (y / this._h);
      for (let x = sp / 2 + (row % 2) * sp / 2; x < this._w; x += sp) {
        const lng = this._nw.lng + (this._se.lng - this._nw.lng) * (x / this._w);
        // no wind data beyond the baked box — don't draw edge-clamped ghosts
        if (lat < DATA_BOX.la0 || lat > DATA_BOX.la1 || lng < DATA_BOX.lo0 || lng > DATA_BOX.lo1) continue;
        const [u, v] = sampleWind(lat, lng, t);
        const spd = Math.hypot(u, v);
        const calmKeep = ['barbs', 'socks'].includes((WIND_STYLE[VEC] || {}).mode);
        if (spd < 0.2 && !calmKeep) continue;
        const uxn = spd > 0.01 ? u / spd : 0, vyn = spd > 0.01 ? v / spd : 1;
        const eff = spd;                       // land/terrain transfer already applied in sampleWind
        raw.push({ x, y, uxn, vyn, eff });
        if (eff > mx) mx = eff;
      }
    }
    // Use the whole wind ramp in this view, while keeping a 10 kn floor so
    // ordinary breezes do not exaggerate themselves into gale colors.
    windScaleMax = Math.max(10, Math.ceil(mx));
    windColorMax = windScaleMax;
    if (VEC === '0') updateWindBar0();
    const el0 = $('lg-wind-max');
    const el = VEC === '0' ? el0 : null;
    if (el) el.textContent = String(Math.round(windScaleMax));
    const cells = [];
    const barbMode = (WIND_STYLE[VEC] || {}).mode === 'barbs';
    for (const r of raw) {
      // variants: absolute 20 kn size anchor, so the same wind draws the
      // same mark on every day; only the control autoscales. Barb mode
      // keeps near-calm cells: met notation owns a calm symbol.
      const f = Math.min(1, r.eff / (VEC === '0' ? windScaleMax : 20));
      if (f < 0.06 && !barbMode && (WIND_STYLE[VEC] || {}).mode !== 'socks') continue;
      cells.push({ x: r.x, y: r.y, dx: r.uxn, dy: -r.vyn, f, kn: r.eff, seed: ((r.x * 73 + r.y * 149) % 997) / 997 });
    }
    this._cells = cells;
    this._knotTop = null;                 // re-pick the windiest spots
    this._drawWind();
  },
  _drawWind() {
    this._wStop();
    if (!S.wind) { this._ctx.clearRect(0, 0, this._w, this._h); return; }
    const st = WIND_STYLE[VEC] || WIND_STYLE[0];
    if (st.mode === 'unified') return this._wUnifiedBuild();
    if (st.mode === 'quiver') return this._wQuiver();
    if (st.mode === 'inkquiver') return this._wInkQuiver();
    if (st.mode === 'amberquiver') return this._wInkQuiver('rgba(211,116,32,0.95)', 'rgba(255,255,255,0.9)');
    if (st.mode === 'barbs') return this._wBarbs();
    if (st.mode === 'windlines') return this._wWindLines();
    if (st.mode === 'wedges') return this._wWedges();
    if (st.mode === 'socks') { this._wSocks(0); return this._wStart('socks'); }
    this._drawStaticArrows();
  },
  _wStop() {
    if (this._wraf) cancelAnimationFrame(this._wraf);
    this._wraf = null;
  },
  _wStart(mode) {
    if (this._wraf || REDUCED_MOTION) return;
    this._wT = performance.now();
    const tick = (ts) => {
      this._wraf = requestAnimationFrame(tick);
      if (!this._canvas || !this._canvas.isConnected) return this._wStop();
      if (this._paused || (document.hidden && !S._forceAnim) || !this._w) { this._wT = ts; return; }
      if (ts - (this._wLast || 0) < 30) return;
      this._wLast = ts;
      const dt = clamp((ts - this._wT) / 1000, 0.01, 0.15);
      this._wT = ts;
      if (mode === 'socks') this._wSocks(ts / 1000);
      else if (mode === 'unified') this._wUnifiedFrame(dt, ts / 1000);
    };
    this._wraf = requestAnimationFrame(tick);
  },
  _wIn(x, y) {
    const lat = this._nw.lat + (this._se.lat - this._nw.lat) * (y / this._h);
    const lng = this._nw.lng + (this._se.lng - this._nw.lng) * (x / this._w);
    return lat > DATA_BOX.la0 && lat < DATA_BOX.la1 && lng > DATA_BOX.lo0 && lng < DATA_BOX.lo1;
  },
  // label inks per composition: [text, halo]
  _wKnotInk(kn) {
    if (VEC === '0') return [windColor3(Math.min(1, kn / windScaleMax), 0.98), 'rgba(35,68,86,0.82)'];
    if (VEC === '3') return ['#1c2f4a', 'rgba(255,255,255,0.9)'];
    if (VEC === '5') return ['rgba(176,92,22,0.97)', 'rgba(255,255,255,0.9)'];
    if (VEC === '1') return ['rgba(8,8,8,0.95)', 'rgba(255,255,255,0.9)'];
    // rust: off the WIND ramp (teal-green family), off the slack slate
    // the current labels use, and it echoes vec7's sock stripes
    return ['rgba(170,60,10,0.97)', 'rgba(255,255,255,0.9)'];
  },
  /* ---- #6's slow particle grain, ported to wind, below the arrow grid ---- */
  _wUnifiedBuild() {
    const t = clamp(S.tScrub, S.wind.times[0], S.wind.times[S.wind.times.length - 1]);
    const dpr = this._dpr || clamp(devicePixelRatio || 1, 1, 2);
    const cv = this._wTrailCv = this._wTrailCv || document.createElement('canvas');
    cv.width = Math.round(this._w * dpr);
    cv.height = Math.round(this._h * dpr);
    const trail = this._wTrailCtx = cv.getContext('2d');
    trail.setTransform(dpr, 0, 0, dpr, 0, 0);
    trail.clearRect(0, 0, this._w, this._h);
    trail.lineCap = 'round';

    // The same immediate static frame as #6: short, solid integrated flow
    // strokes. Animation then dissolves this base into the particle grain.
    for (const c of this._cells) {
      if (hash01(c.x, c.y) > 0.42) continue;
      const halfFor = (dir) => {
        const out = [[c.x, c.y, c.kn]];
        let cx = c.x, cy = c.y;
        const n = 4 + Math.round(6 * c.f);
        for (let k = 0; k < n; k++) {
          const [du, dv, kn] = this._wFlow(cx, cy, t);
          if (kn < 0.2) break;
          cx += dir * (du / kn) * 6;
          cy += dir * (dv / kn) * 6;
          if (!this._wIn(cx, cy)) break;
          out.push([cx, cy, kn]);
        }
        return out;
      };
      const back = halfFor(-1).reverse();
      const line = back.concat(halfFor(1).slice(1));
      for (let k = 1; k < line.length; k++) {
        const f = clamp(((line[k - 1][2] + line[k][2]) * 0.5) / windScaleMax, 0, 1);
        trail.strokeStyle = windStreamColor(0.58);
        trail.lineWidth = 1.1;
        trail.beginPath();
        trail.moveTo(line[k - 1][0], line[k - 1][1]);
        trail.lineTo(line[k][0], line[k][1]);
        trail.stroke();
      }
    }
    this._wTrailPool = null;
    this._wFadeDebt = 0;
    this._wUnifiedFrame(0, REDUCED_MOTION ? 0 : performance.now() / 1000);
    this._wStart('unified');
  },
  _wSeedOne(p) {
    for (let k = 0; k < 20; k++) {
      const x = Math.random() * this._w, y = Math.random() * this._h;
      if (this._wIn(x, y)) {
        p.x = x; p.y = y; p.age = Math.floor(Math.random() * 6); return;
      }
    }
    p.age = 0;
  },
  _wUnifiedFrame(dt, tsec) {
    const ctx = this._ctx;
    const trail = this._wTrailCtx;
    if (!trail || !this._wTrailCv) return;
    const maxAge = 700;
    if (!this._wTrailPool) {
      this._wTrailPool = [];
      const count = Math.round(clamp((this._w * this._h) / 1900, 320, 650));
      for (let i = 0; i < count; i++) {
        const p = { x: 0, y: 0, age: 0 };
        this._wSeedOne(p);
        p.age = Math.floor(Math.random() * maxAge);
        this._wTrailPool.push(p);
      }
    }

    // Exact #6 fade-debt behavior: accumulate sub-byte erases and spend
    // them in visible chunks so the slow silk never becomes a permanent veil.
    this._wFadeDebt = (this._wFadeDebt || 0) + (1 - Math.pow(1 - 0.009, dt * 30));
    if (this._wFadeDebt >= 0.06) {
      trail.globalCompositeOperation = 'destination-out';
      trail.fillStyle = `rgba(0,0,0,${this._wFadeDebt.toFixed(3)})`;
      trail.fillRect(0, 0, this._w, this._h);
      trail.globalCompositeOperation = 'source-over';
      this._wFadeDebt = 0;
    }
    const t = clamp(S.tScrub, S.wind.times[0], S.wind.times[S.wind.times.length - 1]);
    trail.lineCap = 'round';
    for (const p of this._wTrailPool) {
      const [du, dv, kn] = this._wFlow(p.x, p.y, t);
      const f = clamp(kn / windScaleMax, 0, 1);
      if (kn < 0.2 || ++p.age > maxAge) { this._wSeedOne(p); continue; }
      const step = 9 * dt;
      const nSub = Math.max(1, Math.ceil(step / 3));
      let cx = p.x, cy = p.y, dead = false;
      for (let s = 0; s < nSub; s++) {
        cx += (du / kn) * (step / nSub);
        cy += (dv / kn) * (step / nSub);
        if (!this._wIn(cx, cy)) { dead = true; break; }
      }
      if (dead) { this._wSeedOne(p); continue; }
      const env = clamp(Math.min(p.age, maxAge - p.age) / (maxAge * 0.12), 0.05, 1);
      trail.strokeStyle = windStreamColor(0.68 * env);
      trail.lineWidth = 1.1;
      trail.beginPath(); trail.moveTo(p.x, p.y); trail.lineTo(cx, cy); trail.stroke();
      p.x = cx; p.y = cy;
    }

    // Composite the wind texture first. Then punch a clean corridor through
    // it for every arrow: same-hue lines passing beneath a thin shaft still
    // read as crossing it even when canvas order is technically correct.
    ctx.clearRect(0, 0, this._w, this._h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.drawImage(this._wTrailCv, 0, 0, this._wTrailCv.width, this._wTrailCv.height, 0, 0, this._w, this._h);

    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    for (const c of this._cells) {
      const f = clamp(c.kn / windScaleMax, 0, 1);
      const L = 14 + 28 * f;
      const head = 4.5 + 4 * f;
      ctx.lineWidth = 9 + 4 * f;
      ctx.beginPath();
      ctx.moveTo(c.x - c.dx * (L * 0.5 + 3), c.y - c.dy * (L * 0.5 + 3));
      ctx.lineTo(c.x + c.dx * (L * 0.5 + head * 1.5 + 3), c.y + c.dy * (L * 0.5 + head * 1.5 + 3));
      ctx.stroke();
    }
    ctx.restore();

    for (const c of this._cells) {
      const f = clamp(c.kn / windScaleMax, 0, 1);
      const L = 14 + 28 * f;
      if (c.kn > 20) {
        const pulse = REDUCED_MOTION ? 0.55 : 0.5 + 0.5 * Math.sin(tsec * 3.2 + c.seed * Math.PI * 2);
        ctx.shadowColor = `rgba(${WIND_STREAM_RGB.join(',')},${(0.55 + 0.35 * pulse).toFixed(2)})`;
        ctx.shadowBlur = 7 + 10 * pulse;
      }
      drawArrow(ctx, c.x, c.y, c.dx, c.dy, L, 2 + 1.05 * f, 4.5 + 4 * f, windColor3(f));
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
    }
  },
  /* ---- the unified wind quiver: static, cased, spectral, BIG heads ---- */
  _wQuiver() {
    const ctx = this._ctx;
    ctx.clearRect(0, 0, this._w, this._h);
    ctx.lineCap = 'round';
    for (const c of this._cells) {
      const L2 = 12 + 26 * Math.min(1, c.kn / 25);
      const head = 4.5 + L2 * 0.3;             // direction reads FIRST
      drawArrow(ctx, c.x, c.y, c.dx, c.dy, L2, 2.2 + 1.6 * c.f + 2.6, head + 1.8, 'rgba(20,28,38,0.85)');
      drawArrow(ctx, c.x, c.y, c.dx, c.dy, L2, 2.2 + 1.6 * c.f, head, `rgba(${cmapAt(WIND_CMAP, c.kn / 25)},0.95)`);
    }
    this._drawWindKnots(ctx);
  },
  /* ---- 1 · ink quiver (and 5 · amber): one solid ink, speed in SIZE ---- */
  _wInkQuiver(ink, cas) {
    const ctx = this._ctx;
    ctx.clearRect(0, 0, this._w, this._h);
    ctx.lineCap = 'round';
    for (const c of this._cells) {
      const kf = Math.min(1, c.kn / 25);
      const L2 = 9 + 31 * kf;
      const head = 4 + L2 * 0.32;
      drawArrow(ctx, c.x, c.y, c.dx, c.dy, L2, 1.6 + 2.2 * kf + 2.8, head + 1.8, cas || 'rgba(255,255,255,0.88)');
      drawArrow(ctx, c.x, c.y, c.dx, c.dy, L2, 1.6 + 2.2 * kf, head, ink || 'rgba(8,8,8,0.95)');
    }
    this._drawWindKnots(ctx);
  },
  /* ---- 3 · barbs, OVERSIZED: the met glyph must read on a phone ---- */
  _wBarbs() {
    const ctx = this._ctx;
    ctx.clearRect(0, 0, this._w, this._h);
    ctx.lineCap = 'round';
    const pal = '28,47,74';
    for (const c of this._cells) {
      if (c.kn < 2.5) {
        ctx.beginPath(); ctx.arc(c.x, c.y, 4.2, 0, 2 * Math.PI);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 4.6; ctx.stroke();
        ctx.strokeStyle = `rgba(${pal},0.9)`; ctx.lineWidth = 2.1; ctx.stroke();
        continue;
      }
      const L = 42;
      const tx = c.x - c.dx * L / 2, ty = c.y - c.dy * L / 2;
      const hx2 = c.x + c.dx * L / 2, hy2 = c.y + c.dy * L / 2;
      // feathers LEFT of the downwind vector (Northern Hemisphere)
      const fx2 = c.dy * 0.87 - c.dx * 0.5, fy2 = -c.dx * 0.87 - c.dy * 0.5;
      const strokes = [[tx, ty, hx2, hy2]];
      let kn = Math.round(c.kn / 5) * 5;
      let o2 = 0;
      while (kn >= 50) {
        strokes.push([tx + c.dx * o2, ty + c.dy * o2, tx + c.dx * o2 + fx2 * 17, ty + c.dy * o2 + fy2 * 17]);
        strokes.push([tx + c.dx * (o2 + 8), ty + c.dy * (o2 + 8), tx + c.dx * o2 + fx2 * 17, ty + c.dy * o2 + fy2 * 17]);
        o2 += 10; kn -= 50;
      }
      while (kn >= 10) {
        strokes.push([tx + c.dx * o2, ty + c.dy * o2, tx + c.dx * o2 + fx2 * 17, ty + c.dy * o2 + fy2 * 17]);
        o2 += 7.5; kn -= 10;
      }
      if (kn >= 5) {
        const o3 = Math.max(o2, 7.5);
        strokes.push([tx + c.dx * o3, ty + c.dy * o3, tx + c.dx * o3 + fx2 * 9.5, ty + c.dy * o3 + fy2 * 9.5]);
      }
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass ? `rgba(${pal},0.92)` : 'rgba(255,255,255,0.9)';
        ctx.lineWidth = pass ? 2.2 : 5.4;
        for (const [x1, y1, x2, y2] of strokes) {
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        }
      }
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.moveTo(hx2 + c.dx * 9.3, hy2 + c.dy * 9.3);
      ctx.lineTo(hx2 - c.dy * 6.2, hy2 + c.dx * 6.2);
      ctx.lineTo(hx2 + c.dy * 6.2, hy2 - c.dx * 6.2);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = `rgba(${pal},0.92)`;
      ctx.beginPath();
      ctx.moveTo(hx2 + c.dx * 7.5, hy2 + c.dy * 7.5);
      ctx.lineTo(hx2 - c.dy * 4.6, hy2 + c.dx * 4.6);
      ctx.lineTo(hx2 + c.dy * 4.6, hy2 - c.dx * 4.6);
      ctx.closePath(); ctx.fill();
    }
    this._drawWindKnots(ctx);
  },
  /* ---- 4 · wind streamlines: smooth colored air over granular water ---- */
  _wWindLines() {
    const ctx = this._ctx;
    ctx.clearRect(0, 0, this._w, this._h);
    ctx.lineCap = 'round';
    const t = clamp(S.tScrub, S.wind.times[0], S.wind.times[S.wind.times.length - 1]);
    for (const c of this._cells) {
      const kf = Math.min(1, c.kn / 25);
      // integrate the wind field both ways; per-segment WIND_CMAP color
      const line = [[c.x, c.y, c.kn]];
      for (const dir of [-1, 1]) {
        let cx = c.x, cy = c.y;
        const half = [];
        for (let k = 0; k < 4 + Math.round(2 * kf); k++) {
          const [du, dv, kk] = this._wFlow(cx, cy, t);
          if (kk < 0.5) break;
          cx += dir * (du / kk) * 8; cy += dir * (dv / kk) * 8;
          half.push([cx, cy, kk]);
        }
        if (dir === -1) line.unshift(...half.reverse());
        else line.push(...half);
      }
      if (line.length < 4) continue;
      for (const pass of [0, 1]) {
        for (let k = 1; k < line.length; k++) {
          const kk = (line[k - 1][2] + line[k][2]) / 2;
          ctx.strokeStyle = pass ? `rgba(${cmapAt(WIND_CMAP, kk / 25)},0.95)` : 'rgba(255,255,255,0.85)';
          ctx.lineWidth = (2 + 1.8 * Math.min(1, kk / 25)) + (pass ? 0 : 2.6);
          ctx.beginPath();
          ctx.moveTo(line[k - 1][0], line[k - 1][1]);
          ctx.lineTo(line[k][0], line[k][1]);
          ctx.stroke();
        }
      }
      const [ex, ey, ek] = line[line.length - 1], [qx, qy] = line[line.length - 2];
      const hl = Math.hypot(ex - qx, ey - qy) || 1;
      const hx = (ex - qx) / hl, hy = (ey - qy) / hl;
      const hs = 4.5 + 3 * kf;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.moveTo(ex + hx * (hs * 1.5 + 2), ey + hy * (hs * 1.5 + 2));
      ctx.lineTo(ex - hy * (hs * 0.62 + 1.5), ey + hx * (hs * 0.62 + 1.5));
      ctx.lineTo(ex + hy * (hs * 0.62 + 1.5), ey - hx * (hs * 0.62 + 1.5));
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = `rgba(${cmapAt(WIND_CMAP, ek / 25)},0.95)`;
      ctx.beginPath();
      ctx.moveTo(ex + hx * hs * 1.5, ey + hy * hs * 1.5);
      ctx.lineTo(ex - hy * hs * 0.62, ey + hx * hs * 0.62);
      ctx.lineTo(ex + hy * hs * 0.62, ey - hx * hs * 0.62);
      ctx.closePath(); ctx.fill();
    }
    this._drawWindKnots(ctx);
  },
  /* ---- 6 · wedge darts: solid filled kites, the head IS the mark ---- */
  _wWedges() {
    const ctx = this._ctx;
    ctx.clearRect(0, 0, this._w, this._h);
    ctx.lineJoin = 'round';
    for (const c of this._cells) {
      const kf = Math.min(1, c.kn / 25);
      const L2 = 9 + 20 * kf, w2 = 3.5 + 2.8 * kf;
      const tipx = c.x + c.dx * L2 * 0.6, tipy = c.y + c.dy * L2 * 0.6;
      const bx = c.x - c.dx * L2 * 0.4, by = c.y - c.dy * L2 * 0.4;
      ctx.beginPath();
      ctx.moveTo(tipx, tipy);
      ctx.lineTo(bx - c.dy * w2, by + c.dx * w2);
      ctx.lineTo(c.x - c.dx * L2 * 0.22, c.y - c.dy * L2 * 0.22);
      ctx.lineTo(bx + c.dy * w2, by - c.dx * w2);
      ctx.closePath();
      ctx.fillStyle = `rgba(${cmapAt(WIND_CMAP, c.kn / 25)},0.95)`;
      ctx.strokeStyle = 'rgba(20,28,38,0.85)';
      ctx.lineWidth = 2.4;
      ctx.fill();
      ctx.stroke();
    }
    this._drawWindKnots(ctx);
  },
  /* ---- 7 · G: windsocks — inflation and filled stripes = speed ---- */
  _wSocks(tsec) {
    const ctx = this._ctx;
    ctx.clearRect(0, 0, this._w, this._h);
    ctx.lineCap = 'round';
    for (const c of this._cells) {
      const sway = REDUCED_MOTION || !tsec ? 0 : Math.sin(tsec * 1.4 + c.seed * 6.28) * 0.05;
      const ca = Math.cos(sway), sa = Math.sin(sway);
      const dx = c.dx * ca - c.dy * sa, dy = c.dx * sa + c.dy * ca;
      const kf = Math.min(1, c.kn / 20);
      // FAA reading: stripe n lights AT 3n kn, full sock = 15+; length
      // spans 3:1 so droop-for-length survives the width JND
      const L = 7 + 21 * kf;
      const filled = Math.max(0, Math.min(5, Math.floor(c.kn / 3)));
      // silhouette casing, then the five tapered stripe segments
      const w0 = 4.6, w1 = 1.6;
      const px2 = -dy, py2 = dx;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(c.x + px2 * w0, c.y + py2 * w0);
      ctx.lineTo(c.x + dx * L + px2 * w1, c.y + dy * L + py2 * w1);
      ctx.lineTo(c.x + dx * L - px2 * w1, c.y + dy * L - py2 * w1);
      ctx.lineTo(c.x - px2 * w0, c.y - py2 * w0);
      ctx.closePath(); ctx.stroke();
      for (let k = 0; k < 5; k++) {
        const t0 = k / 5, t1 = (k + 1) / 5;
        const wa = w0 + (w1 - w0) * t0, wb = w0 + (w1 - w0) * t1;
        ctx.beginPath();
        ctx.moveTo(c.x + dx * L * t0 + px2 * wa, c.y + dy * L * t0 + py2 * wa);
        ctx.lineTo(c.x + dx * L * t1 + px2 * wb, c.y + dy * L * t1 + py2 * wb);
        ctx.lineTo(c.x + dx * L * t1 - px2 * wb, c.y + dy * L * t1 - py2 * wb);
        ctx.lineTo(c.x + dx * L * t0 - px2 * wa, c.y + dy * L * t0 - py2 * wa);
        ctx.closePath();
        // unfilled stripes are SLATE, not faint white: white-on-white
        // water made counts 1-2 vs 3-4 unreadable on the pale chart
        ctx.fillStyle = k < filled
          ? (k % 2 ? 'rgba(255,255,255,0.95)' : 'rgba(226,88,22,0.95)')
          : 'rgba(128,142,158,0.75)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(28,47,74,0.8)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(28,47,74,0.95)';
      ctx.beginPath(); ctx.arc(c.x, c.y, 1.9, 0, 2 * Math.PI); ctx.fill();
      // a real cased arrowhead past the tip: which way the sock blows
      // must not depend on reading the taper (grade)
      const tipx = c.x + dx * (L + 2), tipy = c.y + dy * (L + 2);
      for (const pass of [0, 1]) {
        const hs2 = pass ? 4.2 : 5.6;
        ctx.fillStyle = pass ? 'rgba(28,47,74,0.95)' : 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.moveTo(tipx + dx * hs2 * 1.4, tipy + dy * hs2 * 1.4);
        ctx.lineTo(tipx - dy * hs2 * 0.62, tipy + dx * hs2 * 0.62);
        ctx.lineTo(tipx + dy * hs2 * 0.62, tipy - dx * hs2 * 0.62);
        ctx.closePath(); ctx.fill();
      }
    }
    this._drawWindKnots(ctx);
  },
  /* ---- 0: the production quiver, untouched ---- */
  _drawStaticArrows() {
    const ctx = this._ctx;
    ctx.clearRect(0, 0, this._w, this._h);
    for (const c of this._cells) {
      // LENGTH keeps the 15 kn floor via c.f; COLOR rescales to today's
      // max, and the red end carries a soft glow
      const fc = clamp(c.kn / windColorMax, 0, 1);
      if (fc > 0.85 && c.kn > 10) {
        ctx.shadowColor = 'rgba(214,26,26,0.65)';
        ctx.shadowBlur = 7;
      }
      drawArrow(ctx, c.x, c.y, c.dx, c.dy, 5 + c.f * 42, 1.7, 3 + 3.5 * c.f, windColor3(fc));
      ctx.shadowBlur = 0;
    }
  },
  _wFlow(x, y, t) {
    const lat = this._nw.lat + (this._se.lat - this._nw.lat) * (y / this._h);
    const lng = this._nw.lng + (this._se.lng - this._nw.lng) * (x / this._w);
    const [u, v] = sampleWind(lat, lng, t);
    return [u, -v, Math.hypot(u, v)];
  },
  // printed wind values: the 3 windiest distinct spots, in this
  // composition's air hue — both fields get real numbers
  _drawWindKnots(ctx) {
    if (!this._knotTop || !this._knotTop.length) {
      // ONLY candidates inside the visible window (the padded canvas
      // margins swallowed every label until 2026-07-26), clear of the UI
      // cards, and DIFFERENT from each other: on a uniform day one number
      // says it all — printing '14 kn' three times is noise, so an extra
      // label must disagree by 2 kn to earn its ink
      const vb = layerViewBox(this);
      const ex = uiExclusions(this);
      const picked = [];
      for (const c2 of [...this._cells].sort((a2, b2) => b2.kn - a2.kn)) {
        if (picked.length >= 3) break;
        if (c2.x < vb[0] + 46 || c2.x > vb[2] - 66 || c2.y < vb[1] + 76 || c2.y > vb[3] - 46) continue;
        if (inExclusion(ex, c2.x, c2.y - 12)) continue;
        // never overprint a current label: both pickers chase open water
        if ((S._curKnotRects || []).some((r2) => c2.x > r2[0] - 20 && c2.x < r2[2] + 20 && c2.y - 12 > r2[1] - 16 && c2.y - 12 < r2[3] + 16)) continue;
        if (picked.some((o2) => Math.hypot(o2.x - c2.x, o2.y - c2.y) < 170)) continue;
        if (picked.some((o2) => Math.abs(Math.round(o2.kn) - Math.round(c2.kn)) < 2)) continue;
        picked.push(c2);
      }
      this._knotTop = picked;
    }
    ctx.setLineDash([]);
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const c2 of this._knotTop) {
      const lbl = Math.round(c2.kn) + ' kn';
      const [ink, halo] = this._wKnotInk(c2.kn);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = halo;
      ctx.strokeText(lbl, c2.x, c2.y - 12);
      ctx.fillStyle = ink;
      ctx.fillText(lbl, c2.x, c2.y - 12);
    }
  },
});

// fallback if WebGL is unavailable: water as particles (blue ramp)
const WATER_FLOW = {
  pane: 'waterPane',
  ready: () => waterReady,
  sample: sampleWater,
  style: (kn) => {
    const c = rampLookup(WATER_RAMP, kn);
    return [`rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.min(0.9, c[3] + 0.1).toFixed(2)})`, clamp(1.7 + kn * 0.35, 1.7, 2.9)];
  },
  minSpd: 0.1, fade: 0.038, maxAge: 170,
  pxBase: 5, pxPerKn: 15, pxMax: 85,
  density: 2300, minCount: 300, maxCount: 1000,
  staticLen: 8, staticStep: 52,
};

/* One mutually-exclusive chart palette mask: every sampled map pixel is
   either lime land or azure water. Drawing both colors in this same canvas
   prevents a uniform land wash from contaminating the ocean color. */
const ChartPaletteLayer = L.Layer.extend({
  onAdd(m) {
    this._map = m;
    const c = this._canvas = document.createElement('canvas');
    c.className = 'flow-canvas chart-tint-canvas';
    m.getPane('chartTintPane').appendChild(c);
    this._ctx = c.getContext('2d');
    this._onMoveEnd = () => this._reset();
    m.on('moveend zoomend resize', this._onMoveEnd);
    this._reset();
  },
  onRemove(m) {
    m.off('moveend zoomend resize', this._onMoveEnd);
    releaseCanvasZoom(this, m);
    this._canvas.remove();
  },
  setVisible(on) {
    this._visible = !!on;
    if (this._canvas) this._canvas.style.display = this._visible ? '' : 'none';
    if (this._visible && this._map) this._reset();
  },
  redraw() { if (this._map && this._visible !== false) this._reset(); },
  _reset() {
    const r = padReset(this, this._map, 1);
    if (!r) return;
    this._visible = this._visible !== false;
    this._canvas.style.display = this._visible ? '' : 'none';
    if (!this._visible) return;
    const ctx = this._ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    // Until the core geography arrives, transparent is honest and cheaper;
    // treating every pixel as water produced a conspicuous blue flash.
    if (!GEO) return;

    // Four CSS pixels per mask sample keeps redraws light; smooth scaling
    // gives the shoreline a clean antialiased edge.
    const step = 4;
    const sw = Math.ceil(this._w / step), sh = Math.ceil(this._h / step);
    const off = this._maskCanvas || (this._maskCanvas = document.createElement('canvas'));
    off.width = sw; off.height = sh;
    const ox = off.getContext('2d');
    const img = ox.createImageData(sw, sh), d = img.data;
    for (let y = 0; y < sh; y++) {
      const fy = Math.min(1, ((y + 0.5) * step) / this._h);
      const lat = this._nw.lat + (this._se.lat - this._nw.lat) * fy;
      const my0 = mercY(lat);
      for (let x = 0; x < sw; x++) {
        const fx = Math.min(1, ((x + 0.5) * step) / this._w);
        const lng = this._nw.lng + (this._se.lng - this._nw.lng) * fx;
        const q = (y * sw + x) * 4;
        if (isWaterAtMerc(my0, lng)) {
          d[q] = 0; d[q + 1] = 127; d[q + 2] = 255;
        } else {
          d[q] = 167; d[q + 1] = 201; d[q + 2] = 87;
        }
        d[q + 3] = 128; // requested diagnostic: 50% opacity
      }
    }
    ox.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, sw, sh, 0, 0, this._canvas.width, this._canvas.height);
  },
});

/* ------------------------------ map ------------------------------ */

let map, userMovedMap = false, hashHours = 0;
// The official chart is the production default; an explicit user toggle is
// remembered under a fresh key so legacy non-chart experiments cannot win.
let encOn = true;
try {
  const savedChart = localStorage.getItem('whChart5');
  encOn = savedChart == null ? true : savedChart === '1';
} catch (e) {}
let chartLayer = null;
let waterLayer = null, waterGL = null, curArrows = null, windArrows = null, chartTintLayer = null;
const curMarkers = [];

function initMap() {
  map = L.map('map', {
    zoomControl: false, attributionControl: false,
    minZoom: 10.5, maxZoom: 17, zoomSnap: 0.25,
    maxBounds: MAX_BOUNDS, maxBoundsViscosity: 1.0,
    // no animated zoom: every zoom (double-tap, wheel, slider commit) snaps
    // in a single frame so tiles, water, and arrows can never desync
    zoomAnimation: false,
    // Phones expose intermediate pinch frames. Avoid tile cross-fades and
    // elastic limit frames, which make coastlines look like stacked shadows.
    fadeAnimation: !MOBILE_MAP,
    markerZoomAnimation: !MOBILE_MAP,
    bounceAtZoomLimits: false,
  });
  map.on('moveend', () => { try { updateWaveLegend(); } catch (e) {} });
  // the view must never dwarf the data: on any window size, minimum zoom is
  // exactly "the full bounds fill the frame" — every visible pixel is baked
  const fitMin = () => {
    const z = Math.max(9.5, map.getBoundsZoom(L.latLngBounds(MAX_BOUNDS), true));
    map.setMinZoom(z);
    if (map.getZoom() < z) map.setZoom(z, { animate: false });
  };
  map.on('resize', fitMin);
  fitMin();
  map.createPane('encPane');    map.getPane('encPane').style.zIndex = 250;
  map.createPane('chartTintPane');
  map.getPane('chartTintPane').style.zIndex = 330;
  map.getPane('chartTintPane').style.pointerEvents = 'none';
  map.getPane('chartTintPane').style.width = '100%';
  map.getPane('chartTintPane').style.height = '100%';
  map.createPane('waterPane');  map.getPane('waterPane').style.zIndex = 340;
  map.getPane('waterPane').style.pointerEvents = 'none';
  map.createPane('windPane');   map.getPane('windPane').style.zIndex = 380;
  map.getPane('windPane').style.pointerEvents = 'none';

  chartTintLayer = new ChartPaletteLayer();
  map.addLayer(chartTintLayer);

  // No basemap: land is a flat paper tone (CSS background) and the rendered
  // water (from the baked geography) defines the shoreline. The ⚓ chart
  // supplies official detail on demand.

  // Place names are OFF for now (Bezia, 2026-07-22): the Carto label tiles
  // put names in wrong or cluttered spots. A proper self-made label pass
  // comes with the basemap redesign.

  // the chart pyramid is our own vector rendering (tools/bake_chart.py, from
  // fetched ENC GeoJSON) — static files, so chart view costs nothing live.
  // Two layers: the outer ring tops out at z14; the core has native z16.
  // Phones keep only one off-screen tile ring and fetch after the gesture.
  // The previous ten-ring buffer could request most of the chart pyramid on
  // first paint and also replaced tiles visibly throughout a live pinch.
  const chartTilePerf = {
    keepBuffer: MOBILE_MAP ? 1 : 4,
    updateWhenIdle: MOBILE_MAP,
    // Leaflet otherwise leaves the previous tile zoom frozen through a
    // phone pinch while our canvas overlays keep moving. Keep both parts of
    // the chart on the same continuously changing transform.
    updateWhenZooming: true,
  };
  const chartOuter = L.tileLayer('data/chart/{z}/{x}/{y}.png?v=7', {
    pane: 'encPane', minNativeZoom: 11, maxNativeZoom: 14,
    minZoom: 9, maxZoom: 17, noWrap: true, ...chartTilePerf,
    bounds: L.latLngBounds(MAX_BOUNDS),
  });
  const chartCore = L.tileLayer('data/chart/{z}/{x}/{y}.png?v=7', {
    pane: 'encPane', minNativeZoom: 13, maxNativeZoom: 16,
    // Below 14.5 the core and outer layers request the same z13/z14 images;
    // drawing both only doubles DOM/decode work with identical pixels.
    minZoom: 14.5, maxZoom: 17, noWrap: true, ...chartTilePerf,
    bounds: L.latLngBounds([[41.455, -70.780], [41.585, -70.575]]),
  });
  chartLayer = L.layerGroup([chartOuter, chartCore]);

  let programmaticMove = false, refitT = null;
  const refit = () => {
    map.invalidateSize({ animate: false });
    const sz = map.getSize();
    if (sz.x < 50 || sz.y < 50) {
      clearTimeout(refitT);
      refitT = setTimeout(refit, 250);
      return;
    }
    programmaticMove = true;
    map.fitBounds(FIT_BOUNDS);
    // wide windows are height-constrained by fitBounds and show far more sea
    // than Woods Hole — tighten so the box fills most of the width instead
    const b = map.getBounds();
    const spanV = b.getEast() - b.getWest();
    const spanB = FIT_BOUNDS[1][1] - FIT_BOUNDS[0][1];
    if (spanV > 1.6 * spanB) {
      map.setZoom(map.getZoom() + Math.log2(spanV / (1.35 * spanB)), { animate: false });
    }
    setTimeout(() => { programmaticMove = false; }, 900);
  };
  map.on('dragstart zoomstart', () => { if (!programmaticMove) userMovedMap = true; });
  // deep link: #lat,lng,zoom[,+hours] jumps to a spot (and a scrub time) —
  // handy for sharing exactly what you're seeing
  const hm = location.hash.match(/^#(-?\d+\.?\d*),(-?\d+\.?\d*),(\d+\.?\d*)(?:,(-?\d+\.?\d*))?$/);
  if (hm) {
    userMovedMap = true;
    map.setView([+hm[1], +hm[2]], +hm[3]);
    if (hm[4]) hashHours = parseFloat(hm[4]) || 0;
  } else if (matchMedia('(pointer: coarse)').matches) {
    // a phone starts on the water that matters: the Hole and Great Harbor
    map.setView([41.5195, -70.6745], 13.6, { animate: false });
    setTimeout(() => { if (!userMovedMap) map.setView([41.5195, -70.6745], 13.6, { animate: false }); }, 80);
  } else {
    refit();
    setTimeout(() => { if (!userMovedMap) refit(); }, 80);
  }
  window.addEventListener('resize', debounce(() => { if (!userMovedMap) refit(); else map.invalidateSize(); }, 200));
  $('btn-home').addEventListener('click', () => {
    userMovedMap = false;
    // reset means a clean slate: the planned route goes too (undoable —
    // re-enter plan mode and tap undo if the reset was a slip)
    planClear();
    refit();
  });
  // page opened in a background tab: the container has no size, so the map
  // can't take its first view until the tab is shown — recover immediately
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !map._loaded && !userMovedMap) refit();
  });

  // tide station marker
  const tideIcon = L.divIcon({ className: 'tide-marker', html: '<div class="ring"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
  L.marker([41.5236, -70.6711], { icon: tideIcon, keyboard: false })
    .addTo(map)
    .bindPopup(() => tidePopupHTML());

  // wind observation stations, tappable like the tide station
  buildWindMarkers();

  // water: WebGL texture, or particles when WebGL is unavailable. onAdd is
  // deferred until the map takes its first view (background-tab boot), so the
  // failure path runs a callback rather than a synchronous check here
  waterGL = new GLWater();
  waterGL._onDead = () => {
    if (waterLayer) return;
    map.removeLayer(waterGL);
    waterGL = null;
    waterLayer = new FlowLayer(WATER_FLOW);
    map.addLayer(waterLayer);
  };
  map.addLayer(waterGL);
  if (waterGL && waterGL._dead) waterGL._onDead();
  curArrows = new ArrowLayer(CURRENT_ARROWS);
  map.addLayer(curArrows);
  windArrows = new WindStreaks();
  map.addLayer(windArrows);
}

function debounce(fn, ms) { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; }

// Landmark name labels removed at Bezia's request (2026-07-22) until the
// basemap redesign: data/landmarks.json and tools/bake_landmarks.py remain
// for that future pass.

function toggleChart() {
  encOn = !encOn;
  try { localStorage.setItem('whChart5', encOn ? '1' : '0'); } catch (e) {}
  applyChart();
}

function applyChart() {
  $('btn-chart').setAttribute('aria-pressed', String(encOn));
  if (chartTintLayer) chartTintLayer.setVisible(encOn);
  if (chartLayer) {
    if (encOn) chartLayer.addTo(map);
    else map.removeLayer(chartLayer);
  }
  // with the chart under it, the water becomes a single-color translucent
  // overlay drawn IN the shader (uChart) — bands and soundings read through
  // the tint while waves and whitecaps stay visible
  if (waterGL) {
    waterGL._chartMode = encOn;
    if (waterGL._canvas) waterGL._canvas.style.opacity = 1;
  } else if (waterLayer && waterLayer._canvas) {
    waterLayer._canvas.style.opacity = encOn ? 0 : 1;
  }
  try { updateBuoyVis(); } catch (e) {}
  if (curArrows && curArrows._canvas) curArrows._canvas.style.opacity = 1;
  if (windArrows && windArrows._canvas) windArrows._canvas.style.opacity = 1;
  // vec3's fill bakes the chart-mode alpha into its pixels: rebuild
  if (VEC === '3' && curArrows) try { curArrows.redraw(); } catch (e) {}
}

/* --------- current-station markers (subtle dots; the flow itself shows the current) --------- */

// idempotent: adds markers for new stations, re-points existing popups at the
// fresh station objects (loadCurrents replaces S.currents wholesale on recovery)
function buildCurrentMarkers() {
  for (const st of S.currents) {
    const cm = curMarkers.find((c2) => c2.st.cfg.id === st.cfg.id);
    if (cm) {
      if (cm.st !== st) { cm.st = st; cm.m.unbindPopup().bindPopup(() => currentPopupHTML(st), { maxWidth: 260 }); }
      continue;
    }
    const icon = L.divIcon({ className: 'sta-dot-wrap', html: '<div class="sta-dot"></div>', iconSize: [24, 24], iconAnchor: [12, 12] });
    const m = L.marker([st.cfg.lat, st.cfg.lng], { icon, keyboard: false }).addTo(map);
    m.bindPopup(() => currentPopupHTML(st), { maxWidth: 260 });
    curMarkers.push({ st, m });
  }
}

function fmtEv(e) {
  const type = e.type === 'slack' ? 'Slack' : (e.v >= 0 ? 'Flood' : 'Ebb');
  const cls = e.type === 'slack' ? '' : (e.v >= 0 ? 'ev-flood' : 'ev-ebb');
  const kn = e.type === 'slack' ? '' : ` ${Math.abs(e.v).toFixed(1)} kn`;
  return `<tr><td class="${cls}">${type}${kn}</td><td>${fmtDW.format(e.t)} ${fmtT.format(e.t)}</td></tr>`;
}

function currentPopupHTML(st) {
  const v = stationV(st, S.tScrub);
  const state = Math.abs(v) < 0.15 ? 'slack' : (v >= 0 ? `flooding ${Math.abs(v).toFixed(1)} kn → ${compass(st.floodDir)}` : `ebbing ${Math.abs(v).toFixed(1)} kn → ${compass(st.ebbDir)}`);
  let evs = st.events;
  if ((!evs || !evs.length) && st.series) evs = seriesEvents(st.series.times, st.series.vals);
  if ((!evs || !evs.length) && HARM && HARM[st.cfg.id]) {
    const ts = [], vs = [];
    for (let hh = -6; hh <= 30; hh += 0.5) { const tt = S.tScrub + hh * 3600e3; ts.push(tt); vs.push(stationV(st, tt)); }
    evs = seriesEvents(ts, vs);
  }
  const next = (evs || []).filter(e => e.t > S.tScrub - 30 * 60e3).slice(0, 5);
  return `<b class="pname">${st.cfg.name}</b><br>${timeWord()}: <b>${state}</b>
    <table>${next.map(fmtEv).join('')}</table>`;
}

function seriesEvents(times, vals) {
  const ev = [];
  for (let k = 1; k < times.length - 1; k++) {
    const a = vals[k - 1], b = vals[k], c = vals[k + 1];
    if ((a <= 0 && b > 0) || (a >= 0 && b < 0)) {
      const f = Math.abs(a) / (Math.abs(a) + Math.abs(b) || 1);
      ev.push({ t: times[k - 1] + f * (times[k] - times[k - 1]), v: 0, type: 'slack' });
    }
    if ((b > a && b >= c && b > 0.2) || (b < a && b <= c && b < -0.2)) ev.push({ t: times[k], v: b, type: 'max' });
  }
  return ev;
}

/* --------- wind-observation markers (tap a station for its live reading) ---------
   The map's own claim at the station is shown beside the measurement — every
   station is a standing test of the wind field, in public. */

const WIND_MARK_STATIONS = [
  { id: 'KMAWOODS477', name: 'Woods Hole Yacht Club', lat: 41.52745, lng: -70.67577, src: 'whyc', by: 'Weather Underground PWS · pinned exactly' },
  { id: 'tempest81687', name: 'Gansett Rd', lat: 41.53953, lng: -70.66666, src: 'tempest', by: 'Tempest · near-marine SW exposure' },
  { id: 'tempest23779', name: 'Mill Pond', lat: 41.52765, lng: -70.67119, src: 'tempest', by: 'Tempest · village siting' },
  { id: 'BUZM3', name: 'Buzzards Bay tower', lat: 41.396, lng: -71.033, src: 'nws', by: 'NDBC · anemometer 24.8 m · regional constraint' },
  { id: 'KFMH', name: 'Otis / Joint Base Cape Cod', lat: 41.658, lng: -70.521, src: 'nws', by: 'NWS METAR · display only' },
  { id: 'KMVY', name: "Martha's Vineyard airport", lat: 41.393, lng: -70.615, src: 'nws', by: 'NWS METAR · display only' },
  { id: 'KEWB', name: 'New Bedford airport', lat: 41.676, lng: -70.957, src: 'nws', by: 'NWS METAR · display only' },
];
const windMk = {};

function buildWindMarkers() {
  const icon = L.divIcon({ className: 'wind-marker', html: '<div class="vane"></div>', iconSize: [24, 24], iconAnchor: [12, 12] });
  for (const ws of WIND_MARK_STATIONS) {
    // A private Tempest station has no useful public marker unless this
    // browser actually has a reading for it. Never put dead/token-only
    // instrumentation on the public map.
    const available = ws.src !== 'tempest' || !!windObsOf(ws);
    if (!available) {
      if (windMk[ws.id]) {
        map.removeLayer(windMk[ws.id]);
        delete windMk[ws.id];
      }
      continue;
    }
    if (windMk[ws.id]) continue;
    const m = L.marker([ws.lat, ws.lng], { icon, keyboard: false }).addTo(map);
    m.bindPopup(() => windPopupHTML(ws), { maxWidth: 250 });
    windMk[ws.id] = m;
  }
}

function windObsOf(ws) {
  if (ws.src === 'whyc') {
    return S.whyc ? { kn: S.whyc.spd, gst: S.whyc.gst, dir: S.whyc.dir, t: S.whyc.t } : null;
  }
  if (ws.src === 'tempest') {
    const o = (S.exactObs || []).find((r) => r.st.id === ws.id);
    if (o) return { kn: o.kn, gst: null, dir: o.dir, t: o.t };
    return null;
  }
  const row = (S.windObs || []).find((r) => r.st.id === ws.id);
  if (!row || !row.p) return null;
  const p = row.p;
  return {
    kn: p.windSpeed && p.windSpeed.value != null ? p.windSpeed.value * 0.539957 : null,
    gst: p.windGust && p.windGust.value != null ? p.windGust.value * 0.539957 : null,
    dir: p.windDirection ? p.windDirection.value : null,
    t: p.timestamp ? Date.parse(p.timestamp) : null,
  };
}

function windPopupHTML(ws) {
  const o = windObsOf(ws);
  const pos = windMk[ws.id] ? windMk[ws.id].getLatLng() : ws;
  let meas;
  if (o && o.kn != null) {
    const ageMin = o.t ? Math.max(0, Math.round((Date.now() - o.t) / 60e3)) : null;
    meas = `measured: <b>${o.dir != null ? compass(o.dir) + ' ' : ''}${o.kn.toFixed(0)} kn</b>`
      + (o.gst != null ? `, gusts ${o.gst.toFixed(0)}` : '')
      + (ageMin != null ? ` <small>· ${ageMin < 90 ? ageMin + ' min ago' : Math.round(ageMin / 60) + ' h ago'}</small>` : '');
  } else {
    meas = '<small>not reporting wind right now</small>';
  }
  const m = sampleWind(pos.lat, pos.lng, S.tScrub);
  const mkn = Math.hypot(m[0], m[1]);
  const mdir = (Math.atan2(-m[0], -m[1]) * 180 / Math.PI + 360) % 360;
  return `<b class="pname">${ws.name}</b><br>${meas}
    <br>map here ${timeWord()}: <b>${compass(mdir)} ${mkn.toFixed(0)} kn</b>`;
}

function tidePopupHTML() {
  const rows = S.hilo.filter(h => h.t > S.tScrub - 30 * 60e3).slice(0, 4)
    .map(h => `<tr><td class="${h.type === 'H' ? 'ev-flood' : 'ev-ebb'}">${h.type === 'H' ? 'High' : 'Low'} ${h.v.toFixed(1)} ft</td><td>${fmtDW.format(h.t)} ${fmtT.format(h.t)}</td></tr>`).join('');
  const obs = (S.obs.wl != null) ? `<br>observed now: <b>${S.obs.wl.toFixed(2)} ft</b> MLLW` : '';
  // the page grades itself: forecast vs the gauge over the last day
  setTimeout(fillTideTrust, 30);
  return `<b class="pname">NOAA ${TIDE_STATION} · WHOI dock</b>${obs}<table>${rows}</table>`
    + `<div id="tide-trust"><small>scoring the last 24 h…</small></div><small>heights above MLLW</small>`;
}

async function fillTideTrust() {
  const el = document.getElementById('tide-trust');
  if (!el) return;
  try {
    if (!S._tideTrust || Date.now() - S._tideTrust.at > 30 * 60e3) {
      // rolling 24 h of 6-minute gauge readings ('today' is GMT and can be
      // minutes old); bias and scatter reported SEPARATELY — a uniform
      // offset is weather riding on the astronomy, not model error
      const b0 = new Date(Date.now() - 24 * 3600e3);
      const pad2 = (x2) => String(x2).padStart(2, '0');
      const begin = `${b0.getUTCFullYear()}${pad2(b0.getUTCMonth() + 1)}${pad2(b0.getUTCDate())} ${pad2(b0.getUTCHours())}:${pad2(b0.getUTCMinutes())}`;
      const d = await fetchJSON(coopsURL({
        product: 'water_level', datum: 'MLLW', station: TIDE_STATION, begin_date: begin, range: 24,
      }), 10 * 60e3);
      const errs = [];
      for (const p of d.data || []) {
        const tt = parseGmt(p.t), ov = +p.v;
        if (!isFinite(ov)) continue;
        let best = null;
        for (let i = 0; i < S.tide.times.length; i++) {
          if (best === null || Math.abs(S.tide.times[i] - tt) < Math.abs(S.tide.times[best] - tt)) best = i;
        }
        if (best === null || Math.abs(S.tide.times[best] - tt) > 30 * 60e3) continue;
        errs.push(ov - S.tide.vals[best]);
      }
      if (!errs.length) throw new Error('no overlap');
      const bias = errs.reduce((a2, b2) => a2 + b2, 0) / errs.length;
      const sc = Math.sqrt(errs.reduce((a2, e2) => a2 + (e2 - bias) * (e2 - bias), 0) / errs.length);
      S._tideTrust = { at: Date.now(), bias, sc, n: errs.length };
    }
    const T2 = S._tideTrust;
    const biasTxt = Math.abs(T2.bias) < 0.08 ? 'on the astronomical prediction'
      : `${Math.abs(T2.bias).toFixed(2)} ft ${T2.bias > 0 ? 'above' : 'below'} prediction (weather)`;
    el.innerHTML = `<small>gauge, last 24 h: ${biasTxt} · scatter ${T2.sc.toFixed(2)} ft (${T2.n} readings)</small>`;
  } catch (e) {
    el.innerHTML = '<small>gauge history unavailable</small>';
  }
}

function timeWord() {
  return S.live ? 'now' : fmtDW.format(S.tScrub) + ' ' + fmtT.format(S.tScrub);
}

/* ------------------------------ legend ------------------------------
   Autoscaled to the 72-hour window: the bar spans 0 → this window's max,
   cropping the fixed physical ramp so colors stay comparable day to day. */

function fillLegend() {
  if (VEC !== '0') {
    // the legend is trivial: bars and glyph samples with numbers, no
    // prose. Each column shows the composition's OWN encoding — a color
    // ramp where color is the channel, sized samples where size is, line
    // spacing where density is, real barb and sock glyphs where those are.
    const vk = document.getElementById('veckey');
    if (vk) vk.remove();
    $('legend').style.display = '';
    const curBot = $('lg-tog-cur').querySelector('.lg-bot');
    const windBot = $('lg-tog-wind').querySelector('.lg-bot');
    $('lg-cur-max').textContent = '4+';
    curBot.textContent = '0';
    const grad = (cm) => {
      let out = '';
      for (let k = 0; k <= 8; k++) out += `<stop offset="${Math.round(k / 8 * 100)}%" stop-color="rgb(${cmapAt(cm, k / 8)})"/>`;
      return out;
    };
    const bar = (cm, chip) => `<defs><linearGradient id="lgc" x1="0" y1="1" x2="0" y2="0">${grad(cm)}</linearGradient></defs>`
      + (chip ? `<rect x="3" y="0" width="20" height="96" rx="6" fill="${chip}"/>` : '')
      + `<rect x="5" y="2" width="16" height="92" rx="5" fill="url(#lgc)"/>`;
    // current column
    if (VEC === '1') $('lg-cur').innerHTML = bar(WATER_CMAP);
    else if (VEC === '2') {
      const a2 = (cy, f) => {
        const len = 4 + f * 22, w2 = 1.1 + 3.6 * f, hs2 = 4 + 3.6 * f;
        const yTop = cy - len / 2;
        return `<line x1="13" y1="${(cy + len / 2).toFixed(1)}" x2="13" y2="${yTop.toFixed(1)}" stroke="#fff" stroke-width="${(w2 + 2.4).toFixed(1)}" stroke-linecap="round"/>`
          + `<line x1="13" y1="${(cy + len / 2).toFixed(1)}" x2="13" y2="${yTop.toFixed(1)}" stroke="rgba(15,15,15,0.95)" stroke-width="${w2.toFixed(1)}" stroke-dasharray="9 8" stroke-linecap="round"/>`
          + `<path d="M13 ${(yTop - hs2 * 1.5 - 2.2).toFixed(1)} L${(13 - hs2 * 0.62 - 1.6).toFixed(1)} ${yTop.toFixed(1)} L${(13 + hs2 * 0.62 + 1.6).toFixed(1)} ${yTop.toFixed(1)} Z" fill="rgba(255,255,255,0.85)"/>`
          + `<path d="M13 ${(yTop - hs2 * 1.5).toFixed(1)} L${(13 - hs2 * 0.62).toFixed(1)} ${yTop.toFixed(1)} L${(13 + hs2 * 0.62).toFixed(1)} ${yTop.toFixed(1)} Z" fill="rgba(15,15,15,0.95)"/>`;
      };
      $('lg-cur').innerHTML = a2(22, 1) + a2(54, 0.5) + a2(84, 0.15);
    } else if (VEC === '3') $('lg-cur').innerHTML = bar(CM.viridis);
    else if (VEC === '4') $('lg-cur').innerHTML = bar(WATER_CMAP);
    else if (VEC === '5') {
      // dashed stroke samples at the engraving's OWN widths (width =
      // speed now; the retired density swatches lied about the law)
      const e5 = (cy, f) => `<line x1="4" y1="${cy}" x2="22" y2="${cy}" stroke="rgba(12,11,8,0.92)" stroke-width="${(0.6 + 3.2 * f).toFixed(1)}" stroke-dasharray="8 6" stroke-linecap="round"/>`;
      $('lg-cur').innerHTML = e5(16, 1) + e5(50, 0.5) + e5(82, 0.12);
    } else if (VEC === '6') {
      // the bar plus the exact cased silk arrows _grainChevrons draws:
      // every mark type on the map is priced here
      let g6 = bar(CM.silk);
      for (const [cy, f] of [[18, 1], [50, 0.5], [82, 0.15]]) {
        const L2 = (9 + 15 * f) * 0.9, hs2 = 3.6 + 3 * f;
        g6 += `<line x1="13" y1="${(cy + L2 / 2).toFixed(1)}" x2="13" y2="${(cy - L2 / 2).toFixed(1)}" stroke="rgba(255,255,255,0.85)" stroke-width="5.2" stroke-linecap="round"/>`
          + `<line x1="13" y1="${(cy + L2 / 2).toFixed(1)}" x2="13" y2="${(cy - L2 / 2).toFixed(1)}" stroke="${vCol('silk', f, 0.95)}" stroke-width="1.8" stroke-linecap="round"/>`
          + `<path d="M13 ${(cy - L2 / 2 - hs2).toFixed(1)} L${(13 - hs2 * 0.62).toFixed(1)} ${(cy - L2 / 2).toFixed(1)} L${(13 + hs2 * 0.62).toFixed(1)} ${(cy - L2 / 2).toFixed(1)} Z" fill="${vCol('silk', f, 0.95)}"/>`;
      }
      $('lg-cur').innerHTML = g6;
    }
    else if (VEC === '7') {
      // two dotted tracks at the LIVE gap law (S._mGap4 px per 4 kn at
      // this zoom): the composition's own spatial channel, priced
      const g4 = clamp(S._mGap4 || 34, 10, 88);
      let g7 = `<text x="8" y="8" text-anchor="middle" font-size="8" font-weight="700" fill="#33475c">4</text>`
        + `<text x="18" y="8" text-anchor="middle" font-size="8" font-weight="700" fill="#33475c">1</text>`;
      for (const [x2, kn2] of [[8, 4], [18, 1]]) {
        const gap = g4 * kn2 / 4;
        for (let yy = 14; yy <= 92; yy += gap) {
          g7 += `<circle cx="${x2}" cy="${yy.toFixed(1)}" r="${kn2 === 4 ? 2.4 : 1.8}" fill="${curCol(kn2, 0.92)}" stroke="rgba(28,47,74,0.9)" stroke-width="0.8"/>`;
        }
      }
      $('lg-cur').innerHTML = g7;
    } else $('lg-cur').innerHTML = bar(WATER_CMAP);
    // wind column
    const lw = $('lg-wind');
    lw.innerHTML = '';
    lw.style.background = 'none';
    $('lg-wind-max').textContent = '20+';
    windBot.textContent = '0';
    const flat = (cm) => `linear-gradient(to top, ${[0, 1, 2, 3, 4]
      .map((k) => `rgb(${cmapAt(cm, k / 4)}) ${k * 20}% ${(k + 1) * 20}%`).join(', ')})`;
    if (VEC === '7') {
      $('lg-wind-max').textContent = '15+';
      windBot.textContent = '0';
      // the SHIPPED sock law: L = 7+21kf, widths 4.6->1.6, slate unfilled,
      // white silhouette casing, cased tip arrow — and a 0-stripe calm rung
      const sockG = (cy, kn) => {
        const kf = Math.min(1, kn / 20), L2 = (7 + 21 * kf) * 0.82, filled = Math.min(5, Math.floor(kn / 3));
        let s2 = `<polygon points="${(13 - 4.6).toFixed(1)},${(cy + 9).toFixed(1)} ${(13 + 4.6).toFixed(1)},${(cy + 9).toFixed(1)} ${(13 + 1.6).toFixed(1)},${(cy + 9 - L2).toFixed(1)} ${(13 - 1.6).toFixed(1)},${(cy + 9 - L2).toFixed(1)}" fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="2.6"/>`;
        for (let k = 0; k < 5; k++) {
          const t0 = k / 5, t1 = (k + 1) / 5;
          const wa = 4.6 - 3 * t0, wb = 4.6 - 3 * t1;
          s2 += `<polygon points="${(13 - wa).toFixed(1)},${(cy + 9 - L2 * t0).toFixed(1)} ${(13 + wa).toFixed(1)},${(cy + 9 - L2 * t0).toFixed(1)} ${(13 + wb).toFixed(1)},${(cy + 9 - L2 * t1).toFixed(1)} ${(13 - wb).toFixed(1)},${(cy + 9 - L2 * t1).toFixed(1)}"`
            + ` fill="${k < filled ? (k % 2 ? '#fff' : 'rgb(226,88,22)') : 'rgba(128,142,158,0.75)'}" stroke="rgba(28,47,74,0.9)" stroke-width="0.8"/>`;
        }
        const ty = cy + 9 - L2 - 2;
        s2 += `<path d="M13 ${(ty - 7.8).toFixed(1)} L${(13 - 4.3).toFixed(1)} ${ty.toFixed(1)} L${(13 + 4.3).toFixed(1)} ${ty.toFixed(1)} Z" fill="rgba(255,255,255,0.9)"/>`
          + `<path d="M13 ${(ty - 5.9).toFixed(1)} L${(13 - 3.2).toFixed(1)} ${ty.toFixed(1)} L${(13 + 3.2).toFixed(1)} ${ty.toFixed(1)} Z" fill="rgba(28,47,74,0.95)"/>`;
        return s2 + `<circle cx="13" cy="${cy + 10}" r="1.6" fill="rgb(28,47,74)"/>`;
      };
      lw.innerHTML = `<svg width="26" height="96" viewBox="0 0 26 96">${sockG(14, 15)}${sockG(48, 6)}${sockG(80, 0)}</svg>`;
    } else if (VEC === '1' || VEC === '5') {
      // the FULL shipped size law, no scaling: these samples ARE the
      // price list for a size-coded ink (two samples fit true-size)
      $('lg-wind-max').textContent = '25';
      windBot.textContent = '4';
      const inkL = VEC === '5' ? 'rgb(211,116,32)' : 'rgb(8,8,8)';
      const aw = (cy, kn) => {
        const kf = Math.min(1, kn / 25), L2 = 9 + 31 * kf, w2 = 1.6 + 2.2 * kf, hh = 4 + 0.32 * L2;
        const yB = cy + L2 / 2, yT = cy - L2 / 2;
        return `<line x1="13" y1="${yB.toFixed(1)}" x2="13" y2="${yT.toFixed(1)}" stroke="rgba(255,255,255,0.88)" stroke-width="${(w2 + 2.8).toFixed(1)}" stroke-linecap="round"/>`
          + `<line x1="13" y1="${yB.toFixed(1)}" x2="13" y2="${yT.toFixed(1)}" stroke="${inkL}" stroke-width="${w2.toFixed(1)}" stroke-linecap="round"/>`
          + `<path d="M13 ${(yT - hh - 1.8).toFixed(1)} L${(13 - hh * 0.4 - 1.4).toFixed(1)} ${yT.toFixed(1)} L${(13 + hh * 0.4 + 1.4).toFixed(1)} ${yT.toFixed(1)} Z" fill="rgba(255,255,255,0.88)"/>`
          + `<path d="M13 ${(yT - hh).toFixed(1)} L${(13 - hh * 0.4).toFixed(1)} ${yT.toFixed(1)} L${(13 + hh * 0.4).toFixed(1)} ${yT.toFixed(1)} Z" fill="${inkL}"/>`;
      };
      lw.innerHTML = `<svg width="26" height="96" viewBox="0 0 26 96">${aw(38, 25)}${aw(82, 4)}</svg>`;
    } else if (VEC === '3') {
      $('lg-wind-max').textContent = '25';
      windBot.textContent = '0';
      // feathers rake TOWARD THE TAIL like the map's, cased like the
      // map's, a digit beside every glyph, and the calm ring priced
      const barbG = (cy, kn) => {
        let s2 = '';
        const seg = (x1, y1, x2, y2) =>
          `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(255,255,255,0.9)" stroke-width="4" stroke-linecap="round"/>`
          + `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgb(28,47,74)" stroke-width="1.9" stroke-linecap="round"/>`;
        s2 += seg(15, cy + 12, 15, cy - 11);
        let rem = kn, o = cy + 12;
        while (rem >= 10) { s2 += seg(15, o, 5.5, o + 4.5); o -= 5; rem -= 10; }
        if (rem >= 5) s2 += seg(15, o, 9, o + 3);
        s2 += `<path d="M15 ${cy - 15.5} L11.8 ${cy - 9} L18.2 ${cy - 9} Z" fill="rgb(28,47,74)"/>`;
        return s2;
      };
      const ring = (cy) => `<circle cx="15" cy="${cy}" r="4.2" fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="4.6"/><circle cx="15" cy="${cy}" r="4.2" fill="none" stroke="rgb(28,47,74)" stroke-width="2.1"/>`;
      lw.innerHTML = `<svg width="26" height="96" viewBox="0 0 26 96">${barbG(14, 25)}${barbG(44, 15)}${barbG(70, 5)}${ring(89)}</svg>`;
    } else if (VEC === '6') {
      // the kite itself, at three priced sizes, by _wWedges' geometry
      $('lg-wind-max').textContent = '25';
      windBot.textContent = '4';
      const kite = (cy, kn) => {
        const kf = Math.min(1, kn / 25), L2 = 9 + 20 * kf, w2 = 3.5 + 2.8 * kf;
        const tip = cy - L2 * 0.6, back = cy + L2 * 0.4, notch = cy + L2 * 0.22;
        return `<polygon points="13,${tip.toFixed(1)} ${(13 - w2).toFixed(1)},${back.toFixed(1)} 13,${notch.toFixed(1)} ${(13 + w2).toFixed(1)},${back.toFixed(1)}"`
          + ` fill="rgba(${cmapAt(WIND_CMAP, kn / 25)},0.95)" stroke="rgba(20,28,38,0.85)" stroke-width="2"/>`;
      };
      lw.innerHTML = `<svg width="26" height="96" viewBox="0 0 26 96">${kite(18, 25)}${kite(50, 12)}${kite(82, 4)}</svg>`;
    } else if (VEC === '2') {
      // the quiver's own cased arrows at two true sizes
      $('lg-wind-max').textContent = '25';
      windBot.textContent = '4';
      const qa = (cy, kn) => {
        const kf25 = Math.min(1, kn / 25), L2 = 12 + 26 * kf25, w2 = 2.2 + 1.6 * Math.min(1, kn / 20), hh = 4.5 + L2 * 0.3;
        const yB = cy + L2 / 2, yT = cy - L2 / 2;
        return `<line x1="13" y1="${yB.toFixed(1)}" x2="13" y2="${yT.toFixed(1)}" stroke="rgba(20,28,38,0.85)" stroke-width="${(w2 + 2.6).toFixed(1)}" stroke-linecap="round"/>`
          + `<line x1="13" y1="${yB.toFixed(1)}" x2="13" y2="${yT.toFixed(1)}" stroke="rgb(${cmapAt(WIND_CMAP, kn / 25)})" stroke-width="${w2.toFixed(1)}" stroke-linecap="round"/>`
          + `<path d="M13 ${(yT - hh - 1.8).toFixed(1)} L${(13 - hh * 0.4 - 1.4).toFixed(1)} ${yT.toFixed(1)} L${(13 + hh * 0.4 + 1.4).toFixed(1)} ${yT.toFixed(1)} Z" fill="rgba(20,28,38,0.85)"/>`
          + `<path d="M13 ${(yT - hh).toFixed(1)} L${(13 - hh * 0.4).toFixed(1)} ${yT.toFixed(1)} L${(13 + hh * 0.4).toFixed(1)} ${yT.toFixed(1)} Z" fill="rgb(${cmapAt(WIND_CMAP, kn / 25)})"/>`;
      };
      lw.innerHTML = `<svg width="26" height="96" viewBox="0 0 26 96">${qa(36, 25)}${qa(82, 4)}</svg>`;
    } else {
      // vec4's colored lines: the ramp bar sampled AT the true stops so
      // no legend color exists that the map cannot draw
      $('lg-wind-max').textContent = '25+';
      lw.style.background = `linear-gradient(to top, ${[0, 1, 2, 3, 4, 5, 6, 7, 8]
        .map((k) => `rgb(${cmapAt(WIND_CMAP, k / 8)}) ${(k * 12.5).toFixed(1)}%`).join(', ')})`;
    }
    return;
  }
  // Current uses its physical 4 kn ceiling; wind consumes the visible range
  // with a 10 kn minimum ceiling.
  $('lg-cur-max').textContent = '4+';
  $('lg-wind-max').textContent = String(Math.round(windScaleMax));
  const stops0 = CUR3.map(([f, rgb]) => `<stop offset="${(f * 100).toFixed(0)}%" stop-color="rgb(${rgb.join(',')})"/>`).join('');
  $('lg-cur').innerHTML = `<defs><linearGradient id="lgc0" x1="0" y1="1" x2="0" y2="0">${stops0}</linearGradient></defs>`
    + '<rect x="5" y="2" width="16" height="92" rx="5" fill="url(#lgc0)"/>';
  updateWindBar0();
}

/* ------------------------------ timeline ------------------------------ */

const TL = { w: 0, h: matchMedia('(pointer: coarse)').matches ? 128 : 118, padT: 14, padB: 13, padL: 42, padR: 42, bins: [] };
let tlRetry = 0;

/* Forward-only, TWO-PANEL time model. Panel A: now (with 1 h of context)
   to +12 h, 58% of the width. Panel B: +12 h to +72 h, the rest. Both
   panels are LINEAR; the visible gap between them IS the axis break, and
   each panel carries its own tick labels. Every pixel<->time conversion
   in the app goes through tlWarp/tlUnwarp, so the scrubber, the plan band
   and the cursor share one geometry. u is the fraction of drawable width. */
const P1F = 0.58, GAPF = 0.025;
const barT0 = () => S.tNow - 3600e3;
const barSplit = () => S.tNow + 12 * 3600e3;
function tlWarp(t) {
  const t0 = barT0(), tm = barSplit();
  if (t <= tm) return P1F * clamp((t - t0) / (tm - t0), 0, 1);
  return P1F + GAPF + (1 - P1F - GAPF) * clamp((t - tm) / (S.tMax - tm), 0, 1);
}
function tlUnwarp(u) {
  const t0 = barT0(), tm = barSplit();
  u = clamp(u, 0, 1);
  if (u <= P1F) return t0 + u / P1F * (tm - t0);
  if (u < P1F + GAPF) return tm;                 // the break itself snaps to +12 h
  return tm + (u - P1F - GAPF) / (1 - P1F - GAPF) * (S.tMax - tm);
}

function resolveTimelineLabelCollisions(svg) {
  // Keep the information hierarchy deterministic at every width. Higher
  // priority text wins; a lower-priority tick or legend label disappears
  // instead of printing through it. The selected-column box is painted
  // underneath all text, so it can never obscure the values it groups.
  const priority = (el) => {
    if (el.classList.contains('cellnum')) return 100;
    if (el.classList.contains('rowname') || el.classList.contains('ytick')) return 95;
    if (el.classList.contains('hl')) return 90;
    if (el.classList.contains('now')) return 88;
    if (el.classList.contains('phdr')) return 80;
    if (el.classList.contains('avgtide-lb')) return 70;
    if (el.classList.contains('xlbl')) return 55;
    if (el.classList.contains('lgnum')) return 45;
    return 40;
  };
  const labels = [...svg.querySelectorAll('text')];
  for (const el of labels) el.style.visibility = '';
  const measured = [];
  for (let i = 0; i < labels.length; i++) {
    try {
      const b = labels[i].getBBox();
      if (b.width > 0 && b.height > 0) measured.push({ el: labels[i], i, p: priority(labels[i]), b });
    } catch (e) {}
  }
  measured.sort((a, b) => b.p - a.p || a.i - b.i);
  const kept = [];
  const overlaps = (a, b) => a.x < b.x + b.width + 3 && a.x + a.width + 3 > b.x
    && a.y < b.y + b.height + 2 && a.y + a.height + 2 > b.y;
  for (const item of measured) {
    if (kept.some((other) => overlaps(item.b, other))) item.el.style.visibility = 'hidden';
    else kept.push(item.b);
  }
}

function buildTimeline() {
  const svg = $('timeline');
  let w = svg.clientWidth || svg.parentNode.clientWidth;
  if (w < 120 && tlRetry < 120) {
    tlRetry++;
    requestAnimationFrame(buildTimeline);
    return;
  }
  tlRetry = 0;
  if (w < 120) w = 360;
  TL.w = w;
  TL.builtTMin = S.tMin;
  TL.bins = [];
  // phones get a TALLER strip: the tide curve was too squished to read
  // high/low times or heights (user)
  TL.h = window.innerWidth <= 699 ? 128 : 118; // must match the CSS #timeline height
  const phone = w <= 520;
  const h = TL.h;
  svg.style.height = h + 'px';
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const x = (t) => TL.padL + tlWarp(t) * (w - TL.padL - TL.padR);
  const parts = [];
  const lateLbls = [];

  /* ---------- shared two-panel frame ---------- */
  const t0 = barT0(), tm = barSplit(), t1 = S.tMax;
  const pA = { t0, t1: tm, x0: x(t0), x1: TL.padL + P1F * (w - TL.padL - TL.padR) };
  const pB = { t0: tm, t1, x0: TL.padL + (P1F + GAPF) * (w - TL.padL - TL.padR), x1: w - TL.padR };
  const plotT = TL.padT, plotB = h - TL.padB, plotH = plotB - plotT;
  const et = (t, opt) => new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: 'America/New_York' }, opt)).format(t);
  const etHour = (t) => parseInt(et(t, { hour: 'numeric', hourCycle: 'h23' }), 10);
  const hourLbl = (t) => { const hr = etHour(t); return `${(hr % 12) || 12}${hr < 12 ? 'a' : 'p'}`; };
  const clkLbl = (t) => et(t, { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '').toLowerCase();

  if (S.sun) for (const p2 of [pA, pB]) {
    for (let i = 0; i < S.sun.length; i++) {
      const dusk = S.sun[i].set, dawn = (S.sun[i + 1] && S.sun[i + 1].rise) || (t1 + 1);
      const a2 = clamp(dusk, p2.t0, p2.t1), b2 = clamp(dawn, p2.t0, p2.t1);
      if (b2 > a2) {
        parts.push(`<rect class="night" x="${x(a2).toFixed(1)}" y="${plotT}" width="${(x(b2) - x(a2)).toFixed(1)}" height="${plotH}"/>`);
        // a faint moon names the band, so shading is never mistaken for data
        if (x(b2) - x(a2) > 24) parts.push(`<text class="nightlbl" x="${((x(a2) + x(b2)) / 2).toFixed(1)}" y="${plotT + 9}" text-anchor="middle">☾</text>`);
      }
    }
  }
  for (const p2 of [pA, pB]) {
    parts.push(`<rect class="panelbox" x="${p2.x0.toFixed(1)}" y="${plotT}" width="${(p2.x1 - p2.x0).toFixed(1)}" height="${plotH}"/>`);
  }
  // panel headers: the break AND its magnitude, stated
  // the 12 h window usually crosses midnight: name both days, or the
  // after-midnight columns get silently misdated
  const dayN = et(S.tNow, { weekday: 'short' }).toUpperCase(), dayM = et(tm, { weekday: 'short' }).toUpperCase();
  lateLbls.push(`<text class="phdr" x="${(pA.x0 + 1).toFixed(1)}" y="${plotT - 3}">NEXT 12 H · ${dayN}${dayM !== dayN ? '→' + dayM : ''} ET</text>`);
  lateLbls.push(`<text class="phdr" x="${(pB.x0 + 1).toFixed(1)}" y="${plotT - 3}">+12 H TO +72 H</text>`);
  // the seam carries the SAME timestamp on both sides of the gap; label it
  // with the NEAREST hour, not the floored one, so it agrees with the scale
  lateLbls.push(`<text class="xlbl" x="${((pA.x1 + pB.x0) / 2).toFixed(1)}" y="${h - 2.5}" text-anchor="middle">${hourLbl(Math.round(tm / 3600e3) * 3600e3)}</text>`);
  const gxm = (pA.x1 + pB.x0) / 2;
  parts.push(`<line class="brk" x1="${(gxm - 2).toFixed(1)}" y1="${plotB - 6}" x2="${(gxm + 4).toFixed(1)}" y2="${plotB + 6}"/>`);
  parts.push(`<line class="brk" x1="${(gxm - 8).toFixed(1)}" y1="${plotB - 6}" x2="${(gxm - 2).toFixed(1)}" y2="${plotB + 6}"/>`);

  // x ticks. Panel A: labeled every 3 h, minors hourly, day+ET named once.
  // Panel B: weekday at each midnight tick, labeled 6a/6p minors.
  for (let t = Math.ceil(t0 / 3600e3) * 3600e3; t <= t1; t += 3600e3) {
    const hr = etHour(t), cx2 = x(t);
    if (t <= tm) {
      const major = hr % 3 === 0;
      parts.push(`<line class="xtick${major ? '' : ' minor'}" x1="${cx2.toFixed(1)}" y1="${plotB}" x2="${cx2.toFixed(1)}" y2="${plotB + (major ? 5 : 3)}"/>`);
      if (major && cx2 > pA.x0 + 14 && cx2 < pA.x1 - 26 && Math.abs(cx2 - x(S.tNow)) > 22) lateLbls.push(`<text class="xlbl" x="${cx2.toFixed(1)}" y="${h - 2.5}" text-anchor="middle">${hourLbl(t)}</text>`);
    } else if (t > tm) {
      if (hr === 0) {
        parts.push(`<line class="xtick" x1="${cx2.toFixed(1)}" y1="${plotB}" x2="${cx2.toFixed(1)}" y2="${plotB + 5}"/>`);
        parts.push(`<line class="xtick day" x1="${cx2.toFixed(1)}" y1="${plotT}" x2="${cx2.toFixed(1)}" y2="${plotB}"/>`);
      } else if (hr % 6 === 0) {
        parts.push(`<line class="xtick minor" x1="${cx2.toFixed(1)}" y1="${plotB}" x2="${cx2.toFixed(1)}" y2="${plotB + 3}"/>`);
        if (!phone && (hr === 6 || hr === 18) && cx2 > pB.x0 + 34) lateLbls.push(`<text class="xlbl minor" x="${cx2.toFixed(1)}" y="${h - 2.5}" text-anchor="middle">${hr === 6 ? '6a' : '6p'}</text>`);
      }
      if (hr === 12) lateLbls.push(`<text class="xlbl day" x="${cx2.toFixed(1)}" y="${h - 2.5}" text-anchor="middle">${et(t, { weekday: 'short' })}</text>`);
    }
  }

  parts.push(`<line class="nowline" x1="${x(S.tNow).toFixed(1)}" y1="${plotT}" x2="${x(S.tNow).toFixed(1)}" y2="${plotB}"/>`);
  // name the line: two unlabeled verticals (now + scrub cursor) are
  // indistinguishable to a first-time reader
  lateLbls.push(`<text class="xlbl now" x="${x(S.tNow).toFixed(1)}" y="${h - 2.5}" text-anchor="middle">now</text>`);
  if (x(S.tNow) - pA.x0 > 2) parts.push(`<rect class="past" x="${pA.x0.toFixed(1)}" y="${plotT}" width="${(x(S.tNow) - pA.x0).toFixed(1)}" height="${plotH}"/>`);

  /* ---------- shared series ---------- */
  const wLo2 = S.wind ? S.wind.times[0] : 0, wHi2 = S.wind ? S.wind.times[S.wind.times.length - 1] : 1;
  const windAt = (t) => {
    const v2 = sampleWind(CENTER.lat, CENTER.lng, clamp(t, wLo2, wHi2));
    return { kn: Math.hypot(v2[0], v2[1]), g: v2[2] || 0, ue: v2[0], un: v2[1] };
  };
  const rainAt = (t) => {
    const C2 = S.centerWx;
    if (!C2 || !C2.rain || !C2.rain.length) return 0;
    return C2.rain[clamp(Math.round((t - C2.times[0]) / 3600e3), 0, C2.rain.length - 1)] || 0;
  };
  const boltAt = (t) => {
    const C2 = S.centerWx;
    if (!C2 || !C2.wcode || !C2.wcode.length) return false;
    return (C2.wcode[clamp(Math.round((t - C2.times[0]) / 3600e3), 0, C2.wcode.length - 1)] || 0) >= 95;
  };
  const tid = [];
  if (S.tide) for (let i = 0; i < S.tide.times.length; i += 2) {
    const t = S.tide.times[i];
    if (t >= t0 - 20 * 60e3 && t <= t1 + 20 * 60e3) tid.push([t, S.tide.vals[i]]);
  }
  let tLo = 0, tHi = 2.5;
  if (tid.length) {
    tLo = Math.floor(Math.min(...tid.map((p) => p[1])));
    tHi = Math.ceil(Math.max(...tid.map((p) => p[1])));
    if (tHi - tLo < 1) tHi = tLo + 1;
  }
  const polyP = (pts2, yFn, p2) => pts2.filter((q) => q[0] >= p2.t0 - 1 && q[0] <= p2.t1 + 1)
    .map((q, i) => `${i ? 'L' : 'M'}${x(q[0]).toFixed(1)},${yFn(q[1]).toFixed(1)}`).join('');
  const areaP = (pts2, yFn, p2, baseY) => {
    const inP = pts2.filter((q) => q[0] >= p2.t0 - 1 && q[0] <= p2.t1 + 1);
    if (!inP.length) return '';
    return polyP(pts2, yFn, p2) + `L${x(inP[inP.length - 1][0]).toFixed(1)},${baseY.toFixed(1)}L${x(inP[0][0]).toFixed(1)},${baseY.toFixed(1)}Z`;
  };
  const arrowG = (X, Y, ue, un, cls, sc) =>
    `<g class="${cls}" transform="translate(${X.toFixed(1)},${Y.toFixed(1)}) rotate(${(Math.atan2(ue, un) * 180 / Math.PI).toFixed(0)}) scale(${sc || 1})"><line y1="6" y2="-2.5"/><path d="M0,-6.5 L-3.1,-0.8 L3.1,-0.8 Z"/></g>`;
  const yAxisBoth = (yFor, ticks, unit) => {
    // labeled axis on panel A's left, a mirrored labeled axis in panel B's
    // right margin (outside the box, over empty viewport, never over data),
    // and light gridlines at the SAME labeled values through both panels
    parts.push(`<line class="axis" x1="${pA.x0.toFixed(1)}" y1="${yFor(ticks[ticks.length - 1]).toFixed(1)}" x2="${pA.x0.toFixed(1)}" y2="${yFor(ticks[0]).toFixed(1)}"/>`);
    parts.push(`<line class="axis" x1="${pB.x1.toFixed(1)}" y1="${yFor(ticks[ticks.length - 1]).toFixed(1)}" x2="${pB.x1.toFixed(1)}" y2="${yFor(ticks[0]).toFixed(1)}"/>`);
    for (const tv of ticks) {
      const yy = yFor(tv);
      for (const p2 of [pA, pB]) {
        parts.push(`<line class="wgrid" x1="${p2.x0.toFixed(1)}" y1="${yy.toFixed(1)}" x2="${p2.x1.toFixed(1)}" y2="${yy.toFixed(1)}"/>`);
      }
      parts.push(`<line class="axis" x1="${(pA.x0 - 4).toFixed(1)}" y1="${yy.toFixed(1)}" x2="${pA.x0.toFixed(1)}" y2="${yy.toFixed(1)}"/>`);
      parts.push(`<line class="axis" x1="${pB.x1.toFixed(1)}" y1="${yy.toFixed(1)}" x2="${(pB.x1 + 4).toFixed(1)}" y2="${yy.toFixed(1)}"/>`);
      const lb = tv === ticks[0] ? tv + ' ' + unit : String(tv);
      lateLbls.push(`<text class="ytick" x="${(pA.x0 - 6).toFixed(1)}" y="${(yy + 4).toFixed(1)}" text-anchor="end">${lb}</text>`);
      lateLbls.push(`<text class="ytick" x="${(pB.x1 + 6).toFixed(1)}" y="${(yy + 4).toFixed(1)}">${lb}</text>`);
    }
  };
  // thunder: full-height translucent bands, the strongest possible cue
  for (const p2 of [pA, pB]) {
    const step = 3600e3;
    for (let t = Math.ceil(p2.t0 / step) * step; t < p2.t1; t += step) {
      if (boltAt(t)) parts.push(`<rect class="stormband" x="${x(t).toFixed(1)}" y="${plotT}" width="${Math.max(2, x(t + step) - x(t)).toFixed(1)}" height="${plotH}"/>`);
    }
  }
  // tide H/L labels: TIME is the question being answered; height rides along
  // in panel A. Highs outrank lows when space runs out.
  const hlLabels = (yFn) => {
    // H labels ride above crests, L labels below troughs: two separate
    // lanes, so each event yields only to the previous one of its OWN kind
    // (the old shared-lane rule silently deleted every low in panel B)
    let lastH = -1e9, lastL = -1e9;
    const evs2 = (S.hilo || []).filter((e2) => e2.t >= t0 && e2.t <= t1);
    for (const hl of evs2) {
      const inA = hl.t <= tm;
      const isH = hl.type === 'H';
      const txt = inA ? `${hl.type} ${hl.v.toFixed(1)}ft ${clkLbl(hl.t)}` : `${hl.type} ${hourLbl(hl.t)}`;
      // keep the whole label inside its own panel, clear of the seam gap
      const p2 = inA ? pA : pB;
      const halfW = txt.length * (inA ? 2.95 : 3.3);
      const cx2 = clamp(x(hl.t), p2.x0 + halfW + 2, p2.x1 - halfW - 2);
      if (isH) { if (cx2 - lastH < halfW * 2 + 6) continue; lastH = cx2; }
      else { if (cx2 - lastL < halfW * 2 + 6) continue; lastL = cx2; }
      // panel A labels ride the curve; panel B's sit in fixed lanes (H high,
      // L on the floor) so the two kinds can never meet in the thin band
      const yy = inA
        ? (isH ? Math.max(yFn(hl.v) - 4, plotT + 10) : Math.min(yFn(hl.v) + 11, plotB - 3))
        : (isH ? Math.max(yFn(tHi) - 4, plotB - 27) : plotB - 3);
      lateLbls.push(`<text class="hl" x="${cx2.toFixed(1)}" y="${yy.toFixed(1)}" text-anchor="middle">${txt}</text>`);
    }
  };

  /* ---------- the forecast bar: numeric strips (Windy manner) ---------- */
  const rowsH = { dir: 14, wind: 19, gust: 19, rain: 10 };
  const tideH = plotH - rowsH.dir - rowsH.wind - rowsH.gust - rowsH.rain - 4;
  let yy0 = plotT;
  const rowY = {};
  for (const k of ['dir', 'wind', 'gust', 'rain']) { rowY[k] = yy0; yy0 += rowsH[k]; }
  // discrete stepped ramp; every stop passes text contrast with its ink
  const STOPS = [
    [5, '#f3ddb4', 0], [10, '#eec680', 0], [15, '#e5a958', 0], [20, '#d47f3c', 0],
    [27, '#b8512e', 1], [35, '#93301f', 1], [999, '#6b1a14', 1]];
  const ramp = (kn) => STOPS.find((s) => kn < s[0]);
  const binsFor = (p2) => {
    // panel B: 6 h bins, wide enough that every cell still carries its
    // number. Bins snap to the ET clock (12a/6a/12p/6p), the same rhythm as
    // the drawn ticks: a UTC grid sits 4-5 h off and leaves a blank gap at
    // the panel edge. The first bin walks BACK past the edge and is clipped,
    // so every hour of the span is covered.
    const bw = p2 === pA ? (phone ? 2 : 1) : (phone ? 12 : 6);
    let t = Math.floor(p2.t0 / 3600e3) * 3600e3;
    while (etHour(t) % bw !== 0) t -= 3600e3;
    const out = [];
    for (; t < p2.t1; t += bw * 3600e3) {
      const ta = Math.max(t, p2.t0), tb = Math.min(t + bw * 3600e3, p2.t1);
      if (tb - ta > 60e3) out.push([ta, tb]);
    }
    return out;
  };
  for (const p2 of [pA, pB]) {
    for (const [ta, tb] of binsFor(p2)) {
      // clamp to the panel box: x(t) at exactly the seam time resolves to
      // the panel A side of the warp, which would drag panel B's first
      // cell across the gap
      const xL = Math.max(x(ta), p2.x0), xR = Math.min(x(tb), p2.x1);
      const cw = xR - xL, cxm = (xL + xR) / 2;
      if (cw < 2) continue;
      TL.bins.push({ ta, tb, x0: xL, x1: xR });
      let kn = 0, g2 = 0, mm = 0, nh = 0;
      for (let t = ta; t < tb; t += 3600e3) { const wv2 = windAt(t + 1800e3); kn = Math.max(kn, wv2.kn); g2 = Math.max(g2, wv2.g); mm += rainAt(t); nh++; }
      mm = nh ? mm / nh : 0;
      const wvm = windAt((ta + tb) / 2);
      if (cw >= 13) parts.push(arrowG(cxm, rowY.dir + rowsH.dir / 2, wvm.ue, wvm.un, 'ccol', cw >= 24 ? 0.95 : 0.8));
      const s1 = ramp(kn), s2 = ramp(g2);
      parts.push(`<rect class="cell" x="${xL.toFixed(1)}" y="${rowY.wind}" width="${cw.toFixed(1)}" height="${rowsH.wind - 2}" fill="${s1[1]}"/>`);
      parts.push(`<rect class="cell" x="${xL.toFixed(1)}" y="${rowY.gust}" width="${cw.toFixed(1)}" height="${rowsH.gust - 2}" fill="${s2[1]}"/>`);
      if (cw >= 22) {
        lateLbls.push(`<text class="cellnum${s1[2] ? ' inv' : ''}" x="${cxm.toFixed(1)}" y="${rowY.wind + rowsH.wind / 2 + 4}" text-anchor="middle">${Math.round(kn)}</text>`);
        lateLbls.push(`<text class="cellnum${s2[2] ? ' inv' : ''}" x="${cxm.toFixed(1)}" y="${rowY.gust + rowsH.gust / 2 + 4}" text-anchor="middle">${Math.round(g2)}</text>`);
      }
      if (mm >= 0.1) {
        const op = mm < 1 ? 0.3 : mm < 3 ? 0.55 : 0.85;
        parts.push(`<rect class="cell" x="${xL.toFixed(1)}" y="${rowY.rain}" width="${cw.toFixed(1)}" height="${rowsH.rain - 2}" fill="rgba(43,86,127,${op})"/>`);
      }
    }
  }
  const rn = [['dir', 'dir'], ['wind', 'wind'], ['gust', 'gust'], ['rain', 'rain']];
  for (const [k, nm] of rn) lateLbls.push(`<text class="rowname" x="${(pA.x0 - 6).toFixed(1)}" y="${rowY[k] + rowsH[k] / 2 + (k === 'rain' ? 2 : 4)}" text-anchor="end">${nm}</text>`);
  // legends live in the HEADER BAND, never inside a data row: wind ramp
  // over panel B's header, rain steps over panel A's header
  if (!phone) {
    const lh2 = 11, ly2 = 1;
    const sw2 = 22, lxW = pB.x1 - 6 * sw2 - 58;
    STOPS.slice(0, 6).forEach((s, i2) => {
      lateLbls.push(`<rect x="${(lxW + i2 * sw2).toFixed(1)}" y="${ly2}" width="${sw2}" height="${lh2}" fill="${s[1]}"/>`);
      lateLbls.push(`<text class="lgnum${s[2] ? ' inv' : ''}" x="${(lxW + i2 * sw2 + sw2 / 2).toFixed(1)}" y="${ly2 + lh2 - 2}" text-anchor="middle">${s[0] === 999 ? '35+' : s[0]}</text>`);
    });
    lateLbls.push(`<text class="rowname" x="${(lxW + 6 * sw2 + 5).toFixed(1)}" y="${ly2 + lh2 - 2}">kn max</text>`);
    const rw2 = 26, lxR = pA.x1 - 3 * rw2 - 92;
    [[0.30, '<1'], [0.55, '1-3'], [0.85, '>3']].forEach((rr, i2) => {
      lateLbls.push(`<rect x="${(lxR + i2 * rw2).toFixed(1)}" y="${ly2}" width="${rw2}" height="${lh2}" fill="rgba(43,86,127,${rr[0]})"/>`);
      lateLbls.push(`<text class="lgnum${rr[0] > 0.6 ? ' inv' : ''}" x="${(lxR + i2 * rw2 + rw2 / 2).toFixed(1)}" y="${ly2 + lh2 - 2}" text-anchor="middle">${rr[1]}</text>`);
    });
    lateLbls.push(`<text class="rowname" x="${(lxR + 3 * rw2 + 5).toFixed(1)}" y="${ly2 + lh2 - 2}">rain mm/h</text>`);
  }
  const yT = (v) => plotB - (v - tLo) / (tHi - tLo) * (tideH - 2);
  if (tid.length) for (const p2 of [pA, pB]) {
    parts.push(`<path class="tide-area" d="${areaP(tid, yT, p2, plotB)}"/>`);
    parts.push(`<path class="tide-line" d="${polyP(tid, yT, p2)}" fill="none"/>`);
  }
  yAxisBoth(yT, [tLo, tHi], 'ft');
  hlLabels(yT);
  // average high/low reference lines: an unusually high high must read
  // as 'above normal' at a glance (means over the loaded ~4 days)
  {
    const hv = (S.hilo || []).filter((h2) => h2.type === 'H').map((h2) => h2.v);
    const lv = (S.hilo || []).filter((h2) => h2.type === 'L').map((h2) => h2.v);
    if (hv.length >= 2 && lv.length >= 2) {
      const mH = hv.reduce((a2, b2) => a2 + b2, 0) / hv.length;
      const mL = lv.reduce((a2, b2) => a2 + b2, 0) / lv.length;
      for (const [mv, lb] of [[mH, 'avg H'], [mL, 'avg L']]) {
        const yy = yT(mv);
        if (yy < plotB - tideH + 6 || yy > plotB - 2) continue;
        for (const p2 of [pA, pB]) {
          parts.push(`<line class="avgtide" x1="${p2.x0.toFixed(1)}" y1="${yy.toFixed(1)}" x2="${p2.x1.toFixed(1)}" y2="${yy.toFixed(1)}"/>`);
        }
        lateLbls.push(`<text class="avgtide-lb" x="${(pA.x1 - 3).toFixed(1)}" y="${(yy - 2).toFixed(1)}" text-anchor="end">${lb}</text>`);
      }
    }
  }

  // Highlight the selected forecast column as one unit. Direction, wind and
  // gust now read like the same moment instead of being cut by a cursor line.
  const scrubTop = rowY.dir + 1;
  const scrubBottom = rowY.gust + rowsH.gust - 2;
  parts.push(`<g id="scrubcursor"><rect class="scrubbox" x="0" y="${scrubTop}" width="1" height="${scrubBottom - scrubTop}" rx="4"/></g>`);
  parts.push(...lateLbls);
  svg.innerHTML = parts.join('');
  resolveTimelineLabelCollisions(svg);
  positionScrub();
  try { updatePlanBand(); } catch (e) {}
}

function positionScrub() {
  const g = document.getElementById('scrubcursor');
  if (!g) return;
  const box = g.querySelector('.scrubbox');
  if (!box) return;
  const bins = TL.bins || [];
  const bin = bins.find((b, i) => S.tScrub >= b.ta && (S.tScrub < b.tb || (i === bins.length - 1 && S.tScrub <= b.tb)));
  if (bin) {
    box.setAttribute('x', (bin.x0 + 1).toFixed(1));
    box.setAttribute('width', Math.max(2, bin.x1 - bin.x0 - 2).toFixed(1));
  } else {
    const px = TL.padL + tlWarp(S.tScrub) * (TL.w - TL.padL - TL.padR);
    box.setAttribute('x', (px - 4).toFixed(1));
    box.setAttribute('width', '8');
  }
}

/* ------------------------------ readouts ------------------------------ */

function updateReadout() {
  if (googleWeatherBase && Date.now() >= googleWeatherExpiry) clearGoogleWeather(true);
  const t = S.tScrub;
  const nowMs = Date.now();
  try { updateWaveLegend(); } catch (e) {}   // seas scale follows the scrub
  try { updateFerryGhosts(); } catch (e) {}  // scheduled boats follow it too

  // wind chip — live: Yacht Club anemometer on Great Harbor; scrubbed: model forecast
  const whycFresh = S.whyc && (nowMs - S.whyc.t) < 40 * 60e3;
  const kfmhFresh = S.kfmh && S.kfmh.spd != null && (nowMs - S.kfmh.t) < 75 * 60e3;
  if (S.live && whycFresh) {
    $('wind-val').textContent = `${S.whyc.dir != null ? compass(S.whyc.dir) + ' ' : ''}${S.whyc.spd.toFixed(0)} kn`;
    $('wind-sub').textContent = (S.whyc.gst ? `gusts ${Math.round(S.whyc.gst)} · ` : '') + 'live · yacht club';
    if (S.whyc.dir != null) $('wind-arrow').style.transform = `rotate(${(S.whyc.dir + 180) % 360}deg)`;
  } else if (S.live && kfmhFresh) {
    $('wind-val').textContent = `${S.kfmh.dir != null ? compass(S.kfmh.dir) + ' ' : ''}${S.kfmh.spd.toFixed(0)} kn`;
    $('wind-sub').textContent = (S.kfmh.gst ? `gusts ${Math.round(S.kfmh.gst)} · ` : '') + 'live · otis';
    if (S.kfmh.dir != null) $('wind-arrow').style.transform = `rotate(${(S.kfmh.dir + 180) % 360}deg)`;
  } else if (S.wind) {
    const [u, v, g] = sampleWind(CENTER.lat, CENTER.lng, t);
    const spd = Math.hypot(u, v);
    const from = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
    $('wind-val').textContent = `${compass(from)} ${spd.toFixed(0)} kn`;
    $('wind-sub').textContent = g ? `gusts ${Math.round(g)} kn` : 'wind';
    $('wind-arrow').style.transform = `rotate(${(from + 180) % 360}deg)`;
  }

  // current chip (primary station, incl. weather adjustment)
  const prim = S.currents.find(c => c.cfg.primary) || S.currents[0];
  if (prim) {
    const v = stationV(prim, t), sp = Math.abs(v);
    const dir = v >= 0 ? prim.floodDir : prim.ebbDir;
    $('cur-val').textContent = sp < 0.15 ? 'slack' : `${sp.toFixed(1)} kn ${v >= 0 ? 'flood' : 'ebb'}`;
    const csub = $('cur-sub');
    if (csub) {
      // what happens NEXT at the Strait: the number a sailor plans around
      const nxt = (prim.events || []).find((e) => e.t > t);
      if (!nxt) csub.textContent = prim.cfg.short;
      else {
        const mins = Math.round((nxt.t - t) / 60e3);
        const when = mins <= 99 ? `in ${mins} min` : fmtT.format(nxt.t);
        csub.textContent = nxt.type === 'slack'
          ? `slack ${when}`
          : `peak ${Math.abs(nxt.v).toFixed(1)} kn ${when}`;
      }
    }
    $('cur-arrow').style.transform = sp < 0.15 ? '' : `rotate(${dir}deg)`;
    $('cur-arrow').style.opacity = sp < 0.15 ? .35 : 1;
  } else if (flowField && flowField.tideOnly) {
    // stations down: show the tide-driven estimate for the Strait
    const c = sampleWater(41.5193, -70.6829, t);
    const sp = Math.hypot(c[0], c[1]);
    const dir = (Math.atan2(c[0], c[1]) * 180 / Math.PI + 360) % 360;
    $('cur-val').textContent = sp < 0.15 ? 'slack' : `${sp.toFixed(1)} kn est`;
    $('cur-arrow').style.transform = sp < 0.15 ? '' : `rotate(${dir}deg)`;
    $('cur-arrow').style.opacity = sp < 0.15 ? .35 : 1;
  }
  // source-health badge: say quietly when a live source is down and what
  // is standing in for it
  const sw2 = $('srcwarn');
  if (sw2) {
    const warns = [];
    if (GOOGLE_WEATHER_ENDPOINT && !googleWeatherBase) warns.push('Google weather unavailable · Open-Meteo forecast');
    if (S.curSource === 'salvaged') warns.push("NOAA currents down · yesterday's tables");
    else if (S.curSource === 'none') {
      warns.push(flowField && flowField.tideOnly
        ? 'NOAA currents down · tide-driven estimate'
        : 'NOAA currents down');
    }
    // boats: say when the stream has gone quiet (after a fair boot window)
    const aisSilent = nowMs - aisLastMsg > 3 * 60e3;
    if (aisSilent && aisLastMsg === 0 && nowMs - AIS_T0 > 3 * 60e3) warns.push('boats feed unreachable');
    else if (aisSilent && aisLastMsg > 0) warns.push('boats feed down · retrying');
    // a ferry underway inside the passage right now: a quiet heads-up
    try {
      for (const [, sh3] of aisShips) {
        if (!(sh3.sog > 3) || nowMs - sh3.t > 6 * 60e3) continue;
        if (!AIS_FERRY_RE.test(sh3.name || '')) continue;
        if (sh3.lat > 41.508 && sh3.lat < 41.527 && sh3.lng > -70.695 && sh3.lng < -70.655) {
          warns.push('ferry in the passage'); break;
        }
      }
    } catch (e) {}
    sw2.hidden = !warns.length;
    if (warns.length) sw2.textContent = warns.join(' · ');
  }

  // tide chip
  if (S.tide) {
    const v = interp(S.tide.times, S.tide.vals, t);
    const v2 = interp(S.tide.times, S.tide.vals, t + 30 * 60e3);
    const rising = v2 > v;
    const next = S.hilo.find(h => h.t > t);
    const useObs = S.live && S.obs.wl != null && (S.tNow - (S.obs.wlT || 0)) < 90 * 60e3;
    $('tide-val').textContent = `${(useObs ? S.obs.wl : v).toFixed(1)} ft ${rising ? '▲' : '▼'}`;
    $('tide-sub').textContent = next ? `${next.type === 'H' ? 'high' : 'low'} ${fmtT.format(next.t)}` : 'tide';
  }

  // temp chip
  {
    const liveAir = S.obs.atemp != null ? S.obs.atemp : (S.whyc ? S.whyc.temp : null);
    const air = S.live || !S.centerWx
      ? liveAir
      : interp(S.centerWx.times, S.centerWx.temp, t);
    const wa = S.obs.wtemp != null ? Math.round(S.obs.wtemp) + '°' : '—';
    const ai = air != null ? Math.round(air) + '°' : '—';
    $('temp-val').textContent = `${wa} · ${ai}`;
    const seas = waveFt(t);
    $('temp-sub').textContent = seas != null
      ? `water · air · seas ${seas < 9.95 ? seas.toFixed(1) : Math.round(seas)} ft`
      : (S.live ? 'water · air' : 'water(now) · air');
  }

  // time readout
  const dtms = t - S.tNow;
  if (S.live) {
    // live needs no announcement — unless the data itself has gone stale
    // (offline on the water): then say what vintage you are looking at
    const stale = S.dataAsOf && nowMs - S.dataAsOf > 75 * 60e3;
    $('scrubtime').textContent = stale ? 'data as of ' + fmtT.format(S.dataAsOf) : '';
  } else {
    const hrs = Math.round(dtms / 36e5 * 10) / 10;
    const rel = dtms >= 0 ? `+${hrs} h` : `${hrs} h`;
    $('scrubtime').innerHTML = `${fmtDWd.format(t)} ${fmtT.format(t)} <span class="plus">${rel}</span>`;
  }
  $('btn-now').classList.toggle('is-live', S.live);
  $('btn-now-label').textContent = S.live ? 'LIVE' : 'NOW';

  positionScrub();
  if (waterGL) waterGL.flowDirty();
  if (waterLayer) waterLayer.redrawStatic();
  if (curArrows) curArrows.requestRedraw();
  if (windArrows) windArrows.notifyTime();
  // departure time = scrub time, so the plan re-marches with the scrubber
  try { if (PLAN.pts.length > 1) planRecalcSoon(); } catch (e) {}
}

let rafPending = false;
function requestReadout() {
  try { buoyTiltTick(); } catch (e) {}
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; updateReadout(); });
}

function setScrub(t, opts) {
  if (!Number.isFinite(t)) return;
  S.tScrub = clamp(t, S.tMin, S.tMax);
  S.live = Math.abs(S.tScrub - S.tNow) < 7.5 * 60e3;
  if (!opts || !opts.fromPlay) stopPlay();
  $('scrub-range').value = Math.round(tlWarp(S.tScrub) * 1000);
  requestReadout();
}

/* ------------------------------ scrub interactions ------------------------------ */

function initScrub() {
  const svg = $('timeline');
  let dragging = false;
  const toT = (clientX) => {
    const r = svg.getBoundingClientRect();
    if (!TL.w || !r.width) return S.tScrub;      // tapped before the first build
    const f = (clientX - r.left - TL.padL * r.width / TL.w) / (r.width * (TL.w - TL.padL - TL.padR) / TL.w);
    return tlUnwarp(f);
  };
  svg.addEventListener('pointerdown', (e) => {
    dragging = true;
    setScrub(toT(e.clientX));
    try { svg.setPointerCapture(e.pointerId); } catch (e2) {}
  });
  svg.addEventListener('pointermove', (e) => { if (dragging) setScrub(toT(e.clientX)); });
  svg.addEventListener('pointerup', () => { dragging = false; });
  svg.addEventListener('pointercancel', () => { dragging = false; });

  $('scrub-range').addEventListener('input', (e) => {
    setScrub(tlUnwarp(+e.target.value / 1000));
  });
  $('btn-now').addEventListener('click', () => {
    S.tNow = Date.now();
    S.tMax = S.tNow + HOURS_FWD * 3600e3;
    S.tMin = S.tNow - HOURS_BACK * 3600e3;
    buildTimeline();                    // window may have slid while scrubbed
    setScrub(S.tNow);
  });
  $('btn-play').addEventListener('click', togglePlay);
}

let playRAF = null, playLast = 0;
function togglePlay() {
  if (S.playing) return stopPlay();
  S.playing = true;
  $('btn-play').textContent = '❚❚';
  if (S.tMax - S.tScrub < 60e3) S.tScrub = S.tNow;
  playLast = performance.now();
  // constant speed in WARPED space: the expanded first 12 h play ~4x slower
  // (and sample ~4x finer) than the far forecast — today is what you plan
  const USPEED = 1 / 40000;                          // full sweep in ~40 s
  const step = (now) => {
    if (!S.playing) return;
    const dt = now - playLast; playLast = now;
    const u = tlWarp(S.tScrub) + dt * USPEED;
    if (u >= 1) { setScrub(S.tMax, { fromPlay: true }); stopPlay(); return; }
    setScrub(tlUnwarp(u), { fromPlay: true });
    playRAF = requestAnimationFrame(step);
  };
  playRAF = requestAnimationFrame(step);
}
function stopPlay() {
  S.playing = false;
  if (playRAF) cancelAnimationFrame(playRAF);
  playRAF = null;
  $('btn-play').textContent = '▶';
}

/* ------------------------------ header / alerts ------------------------------ */

function renderAlerts() {
  const bar = $('alertbar');
  if (!S.alerts.length) {
    bar.hidden = true;
    document.documentElement.style.setProperty('--alerth', '0px');
    if (map) map.invalidateSize({ animate: false });
    return;
  }
  const a = S.alerts[0];
  const until = a.ends || a.expires;
  const more = S.alerts.length > 1 ? ` (+${S.alerts.length - 1} more)` : '';
  bar.innerHTML = `⚠️ <b>${a.event}</b>${until ? ' until ' + fmtDW.format(Date.parse(until)) + ' ' + fmtT.format(Date.parse(until)) : ''}${more} — <a href="https://forecast.weather.gov/shmrn.php?mz=anz233" target="_blank" rel="noopener">marine forecast</a>`;
  bar.hidden = false;
  requestAnimationFrame(() => {
    document.documentElement.style.setProperty('--alerth', bar.offsetHeight + 'px');
    if (map) map.invalidateSize({ animate: false });
  });
}

/* ------------------------------ webcams ------------------------------ */

function initCams() {
  document.querySelectorAll('.cam[data-embed]').forEach(cam => {
    const target = cam.querySelector('.cam-frame');
    if (!target) return;
    target.addEventListener('click', () => {
      const ifr = document.createElement('iframe');
      ifr.src = cam.dataset.src;
      ifr.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      ifr.allowFullscreen = true;
      ifr.loading = 'lazy';
      ifr.referrerPolicy = 'no-referrer-when-downgrade';
      target.innerHTML = '';
      target.appendChild(ifr);
    });
  });

  // Yacht Club stills are below a full-screen map. They used to download two
  // 1100 px images immediately and then refresh them forever, competing with
  // chart/model data on a phone that had never scrolled near the cameras.
  // Start once the section approaches the viewport (or its button is tapped),
  // and refresh only while it is actually visible.
  const camSection = $('cams');
  let yachtStarted = false, camsVisible = false;
  const loadCamPosters = () => {
    document.querySelectorAll('#cams img[data-poster]').forEach((img) => {
      if (!img.hasAttribute('src')) img.src = img.dataset.poster;
    });
  };
  const startYachtCams = () => {
    if (yachtStarted) return;
    yachtStarted = true;
    document.querySelectorAll('img.yc-cam').forEach(img => {
      const base = img.dataset.src;
      const link = img.dataset.link;
      const bust = () => {
        if (document.hidden || !camsVisible) return;
        img.src = base + '&t=' + Math.floor(Date.now() / 20000);
      };
      let errs = 0, bustTimer = null;
      img.decoding = 'async';
      img.fetchPriority = 'low';
      img.addEventListener('error', () => {
        // a single proxy hiccup shouldn't retire the camera; three in a row
        // means it's actually down — swap to the external link and stop fetching
        if (++errs < 3) return;
        clearInterval(bustTimer);
        const frame = img.closest('.cam-frame');
        if (frame) frame.innerHTML = `<a class="cam-ext" href="${link}" target="_blank" rel="noopener">open live stream ↗</a>`;
      });
      img.addEventListener('load', () => { errs = 0; });
      bust();
      bustTimer = setInterval(bust, 20000);
    });
  };

  if (camSection && 'IntersectionObserver' in window) {
    const nearObserver = new IntersectionObserver((entries, obs) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      startYachtCams();
      obs.disconnect();
    }, { rootMargin: '600px 0px' });
    nearObserver.observe(camSection);

    const visibleObserver = new IntersectionObserver((entries) => {
      const wasVisible = camsVisible;
      camsVisible = entries.some((e) => e.isIntersecting);
      if (camsVisible && !wasVisible) {
        loadCamPosters();
        startYachtCams();
        document.querySelectorAll('img.yc-cam').forEach((img) => {
          if (!img.hasAttribute('src') && img.dataset.src) img.src = img.dataset.src + '&t=' + Math.floor(Date.now() / 20000);
        });
      }
    }, { threshold: 0.01 });
    visibleObserver.observe(camSection);
  }

  $('btn-cams').addEventListener('click', () => {
    camsVisible = true;
    loadCamPosters();
    startYachtCams();
    camSection.scrollIntoView({ behavior: 'smooth' });
  });
}

/* ------------------- tap anywhere: local 12 h forecast ------------------- */

const fmtHr = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric' });
function rainAtSpot(t) {
  const C2 = S.centerWx;
  if (!C2 || !C2.rain || !C2.rain.length) return 0;
  return C2.rain[clamp(Math.round((t - C2.times[0]) / 3600e3), 0, C2.rain.length - 1)] || 0;
}

function showSpotForecast(latlng) {
  if (!GEO || !isWaterAt(latlng.lat, latlng.lng)) return;
  const { lat, lng } = latlng;
  const STEP = 20 * 60e3, N = 37;                       // 12 h at 20-min steps
  const t0 = clamp(S.tScrub, S.tMin, S.tMax - 60e3);
  const tEnd = Math.min(t0 + (N - 1) * STEP, S.tMax);
  const cur = [], wnd = [], tid = [];
  for (let i = 0; i < N; i++) {
    const t = Math.min(t0 + i * STEP, S.tMax);
    const c = sampleWater(lat, lng, t);
    cur.push(Math.hypot(c[0], c[1]));
    const w = S.wind
      ? sampleWind(lat, lng, clamp(t, S.wind.times[0], S.wind.times[S.wind.times.length - 1]))
      : [0, 0];
    wnd.push(Math.hypot(w[0], w[1]));
    tid.push(localTideM(lat, lng, t));
  }
  // no header prose: the box IS the bottom bar's language at this spot,
  // and the first column (the tapped moment) is highlighted (user spec)
  const div = document.createElement('div');
  div.className = 'spot';
  const RED = '#c04a3c', INKC = '#16202c';
  const W = 276, Hc = 186, dpr = clamp(devicePixelRatio || 1, 1, 2);
  const cv = document.createElement('canvas');
  cv.width = W * dpr; cv.height = Hc * dpr;
  cv.style.width = W + 'px'; cv.style.height = Hc + 'px';
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const COLS = 9, STEPC = 1.5 * 3600e3;
  const x0 = 18, x1 = W - 10;
  const CX = (k) => x0 + (k / (COLS - 1)) * (x1 - x0);
  const X = (t) => x0 + ((t - t0) / ((COLS - 1) * STEPC)) * (x1 - x0);
  if (S.sun) {
    g.fillStyle = 'rgba(30, 45, 80, 0.07)';
    for (let i = 0; i < S.sun.length; i++) {
      const dusk = S.sun[i].set, dawn = S.sun[i + 1] ? S.sun[i + 1].rise : dusk + 10 * 3600e3;
      const a = Math.max(dusk, t0), b = Math.min(dawn, t0 + (COLS - 1) * STEPC);
      if (b > a) g.fillRect(X(a), 0, X(b) - X(a), Hc - 14);
    }
  }
  const arrow = (x, y, ang, len, color) => {
    g.save(); g.translate(x, y); g.rotate(ang);
    g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 1.7;
    g.beginPath(); g.moveTo(0, len / 2); g.lineTo(0, -len / 2 + 4); g.stroke();
    g.beginPath(); g.moveTo(0, -len / 2); g.lineTo(-3.6, -len / 2 + 6.5); g.lineTo(3.6, -len / 2 + 6.5); g.closePath(); g.fill();
    g.restore();
  };
  // the SAME ramp the bottom bar uses for its wind and gust cells
  const STOPS2 = [
    [5, '#f3ddb4', 0], [10, '#eec680', 0], [15, '#e5a958', 0], [20, '#d47f3c', 0],
    [27, '#b8512e', 1], [35, '#93301f', 1], [999, '#6b1a14', 1]];
  const ramp2 = (kn) => STOPS2.find((s2) => kn < s2[0]);
  const cwd = (x1 - x0) / (COLS - 1);
  // highlight the tapped moment's column
  g.fillStyle = 'rgba(178,63,49,0.07)';
  g.strokeStyle = 'rgba(178,63,49,0.85)';
  g.lineWidth = 1.4;
  g.beginPath();
  g.roundRect(CX(0) - cwd / 2 + 1, 2, cwd - 2, Hc - 16, 4);
  g.fill(); g.stroke();
  g.font = '10px system-ui, sans-serif';
  g.textAlign = 'center';
  for (let k = 0; k < COLS; k++) {
    const t = Math.min(t0 + k * STEPC, S.tMax);
    const wv = S.wind ? sampleWind(lat, lng, clamp(t, S.wind.times[0], S.wind.times[S.wind.times.length - 1])) : [0, 0, 0];
    const wkn = Math.hypot(wv[0], wv[1]);
    const gkn = Math.max(wv[2] || 0, wkn);
    const xa = CX(k) - cwd / 2 + 2, cw2 = cwd - 4;
    // dir / wind / gust / rain rows, exactly like the bottom bar
    if (wkn > 0.4) arrow(CX(k), 12, Math.atan2(wv[0], wv[1]), 13, RED);
    const s1 = ramp2(wkn), s2 = ramp2(gkn);
    g.fillStyle = s1[1];
    g.fillRect(xa, 21, cw2, 15);
    g.fillStyle = s1[2] ? '#fff' : '#3a2a12';
    g.fillText(String(Math.round(wkn)), CX(k), 32.5);
    g.fillStyle = s2[1];
    g.fillRect(xa, 38, cw2, 15);
    g.fillStyle = s2[2] ? '#fff' : '#3a2a12';
    g.fillText(String(Math.round(gkn)), CX(k), 49.5);
    const mm = typeof rainAtSpot === 'function' ? rainAtSpot(t) : 0;
    if (mm >= 0.1) {
      g.fillStyle = `rgba(43,86,127,${mm < 1 ? 0.3 : mm < 3 ? 0.55 : 0.85})`;
      g.fillRect(xa, 55, cw2, 7);
    }
    const c = sampleWater(lat, lng, t);
    const ckn = Math.hypot(c[0], c[1]);
    if (ckn > 0.05) arrow(CX(k), 82, Math.atan2(c[0], c[1]), 15, INKC);
    g.fillStyle = INKC;
    g.fillText(ckn >= 0.95 ? ckn.toFixed(1) : ckn.toFixed(1).slice(1), CX(k), 104);
  }
  // tide band
  const tMin = Math.min(...tid), tMax2 = Math.max(...tid) + 0.01;
  g.beginPath();
  g.moveTo(x0, 152);
  tid.forEach((v, i) => g.lineTo(X(t0 + i * STEP), 152 - ((v - tMin) / (tMax2 - tMin)) * 26));
  g.lineTo(X(t0 + (tid.length - 1) * STEP), 152);
  g.closePath();
  g.fillStyle = 'rgba(120, 170, 210, 0.35)';
  g.fill();
  g.fillStyle = 'rgba(20, 30, 45, 0.45)';
  g.font = '8px system-ui, sans-serif';
  g.textAlign = 'left';
  g.fillText('wind', 2, 12);
  g.fillText('gust', 2, 49);
  g.fillText('rain', 2, 61);
  g.fillText('current', 2, 74);
  g.fillText('tide', 2, 134);
  g.font = '9px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillStyle = 'rgba(20, 30, 45, 0.55)';
  for (let k = 0; k < COLS; k += 2) {
    g.fillText(fmtHr.format(t0 + k * STEPC).toLowerCase().replace(/[\s\u202f]/g, ''), CX(k), Hc - 4);
    g.fillRect(CX(k) - 0.5, 152, 1, 4);
  }
  div.appendChild(cv);
  L.popup({ className: 'spot-pop', maxWidth: 300 })
    .setLatLng(latlng).setContent(div).openOn(map);
}

/* ---------------- moon phase (springs/neaps context) ---------------- */

function moonPhase(t) {
  const syn = 29.530588853 * 86400e3;
  let ph = ((t - Date.UTC(2000, 0, 6, 18, 14)) % syn) / syn;
  if (ph < 0) ph += 1;
  return ph;                                   // 0 new … 0.5 full … 1 new
}

function renderMoon() {
  let el = document.getElementById('moon');
  if (!el) {
    el = document.createElement('span');
    el.id = 'moon';
    const ro = $('readout');
    if (!ro) return;
    ro.insertBefore(el, $('btn-play'));
  }
  const ph = moonPhase(S.tScrub || Date.now());
  const illum = (1 - Math.cos(ph * 2 * Math.PI)) / 2;
  const dSyz = Math.min(Math.abs(ph), Math.abs(ph - 0.5), Math.abs(ph - 1)) * 2;
  const tag = dSyz < 0.22 ? 'springs' : dSyz > 0.78 ? 'neaps' : '';
  const dpr = clamp(devicePixelRatio || 1, 1, 2);
  const cv = document.createElement('canvas');
  cv.width = 18 * dpr; cv.height = 18 * dpr;
  cv.style.width = '18px'; cv.style.height = '18px';
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const cx = 9, cy = 9, r = 7;
  g.fillStyle = '#293952';
  g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill();
  const k = Math.cos(2 * Math.PI * ph);
  const waxing = ph < 0.5;
  g.fillStyle = '#f2ecdb';
  g.beginPath();
  if (waxing) g.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2);
  else g.arc(cx, cy, r, Math.PI / 2, 3 * Math.PI / 2);
  g.ellipse(cx, cy, Math.abs(k) * r, r, 0,
    waxing ? Math.PI / 2 : 3 * Math.PI / 2,
    waxing ? 3 * Math.PI / 2 : Math.PI / 2,
    k > 0);
  g.closePath(); g.fill();
  g.strokeStyle = 'rgba(40, 55, 80, 0.5)'; g.lineWidth = 0.8;
  g.beginPath(); g.arc(cx, cy, r, 0, 7); g.stroke();
  el.title = `moon ${Math.round(illum * 100)}% lit${tag ? ' — ' + tag + ' tides' : ''}`;
  el.innerHTML = '';
  el.appendChild(cv);
  if (tag) {
    const s = document.createElement('small');
    s.textContent = tag;
    el.appendChild(s);
  }
  updateWaveLegend();
}

// wave scale: 0..3 ft minimum, growing to hold the biggest sea in the frame
function updateWaveLegend() {
  const wl = document.getElementById('lg-wave-max');
  if (!wl) return;
  const N = S.necofs;
  let mx = 0;
  // map._loaded: in a background-tab boot Leaflet has no view yet and
  // getBounds() THROWS — that throw once killed the whole boot chain
  // (2026-07-25: every background-tab open served the channel skeleton
  // instead of the calibrated field because of this line)
  if (N && N.hs && N.wtimes && N.wtimes.length > 1 && map && map._loaded) {
    const b = map.getBounds();
    const t = clamp(S.tScrub || Date.now(), S.tMin || 0, S.tMax || 8e15);
    const step = N.wtimes[1] - N.wtimes[0];
    const k = clamp(Math.round((t - N.wtimes[0]) / step), 0, N.wtimes.length - 1);
    for (let i = 0; i < N.wpts.length; i++) {
      const p = N.wpts[i];
      if (p[0] < b.getSouth() || p[0] > b.getNorth() || p[1] < b.getWest() || p[1] > b.getEast()) continue;
      const cm = N.hs[k][i];
      if (cm > mx) mx = cm;
    }
  }
  const ft = Math.max(2, Math.ceil(mx * 0.0328084 * seasBias(clamp(S.tScrub, S.tMin, S.tMax))));
  wl.textContent = ft + ' ft';
}

/* ------------- layer toggles: the legend scales are the switches ------------- */

function initLayerToggles() {
  const vis = { cur: true, wind: true, waves: false };
  try { Object.assign(vis, JSON.parse(localStorage.getItem('whLayers1') || '{}')); } catch (e) {}
  vis.waves = false;
  S.layerVis = vis;
  const apply = () => {
    const set = (id, on) => { const el = $(id); if (el) el.classList.toggle('off', !on); };
    set('lg-tog-cur', vis.cur); set('lg-tog-wind', vis.wind); set('lg-tog-waves', vis.waves);
    if (curArrows && curArrows._canvas) curArrows._canvas.style.display = vis.cur ? '' : 'none';
    if (windArrows && windArrows._canvas) windArrows._canvas.style.display = vis.wind ? '' : 'none';
    if (waterGL) waterGL._wavesOn = vis.waves;
  };
  const hook = (id, key) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('click', () => {
      vis[key] = !vis[key];
      try { localStorage.setItem('whLayers1', JSON.stringify(vis)); } catch (e) {}
      apply();
    });
  };
  hook('lg-tog-cur', 'cur');
  hook('lg-tog-wind', 'wind');
  hook('lg-tog-waves', 'waves');
  // the legend floats over the map — taps must toggle scales, never fall
  // through and open a spot forecast underneath
  const lg = $('legend');
  if (lg && window.L && L.DomEvent) {
    L.DomEvent.disableClickPropagation(lg);
    L.DomEvent.disableScrollPropagation(lg);
  }
  apply();
  S.applyLayerVis = apply;
}

/* ------------- desktop zoom slider: min to max in one drag ------------- */

function initZoomSlider() {
  const zs = $('zoomslider');
  if (!zs || !map) return;
  // min zoom is dynamic (it follows the window size) — read it live
  const zmin = () => map.getMinZoom(), zmax = map.getMaxZoom();
  const cont = map.getContainer();
  let dragging = false, baseZ = 0;
  const sync = () => { if (!dragging) zs.value = String((map.getZoom() - zmin()) / (zmax - zmin())); };
  const target = () => zmin() + parseFloat(zs.value) * (zmax - zmin());
  // during the drag, PREVIEW by scaling the whole map container — tiles,
  // water, and arrows move as one (perfectly synced, slightly soft); the
  // real zoom commits once on release, so layers never race each other
  zs.addEventListener('input', () => {
    if (!dragging) { dragging = true; baseZ = map.getZoom(); }
    const s = Math.pow(2, target() - baseZ);
    cont.style.transformOrigin = '50% 50%';
    cont.style.transform = 'scale(' + s + ')';
  });
  const commit = () => {
    if (!dragging) return;
    dragging = false;
    cont.style.transform = '';
    map.setZoom(target(), { animate: false });
  };
  zs.addEventListener('change', commit);
  zs.addEventListener('pointerup', commit);
  zs.addEventListener('mouseup', commit);
  map.on('zoomend', sync);
  map.on('resize', sync);
  const zw = $('zoomwrap');
  if (zw && window.L && L.DomEvent) {
    L.DomEvent.disableClickPropagation(zw);
    L.DomEvent.disableScrollPropagation(zw);
  }
  sync();
}

/* ------------------------------ route planner ------------------------------ */
/* Tap the water to drop waypoints; drag a ring to move it, drag the faint
   mid-segment ring to insert one, tap a ring to remove it. Legs march
   forward in time from the scrub position at your max speed (plus the
   along-track current — this is Woods Hole), sampling the FORECAST wind
   where and when you'd actually be there: any stretch pointing within 30°
   of upwind turns red (a sailboat must beat; time gets the tack detour).
   The trip window shades green on the timeline. */

const PLAN = {
  on: false, pts: [], speed: 7, boat: 'seasprite23', customPolar: null,
  markers: [], mids: [], lineLayer: null, etaMk: null,
  tDep: null, tArr: null, anyRed: false,
};

/* ---- boat polars ----
   Parametric polar from published hull specs: hull speed 1.34 sqrt(LWL),
   power from SA/D, pointing from keel type. Speeds are a smooth surface
   v(TWA, TWS); the planner picks the heading that maximizes progress
   toward the mark (VMC), so tacking upwind and gybing downwind fall out
   of the polar with no cone rules. Custom polars: the user drags the
   12 kn curve; other wind speeds scale by the same saturation law. */
const BOATS = [
  // specs verified against sailboatdata.com (research pass 2026-07-18);
  // J/24 and Catalina 30 carry REAL ORC certificate polars (jieter/orc-data, MIT)
  { id: 'seasprite23', name: 'Sea Sprite 23', lwl: 16.25, disp: 3350, sa: 247.9, keel: 'full', draft: 3.1 },
  { id: 'h125', name: 'Herreshoff 12½', lwl: 12.5, disp: 1250, sa: 140, keel: 'full', draft: 2.5 },
  { id: 'bullseye', name: 'Bullseye', lwl: 12.56, disp: 1350, sa: 155, keel: 'full', draft: 2.4 },
  { id: 'beetle', name: 'Beetle Cat', lwl: 11.67, disp: 450, sa: 140, keel: 'centerboard', draft: 2.0 },
  { id: 'sanderling', name: 'Marshall Sanderling 18', lwl: 17.5, disp: 2200, sa: 253, keel: 'centerboard', draft: 4.3 },
  { id: 'rhodes19', name: 'Rhodes 19', lwl: 17.75, disp: 1355, sa: 167, keel: 'fin', draft: 3.25 },
  { id: 'shields', name: 'Shields', lwl: 20.0, disp: 4600, sa: 363, keel: 'fin', draft: 4.75 },
  { id: 'j24', name: 'J/24', lwl: 20.0, disp: 3100, sa: 261, keel: 'fin', draft: 4.0,
    orc: { twa: [52, 60, 75, 90, 110, 120, 135, 150], tws: [6, 8, 10, 12, 14, 16, 20, 24],
      v: [[4.67, 5.43, 5.82, 6.04, 6.14, 6.18, 6.21, 6.14], [4.91, 5.61, 5.96, 6.17, 6.31, 6.37, 6.45, 6.43],
          [5.05, 5.7, 6.06, 6.32, 6.54, 6.69, 6.86, 6.94], [4.96, 5.67, 6.13, 6.44, 6.63, 6.87, 7.24, 7.49],
          [4.85, 5.72, 6.2, 6.6, 6.97, 7.32, 7.94, 8.56], [4.7, 5.6, 6.11, 6.51, 6.9, 7.32, 8.6, 10.03],
          [4.22, 5.14, 5.83, 6.24, 6.62, 7.01, 8.13, 11.09], [3.55, 4.53, 5.33, 5.91, 6.28, 6.63, 7.4, 9.22]] } },
  { id: 'catalina22', name: 'Catalina 22', lwl: 19.33, disp: 2250, sa: 205, keel: 'centerboard', draft: 5.0 },
  { id: 'catalina30', name: 'Catalina 30', lwl: 25.0, disp: 10200, sa: 437, keel: 'fin', draft: 5.25,
    orc: { twa: [52, 60, 75, 90, 110, 120, 135, 150], tws: [6, 8, 10, 12, 14, 16, 20],
      v: [[4.76, 5.58, 6.07, 6.3, 6.4, 6.45, 6.46], [5.04, 5.85, 6.24, 6.44, 6.57, 6.63, 6.67],
          [5.26, 6.02, 6.36, 6.58, 6.76, 6.92, 7.05], [5.22, 6.03, 6.39, 6.66, 6.84, 7.05, 7.39],
          [5.02, 6, 6.47, 6.79, 7.1, 7.38, 7.68], [4.89, 5.88, 6.41, 6.74, 7.06, 7.38, 7.89],
          [4.5, 5.45, 6.17, 6.54, 6.84, 7.17, 7.77], [3.9, 4.83, 5.63, 6.23, 6.55, 6.84, 7.44]] } },
  { id: 'ensign', name: 'Pearson Ensign', lwl: 16.75, disp: 3000, sa: 235, keel: 'full', draft: 3.0 },
  { id: 'capedory25', name: 'Cape Dory 25', lwl: 18.0, disp: 4000, sa: 262, keel: 'full', draft: 3.0 },
  { id: 'power', name: 'Powerboat (fixed speed)', power: true, draft: 3.0 },
];

function boatDraftM() {               // meters; manual override wins, else the boat's spec
  if (PLAN.draftOverride) return PLAN.draftOverride * 0.3048;
  const b = BOATS.find((x) => x.id === PLAN.boat);
  return ((b && b.draft) || 3.1) * 0.3048;
}

function boatPolar(id) {
  const b = BOATS.find((x) => x.id === id) || BOATS[0];
  if (b.power) return { power: true };
  const vh = 1.34 * Math.sqrt(b.lwl);
  const sad = b.sa / Math.pow(b.disp / 64, 2 / 3);
  return {
    vh, orc: b.orc || null,
    twsSat: 12 * Math.sqrt(17 / Math.max(8, sad)),
    twaMin: b.keel === 'full' ? 45 : b.keel === 'centerboard' ? 47 : 40,
  };
}

function orcSpeed(T, twa, tws) {        // bilinear on the certificate table
  const a = clamp(Math.abs(twa), 0, 180);
  if (a < T.twa[0]) {
    // inside the table's closest-hauled point: taper to zero at 40 deg
    if (a < 40) return 0;
    return orcSpeed(T, T.twa[0], tws) * (a - 40) / (T.twa[0] - 40);
  }
  const A = T.twa, W = T.tws;
  const aa = Math.min(a, A[A.length - 1]);
  let i = 0; while (i < A.length - 2 && A[i + 1] < aa) i++;
  const fa = clamp((aa - A[i]) / (A[i + 1] - A[i]), 0, 1);
  const w = clamp(tws, W[0], W[W.length - 1]);
  let j = 0; while (j < W.length - 2 && W[j + 1] < w) j++;
  const fw = clamp((w - W[j]) / (W[j + 1] - W[j]), 0, 1);
  let v = T.v[i][j] * (1 - fa) * (1 - fw) + T.v[i + 1][j] * fa * (1 - fw)
    + T.v[i][j + 1] * (1 - fa) * fw + T.v[i + 1][j + 1] * fa * fw;
  // below the certificate's lightest wind: same saturation law as elsewhere
  if (tws < W[0]) v *= Math.tanh(1.6 * tws / 10.9) / Math.tanh(1.6 * W[0] / 10.9);
  // beyond 150 deg the table ends: real boats slow slightly dead down
  return a > A[A.length - 1] ? v * (1 - 0.08 * (a - A[A.length - 1]) / 30) : v;
}

function polarSpeed(P, twa, tws) {      // twa deg (0 = head to wind), tws kn -> boat kn
  if (PLAN.boat === 'custom' && PLAN.customPolar) {
    const C = PLAN.customPolar;         // speeds at 12 kn wind, every 15 deg from 30 to 180
    const a = clamp(Math.abs(twa), 0, 180);
    const fi = clamp((a - 30) / 15, 0, C.length - 1.001);
    const i0 = fi | 0;
    const v12 = a < 30 ? 0 : C[i0] * (1 - (fi - i0)) + C[i0 + 1] * (fi - i0);
    const sat = 12 / 1.1;
    return v12 * Math.tanh(1.6 * tws / sat) / Math.tanh(1.6 * 12 / sat);
  }
  if (P.orc) return orcSpeed(P.orc, twa, tws);
  const a = Math.abs(twa);
  if (a < P.twaMin) return 0;
  const g = a < 110
    ? 0.55 + 0.45 * Math.sin(Math.PI / 2 * (a - P.twaMin) / (110 - P.twaMin))
    : 1 - 0.22 * Math.pow((a - 110) / 70, 2);
  return P.vh * g * Math.tanh(1.6 * tws / P.twsSat);
}

function bestVMC(P, twaRhumb, tws) {    // -> [progress kn toward the mark, needs tacking]
  let best = 0, bestTwa = twaRhumb;
  for (let twa = 25; twa <= 180; twa += 5) {
    const off = twa - twaRhumb;
    if (Math.abs(off) > 85) continue;
    const v = polarSpeed(P, twa, tws) * Math.cos(off * Math.PI / 180);
    if (v > best) { best = v; bestTwa = twa; }
  }
  return [best, Math.abs(bestTwa - twaRhumb) > 25];
}

/* ---- boat picker + draggable polar editor ---- */
function initBoatUI() {
  const sel = $('plan-boat');
  if (!sel) return;
  const fill = () => {
    sel.innerHTML = BOATS.map((b) => `<option value="${b.id}">${b.name}</option>`).join('')
      + (PLAN.customPolar ? '<option value="custom">Custom polar</option>' : '');
    sel.value = PLAN.boat;
  };
  fill();
  const showSpeed = () => {
    $('plan-speed-row').hidden = PLAN.boat !== 'power';
    const dEl = $('plan-draft');
    if (dEl) dEl.textContent = 'draft ' + (boatDraftM() / 0.3048).toFixed(1) + ' ft';
  };
  showSpeed();
  sel.addEventListener('change', () => {
    PLAN.boat = sel.value;
    fill(); showSpeed(); planSave(); planRecalc();
  });
  $('plan-polar-btn').addEventListener('click', () => openPolarPad(fill));
  $('pp-cancel').addEventListener('click', () => { $('polarpad').hidden = true; });
}

function openPolarPad(refill) {
  const pad = $('polarpad'), svg = $('pp-svg');
  pad.hidden = false;
  pad.onclick = (ev) => { if (ev.target === pad) pad.hidden = true; };
  const P = boatPolar(PLAN.boat === 'custom' || PLAN.boat === 'power' ? 'seasprite23' : PLAN.boat);
  const vmax = Math.max(6, Math.ceil((P.vh || 6) * 1.25),
    PLAN.boat === 'custom' && PLAN.customPolar ? Math.ceil(Math.max(...PLAN.customPolar)) : 0);
  const CX = 22, CY = 186, R = 150;
  svg.setAttribute('viewBox', '0 8 216 356');
  // working curve: speeds at 12 kn wind, TWA 30..180 step 15
  const cur = (PLAN.boat === 'custom' && PLAN.customPolar) ? PLAN.customPolar.slice()
    : Array.from({ length: 11 }, (_, i) => {
        const a = 30 + 15 * i;
        if (P.orc) return +orcSpeed(P.orc, a, 12).toFixed(2);
        const g = a < P.twaMin ? 0 : (a < 110
          ? 0.55 + 0.45 * Math.sin(Math.PI / 2 * (a - P.twaMin) / (110 - P.twaMin))
          : 1 - 0.22 * Math.pow((a - 110) / 70, 2));
        return +(P.vh * g * Math.tanh(1.6 * 12 / P.twsSat)).toFixed(2);
      });
  const pos = (i) => {
    const a = (30 + 15 * i) * Math.PI / 180, r = cur[i] / vmax * R;
    return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
  };
  const draw = () => {
    // compact half polar: rings, the 90-degree axis carries the speed
    // numbers (standard polar-plot form), four angle marks, nothing else
    let g = '';
    for (let v = 2; v <= vmax; v += 2) {
      const r = v / vmax * R;
      g += `<path d="M ${CX} ${CY - r} A ${r} ${r} 0 0 1 ${CX} ${CY + r}" fill="none" stroke="#dfe7ee"/>`;
    }
    for (let i = 0; i < 11; i++) {
      const a = (30 + 15 * i) * Math.PI / 180;
      g += `<line x1="${CX}" y1="${CY}" x2="${(CX + R * Math.sin(a)).toFixed(1)}" y2="${(CY - R * Math.cos(a)).toFixed(1)}" stroke="#eef2f6"/>`;
    }
    g += `<line x1="${CX}" y1="${CY}" x2="${CX + R}" y2="${CY}" stroke="#b9c6d2" stroke-width="1.3"/>`;
    for (let v = 2; v <= vmax; v += 2) {
      const r = v / vmax * R;
      g += `<text x="${(CX + r).toFixed(1)}" y="${CY + 14}" font-size="10.5" font-weight="700" fill="#44586c" text-anchor="middle">${v}${v + 2 > vmax ? ' kn' : ''}</text>`;
    }
    for (const ang of [45, 90, 135, 180]) {
      const a = ang * Math.PI / 180;
      g += `<text x="${(CX + (R + 13) * Math.sin(a)).toFixed(1)}" y="${(CY - (R + 13) * Math.cos(a) + 4).toFixed(1)}" font-size="10.5" font-weight="700" fill="#44586c" text-anchor="middle">${ang}°</text>`;
    }
    const pts = Array.from({ length: 11 }, (_, i) => pos(i));
    g += `<polyline points="${pts.map((p2) => p2.map((q) => q.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="#c9531a" stroke-width="2.5" stroke-linejoin="round"/>`;
    pts.forEach((p2, i) => {
      g += `<circle cx="${p2[0].toFixed(1)}" cy="${p2[1].toFixed(1)}" r="6" fill="#c9531a" fill-opacity=".9" stroke="#fff" stroke-width="1.6" data-i="${i}"/>`;
    });
    svg.innerHTML = g;
  };
  draw();
  let dragI = -1;
  const toLocal = (ev) => {
    const b = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;      // stay honest to whatever viewBox draw() set
    const p2 = ev.touches ? ev.touches[0] : ev;
    return [(p2.clientX - b.left) * vb.width / b.width + vb.x,
            (p2.clientY - b.top) * vb.height / b.height + vb.y];
  };
  svg.onpointerdown = (ev) => {
    const [x, y] = toLocal(ev);
    let bi = -1, bd = 1e9;
    for (let i = 0; i < 11; i++) {
      const p2 = pos(i), d = Math.hypot(x - p2[0], y - p2[1]);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bd < 30) { dragI = bi; svg.setPointerCapture(ev.pointerId); }
  };
  svg.onpointermove = (ev) => {
    if (dragI < 0) return;
    const [x, y] = toLocal(ev);
    const r = Math.hypot(x - CX, y - CY);
    cur[dragI] = clamp(r / R * vmax, 0, vmax);
    draw();
  };
  svg.onpointerup = svg.onpointercancel = () => { dragI = -1; };
  const dIn = $('pp-draft');
  if (dIn) {
    dIn.value = (boatDraftM() / 0.3048).toFixed(1);
    dIn.oninput = () => {
      const v = parseFloat(dIn.value);
      PLAN.draftOverride = v > 0.4 && v < 15 ? v : null;
      const dEl = $('plan-draft');
      if (dEl) dEl.textContent = 'draft ' + (boatDraftM() / 0.3048).toFixed(1) + ' ft';
      planSave(); planRecalc();
    };
  }
  $('pp-save').onclick = () => {
    PLAN.customPolar = cur.map((v) => +v.toFixed(2));
    // 'custom' has no spec draft: carry the outgoing boat's draft forward so
    // the grounding check doesn't silently fall back to the 3.1 ft default
    if (!PLAN.draftOverride) {
      const b2 = BOATS.find((b3) => b3.id === PLAN.boat);
      if (b2 && b2.draft) PLAN.draftOverride = b2.draft;
    }
    PLAN.boat = 'custom';
    pad.hidden = true;
    if (refill) refill();
    $('plan-speed-row').hidden = true;
    const dEl = $('plan-draft');
    if (dEl) dEl.textContent = 'draft ' + (boatDraftM() / 0.3048).toFixed(1) + ' ft';
    planSave(); planRecalc();
  };
}

function planSave() {
  try {
    localStorage.setItem('whPlan1', JSON.stringify({
      p: PLAN.pts.map((p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5]),
      v: PLAN.speed, b: PLAN.boat, cp: PLAN.customPolar, d: PLAN.draftOverride,
    }));
  } catch (e) {}
}

/* ---- route history: every settled edit is a snapshot; undo/redo walk it ---- */
function planPush() {
  PLAN.hist = (PLAN.hist || []).slice(0, PLAN.hi + 1);
  PLAN.hist.push(JSON.stringify(PLAN.pts));
  if (PLAN.hist.length > 80) PLAN.hist.shift();
  PLAN.hi = PLAN.hist.length - 1;
  planBtnsUpdate();
}
function planRestore(i) {
  if (!PLAN.hist || i < 0 || i >= PLAN.hist.length) return;
  PLAN.hi = i;
  PLAN.pts = JSON.parse(PLAN.hist[i]);
  planSave(); rebuildPlanMarkers(); planRecalc(); planBtnsUpdate();
}
function planBtnsUpdate() {
  const u = $('btn-plan-undo'), r = $('btn-plan-redo');
  if (u) u.disabled = !PLAN.hist || PLAN.hi <= 0;
  if (r) r.disabled = !PLAN.hist || PLAN.hi >= PLAN.hist.length - 1;
}
function planClear() {
  if (!PLAN.pts.length) return;
  PLAN.pts = [];
  planPush(); planSave(); rebuildPlanMarkers(); planRecalc();
}
function planReverse() {
  if (PLAN.pts.length < 2) return;
  PLAN.pts.reverse();                    // sail it home — the tide differs
  planPush(); planSave(); rebuildPlanMarkers(); planRecalc();
}

const planFmtDur = (ms) => {
  const m = Math.max(1, Math.round(ms / 60e3));
  return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' m';
};
const planFmtHM = (t) => new Date(t).toLocaleTimeString('en-US',
  { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });

function togglePlan() {
  PLAN.on = !PLAN.on;
  $('btn-plan').setAttribute('aria-pressed', String(PLAN.on));
  $('plancard').hidden = !PLAN.on;
  // plan mode swaps the whole button column: chart/reset/about step aside
  // for undo/redo/reverse/clear (space is the phone's scarcest resource)
  document.body.classList.toggle('planning', PLAN.on);
  // a planning double-tap must not zoom (each tap would also drop a point)
  if (map) { if (PLAN.on) map.doubleClickZoom.disable(); else map.doubleClickZoom.enable(); }
  rebuildPlanMarkers();
  planRecalc();
  planBtnsUpdate();
  try { updateBuoyVis(); } catch (e) {}   // planning summons the marks
}

function addPlanPoint(ll) {
  if (PLAN.pts.length >= 40) return;
  PLAN.pts.push([ll.lat, ll.lng]);
  planPush();
  planSave();
  rebuildPlanMarkers();
  planRecalc();
}

function rebuildPlanMarkers() {
  map.closePopup();
  for (const m of PLAN.markers) map.removeLayer(m);
  for (const m of PLAN.mids) map.removeLayer(m);
  PLAN.markers = []; PLAN.mids = [];
  if (!PLAN.on) return;
  const icon = (cls, px) => L.divIcon({ className: 'plan-pt-wrap',
    html: `<div class="plan-pt ${cls}" style="width:${px}px;height:${px}px;margin:${(40 - px) / 2}px"></div>`,
    iconSize: [40, 40], iconAnchor: [20, 20] });
  PLAN.pts.forEach((p, i) => {
    const cls = i === 0 ? 'start' : i === PLAN.pts.length - 1 ? 'end' : '';
    const mk = L.marker(p, { icon: icon(cls, 18), draggable: true, keyboard: false });
    mk.on('drag', (e) => {
      const ll = e.target.getLatLng();
      PLAN.pts[i] = [ll.lat, ll.lng];
      // keep the neighbouring insert-handles glued to their segments
      if (PLAN.mids[i - 1]) PLAN.mids[i - 1].setLatLng(planMidOf(i - 1));
      if (PLAN.mids[i]) PLAN.mids[i].setLatLng(planMidOf(i));
      planRecalcSoon();
    });
    mk.on('dragend', () => { planPush(); planSave(); planRecalc(); });
    mk.on('click', () => {
      L.popup({ closeButton: false, offset: [0, -6] }).setLatLng(PLAN.pts[i])
        .setContent(`<button class="plan-del" data-i="${i}">✕ remove point ${i + 1}</button>`)
        .openOn(map);
    });
    mk.addTo(map);
    PLAN.markers.push(mk);
  });
  for (let i = 0; i < PLAN.pts.length - 1; i++) {
    const mm = L.marker(planMidOf(i), { icon: icon('mid', 13), draggable: true, keyboard: false });
    mm.__idx = -1;
    mm.on('dragstart', () => {
      const ll = mm.getLatLng();
      PLAN.pts.splice(i + 1, 0, [ll.lat, ll.lng]);   // becomes a real waypoint
      mm.__idx = i + 1;
    });
    mm.on('drag', (e) => {
      if (mm.__idx < 0) return;
      const ll = e.target.getLatLng();
      PLAN.pts[mm.__idx] = [ll.lat, ll.lng];
      planRecalcSoon();
    });
    mm.on('dragend', () => { planPush(); planSave(); rebuildPlanMarkers(); planRecalc(); });
    mm.addTo(map);
    PLAN.mids.push(mm);
  }
}
function planMidOf(i) {
  const a = PLAN.pts[i], b = PLAN.pts[i + 1];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/* march the route through the forecast: distance/heading per leg, wind and
   current sampled mid-chunk at the clock time you would pass through */
function planRecalc() {
  if (PLAN.lineLayer) { map.removeLayer(PLAN.lineLayer); PLAN.lineLayer = null; }
  if (PLAN.etaMk) { map.removeLayer(PLAN.etaMk); PLAN.etaMk = null; }
  PLAN.tDep = PLAN.tArr = null; PLAN.anyRed = false; PLAN.anyGround = false;
  const stats = $('plan-stats');
  if (PLAN.pts.length < 2) {
    if (stats) stats.textContent = PLAN.pts.length ? 'tap the water for your next point' : 'tap the water to drop waypoints';
    updatePlanBand();
    return;
  }
  let t = clamp(S.tScrub, S.tMin, S.tMax);
  const t0 = t;
  let distTot = 0;
  const runs = [];                       // consecutive same-color chunk runs
  for (let i = 0; i < PLAN.pts.length - 1; i++) {
    const a = PLAN.pts[i], b = PLAN.pts[i + 1];
    const dxE = (b[1] - a[1]) * M_LNG, dyN = (b[0] - a[0]) * M_LAT;
    const dist = Math.hypot(dxE, dyN);
    distTot += dist;
    if (dist < 1) continue;
    const hdg = (Math.atan2(dxE, dyN) * 180 / Math.PI + 360) % 360;
    const ux = dxE / dist, uy = dyN / dist;         // track unit vector (E, N)
    const n = clamp(Math.ceil(dist / 700), 1, 30);
    for (let c = 0; c < n; c++) {
      const f0 = c / n, f1 = (c + 1) / n, fm = (f0 + f1) / 2;
      const mlat = a[0] + (b[0] - a[0]) * fm, mlng = a[1] + (b[1] - a[1]) * fm;
      const ts = clamp(t, S.tMin, S.tMax);
      const P = boatPolar(PLAN.boat);
      let red = false, vw = PLAN.speed;
      if (!P.power && S.wind) {
        const tw = clamp(ts, S.wind.times[0], S.wind.times[S.wind.times.length - 1]);
        const w = sampleWind(mlat, mlng, tw);
        const ws = Math.hypot(w[0], w[1]);
        if (ws > 1.2) {
          // TWA of the rhumb line; the polar picks the best heading and
          // its cos-projection IS the tacked/gybed progress speed (VMC)
          const from = (Math.atan2(-w[0], -w[1]) * 180 / Math.PI + 360) % 360;
          const twaR = Math.abs(((hdg - from + 540) % 360) - 180);
          const r2 = bestVMC(P, twaR, ws);
          vw = r2[0]; red = r2[1];
        } else vw = 0.5;                             // drifting air
      }
      const dEff = dist / n;
      // land or water thinner than the boat's draft at passage time: red,
      // regardless of wind. Sampled at three points so a 700 m step cannot
      // hop a shoal unnoticed.
      const draftM = boatDraftM();
      let ground = false;
      for (const ff of [f0, fm, f1]) {
        const gla = a[0] + (b[0] - a[0]) * ff, glo = a[1] + (b[1] - a[1]) * ff;
        const dep = depthMLLW(gla, glo);
        if (dep == null || dep <= 0 || dep + localTideM(gla, glo, ts) < draftM) { ground = true; break; }
      }
      if (ground) { red = true; PLAN.anyGround = true; }
      const cur = sampleWater(mlat, mlng, ts);
      // holding the rhumb line against a cross-set means crabbing: ground
      // speed made good is along + sqrt(vw^2 - cross^2), not vw + along
      const along = cur[0] * ux + cur[1] * uy;       // fair or foul current, kn
      const cross = cur[1] * ux - cur[0] * uy;       // set perpendicular to the leg
      const thru = vw > Math.abs(cross) ? Math.sqrt(vw * vw - cross * cross) : 0;
      const sog = Math.max(0.8, along + thru);
      t += (dEff / 1852) / sog * 3600e3;
      const p0 = [a[0] + (b[0] - a[0]) * f0, a[1] + (b[1] - a[1]) * f0];
      const p1 = [a[0] + (b[0] - a[0]) * f1, a[1] + (b[1] - a[1]) * f1];
      const last = runs[runs.length - 1];
      if (last && last.red === red && last.leg === i) last.pts.push(p1);
      else runs.push({ red, leg: i, pts: [p0, p1] });
      if (red) PLAN.anyRed = true;
    }
  }
  PLAN.tDep = t0; PLAN.tArr = t;
  const lines = [];
  for (const r of runs) {
    const col = r.red ? '#e8503a' : '#37e08a';
    lines.push(L.polyline(r.pts, { color: col, weight: 8, opacity: 0.16, interactive: false,
      className: r.red ? 'plan-line-r' : 'plan-line-g' }));
    lines.push(L.polyline(r.pts, { color: col, weight: 3, opacity: 0.95, interactive: false,
      className: r.red ? 'plan-line-r' : 'plan-line-g' }));
  }
  PLAN.lineLayer = L.layerGroup(lines).addTo(map);
  markWrongSideBuoys();
  const durTxt = planFmtDur(t - t0), hmTxt = planFmtHM(t);
  PLAN.etaMk = L.marker(PLAN.pts[PLAN.pts.length - 1], {
    icon: L.divIcon({ className: 'plan-eta', html: `${durTxt} · ${hmTxt}`, iconSize: null, iconAnchor: [-12, -10] }),
    interactive: false, keyboard: false,
  }).addTo(map);
  if (stats) {
    stats.innerHTML = `${(distTot / 1852).toFixed(1)} nm · ${durTxt} · arrive ${hmTxt}`;
  }
  updatePlanBand();
}
let planRafP = false, planLastFull = 0;
function planRecalcSoon() {
  if (planRafP) return;
  // during playback every frame asks for a re-march; the route doesn't
  // need sub-second ETA updates while the scrubber sweeps
  if (S.playing && performance.now() - planLastFull < 500) return;
  planRafP = true;
  requestAnimationFrame(() => {
    planRafP = false;
    planLastFull = performance.now();
    planRecalc();
  });
}

/* the trip occupies a slice of the forecast: shade it on the timeline */
function updatePlanBand() {
  const svg = $('timeline');
  if (!svg || !TL.w) return;
  let el = document.getElementById('planband');
  if (PLAN.tArr == null || PLAN.pts.length < 2) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    el.id = 'planband';
    const cur = document.getElementById('scrubcursor');
    svg.insertBefore(el, cur);
  }
  const x = (t) => TL.padL + tlWarp(clamp(t, S.tMin, S.tMax)) * (TL.w - TL.padL - TL.padR);
  el.setAttribute('x', x(PLAN.tDep).toFixed(1));
  el.setAttribute('y', '0');
  el.setAttribute('width', Math.max(2, x(PLAN.tArr) - x(PLAN.tDep)).toFixed(1));
  el.setAttribute('height', String(TL.h));
}

function initPlan() {
  try {
    const s = JSON.parse(localStorage.getItem('whPlan1') || 'null');
    if (s && Array.isArray(s.p)) {
      PLAN.pts = s.p.filter((p) => p && p.length === 2);
      PLAN.speed = clamp(+s.v || 7, 0.5, 60);
      if (Array.isArray(s.cp) && s.cp.length === 11) PLAN.customPolar = s.cp;
      if (s.b && (BOATS.some((x) => x.id === s.b) || (s.b === 'custom' && PLAN.customPolar))) PLAN.boat = s.b;
      if (s.d > 0.4 && s.d < 15) PLAN.draftOverride = s.d;
    }
  } catch (e) {}
  $('plan-speed').value = String(PLAN.speed);
  initBoatUI();
  $('btn-plan').addEventListener('click', togglePlan);
  $('plan-speed').addEventListener('input', () => {
    PLAN.speed = clamp(parseFloat($('plan-speed').value) || 7, 0.5, 60);
    planSave(); planRecalc();
  });
  $('btn-plan-clear').addEventListener('click', planClear);
  $('btn-plan-rev').addEventListener('click', planReverse);
  $('btn-plan-undo').addEventListener('click', () => planRestore(PLAN.hi - 1));
  $('btn-plan-redo').addEventListener('click', () => planRestore(PLAN.hi + 1));
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('.plan-del') : null;
    if (!b) return;
    PLAN.pts.splice(+b.dataset.i, 1);
    map.closePopup();
    planPush(); planSave(); rebuildPlanMarkers(); planRecalc();
  });
  // history starts at whatever the last session left behind
  PLAN.hist = [JSON.stringify(PLAN.pts)];
  PLAN.hi = 0;
  planBtnsUpdate();
  if (PLAN.pts.length) planRecalc();     // saved route reappears (view-only)
}

// 1 mi / 1 km scale bar (Leaflet's, restyled) — length adapts to zoom
function initScaleBar() {
  L.control.scale({ position: 'bottomleft', metric: true, imperial: true, maxWidth: 110 }).addTo(map);
}

/* ---- navigation buoys (baked from the ENC vectors) ----
   Shown only when they earn their pixels: chart mode or plan mode, z >= 12.
   Tiny IALA shapes — red nun, green can, banded preferred-channel, safe
   water. Tap = full name; tap while PLANNING = a waypoint ON the buoy,
   because that is how routes are actually run. */
let buoyLayer = null, buoyData = null;
const buoyMarks = [];
/* a lateral buoy guards its shoal side; the shoal direction is read from
   the bathymetry itself (steepest descent of depth around the mark), so
   no rulebook is hardcoded. A planned leg passing the mark on that side
   makes the buoy glow with a small warning. */
function markWrongSideBuoys() {
  for (const bm of buoyMarks) {
    const el = bm.mk.getElement();
    if (el) el.classList.remove('buoy-wrong');
  }
  if (!PLAN.on || PLAN.pts.length < 2 || !buoyMarks.length) return;
  for (const bm of buoyMarks) {
    const b2 = bm.b;
    if (b2.k !== 'r' && b2.k !== 'g') continue;
    // shoal direction: sample depth on an 8-point ring 70 m out
    let sx = 0, sy = 0, shallowest = 1e9;
    for (let q = 0; q < 8; q++) {
      const th = q * Math.PI / 4;
      const la = b2.la + Math.cos(th) * 70 / M_LAT, lo = b2.lo + Math.sin(th) * 70 / M_LNG;
      const dep = depthMLLW(la, lo);
      const dv = dep == null || dep <= 0 ? -1 : dep;
      if (dv < shallowest) { shallowest = dv; sx = Math.sin(th); sy = Math.cos(th); }
    }
    if (shallowest > boatDraftM() + 0.6) continue;     // no guarded shoal near this mark
    for (let i = 0; i < PLAN.pts.length - 1 && !(bm.mk.getElement() || {}).classList?.contains('buoy-wrong'); i++) {
      const a2 = PLAN.pts[i], c2 = PLAN.pts[i + 1];
      const ax = (a2[1] - b2.lo) * M_LNG, ay = (a2[0] - b2.la) * M_LAT;
      const cx = (c2[1] - b2.lo) * M_LNG, cy = (c2[0] - b2.la) * M_LAT;
      const dx = cx - ax, dy = cy - ay;
      const L2 = dx * dx + dy * dy || 1;
      const tproj = clamp(-(ax * dx + ay * dy) / L2, 0, 1);
      const px = ax + tproj * dx, py = ay + tproj * dy;   // closest point, meters from buoy
      const dist = Math.hypot(px, py);
      if (dist > 140) continue;
      if (px * sx + py * sy > 0) {                       // passes on the shoal side
        const el = bm.mk.getElement();
        if (el) el.classList.add('buoy-wrong');
      }
    }
  }
}


function buoySVG(k) {
  // 12x16 side-view buoy, anchored at the waterline (bottom center)
  const hull = '<path d="M2.5 10 L9.5 10 L8.6 13.4 L3.4 13.4 Z" fill="%H"/>';
  const water = '<ellipse cx="6" cy="13.6" rx="4.4" ry="1.1" fill="rgba(60,110,150,.45)"/>';
  let top = '';
  let hc = '#c0392b';
  if (k === 'r') { hc = '#c0392b'; top = '<path d="M4 10 L6 3.2 L8 10 Z" fill="#c0392b"/>'; }
  else if (k === 'g') { hc = '#1e8449'; top = '<rect x="4" y="4" width="4" height="6" rx="0.7" fill="#1e8449"/>'; }
  else if (k === 'rg') { hc = '#c0392b'; top = '<path d="M4 10 L6 3.2 L8 10 Z" fill="#c0392b"/><rect x="3.9" y="7.2" width="4.2" height="1.8" fill="#1e8449"/>'; }
  else if (k === 'gr') { hc = '#1e8449'; top = '<rect x="4" y="4" width="4" height="6" rx="0.7" fill="#1e8449"/><rect x="4" y="6.4" width="4" height="1.8" fill="#c0392b"/>'; }
  else if (k === 'sw') { hc = '#c0392b'; top = '<circle cx="6" cy="7" r="3.1" fill="#fff" stroke="#c0392b" stroke-width="1.6"/><circle cx="6" cy="2.8" r="1.1" fill="#c0392b"/>'; }
  else { hc = '#d4ac0d'; top = '<circle cx="6" cy="7" r="3.1" fill="#d4ac0d"/>'; }
  return '<svg class="bglyph" viewBox="0 0 12 15" width="12" height="15">'
    + top + hull.replace('%H', hc) + water + '</svg>';
}

async function initBuoys() {
  try {
    const d = await fetchJSON('data/buoys.json?v=1', 24 * 3600e3);
    if (!d || !d.buoys) return;
    buoyData = d.buoys;
    buoyMarks.length = 0;
    const marks = buoyData.map((b) => {
      const mk = L.marker([b.la, b.lo], {
        icon: L.divIcon({ className: 'buoyw',
          html: `<div class="btilt">${buoySVG(b.k)}<div class="bwarn">!</div></div>`,
          iconSize: [22, 22], iconAnchor: [11, 16] }),
        keyboard: false, title: b.n || b.s,
      });
      buoyMarks.push({ b, mk });
      mk.on('click', () => {
        if (PLAN.on) { addPlanPoint(L.latLng(b.la, b.lo)); return; }   // snap the route to the mark
        L.popup({ closeButton: false, offset: [0, -4] })
          .setLatLng([b.la, b.lo]).setContent(`<div class="buoy-name">${b.n || 'buoy ' + b.s}</div>`)
          .openOn(map);
      });
      return mk;
    });
    buoyLayer = L.layerGroup(marks);
    map.on('zoomend', updateBuoyVis);
    map.on('moveend', buoyTiltTick);
    updateBuoyVis();
  } catch (e) {}
}
function buoyTiltTick() {
  if (!buoyLayer || !map.hasLayer(buoyLayer)) return;
  const t = S.tScrub, bounds = map.getBounds();
  for (const bm of buoyMarks) {
    if (!bounds.contains([bm.b.la, bm.b.lo])) continue;
    const el = bm.mk.getElement();
    if (!el) continue;
    const inner = el.firstChild;
    const c = sampleWater(bm.b.la, bm.b.lo, t);
    const spd = Math.hypot(c[0], c[1]);
    if (spd < 0.15) { inner.style.transform = ''; continue; }
    // heel downstream about the waterline: the screen sees the east-west
    // component of a 3D lean; toward/away flow reads as a slight squash
    const brg = Math.atan2(c[0], c[1]);
    const lean = Math.min(34, 8 + spd * 9);
    const rot = lean * Math.sin(brg);
    const squash = 1 - 0.015 * Math.abs(Math.cos(brg)) * lean / 10;
    inner.style.transform = `rotate(${rot.toFixed(1)}deg) scaleY(${squash.toFixed(3)})`;
  }
}

function updateBuoyVis() {
  if (!buoyLayer) return;
  const want = (encOn || PLAN.on) && map.getZoom() >= 15;
  const have = map.hasLayer(buoyLayer);
  if (want && !have) {
    buoyLayer.addTo(map);
    // fresh icon elements: any wrong-side classes from the last planRecalc
    // are gone, and markers born off-map never got them at all
    try { markWrongSideBuoys(); } catch (e) {}
  } else if (!want && have) map.removeLayer(buoyLayer);
}

/* --------------- live AIS (aisstream.io) ---------------
   Real vessel positions inside the frame: the ferries above all, which
   also lets the drawn routes be checked against reality. One live
   websocket, nothing scheduled anywhere: aisstream discourages browser
   clients and in mid-2026 its edge sheds NEW connections under load
   (x-envoy-overloaded 503s, verified 2026-07-22) while established ones
   keep streaming, so a won connection is precious: never double-dial,
   retry with backoff, reset on success. Markers expire after 12 minutes
   without a report; the source-health badge says when the feed is out. */
const AIS_DEFAULT_KEY = '';
const AIS_KEY = (() => { try { return localStorage.getItem('whAisKey') || AIS_DEFAULT_KEY; } catch (e) { return AIS_DEFAULT_KEY; } })();
const AIS_LOCAL_RELAY = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const AIS_STREAM_URL = AIS_LOCAL_RELAY
  ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${new URL('api/ais', location.href).pathname}`
  : 'wss://stream.aisstream.io/v0/stream';
const aisShips = new Map();
let aisLayer = null, aisWS = null, aisRedrawT = null, aisDelay = 20e3;
let aisLastMsg = 0, aisDialAt = 0, aisRetryT = null;
const AIS_T0 = Date.now();
// the area's ferry fleet by AIS name (SSA, Hy-Line, Seastreak, Island
// Queen): tapping one pops the same route corridors as the terminals
const AIS_FERRY_RE = /VINEYARD|ISLAND HOME|NANTUCKET|WOODS HOLE|EAGLE|SANKATY|GAY HEAD|KATAMA|MONOMOY|GOVERNOR|SEASTREAK|ISLAND QUEEN|GREY LADY|LADY MARTHA/i;

function initAIS() {
  aisLayer = L.layerGroup().addTo(map);
  aisConnect();
  setInterval(aisPrune, 60e3);
  // the source-health badge is otherwise event-driven; tick it so boat
  // feed state stays current while the page sits idle
  setInterval(() => { try { requestReadout(); } catch (e) {} }, 60e3);
  // A websocket can remain OPEN while an upstream edge stops forwarding
  // reports. Treat three silent minutes (or a 30 s handshake) as stale and
  // redial; otherwise the existing readyState guard would leave AIS down
  // forever despite showing a nominally connected socket.
  setInterval(aisWatch, 30e3);
  // a tab surfacing from the background re-dials immediately at base delay
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (!aisWS || aisWS.readyState > 1)) { aisDelay = 20e3; aisConnect(); }
  });
}

function aisConnect() {
  if (!AIS_LOCAL_RELAY && !AIS_KEY) return;
  if (aisWS && aisWS.readyState <= 1) return;   // one socket, ever
  if (aisRetryT) { clearTimeout(aisRetryT); aisRetryT = null; }
  try {
    aisDialAt = Date.now();
    aisWS = new WebSocket(AIS_STREAM_URL);
    aisWS.binaryType = 'arraybuffer';
    aisWS.onopen = () => {
      aisDialAt = 0;
      aisDelay = 20e3;
      // Local development uses one server-side relay for every browser tab;
      // AISStream explicitly does not support browser-origin clients. Static
      // hosting retains the legacy direct connection as a best-effort fallback.
      if (!AIS_LOCAL_RELAY) {
        aisWS.send(JSON.stringify({
          APIKey: AIS_KEY,
          BoundingBoxes: [[[41.20, -71.05], [41.70, -70.30]]],
          FilterMessageTypes: ['PositionReport'],
        }));
      }
    };
    aisWS.onmessage = (ev) => {
      let d = null;
      try {
        const txt = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
        d = JSON.parse(txt);
      } catch (e) { return; }
      if (!d || d.MessageType !== 'PositionReport') return;
      const md = d.MetaData || {};
      const pr = (d.Message && d.Message.PositionReport) || {};
      const mmsi = md.MMSI;
      if (!mmsi || md.latitude == null) return;
      aisLastMsg = Date.now();
      let sh = aisShips.get(mmsi);
      if (!sh) { sh = { mk: null }; aisShips.set(mmsi, sh); }
      sh.lat = md.latitude; sh.lng = md.longitude;
      sh.name = (md.ShipName || '').trim() || ('MMSI ' + mmsi);
      sh.cog = pr.Cog != null && pr.Cog < 360 ? pr.Cog : null;
      sh.sog = pr.Sog != null && pr.Sog < 100 ? pr.Sog : null;
      sh.t = Date.now();
      if (!aisRedrawT) aisRedrawT = setTimeout(aisRender, 1500);
    };
    // backoff toward 3 min while the feed sheds connections; overflow
    // rejects are cheap for the server and slots free up unpredictably,
    // so retries stay reasonably eager. A successful open resets to 20 s.
    aisWS.onclose = () => {
      aisWS = null;
      aisDialAt = 0;
      if (!aisRetryT) {
        const wait = aisDelay;
        aisDelay = Math.min(aisDelay * 1.6, 180e3);
        aisRetryT = setTimeout(() => { aisRetryT = null; aisConnect(); }, wait);
      }
    };
    aisWS.onerror = () => { try { aisWS.close(); } catch (e) {} };
  } catch (e) {
    aisWS = null;
    aisDialAt = 0;
    if (!aisRetryT) {
      const wait = aisDelay;
      aisDelay = Math.min(aisDelay * 1.6, 180e3);
      aisRetryT = setTimeout(() => { aisRetryT = null; aisConnect(); }, wait);
    }
  }
}

function aisWatch() {
  const now = Date.now();
  if (!aisWS || aisWS.readyState > 1) { if (!aisRetryT) aisConnect(); return; }
  const handshakeStale = aisWS.readyState === 0 && aisDialAt && now - aisDialAt > 30e3;
  const feedStale = aisWS.readyState === 1 && now - (aisLastMsg || AIS_T0) > 3 * 60e3;
  if (handshakeStale || feedStale) {
    try { aisWS.close(); } catch (e) {
      aisWS = null;
      aisConnect();
    }
  }
}

function aisRender() {
  aisRedrawT = null;
  for (const [, sh] of aisShips) {
    if (!sh.mk) {
      // same visual language as the ferry terminals: a ship glyph, not
      // another arrow (the frame already carries two vector fields); the
      // soft pulsing halo says "live transponder", course lives in the popup
      sh.mk = L.marker([sh.lat, sh.lng], {
        icon: L.divIcon({ className: 'ais-ship', html: '<span class="glyph">⛴</span>', iconSize: [22, 22], iconAnchor: [11, 11] }),
        keyboard: false,
      }).addTo(aisLayer);
      sh.mk.bindPopup(() => {
        const age = Math.round((Date.now() - sh.t) / 60e3);
        return `<b class="pname">${sh.name}</b><br>${sh.sog != null ? sh.sog.toFixed(1) + ' kn' : ''}` +
          `${sh.cog != null ? ' → ' + Math.round(sh.cog) + '°' : ''} <small>· ${age < 1 ? 'now' : age + ' min ago'}</small>`;
      }, { closeButton: false });
      sh.mk.on('popupopen', () => { if (AIS_FERRY_RE.test(sh.name || '')) showFerryRoutes(); });
      sh.mk.on('popupclose', hideFerryRoutes);
    } else {
      sh.mk.setLatLng([sh.lat, sh.lng]);
    }
    const el = sh.mk.getElement();
    if (el) {
      el.classList.toggle('slow', !(sh.sog > 0.5));
      el.classList.toggle('moving', sh.sog > 0.5);
    }
  }
}

function aisPrune() {
  const cut = Date.now() - 12 * 60e3;
  for (const [k, sh] of aisShips) {
    if (sh.t < cut) { if (sh.mk) aisLayer.removeLayer(sh.mk); aisShips.delete(k); }
  }
}

/* --------------- ferry terminals: schedules + live ship positions --------------- */

// every terminal tap draws ALL the area's habitual boat tracks (glowing
// green), cleared when the popup closes. SSA boats clear Great Harbor's
// mouth south of Juniper, pass south of Nobska, and round the Chops;
// Seastreak's NYC boat runs the length of the Sound westbound; the Island
// Queen and Patriot cross from Falmouth; Hy-Line heads for Hyannis.
const FERRY_ROUTES = {
  whvh: [[41.5238, -70.6693], [41.5180, -70.6658], [41.5122, -70.6608],
         [41.5075, -70.6505], [41.5052, -70.6330], [41.4980, -70.6160],
         [41.4870, -70.6035], [41.4815, -70.5990], [41.4720, -70.5945],
         [41.4620, -70.5950], [41.4545, -70.5992]],
  whob: [[41.5238, -70.6693], [41.5180, -70.6658], [41.5122, -70.6608],
         [41.5075, -70.6505], [41.5052, -70.6330], [41.4940, -70.6040],
         [41.4830, -70.5820], [41.4725, -70.5625], [41.4700, -70.5570],
         [41.4610, -70.5535], [41.4577, -70.5558]],
  // Seastreak's NYC boat: clears East Chop then runs MID-SOUND westbound —
  // south of the Elizabeths the whole way out past Cuttyhunk
  obnyc: [[41.4577, -70.5558], [41.4680, -70.5560], [41.4780, -70.6120],
          [41.4600, -70.6600], [41.4480, -70.7300], [41.4340, -70.8100],
          [41.4150, -70.8900], [41.4000, -70.9450]],
  hyl:   [[41.4577, -70.5558], [41.4700, -70.5420], [41.4900, -70.5050],
          [41.5250, -70.4550], [41.5600, -70.4100]],
};
const ALL_ROUTES = ['whvh', 'whob', 'obnyc', 'hyl'];

// real route geometry from OpenStreetMap (tools/bake_ferries.py) replaces
// the hand-drawn tracks above wherever OSM has the named route
async function loadFerryRoutes() {
  try {
    const d = await fetchJSON('data/ferry_routes.json?v=3', 6 * 3600e3);
    for (const k in d) if (FERRY_ROUTES[k] && d[k].length > 2) FERRY_ROUTES[k] = d[k];
  } catch (e) {}
}

// THE ACTUAL SSA SUMMER SCHEDULE — transcribed from the Authority's own
// published PDF (mv3, June 19 – September 10, 2026): real departures AND
// real arrivals per terminal, including the Fri/Sat/Sun vs Mon-Thu splits.
// day flags: d = daily, fss = Fri/Sat/Sun only, mt = Mon-Thu only.
const FERRY_SCHED_NOTE = 'SSA summer schedule · Jun 19 – Sep 10, 2026';
const M = (h, m, day) => ({ t: h * 60 + m, day: day || 'd' });
const SSA = {
  whDepVH: [M(6, 0), M(7, 0), M(8, 15), M(10, 45), M(13, 15), M(15, 45),
            M(18, 15), M(18, 35, 'mt'), M(20, 30), M(20, 45, 'fss'), M(21, 45)],
  whDepOB: [M(6, 35), M(8, 45), M(9, 30), M(11, 10), M(12, 0), M(13, 40),
            M(14, 30), M(16, 10), M(17, 0), M(18, 35, 'fss'), M(19, 30)],
  whArrVH: [M(6, 15), M(6, 45), M(7, 45), M(9, 0), M(10, 15), M(12, 45),
            M(15, 15), M(17, 45), M(20, 0), M(20, 20, 'mt'), M(22, 15)],
  whArrOB: [M(8, 25), M(10, 40), M(11, 30), M(13, 10), M(14, 0), M(15, 40),
            M(16, 30), M(18, 10), M(19, 0), M(20, 20, 'fss'), M(21, 15)],
  vhDep:   [M(5, 30), M(6, 0), M(7, 0), M(8, 15), M(9, 30), M(12, 0),
            M(14, 30), M(17, 0), M(19, 15), M(19, 35, 'mt'), M(21, 30)],
  vhArr:   [M(6, 45), M(7, 45), M(9, 0), M(10, 15), M(11, 30), M(14, 0),
            M(16, 30), M(19, 0), M(19, 20, 'mt'), M(21, 15), M(21, 30, 'fss'), M(22, 30)],
  obDep:   [M(7, 40), M(9, 55), M(10, 45), M(12, 25), M(13, 15), M(14, 55),
            M(15, 45), M(17, 25), M(18, 15), M(19, 35, 'fss'), M(20, 30)],
  obArr:   [M(7, 20), M(9, 30), M(10, 15), M(11, 55), M(12, 45), M(14, 25),
            M(15, 15), M(16, 55), M(17, 45), M(19, 20, 'fss'), M(20, 15)],
};

const FERRY_PORTS = [
  { name: 'Woods Hole terminal — Steamship Authority', lat: 41.5238, lng: -70.6693,
    rows: [
      ['departs → Vineyard Haven', SSA.whDepVH],
      ['departs → Oak Bluffs', SSA.whDepOB],
      ['arrives from Vineyard Haven', SSA.whArrVH],
      ['arrives from Oak Bluffs', SSA.whArrOB],
    ] },
  { name: 'Vineyard Haven terminal — Steamship Authority', lat: 41.4545, lng: -70.5992,
    rows: [
      ['departs → Woods Hole', SSA.vhDep],
      ['arrives from Woods Hole', SSA.vhArr],
    ] },
  { name: 'Oak Bluffs terminal — Steamship Authority', lat: 41.4577, lng: -70.5558,
    rows: [
      ['departs → Woods Hole', SSA.obDep],
      ['arrives from Woods Hole', SSA.obArr],
    ] },
];

let ferryRouteLayer = null;
function showFerryRoutes() {
  hideFerryRoutes();
  // a soft CORRIDOR, not a hairline: the drawn tracks are habitual
  // centerlines and the real boats run a few hundred feet either side
  // (watch the MARTHA'S VINEYARD live), so the band says "expect ferries
  // through here" while the faint dashed line marks the nominal track
  const lines = [];
  for (const k of ALL_ROUTES) {
    const pts = FERRY_ROUTES[k];
    lines.push(L.polyline(pts, { color: '#37e08a', weight: 26, opacity: 0.10,
      interactive: false, className: 'ferry-route-soft' }));
    lines.push(L.polyline(pts, { color: '#37e08a', weight: 13, opacity: 0.14,
      interactive: false, className: 'ferry-route-soft' }));
    lines.push(L.polyline(pts, { color: '#37e08a', weight: 2, opacity: 0.55,
      interactive: false, className: 'ferry-route', dashArray: '1 7' }));
  }
  ferryRouteLayer = L.layerGroup(lines).addTo(map);
}
function hideFerryRoutes() {
  if (ferryRouteLayer) { map.removeLayer(ferryRouteLayer); ferryRouteLayer = null; }
}

/* Scrubbed-time ferry prediction: off LIVE, dead-reckon the scheduled
   boats along their corridors (all four SSA legs are 45-minute
   crossings; verified dep→arr pairs in the timetable above). Ghost
   glyphs, no pulse: this is the schedule speaking, not AIS. */
let ferryGhostLayer = null;
function updateFerryGhosts() {
  if (ferryGhostLayer) { map.removeLayer(ferryGhostLayer); ferryGhostLayer = null; }
  // live boats fade when the clock is scrubbed: a real position is a lie
  // at any other time
  aisShips.forEach((sh) => {
    if (sh.mk && sh.mk._icon) sh.mk._icon.classList.toggle('timefade', !S.live);
  });
  if (S.live) return;
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(new Date(S.tScrub)).reduce((o, p2) => (o[p2.type] = p2.value, o), {});
  const nowMin = (+et.hour) * 60 + (+et.minute);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(et.weekday);
  const runs = (e) => e.day === 'd'
    || (e.day === 'fss' && (dow === 5 || dow === 6 || dow === 0))
    || (e.day === 'mt' && dow >= 1 && dow <= 4);
  const hhmm2 = (mins) => {
    const m2 = ((mins % 1440) + 1440) % 1440, h = Math.floor(m2 / 60);
    return (((h + 11) % 12) + 1) + ':' + String(m2 % 60).padStart(2, '0') + (h < 12 ? 'a' : 'p');
  };
  const DUR = 45;
  const legs = [
    [SSA.whDepVH, 'whvh', 1, 'Woods Hole → Vineyard Haven'],
    [SSA.vhDep, 'whvh', -1, 'Vineyard Haven → Woods Hole'],
    [SSA.whDepOB, 'whob', 1, 'Woods Hole → Oak Bluffs'],
    [SSA.obDep, 'whob', -1, 'Oak Bluffs → Woods Hole'],
  ];
  const mks = [];
  for (const [deps, rk, dir, nm] of legs) {
    const pts = FERRY_ROUTES[rk];
    if (!pts || pts.length < 2) continue;
    for (const e of deps) {
      if (!runs(e)) continue;
      const u0 = (nowMin - e.t) / DUR;
      if (u0 <= 0.02 || u0 >= 0.98) continue;
      const u = dir === 1 ? u0 : 1 - u0;
      let total = 0;
      const seg = [];
      for (let i = 1; i < pts.length; i++) {
        const d2 = Math.hypot(pts[i][0] - pts[i - 1][0], (pts[i][1] - pts[i - 1][1]) * 0.75);
        seg.push(d2); total += d2;
      }
      let want = u * total, la = pts[0][0], lo = pts[0][1];
      for (let i = 0; i < seg.length; i++) {
        if (want <= seg[i]) {
          const f2 = seg[i] ? want / seg[i] : 0;
          la = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f2;
          lo = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f2;
          break;
        }
        want -= seg[i];
      }
      const ic = L.divIcon({ className: 'ais-ship ghost', html: '<span class="glyph">⛴</span>', iconSize: [26, 26], iconAnchor: [13, 13] });
      const mk = L.marker([la, lo], { icon: ic, title: 'scheduled ferry' });
      mk.bindPopup(`<div class="spot ferry"><b>${nm}</b><div class="sub">timetable position · departed ${hhmm2(e.t)} ET</div></div>`);
      mks.push(mk);
    }
  }
  if (mks.length) ferryGhostLayer = L.layerGroup(mks).addTo(map);
}

function initFerries() {
  const hhmm = (mins) => {
    const m2 = ((mins % 1440) + 1440) % 1440;
    return String(Math.floor(m2 / 60)).padStart(2, '0') + ':' + String(m2 % 60).padStart(2, '0');
  };
  for (const p of FERRY_PORTS) {
    const ic = L.divIcon({ className: 'ferry-ico', html: '⛴', iconSize: [22, 22], iconAnchor: [11, 11] });
    const mk = L.marker([p.lat, p.lng], { icon: ic, title: p.name }).addTo(map);
    mk.bindPopup(() => {
      // times already gone by are of no use to a boat — show what's coming,
      // honoring today's Fri/Sat/Sun vs Mon-Thu schedule split. The printed
      // schedule is Eastern: read the clock in Eastern, not viewer-local
      const et = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short',
      }).formatToParts(new Date()).reduce((o, p2) => (o[p2.type] = p2.value, o), {});
      const nowMin = (+et.hour) * 60 + (+et.minute);
      const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(et.weekday);
      const runsToday = (e) => e.day === 'd'
        || (e.day === 'fss' && (dow === 5 || dow === 6 || dow === 0))
        || (e.day === 'mt' && dow >= 1 && dow <= 4);
      const d = document.createElement('div');
      d.className = 'spot ferry';
      const rows = p.rows.map(([label, times]) => {
        const left = times.filter((e) => runsToday(e) && e.t >= nowMin).map((e) => hhmm(e.t));
        return `<div class="fr"><span>${label}</span><em>${left.length ? left.join(' · ') : 'done for today'}</em></div>`;
      }).join('');
      d.innerHTML = `<b>${p.name}</b>` + rows + `<div class="sub">${FERRY_SCHED_NOTE}</div>`;
      return d;
    }, { maxWidth: 310 });
    mk.on('popupopen', showFerryRoutes);
    mk.on('popupclose', hideFerryRoutes);
  }
}

/* --------------- passage windows (tap the current chip) ---------------
   The Eldridge question, answered from the live event ladder: when does
   the Strait run fair each way, and how hard at peak. Flood sets toward
   the Sound, ebb toward Buzzards Bay. */
function initTransit() {
  const card = $('transitcard');
  if (!card) return;
  const openers = [$('chip-cur')].filter(Boolean);
  const dismiss = (e) => {
    if (card.contains(e.target) || openers.some((o) => o.contains(e.target))) return;
    card.hidden = true;
    document.removeEventListener('pointerdown', dismiss);
  };
  for (const el of openers) {
    el.addEventListener('click', () => {
      if (!card.hidden) { card.hidden = true; return; }
      renderTransit();
      card.hidden = false;
      setTimeout(() => document.addEventListener('pointerdown', dismiss), 0);
    });
  }
}

function renderTransit() {
  const rows = $('transit-rows');
  if (!rows) return;
  const prim = S.currents.find((c) => c.cfg.primary) || S.currents[0];
  if (!prim || !(prim.events || []).length) {
    rows.innerHTML = '<div class="tr-row">current stations unavailable</div>';
    return;
  }
  const evs = prim.events.filter((e) => e.t > S.tNow - 9 * 3600e3 && e.t < S.tNow + 44 * 3600e3);
  let html = '';
  for (let i = 0; i < evs.length; i++) {
    const m = evs[i];
    if (m.type === 'slack') continue;
    const s0 = evs.slice(0, i).reverse().find((e) => e.type === 'slack');
    const s1 = evs.slice(i + 1).find((e) => e.type === 'slack');
    if (!s0 || !s1 || s1.t < S.tNow) continue;
    const fair = m.type === 'flood' || m.v >= 0;
    const live = S.tNow >= s0.t && S.tNow <= s1.t;
    html += `<div class="tr-row${live ? ' on' : ''}">`
      + `<em>${fair ? '→ Sound' : '→ Buzzards'}</em>`
      + `<span>${fmtDW.format(s0.t)} ${fmtT.format(s0.t)} – ${fmtT.format(s1.t)}</span>`
      + `<b>peak ${Math.abs(m.v).toFixed(1)} kn ${fmtT.format(m.t)}</b></div>`;
  }
  rows.innerHTML = html || '<div class="tr-row">no windows in range</div>';
}

/* ------------------------------ boot ------------------------------ */

async function boot() {
  S.tNow = Date.now();
  S.tScrub = S.tNow;
  S.tMin = S.tNow - HOURS_BACK * 3600e3;
  S.tMax = S.tNow + HOURS_FWD * 3600e3;

  initMap();
  // Parsing every cached forecast before creating the map was pure startup
  // latency for returning phones. Fetchers already enforce their own TTLs;
  // do quota cleanup well after the first interactive paint.
  setTimeout(() => runWhenIdle(() => pruneCache(36 * 3600e3), 12000), 5000);
  initScrub();
  initCams();
  $('btn-chart').addEventListener('click', toggleChart);
  applyChart();
  initTransit();
  // These controls need only the map, not any remote forecast. Make the page
  // operable immediately even when a NOAA endpoint is slow on cellular.
  initLayerToggles();
  initZoomSlider();
  initScaleBar();
  if (MOBILE_MAP) {
    // Let the browser commit the chart shell before synchronous cache reads
    // inside the data loaders. A painted map is more useful than a frozen
    // blank frame while cached forecast JSON is parsed.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }

  const geoFlowLoad = loadGeo().then(() => MOBILE_MAP
    ? new Promise((resolve) => {
        // The detailed transport pack is 3.2 MB and expands into many typed
        // arrays. The lightweight channel field can draw the first arrows;
        // decode the continuum after the chart has had the connection/CPU.
        setTimeout(() => runWhenIdle(() => loadFlowData().finally(resolve), 5000), 700);
      })
    : Promise.all([loadFlowData(), loadSwe(), loadWindG()]));
  const bootLoads = [
    loadTide(), loadWeatherSources(), loadCurrentHarmonics().then(() => loadCurrents()), loadObs(), loadAlerts(),
    loadResiduals(), loadNecofs(), loadFerryRoutes(), geoFlowLoad, loadWindObs(), loadSeasObs(), loadHaight(),
    loadTideAtlas(),
  ];
  let bootLoadsDone = false;
  const allBootLoads = Promise.allSettled(bootLoads).then((results) => {
    bootLoadsDone = true;
    return results;
  });
  if (MOBILE_MAP) {
    // A single unreachable live feed used to hold every legend, timeline,
    // marker and control for the full 20-second fetch timeout. Paint with
    // whatever has arrived after a short budget; remaining feeds keep loading
    // and are folded into the already-interactive map below.
    await Promise.race([allBootLoads, new Promise((resolve) => setTimeout(resolve, 3200))]);
  } else {
    await allBootLoads;
  }
  // Upload and render whatever geography/data arrived inside the startup budget.
  recalcWindCons();                          // needs both model wind and obs
  if (waterGL) waterGL._reset();
  if (chartTintLayer) chartTintLayer.redraw();

  buildWaterField();
  buildCurrentMarkers();
  initFerries();
  initAIS();
  buildTimeline();
  fillLegend();
  initPlan();
  initBuoys();
  renderMoon();
  setInterval(renderMoon, 10 * 60e3);
  // deferred so a double-tap zoom never fires a spot forecast; and a click
  // that DISMISSES an open popup should only dismiss — the spot forecast
  // takes a second, deliberate tap
  let spotT = null, popupClosedAt = 0;
  map.on('popupclose', () => { popupClosedAt = Date.now(); });
  map.on('click', (e) => {
    clearTimeout(spotT);
    if (PLAN.on) { addPlanPoint(e.latlng); return; }   // planning taps drop waypoints
    if (Date.now() - popupClosedAt < 400) return;
    spotT = setTimeout(() => showSpotForecast(e.latlng), 290);
  });
  map.on('dblclick zoomstart movestart', () => clearTimeout(spotT));
  if (hashHours) setScrub(S.tNow + hashHours * 3600e3);
  updateReadout();
  renderAlerts();

  if (MOBILE_MAP) {
    // These atlases improve close-range current structure and station-scale
    // wind pinning, but together add several megabytes of decode work. Let
    // the complete interactive map paint first, then fold them in at idle.
    geoFlowLoad.then(() => runWhenIdle(async () => {
        await Promise.allSettled([loadSwe(), loadWindG()]);
        if (waterGL) { waterGL.flowDirty(); waterGL._reset(); }
        if (curArrows) curArrows.requestRedraw();
        if (windArrows) windArrows.notifyTime();
      }, 8000));
  }

  // solve the streamfunction flow modes on the real waterway geometry, then
  // swap the field in and refresh everything that samples it
  const onFlowBuilt = () => {
    if (!flowField) return;
    fillLegend();
    if (waterGL) waterGL._reset();     // pond (non-tidal) clamp needs the flow field
    if (curArrows) curArrows.requestRedraw();
    if (windArrows) windArrows.notifyTime();
    if (S.applyLayerVis) S.applyLayerVis();   // arrow canvases exist by now
  };
  if (!bootLoadsDone) {
    allBootLoads.then(() => {
      // Late cellular/API results refine the first paint in place. All of
      // these builders are intentionally idempotent or redraw-only.
      recalcWindCons();
      buildWaterField();
      buildCurrentMarkers();
      buildTimeline();
      fillLegend();
      updateReadout();
      renderAlerts();
      if (waterGL) { waterGL.flowDirty(); waterGL._reset(); }
      if (chartTintLayer) chartTintLayer.redraw();
      if (curArrows) curArrows.requestRedraw();
      if (windArrows) windArrows.notifyTime();
      buildFlowField().then(onFlowBuilt).catch((e) => console.warn('[flow] late boot build failed', e));
    });
  }
  buildFlowField().then(onFlowBuilt).catch((e) => console.warn('[flow] boot build failed', e));
  // watchdog: if any dependency raced or failed at boot, keep trying until
  // the calibrated field exists — the channel skeleton must never silently
  // become the product (2026-07-25: it had, and currents read ~30% low with
  // no jets; the fallback is for dead NOAA feeds, not for load races)
  const flowWatch = setInterval(() => {
    (S._flowDbg = S._flowDbg || []).push(Date.now() % 1e7 + ' watchdog: field=' + !!flowField);
    if (flowField) { clearInterval(flowWatch); return; }
    buildFlowField().then(() => {
      if (flowField) console.warn('[flow] field built on watchdog retry');
      onFlowBuilt();
    }).catch((e) => { (S._flowDbg = S._flowDbg || []).push('watchdog build threw: ' + e.message); });
  }, 8e3);

  // keep "live" mode ticking along
  setInterval(() => {
    if (S.live && !S.playing) {
      S.tNow = Date.now();
      S.tMax = S.tNow + HOURS_FWD * 3600e3;
      S.tMin = S.tNow - HOURS_BACK * 3600e3;
      S.tScrub = S.tNow;
      // the drawn curves/bands live in built coordinates: redraw once the
      // window has slid noticeably past the last build
      if (Math.abs(S.tMin - (TL.builtTMin || 0)) > 2 * 60e3) buildTimeline();
      requestReadout();
    }
  }, 60e3);

  // refresh observations + alerts every 6 min; forecast + residuals every 30 min
  setInterval(async () => {
    await Promise.allSettled([loadObs(), loadAlerts(), loadWindObs(), loadSeasObs()]);
    renderAlerts();
    if (S.live) requestReadout();
  }, 6 * 60e3);
  setInterval(async () => {
    await Promise.allSettled([loadWeatherSources(), loadResiduals(), loadNecofs()]);
    // NOAA's currents service goes down now and then (2026-07-17 it did):
    // when it recovers — or when single stations failed at boot — pick the
    // stations back up without needing a reload
    if (S.curSource !== 'live' || S.currents.length < CURRENT_STATIONS.length || !flowField) {
      await loadCurrents().catch(() => {});
      if (S.currents.length) {
        buildWaterField();             // rebind CHANNELS to the fresh stations
        try { buildCurrentMarkers(); } catch (e) {}
        buildFlowField().then(() => {
          if (flowField) {
            fillLegend();
            if (waterGL) waterGL._reset();
            if (curArrows) curArrows.requestRedraw();
          }
        });
      }
    }
    recalcWindCons();
    buildTimeline();
    fillLegend();
    requestReadout();
    pruneCache(36 * 3600e3);           // long-lived tabs: don't wait for a reboot
  }, 30 * 60e3);

  // console debugging handle
  window.__woodshole = { S, map, waterLayer, waterGL, curArrows, windArrows, sampleWind, sampleWater, headDiffKn, waveFt, CHANNELS };

  // Local reviews always check the worker script at the network. When a new
  // worker takes control, reload once so the page and its versioned assets are
  // guaranteed to come from the same build. Production keeps normal caching.
  if ('serviceWorker' in navigator) {
    try {
      if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
        let devReloading = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (devReloading) return;
          devReloading = true;
          location.reload();
        });
        navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => reg.update());
      } else {
        navigator.serviceWorker.register('sw.js');
      }
    } catch (e) {}
  }

  // pause the animated layers when the map is off screen; show the back-to-map button
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      const off = !entries[0].isIntersecting;
      if (waterLayer) waterLayer.setPaused(off);
      if (waterGL) waterGL.setPaused(off);
      if (windArrows) windArrows.setPaused(off);
      if (eddy) eddy.paused = off;
      $('btn-map').classList.toggle('show', off);
    }, { threshold: 0.05 }).observe($('map'));
  }
  $('btn-map').addEventListener('click', () => $('hero').scrollIntoView({ behavior: 'smooth' }));

  // rebuild the timeline whenever the panel's size actually changes
  if ('ResizeObserver' in window) {
    let lastW = 0;
    new ResizeObserver(debounce(() => {
      const w = $('timeline').clientWidth;
      if (Math.abs(w - lastW) > 2) { lastW = w; buildTimeline(); }
    }, 150)).observe($('panel'));
  } else {
    window.addEventListener('resize', debounce(buildTimeline, 250));
  }
}

// a boot failure must NEVER be silent: half a page with the current field
// quietly replaced by the channel skeleton is worse than an error
boot().catch((e) => {
  S._bootErr = (e && (e.message + '\n' + (e.stack || ''))) || String(e);
  console.error('[boot] failed:', e);
});
