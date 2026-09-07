import test from 'node:test';
import assert from 'node:assert/strict';
import google from '../vendor/google-weather.js';
import worker, { fetchForecasts, refresh } from '../cloudflare/google-weather/worker.mjs';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HOUR = 3600000;
const now = Math.floor(Date.now() / HOUR) * HOUR + 10 * 60000;
const start = Math.floor(now / HOUR) * HOUR;
function hours() {
  return Array.from({ length: 74 }, (_, i) => ({
    interval: { startTime: new Date(start + i * HOUR).toISOString() },
    wind: { direction: { degrees: 90 }, speed: { unit: 'KILOMETERS_PER_HOUR', value: 18.52 },
      gust: { unit: 'KILOMETERS_PER_HOUR', value: 37.04 } },
    temperature: { degrees: 10, unit: 'CELSIUS' },
    precipitation: { qpf: { quantity: 2, unit: 'MILLIMETERS' } },
  }));
}
function payload() {
  return { version: 1, fetchedAt: now, expiresAt: now + 55 * 60000,
    lats: google.LATS, lngs: google.LNGS,
    points: Array.from({ length: 9 }, () => google.normalize(hours())) };
}

test('converts metric wind into westward knots, Celsius into Fahrenheit, and preserves rain', () => {
  const row = google.normalize(hours())[0];
  assert.ok(Math.abs(row.u + 10) < 1e-10);
  assert.ok(Math.abs(row.v) < 1e-10);
  assert.ok(Math.abs(row.g - 20) < 1e-10);
  assert.equal(row.temp, 50);
  assert.equal(row.rain, 2);
});

test('handles imperial responses without confusing mph with knots', () => {
  const source = hours();
  for (const h of source) {
    h.wind.speed = { unit: 'MILES_PER_HOUR', value: 10 };
    h.wind.gust = { unit: 'MILES_PER_HOUR', value: 20 };
    h.temperature = { degrees: 50, unit: 'FAHRENHEIT' };
    h.precipitation.qpf = { quantity: 1, unit: 'INCHES' };
  }
  const row = google.normalize(source)[0];
  assert.ok(Math.abs(row.u + 8.68976242) < 1e-8);
  assert.equal(row.temp, 50);
  assert.equal(row.rain, 25.4);
});

test('rejects gaps, missing values, and an incomplete 72-hour horizon', () => {
  assert.throws(() => google.normalize(hours().slice(0, 24)));
  const gap = hours(); gap[4] = gap[5];
  assert.throws(() => google.normalize(gap));
  const missing = hours(); delete missing[0].wind.speed;
  assert.throws(() => google.normalize(missing));
  const data = payload();
  assert.equal(google.valid(data, now), true);
  assert.equal(google.valid(data, data.expiresAt), false);
  data.points[1][0].time += HOUR;
  assert.equal(google.valid(data, now), false);
});

test('overlays covered hours without mutating fallback, past weather, or thunderstorm codes', () => {
  const times = [start - HOUR, start, start + HOUR, start + 80 * HOUR];
  const values = Array.from({ length: 9 }, () => [3, 3, 3, 3]);
  const wind = { times, u: values, v: values, g: values, nx: 3, ny: 3 };
  const wx = { times, temp: [60, 60, 60, 60], rain: [0, 0, 0, 0], wcode: [0, 95, 0, 0] };
  const merged = google.merge(wind, wx, payload(), google.LATS, google.LNGS, now);
  assert.equal(merged.wind.u[4][0], 3);
  assert.ok(Math.abs(merged.wind.u[4][1] + 10) < 1e-8);
  assert.equal(merged.wind.u[4][3], 3);
  assert.deepEqual(merged.wx.temp, [60, 50, 50, 60]);
  assert.deepEqual(merged.wx.rain, [0, 2, 2, 0]);
  assert.deepEqual(merged.wx.wcode, wx.wcode);
  assert.deepEqual(wx.temp, [60, 60, 60, 60]);
  assert.deepEqual(wind.u[4], [3, 3, 3, 3]);
  assert.equal(google.merge(wind, wx, payload(), google.LATS, google.LNGS, now + HOUR), null);
});

test('interpolates wind vectors without averaging north and south as an easterly wind', () => {
  const data = payload();
  for (let p = 0; p < 9; p++) for (const row of data.points[p]) {
    row.u = 0; row.v = p % 3 === 0 ? 10 : -10;
  }
  const wind = { times: [start], u: [[0]], v: [[0]], g: [[0]], nx: 1, ny: 1 };
  const wx = { times: [start], temp: [0], rain: [0] };
  const mixed = google.merge(wind, wx, data, [41.4], [-70.7875], now);
  assert.equal(mixed.wind.u[0][0], 0);
  assert.ok(Math.abs(mixed.wind.v[0][0]) < 1e-9);
});

