/* Optional Google Weather adapter. No credentials or persistent forecast cache. */
(function (root) {
  'use strict';
  const HOUR = 3600000;
  const LATS = [41.4, 41.525, 41.65];
  const LNGS = [-70.9, -70.675, -70.45];
  function number(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Missing ' + label);
    return value;
  }
  function speed(item) {
    const factors = { KILOMETERS_PER_HOUR: 1 / 1.852, MILES_PER_HOUR: 0.868976242 };
    if (!item || !factors[item.unit]) throw new Error('Unknown wind unit');
    const value = number(item.value, 'wind speed');
    if (value < 0) throw new Error('Negative wind speed');
    return value * factors[item.unit];
  }
  function normalize(hours) {
    if (!Array.isArray(hours) || hours.length < 73) throw new Error('Incomplete Google forecast');
    const rows = hours.map(h => {
      const time = Date.parse(h.interval?.startTime);
      if (!Number.isFinite(time)) throw new Error('Invalid forecast time');
      const knots = speed(h.wind?.speed), gust = speed(h.wind?.gust);
      const direction = knots === 0 ? 0 : number(h.wind?.direction?.degrees, 'wind direction');
      if (direction < 0 || direction > 360) throw new Error('Invalid wind direction');
      const r = direction * Math.PI / 180;
      const temp = number(h.temperature?.degrees, 'temperature');
      if (!['CELSIUS', 'FAHRENHEIT'].includes(h.temperature.unit)) throw new Error('Unknown temperature unit');
      const qpf = h.precipitation?.qpf;
      const rain = number(qpf?.quantity, 'precipitation');
      if (!['MILLIMETERS', 'INCHES'].includes(qpf.unit) || rain < 0) throw new Error('Invalid precipitation');
      return { time, u: -knots * Math.sin(r), v: -knots * Math.cos(r), g: gust,
        temp: h.temperature.unit === 'CELSIUS' ? temp * 9 / 5 + 32 : temp,
        rain: rain * (qpf.unit === 'INCHES' ? 25.4 : 1) };
    });
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].time - rows[i - 1].time !== HOUR) throw new Error('Non-contiguous forecast');
    }
    return rows;
  }
  function valid(data, now = Date.now()) {
    if (!data || data.version !== 1 || !Number.isFinite(data.fetchedAt) || !Number.isFinite(data.expiresAt)
      || data.fetchedAt > now + 60000 || data.expiresAt <= now
      || data.expiresAt - data.fetchedAt > HOUR || data.expiresAt <= data.fetchedAt
      || JSON.stringify(data.lats) !== JSON.stringify(LATS) || JSON.stringify(data.lngs) !== JSON.stringify(LNGS)
      || !Array.isArray(data.points) || data.points.length !== 9) return false;
    if (!Array.isArray(data.points[0]) || data.points[0].some(r => !r)) return false;
    const times = data.points[0].map(r => r.time);
    if (!times || times.length < 73 || times[0] > now || times.at(-1) < now + 72 * HOUR) return false;
    return data.points.every(rows => Array.isArray(rows) && rows.length === times.length && rows.every((r, i) =>
      r && r.time === times[i] && (i === 0 || r.time - times[i - 1] === HOUR)
      && ['time', 'u', 'v', 'g', 'temp', 'rain'].every(k => typeof r[k] === 'number' && Number.isFinite(r[k]))
      && r.g >= 0 && r.rain >= 0));
  }
  function merge(wind, wx, data, lats, lngs, now = Date.now()) {
    if (!wind || !wx || !valid(data, now)) return null;
    const first = data.points[0][0].time;
    const index = t => {
      const k = (t - first) / HOUR;
      return Number.isInteger(k) && k >= 0 && k < data.points[0].length ? k : -1;
    };
    const result = { wind: { ...wind }, wx: { ...wx }, expiresAt: data.expiresAt };
    for (const field of ['u', 'v', 'g']) {
      result.wind[field] = wind[field].map((values, p) => {
        const lat = lats[Math.floor(p / lngs.length)], lng = lngs[p % lngs.length];
        const x = Math.max(0, Math.min(2, (lng - LNGS[0]) / (LNGS[2] - LNGS[0]) * 2));
        const y = Math.max(0, Math.min(2, (lat - LATS[0]) / (LATS[2] - LATS[0]) * 2));
        const ix = Math.min(1, Math.floor(x)), iy = Math.min(1, Math.floor(y));
        const dx = x - ix, dy = y - iy;
        return values.map((original, i) => {
          const k = index(wind.times[i]);
          if (k < 0) return original;
          const at = (a, b) => data.points[a * 3 + b][k][field];
          return at(iy, ix) * (1 - dx) * (1 - dy) + at(iy, ix + 1) * dx * (1 - dy)
            + at(iy + 1, ix) * (1 - dx) * dy + at(iy + 1, ix + 1) * dx * dy;
        });
      });
    }
    for (const field of ['temp', 'rain']) {
      result.wx[field] = wx[field].map((original, i) => {
        const k = index(wx.times[i]);
        return k < 0 ? original : data.points[4][k][field];
      });
    }
    return result;
  }
  const api = { LATS, LNGS, normalize, valid, merge };
  root.WoodsHoleGoogle = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
