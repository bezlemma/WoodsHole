import '../../vendor/google-weather.js';

const { LATS, LNGS, normalize, valid } = globalThis.WoodsHoleGoogle;
const KEY = 'woods-hole-forecast-v1';

export async function fetchForecasts(apiKey, fetcher = fetch, now = Date.now()) {
  const points = [];
  for (const lat of LATS) for (const lng of LNGS) {
    const hours = [];
    let pageToken = '';
    for (let page = 0; page < 4; page++) {
      const url = new URL('https://weather.googleapis.com/v1/forecast/hours:lookup');
      url.search = new URLSearchParams({ 'location.latitude': lat, 'location.longitude': lng,
        hours: '74', pageSize: '24', unitsSystem: 'METRIC', languageCode: 'en',
        ...(pageToken ? { pageToken } : {}) });
      const response = await fetcher(url, { headers: { 'X-Goog-Api-Key': apiKey }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Google Weather returned HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body.forecastHours)) throw new Error('Invalid Google Weather response');
      hours.push(...body.forecastHours);
      pageToken = body.nextPageToken || '';
      if (!pageToken) break;
    }
    if (pageToken) throw new Error('Incomplete Google Weather pagination');
    points.push(normalize(hours));
  }
  const data = { version: 1, fetchedAt: now, expiresAt: now + 55 * 60000, lats: LATS, lngs: LNGS, points };
  if (!valid(data, now)) throw new Error('Google forecasts have inconsistent times or coverage');
  return data;
}

export async function refresh(env, fetcher = fetch) {
  if (!env.GOOGLE_WEATHER_API_KEY || !env.FORECASTS) return;
  const data = await fetchForecasts(env.GOOGLE_WEATHER_API_KEY, fetcher);
  await env.FORECASTS.put(KEY, JSON.stringify(data), { expirationTtl: 3600 });
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refresh(env));
  },
  async fetch(request, env) {
    const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json', Vary: 'Origin' };
    const origin = request.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS || 'https://bezialemma.com,https://www.bezialemma.com').split(',');
    if (origin && !allowed.includes(origin)) return new Response('{"error":"Origin not allowed"}', { status: 403, headers });
    if (origin) headers['Access-Control-Allow-Origin'] = origin;
    if (new URL(request.url).pathname !== '/api/google-weather') return new Response('{}', { status: 404, headers });
    if (request.method !== 'GET') return new Response('{}', { status: 405, headers });
    if (!env.FORECASTS) return new Response('{"error":"Weather source not configured"}', { status: 503, headers });
    const data = await env.FORECASTS.get(KEY, 'json');
    if (!valid(data)) return new Response('{"error":"Fresh forecast unavailable"}', { status: 503, headers });
    // Public requests only read the fixed cached region; they never spend Google quota.
    return new Response(JSON.stringify(data), { headers });
  },
};
