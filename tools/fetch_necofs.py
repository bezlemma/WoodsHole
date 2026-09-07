#!/usr/bin/env python3
"""Nightly NECOFS surface-current subset for bezialemma.com/WoodsHole.

Pulls the UMass/SMAST FVCOM GOM3 3-day forecast over OPeNDAP, extracts
surface u/v at element centers inside a box around Woods Hole, and writes
a compact JSON that the page fetches client-side. On any failure the
previous JSON is left untouched and the script exits 0 so the scheduled
workflow stays green (the page degrades gracefully without the file).

Run from the repository root:  python3 tools/fetch_necofs.py
"""
from pathlib import Path
import calendar
import json
import math
import os
import sys
import time

import numpy as np
from netCDF4 import Dataset, num2date

BBOX = (41.42, 41.62, -70.82, -70.52)          # south, north, west, east
MAX_PTS = 400
HOURS_BACK = 8                                  # keep a little hindcast
CANDIDATES = [
    "http://www.smast.umassd.edu:8080/thredds/dodsC/models/fvcom/NECOFS/Forecasts/NECOFS_FVCOM_OCEAN_NORTHEAST_FORECAST.nc",
    "http://www.smast.umassd.edu:8080/thredds/dodsC/models/fvcom/NECOFS/Forecasts/NECOFS_GOM7_FORECAST.nc",
]
OUT = [str(Path(__file__).resolve().parents[1] / "data" / "necofs.json")]
MS_TO_KN = 1.9438445


def log(*a):
    print(*a, flush=True)


WAVE_URL = "http://www.smast.umassd.edu:8080/thredds/dodsC/models/fvcom/NECOFS/Forecasts/NECOFS_WAVE_FORECAST.nc"
MAX_WAVE_PTS = 160


def fetch_waves(now):
    """Significant wave height (m) at mesh nodes in the box — optional extras."""
    try:
        ds = Dataset(WAVE_URL)
    except Exception as e:                                        # noqa: BLE001
        log("wave model unreachable:", str(e)[:120])
        return {}
    try:
        lat = np.asarray(ds.variables["lat"][:])
        lon = np.asarray(ds.variables["lon"][:])
        lon = np.where(lon > 180, lon - 360, lon)
        sel = np.where((lat >= BBOX[0]) & (lat <= BBOX[1]) & (lon >= BBOX[2]) & (lon <= BBOX[3]))[0]
        log("wave nodes in box:", sel.size)
        if sel.size == 0:
            return {}
        if sel.size > MAX_WAVE_PTS:
            sel = sel[:: int(math.ceil(sel.size / MAX_WAVE_PTS))]
        sel = np.sort(sel)
        tvar = ds.variables["time"]
        nt = tvar.shape[0]
        nback = min(nt, 140)
        cal = getattr(tvar, "calendar", "standard")
        tail = num2date(tvar[nt - nback:nt], tvar.units, calendar=cal)
        epochs = np.array([calendar.timegm(t.timetuple()) for t in tail])
        keep = np.where(epochs >= now - HOURS_BACK * 3600)[0]
        if keep.size == 0:
            return {}
        t0 = nt - nback + int(keep[0])
        t1 = nt - nback + int(keep[-1]) + 1
        smin, smax = int(sel[0]), int(sel[-1])
        rel = sel - smin
        hvar = ds.variables["hs"]
        dvar = ds.variables.get("wdir")
        pvar = ds.variables.get("tpeak")
        H = np.empty((t1 - t0, sel.size), dtype=np.float32)
        D = np.empty((t1 - t0, sel.size), dtype=np.float32) if dvar is not None else None
        P = np.empty((t1 - t0, sel.size), dtype=np.float32) if pvar is not None else None
        for i, ti in enumerate(range(t0, t1)):
            H[i] = np.asarray(hvar[ti, smin:smax + 1])[rel]
            if D is not None:
                D[i] = np.asarray(dvar[ti, smin:smax + 1])[rel]
            if P is not None:
                P[i] = np.asarray(pvar[ti, smin:smax + 1])[rel]
            if i % 24 == 0:
                log(f"  wave step {i}/{t1 - t0}")
        out = {
            "wtimes": [int(e) for e in epochs[keep]],
            "wpts": [[round(float(lat[j]), 5), round(float(lon[j]), 5)] for j in sel],
            "hs": np.rint(np.nan_to_num(H) * 100).astype(int).tolist(),   # integer cm
        }
        if D is not None:
            out["wdir"] = np.rint(np.nan_to_num(D)).astype(int).tolist()  # deg, waves FROM
        if P is not None:
            out["tp"] = np.rint(np.nan_to_num(P) * 10).astype(int).tolist()  # peak period, ds
        return out
    except Exception as e:                                        # noqa: BLE001
        log("wave extraction failed:", type(e).__name__, str(e)[:200])
        return {}
    finally:
        ds.close()


