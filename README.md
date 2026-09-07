# WoodsHole

Wind, tides, currents, waves, and ferry information around Woods Hole, Massachusetts.

Live app: https://bezialemma.com/WoodsHole/

This repository is the source of truth for WoodsHole. The personal website imports
the latest released static build into `WoodsHole/` and `docs/WoodsHole/`. Develop
here and push to `main`; no merging app changes into the website is required.

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

Run `python tools/build.py` to generate `dist/woodshole-site.zip` using Python's
standard library. Only runtime assets are packaged, with checksums and the source
commit in `build.json`. Every push to `main` validates syntax and publishes a
versioned GitHub release. Pull requests produce a build artifact without a release.

The website's **Sync WoodsHole build** workflow checks every 30 minutes (GitHub may
delay scheduled runs), or can be run manually for immediate import. It validates
the release, updates both website copies, and requests a GitHub Pages rebuild.
App routes and relative assets work at `/WoodsHole/` or at a standalone server root.

Imported from `bezlemma/website` at commit
`0ecda77b72d2b1bff975bdb9080d0fe431ca8a9a`. This repository starts with a clean source
snapshot; earlier development history remains in the website repository.
