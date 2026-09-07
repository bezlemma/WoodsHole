# Activate Google weather for WoodsHole

This optional source supplies wind, gusts, temperature, and rain for the existing
72-hour forecast. NOAA observations, tides, currents, marine alerts, Open-Meteo
thunderstorm codes and sun times, and NECOFS waves remain in use. Open-Meteo
provides fallback forecasts when Google is unavailable, incomplete, or expired.
Google forecasts are sampled at nine fixed points across the existing map region.
Interpolation fills the app's grid; it does not increase Google's native resolution.
The app does not claim that Google is more accurate locally without evaluation.

## Google Cloud

1. Create or choose a project at https://console.cloud.google.com/projectcreate.
2. Link billing and enable the Weather API (`weather.googleapis.com`).
3. Create an API key and restrict it to the Weather API. The key is used by this
   server, so do not set browser HTTP-referrer restrictions on it.
4. Set a daily request quota appropriate to the schedule (approximately 1,728
   requests/day; a 2,000/day cap leaves some margin). Check current pricing at
   https://developers.google.com/maps/documentation/weather/usage-and-billing.
   Scheduled requests can incur charges. Public page views do not trigger Google
   requests; the Worker serves the latest cached regional forecast.

## Cloudflare Worker

From this directory, using an authenticated Wrangler CLI:

```powershell
npx wrangler@latest kv namespace create FORECASTS
```

Put the returned namespace ID into `wrangler.jsonc`. Store the API key as a secret
using the interactive prompt (do not paste it into source files or chat):

```powershell
npx wrangler@latest secret put GOOGLE_WEATHER_API_KEY
npx wrangler@latest deploy
```

The scheduled job refreshes at minutes 7 and 37. Each refresh makes at most 36
Google requests, including pagination. It requests 74 hourly records so that the
app's rolling 72-hour window is covered between updates; no longer outlook is shown.
It publishes only a complete, validated response. Failed updates leave the previous
response until it expires. KV entries expire after one hour, and the endpoint stops
serving them after 55 minutes. API keys and forecasts are never committed to GitHub
or included in build releases. Responses bypass browser and service-worker caches.

After the first successful scheduled refresh, verify the Worker's
`/api/google-weather` endpoint returns HTTP 200. Set the `google-weather-endpoint`
meta tag in `index.html` to that full URL and push the app change. Leave it empty
to disable this source. For a local preview, add `http://localhost:8000` to
`ALLOWED_ORIGINS` and set the same endpoint in the local HTML.

## Validation

Run `node --test test/google-weather.test.mjs` from the repository root. These
tests use synthetic forecasts, not paid Google requests. They check units, vector
interpolation, coverage, paging, fallback data preservation, and expiry. A live API
smoke test is still required after the account and secret are configured.

Google's announced WeatherNext 3 integration is behind the Weather API; the API
does not offer a WeatherNext model selector. Label this source Google Weather,
rather than claiming every returned field is a raw WeatherNext 3 prediction.

Service-specific terms: https://cloud.google.com/maps-platform/terms/maps-service-terms
Section 21.1 describes restrictions based on the app's primary purpose; it does not
state a personal-use exception. This implementation does not establish permission
from Google. Attribution and hourly forecast caching requirements are documented
at https://developers.google.com/maps/documentation/weather/policies.
