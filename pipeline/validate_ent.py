import json, numpy as np, pandas as pd
from shapely.geometry import shape, Point
from shapely.strtree import STRtree
from scipy.stats import spearmanr
FIPS = {"Ohio":"39","Georgia":"13","Michigan":"26","Texas":"48","North%20Carolina":"37"}
cty = json.load(open("data/raw/counties.geojson"))["features"]
res = pd.read_csv("data/raw/county24.csv", dtype={"county_fips":str}); res["margin_d"]=-res.per_point_diff*100
trees={}
for st,f in FIPS.items():
    feats=[x for x in cty if str(x["id"]).zfill(5).startswith(f)]; trees[st]=(feats,STRtree([shape(x["geometry"]) for x in feats]))
cell2f={}
rows=[]
for l in open("data/raw/heat_ent.jsonl"):
    d=json.loads(l); st,n=d["name"].split("|"); h=(d["data"].get("results") or {}).get("heatmap") or []
    feats,tree=trees[st]
    for c in h:
        gh=c["location"]["geohash"]
        if gh not in cell2f:
            idx=tree.query(Point(c["location"]["longitude"],c["location"]["latitude"]),predicate="intersects")
            cell2f[gh]=str(feats[idx[0]]["id"]).zfill(5) if len(idx) else None
        if cell2f[gh]: rows.append((st,n,cell2f[gh],c["query"]["affinity"],c["query"]["popularity"]))
df=pd.DataFrame(rows,columns="state ent fips aff pop".split())
g=df.groupby(["state","ent","fips"]).agg(aff=("aff","mean"),pop=("pop","mean")).reset_index()
P=g.pivot_table(index=["state","fips"],columns="ent",values="aff").reset_index()
M=P.merge(res[["county_fips","margin_d","total_votes"]],left_on="fips",right_on="county_fips")
ents=[c for c in P.columns if c not in("state","fips")]
print("per-entity spearman(affinity, D margin) by state")
tab={e:{st:spearmanr(x[e],x.margin_d,nan_policy="omit")[0] for st,x in M.groupby("state")} for e in ents}
print(pd.DataFrame(tab).T.round(2).assign(mean=lambda t:t.mean(axis=1)).sort_values("mean"))
M.to_csv("data/raw/county_ent_aff.csv",index=False)
