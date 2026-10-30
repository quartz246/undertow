"""Undertow web app: serves the locked forecast, the county/cell layers and live block-level Qloo scans."""
import asyncio, json, math, os, time
from pathlib import Path
import httpx, numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from shapely.geometry import Point, shape
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
QLOO = "https://hackathon.api.qloo.com"
KEY = os.environ.get("QLOO_API_KEY", "")
LIVE_ENTITIES = int(os.environ.get("LIVE_ENTITIES", "14"))

app = FastAPI(title="Undertow")
MODEL = json.loads((DATA / "model/model.json").read_text())
COUNTIES = json.loads((DATA / "model/counties.json").read_text())
_feats = json.loads((DATA / "raw/counties.geojson").read_text())["features"]
_geoms = [shape(f["geometry"]) for f in _feats]
_tree = STRtree(_geoms)
_ids = [str(f["id"]).zfill(5) for f in _feats]
# live scans use the strongest entities only, to keep a scan to ~one second of parallel calls
LIVE = sorted(MODEL["entities"].items(), key=lambda kv: -abs(kv[1]["weight"]))[:LIVE_ENTITIES]
_cache: dict = {}
_sem = asyncio.Semaphore(8)

def county_of(lat, lon):
    idx = _tree.query(Point(lon, lat), predicate="intersects")
    return _ids[idx[0]] if len(idx) else None

async def heat(client, ent_id, lat, lon, radius):
    params = {"filter.type": "urn:heatmap", "signal.interests.entities": ent_id,
              "filter.location": f"POINT({lon:.5f} {lat:.5f})", "filter.location.radius": str(radius)}
    async with _sem:
        for attempt in range(2):
            try:
                r = await client.get(QLOO + "/v2/insights", params=params, headers={"X-Api-Key": KEY}, timeout=30)
                if r.status_code == 200:
                    return (r.json().get("results") or {}).get("heatmap") or []
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.5)
    return []

@app.get("/api/live")
async def live(lat: float = Query(..., ge=18, le=72), lon: float = Query(..., ge=-180, le=-60), radius: int = Query(5000, ge=1000, le=30000)):
    """Block-level scan: Qloo heatmaps for the model's strongest entities around a point, scored with the county model
    and anchored to each cell's county 2024 result (cells show how a place differs from its county, not a new topline)."""
    if not KEY:
        raise HTTPException(503, "live Qloo scans are off on this server")
    key = (round(lat, 2), round(lon, 2), radius)
    if key in _cache and time.time() - _cache[key]["t"] < 6 * 3600:
        return _cache[key]["v"]
    t0 = time.time()
    async with httpx.AsyncClient(headers={"User-Agent": "undertow/0.1"}) as client:
        res = await asyncio.gather(*[heat(client, e["id"], lat, lon, radius) for _, e in LIVE])
    cells = {}
    for (name, e), h in zip(LIVE, res):
        for c in h:
            g = c["location"]["geohash"]
            cell = cells.setdefault(g, {"lat": c["location"]["latitude"], "lon": c["location"]["longitude"], "aff": {}})
            cell["aff"][name] = c["query"]["affinity"]
    names = [n for n, _ in LIVE]
    if not cells:
        v = {"cells": [], "entities": names, "ms": int((time.time() - t0) * 1000), "precision": None}
        return v
    gh = list(cells)
    A = np.array([[cells[g]["aff"].get(n, np.nan) for n in names] for g in gh], dtype=float)
    col_min = np.nanmin(np.where(np.isnan(A), np.inf, A), axis=0); col_min[~np.isfinite(col_min)] = 0
    A = np.where(np.isnan(A), col_min, A)
    Z = (A - A.mean(0)) / (A.std(0) + 1e-9)
    w = np.array([MODEL["entities"][n]["weight"] for n in names])
    raw = Z @ w
    out = []
    fips = [county_of(cells[g]["lat"], cells[g]["lon"]) for g in gh]
    for g, f, r_, row in zip(gh, fips, raw, Z):
        if not f or f not in COUNTIES: continue
        out.append({"gh": g, "fips": f, "raw": float(r_), "n": int(sum(1 for n in names if n in cells[g]["aff"])),
                    "top": sorted(((n, round(float(z * wi), 2)) for n, z, wi in zip(names, row, w)), key=lambda t: -abs(t[1]))[:3]})
    # anchor: county 2024 result + this cell's difference from the scan's average for that county
    by = {}
    for c in out: by.setdefault(c["fips"], []).append(c["raw"])
    for c in out:
        c["est"] = round(max(-95, min(95, COUNTIES[c["fips"]]["m24"] + 0.5 * (c["raw"] - float(np.mean(by[c["fips"]]))))), 1)
        c["county"] = COUNTIES[c["fips"]]["name"]; del c["raw"]
    v = {"cells": out, "entities": names, "ms": int((time.time() - t0) * 1000), "precision": len(gh[0])}
    _cache[key] = {"t": time.time(), "v": v}
    return v

@app.get("/api/health")
def health():
    return {"ok": True, "live": bool(KEY)}

def _json(path):
    p = DATA / path
    if not p.exists(): raise HTTPException(404)
    return FileResponse(p, media_type="application/json", headers={"Cache-Control": "public, max-age=300"})

@app.get("/api/forecast")
def forecast(office: str = "senate"):
    if office not in ("senate", "governor"): raise HTTPException(400)
    return _json(f"forecast/{office}.json")

@app.get("/api/qloo")
def qloo_only(): return _json("model/qloo_national.json")

@app.get("/api/markets")
def markets(): return _json("forecast/markets.json")

@app.get("/api/model")
def model(): return _json("model/model.json")

@app.get("/api/backtest")
def backtest(): return _json("model/national_backtest.json")

@app.get("/api/counties")
def counties(): return _json("model/counties.json")

@app.get("/api/states")
def states(): return _json("model/states.json")

@app.get("/api/cells/{stfips}")
def cells(stfips: str):
    if not (stfips.isdigit() and len(stfips) == 2): raise HTTPException(400)
    return _json(f"model/cells/{stfips}.json")

@app.get("/geo/counties-10m.json")
def topo(): return FileResponse(DATA / "raw/counties-10m.json", headers={"Cache-Control": "public, max-age=86400"})

app.mount("/", StaticFiles(directory=ROOT / "app/static", html=True), name="static")
