# WoodsHole

Wind, tides, currents, waves, and ferry information around Woods Hole, Massachusetts.

Live app: https://bezialemma.com/WoodsHole/

This repository is the source of truth for WoodsHole. The personal website imports
the latest released static build into `WoodsHole/` and `docs/WoodsHole/`. Develop
here and publish a static build when ready; no merging app source into the website
is required. Builds and imports are manual, with no scheduled background jobs.

## Development

For a static preview, run `python -m http.server 8000` and open http://localhost:8000/.
For the optional local AIS vessel relay, install `pip install -r requirements.txt`,
set the `AISSTREAM_API_KEY` environment variable, and run `python dev_server.py`.
No API credentials are included. Public static hosting cannot run the Python relay;
live AIS requires a separately configured service. The weather and tide app works
without AIS. The legacy browser fallback can use a user-supplied `whAisKey` in local
storage, although AISStream may reject browser connections.

The optional forecast preparation tool is `python tools/fetch_necofs.py`; it writes
`data/necofs.json`. Commit refreshed data to include it in the next build.

## Build and website delivery

Commit your changes, then run `python tools/build.py` to generate
`dist/woodshole-site.zip` from the committed source using Python's
standard library. Only runtime assets are packaged, with checksums and the source
commit in `build.json`. To publish, upload `dist/woodshole-site.zip` to a GitHub
release, or explicitly run the **Build WoodsHole** workflow on `main`. The workflow
has only a manual trigger; pushes and pull requests do not start it.

The website's **Sync WoodsHole build** workflow also runs only when manually
started. It validates the release, updates both website copies, and requests a
GitHub Pages rebuild. Alternatively, download the release and run the website's
`tools/sync_woodshole.py` locally before publishing the website.
App routes and relative assets work at `/WoodsHole/` or at a standalone server root.

## Runtime and cost

WoodsHole is a static app. Weather requests and refresh timers run in the visitor's
browser while the page is open; nothing polls for weather when nobody has it open.
It uses the existing public endpoints and requires no paid Google Weather account,
Cloudflare Worker, or automated GitHub weather job. Optional `data/necofs.json` is
a manually prepared forecast snapshot, not an automatically refreshed feed. The
local AIS development relay runs only when explicitly started.

Imported from `bezlemma/website` at commit
`0ecda77b72d2b1bff975bdb9080d0fe431ca8a9a`. This repository starts with a clean source
snapshot; earlier development history remains in the website repository.