test('fetches all four pages for each fixed location with the key only in a header', async () => {
  let requests = 0;
  const source = hours();
  const result = await fetchForecasts('test-secret', async (url, options) => {
    requests++;
    assert.equal(url.searchParams.has('key'), false);
    assert.equal(options.headers['X-Goog-Api-Key'], 'test-secret');
    const page = +(url.searchParams.get('pageToken') || 0);
    return Response.json({ forecastHours: source.slice(page * 24, (page + 1) * 24),
      ...(page < 3 ? { nextPageToken: String(page + 1) } : {}) });
  }, now);
  assert.equal(requests, 36);
  assert.equal(result.points.length, 9);
  assert.equal(result.points[0].length, 74);
});

test('failed upstream calls do not overwrite the last forecast or expose the upstream body', async () => {
  let writes = 0;
  await assert.rejects(refresh({ GOOGLE_WEATHER_API_KEY: 'test-secret',
    FORECASTS: { put() { writes++; } } }, async () => new Response('test-secret', { status: 403 })), /HTTP 403/);
  assert.equal(writes, 0);
});

test('public endpoint reads only cached forecasts and refuses stale data', async () => {
  let data = payload();
  // Use the actual clock for the endpoint's freshness check.
  data.fetchedAt = Date.now(); data.expiresAt = Date.now() + 55 * 60000;
  const env = { FORECASTS: { async get() { return data; } } };
  const request = new Request('https://example.test/api/google-weather?anything=ignored', { headers: { Origin: 'https://bezialemma.com' } });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://bezialemma.com');
  data.expiresAt = Date.now() - 1;
  assert.equal((await worker.fetch(request, env)).status, 503);
  assert.equal((await worker.fetch(request, {})).status, 503);
  assert.equal((await worker.fetch(new Request(request.url, { headers: { Origin: 'https://unrelated.example' } }), env)).status, 403);
});

test('app loader activates Google, restores Open-Meteo at expiry, and falls back on API failure', async () => {
  const times = Array.from({ length: 120 }, (_, i) => start + (i - 24) * HOUR);
  const values = Array.from({ length: 9 }, () => times.map(() => 3));
  const baseWind = { times, u: values, v: values, g: values, nx: 3, ny: 3 };
  const baseWx = { times, temp: times.map(() => 60), rain: times.map(() => 0), wcode: [] };
  const state = { wind: null, centerWx: null };
  const attribution = { hidden: true };
  let expire, failing = false, requests = 0;
  const context = vm.createContext({
    document: { querySelector: () => ({ content: 'https://example.test/api/google-weather' }), addEventListener() {} },
    $: () => attribution, S: state, WoodsHoleGoogle: google, GRID_LATS: google.LATS, GRID_LNGS: google.LNGS,
    AbortSignal, Date, setTimeout: callback => { expire = callback; }, clearTimeout() {},
    loadWind: async () => { state.wind = baseWind; }, loadCenterWx: async () => { state.centerWx = baseWx; },
    recalcWindCons() {}, buildTimeline() {}, fillLegend() {}, requestReadout() {}, waterGL: null, windArrows: null,
    fetch: async (_url, options) => {
      requests++; assert.equal(options.cache, 'no-store');
      const data = payload(); data.fetchedAt = Date.now(); data.expiresAt = Date.now() + 55 * 60000;
      return failing ? new Response('{}', { status: 503 }) : Response.json(data);
    },
  });
  const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const GOOGLE_WEATHER_ENDPOINT'), source.indexOf('async function loadWind()'));
  vm.runInContext(code, context);
  await vm.runInContext('loadWeatherSources()', context);
  assert.equal(attribution.hidden, false);
  assert.ok(Math.abs(state.wind.u[4][24] + 10) < 1e-8);
  assert.equal(state.wind.u[4][0], 3);
  expire();
  assert.equal(state.wind, baseWind);
  assert.equal(state.centerWx, baseWx);
  assert.equal(attribution.hidden, true);
  failing = true;
  await vm.runInContext('loadWeatherSources()', context);
  assert.equal(state.wind, baseWind);
  assert.equal(attribution.hidden, true);
  assert.equal(requests, 2);
});

test('service worker never saves or serves a cached Google forecast', async () => {
  let onFetch, networkCalls = 0;
  const context = vm.createContext({ URL,
    self: { addEventListener: (type, callback) => { if (type === 'fetch') onFetch = callback; } },
    fetch: async (_request, options) => {
      networkCalls++; assert.equal(options.cache, 'no-store'); return new Response('{}');
    },
    caches: { match() { throw new Error('Unexpected persistent cache read'); }, open() { throw new Error('Unexpected cache write'); } },
  });
  vm.runInContext(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), context);
  let result;
  onFetch({ request: new Request('https://worker.example/api/google-weather'), respondWith: value => { result = value; } });
  await result;
  assert.equal(networkCalls, 1);
});