def main():
    ds = None
    for url in CANDIDATES:
        try:
            log("trying", url)
            ds = Dataset(url)
            log("  opened")
            break
        except Exception as e:                                    # noqa: BLE001
            log("  failed:", type(e).__name__, str(e)[:200])
    if ds is None:
        log("no NECOFS source reachable — keeping previous file")
        return 0

    try:
        latc = np.asarray(ds.variables["latc"][:])
        lonc = np.asarray(ds.variables["lonc"][:])
        lonc = np.where(lonc > 180, lonc - 360, lonc)
        sel = np.where(
            (latc >= BBOX[0]) & (latc <= BBOX[1]) & (lonc >= BBOX[2]) & (lonc <= BBOX[3])
        )[0]
        log("elements in box:", sel.size)
        if sel.size == 0:
            return 0
        if sel.size > MAX_PTS:
            sel = sel[:: int(math.ceil(sel.size / MAX_PTS))]
        sel = np.sort(sel)

        tvar = ds.variables["time"]
        nt = tvar.shape[0]
        now = time.time()
        # only look at the tail of the aggregation — reading the whole time
        # axis over DAP can time out on long archives
        nback = min(nt, 140)
        cal = getattr(tvar, "calendar", "standard")
        tail = num2date(tvar[nt - nback:nt], tvar.units, calendar=cal)
        epochs = np.array([calendar.timegm(t.timetuple()) for t in tail])
        keep = np.where(epochs >= now - HOURS_BACK * 3600)[0]
        if keep.size == 0:
            log("forecast entirely in the past?")
            return 0
        t0 = nt - nback + int(keep[0])
        t1 = nt - nback + int(keep[-1]) + 1
        epochs = epochs[keep]
        log(f"time steps {t0}..{t1 - 1} of {nt}")

        smin, smax = int(sel[0]), int(sel[-1])
        rel = sel - smin
        span = smax - smin + 1
        log(f"element span {smin}..{smax} ({span})")
        uvar, vvar = ds.variables["u"], ds.variables["v"]
        U = np.empty((t1 - t0, sel.size), dtype=np.float32)
        V = np.empty_like(U)
        if span <= 120000:
            # contiguous slab, one step at a time — small, reliable requests
            for i, ti in enumerate(range(t0, t1)):
                U[i] = np.asarray(uvar[ti, 0, smin:smax + 1])[rel]
                V[i] = np.asarray(vvar[ti, 0, smin:smax + 1])[rel]
                if i % 12 == 0:
                    log(f"  step {i}/{t1 - t0}")
        else:
            for i, ti in enumerate(range(t0, t1)):
                U[i] = np.asarray(uvar[ti, 0, :])[sel]
                V[i] = np.asarray(vvar[ti, 0, :])[sel]
                if i % 12 == 0:
                    log(f"  step {i}/{t1 - t0}")

        out = {
            "generated": int(now),
            "source": "NECOFS (UMassD-SMAST FVCOM) surface currents + SWAN waves",
            "times": [int(e) for e in epochs],
            "pts": [[round(float(latc[j]), 5), round(float(lonc[j]), 5)] for j in sel],
            # integer cm/s keeps the payload small
            "u": np.rint(U * 100).astype(int).tolist(),
            "v": np.rint(V * 100).astype(int).tolist(),
        }
        out.update(fetch_waves(now))
        body = json.dumps(out, separators=(",", ":"))
        for path in OUT:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write(body)
            log("wrote", path, f"{len(body) / 1e6:.2f} MB")
        return 0
    except Exception as e:                                        # noqa: BLE001
        log("extraction failed:", type(e).__name__, str(e)[:300])
        return 0
    finally:
        ds.close()


if __name__ == "__main__":
    sys.exit(main())
