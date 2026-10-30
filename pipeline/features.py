"""Heatmap jsonl -> county x entity affinity table (within-state standardized)."""
import json, numpy as np, pandas as pd
from shapely.geometry import shape, Point
from shapely.strtree import STRtree
_cty = None
def counties():
    global _cty
    if _cty is None: _cty = json.load(open("data/raw/counties.geojson"))["features"]
    return _cty
STFIPS = {f["properties"]["name"]: str(f["id"]).zfill(2) for f in json.load(open("data/raw/states.geojson"))["features"]}
def cell_rows(files):
    trees, c2f, rows = {}, {}, []
    for fn in files:
        for l in open(fn):
            try: d = json.loads(l)
            except Exception: continue
            if "|" not in d.get("name", ""): continue
            st, n = d["name"].split("|"); st = st.replace("%20", " ")
            h = (d["data"].get("results") or {}).get("heatmap") or []
            if st not in trees:
                feats = [x for x in counties() if str(x["id"]).zfill(5).startswith(STFIPS[st])]
                trees[st] = (feats, STRtree([shape(x["geometry"]) for x in feats]))
            feats, tree = trees[st]
            for c in h:
                gh = c["location"]["geohash"]
                if gh not in c2f:
                    idx = tree.query(Point(c["location"]["longitude"], c["location"]["latitude"]), predicate="intersects")
                    c2f[gh] = str(feats[idx[0]]["id"]).zfill(5) if len(idx) else None
                if c2f[gh]: rows.append((st, n, gh, c2f[gh], c["location"]["latitude"], c["location"]["longitude"], c["query"]["affinity"]))
    return pd.DataFrame(rows, columns="state ent gh fips lat lon aff".split())
def county_table(cells):
    g = cells.groupby(["state", "ent", "fips"]).aff.mean().reset_index()
    P = g.pivot_table(index=["state", "fips"], columns="ent", values="aff").reset_index()
    ents = [c for c in P.columns if c not in ("state", "fips")]
    for st, idx in P.groupby("state").groups.items():
        s = P.loc[idx, ents]; s = s.fillna(s.min()); P.loc[idx, ents] = ((s - s.mean()) / (s.std() + 1e-9)).fillna(0)
    return P, ents
def results24():
    r = pd.read_csv("data/raw/county24.csv", dtype={"county_fips": str}); r["margin_d"] = -r.per_point_diff * 100
    return r[["county_fips", "margin_d", "total_votes"]].rename(columns={"county_fips": "fips"})
