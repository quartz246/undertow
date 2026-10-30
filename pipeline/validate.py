import json, numpy as np, pandas as pd
from shapely.geometry import shape, Point
from shapely.strtree import STRtree
from scipy.stats import pearsonr, spearmanr
FIPS = {"Ohio":"39","Georgia":"13","Michigan":"26","Texas":"48","North%20Carolina":"37"}
cty = json.load(open("data/raw/counties.geojson"))["features"]
res = pd.read_csv("data/raw/county24.csv", dtype={"county_fips":str})
res["margin_d"] = -res["per_point_diff"]*100
heat = {}
for l in open("data/raw/heat_test.jsonl"):
    d = json.loads(l); st, a = d["name"].split("|")
    heat[(st,a)] = {c["location"]["geohash"]:(c["location"]["latitude"],c["location"]["longitude"],c["query"]) for c in d["data"]["results"]["heatmap"]}
allrows=[]
for st, f in FIPS.items():
    feats = [x for x in cty if str(x["id"]).zfill(5).startswith(f)]
    geoms = [shape(x["geometry"]) for x in feats]; tree = STRtree(geoms)
    C, P = heat[(st,"conservative")], heat[(st,"progressive")]
    rows=[]
    for gh in set(C)|set(P):
        lat, lon, _ = (C.get(gh) or P.get(gh))
        idx = tree.query(Point(lon,lat), predicate="intersects")
        if len(idx)==0: continue
        fips = str(feats[idx[0]]["id"]).zfill(5)
        c = C.get(gh,(0,0,{}))[2]; p = P.get(gh,(0,0,{}))[2]
        rows.append(dict(fips=fips, ca=c.get("affinity",0), pa=p.get("affinity",0), cp=c.get("popularity",0), pp=p.get("popularity",0)))
    df = pd.DataFrame(rows)
    g = df.groupby("fips").agg(ca=("ca","mean"), pa=("pa","mean"), cp=("cp","mean"), pp=("pp","mean"), n=("ca","size")).reset_index()
    g["lean"] = g.pa - g.ca
    m = g.merge(res, left_on="fips", right_on="county_fips")
    m["state"]=st; allrows.append(m)
    w = m[m.n>=3]
    print(f"{st:18s} counties {len(m):3d} (>=3 cells {len(w):3d})  pearson lean~D margin {pearsonr(w.lean,w.margin_d)[0]:+.2f}  spearman {spearmanr(w.lean,w.margin_d)[0]:+.2f}  | pop-only: prog_pop {spearmanr(w.pp,w.margin_d)[0]:+.2f} cons_pop {spearmanr(w.cp,w.margin_d)[0]:+.2f}")
A = pd.concat(allrows); w=A[A.n>=3]
print("ALL  spearman lean", round(spearmanr(w.lean,w.margin_d)[0],2), " vote-weighted pearson", round(np.corrcoef(w.lean, w.margin_d)[0,1],2))
A.to_csv("data/raw/validate_counties.csv", index=False)
