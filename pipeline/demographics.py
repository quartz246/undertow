"""Qloo as the demographic stand-in (no Census). Each county's age profile is read from the audiences of the tastes
popular there: Qloo's urn:demographics gives every taste's age/gender skew, and a county's profile is the
affinity-weighted mix of those skews, compared with the rest of its state.

Tested before use:
  - Qloo's age-group heatmaps were tried first and failed a sanity check (The Villages, FL read as average age,
    Washtenaw, MI as old), so they are not used.
  - The taste-audience profile reads 8 of 9 well-known places right, is unrelated to partisanship, and does NOT predict
    the 2020->2024 swing. It is shown as context ("who lives here, by Qloo"), never used in a call.
Writes data/model/demographics.json."""
import glob, json, sys
import numpy as np, pandas as pd
sys.path.insert(0, "pipeline")
from features import cell_rows, county_table
from qfetch import fetch

ents = json.load(open("data/raw/entities.json"))
res = fetch([(f"d|{n}", f"/v2/insights?filter.type=urn:demographics&signal.interests.entities={i}") for n, (i, t) in ents.items()], parallel=6)
tastes = {}
for k, d in res.items():
    rows = (d.get("results") or {}).get("demographics") or []
    if not rows: continue
    a, g = rows[0]["query"].get("age", {}), rows[0]["query"].get("gender", {})
    if not a: continue
    young = (a.get("24_and_younger", 0) + a.get("25_to_29", 0) + a.get("30_to_34", 0)) / 3
    tastes[k.split("|", 1)[1]] = {"old": round(a.get("55_and_older", 0), 2), "young": round(young, 2), "female": round(g.get("female", 0), 2),
                                  "age_lean": round(a.get("55_and_older", 0) - young, 2)}
print("tastes with audience demographics:", len(tastes), "of", len(ents))

cells = cell_rows(sorted(glob.glob("data/qloo/states/*.jsonl")))
P, E = county_table(cells)
use = [e for e in E if e in tastes]
wa = np.array([tastes[e]["age_lean"] for e in use]); wf = np.array([tastes[e]["female"] for e in use])
zs = lambda s: (s - s.mean()) / (s.std() + 1e-9)
P["older"] = P.groupby("state", group_keys=False).apply(lambda x: zs(pd.Series((x[use].values * wa).sum(1) / np.abs(wa).sum(), index=x.index)))
P["female"] = P.groupby("state", group_keys=False).apply(lambda x: zs(pd.Series((x[use].values * wf).sum(1) / np.abs(wf).sum(), index=x.index)))

known = {"12119": "The Villages, FL", "12015": "Charlotte Co., FL", "04025": "Yavapai Co., AZ", "18105": "Monroe Co., IN (college)", "19169": "Story Co., IA (college)",
         "42027": "Centre Co., PA (college)", "26161": "Washtenaw Co., MI (college)", "48453": "Travis Co., TX", "49049": "Utah Co., UT (young families)"}
expect_old = {"12119", "12015", "04025"}
check = []
for k, v in known.items():
    x = P.loc[P.fips == k, "older"]
    if len(x): check.append({"place": v, "older": round(float(x.iloc[0]), 2), "expected": "older" if k in expect_old else "younger",
                             "right": bool((x.iloc[0] > 0) == (k in expect_old))})
print("sanity:", sum(c["right"] for c in check), "of", len(check), "right")

r24 = pd.read_csv("data/raw/county24.csv", dtype={"county_fips": str}).rename(columns={"county_fips": "fips"})
r20 = pd.read_csv("data/raw/county20.csv", dtype={"county_fips": str}).rename(columns={"county_fips": "fips"})
M = P[["state", "fips", "older", "female"]].merge(r24[["fips", "per_point_diff", "total_votes"]], on="fips").merge(
    r20[["fips", "per_point_diff"]].rename(columns={"per_point_diff": "p20"}), on="fips")
M["m24"] = -M.per_point_diff * 100; M["m20"] = -M.p20 * 100; M["logv"] = np.log(M.total_votes)
def resid(y, X): A = np.c_[np.ones(len(X)), X]; return y - A @ np.linalg.lstsq(A, y, rcond=None)[0]
pv, sw = [], []
for st, x in M.groupby("state"):
    if len(x) < 10: continue
    pv.append(np.corrcoef(x.older, x.m24)[0, 1])
    ctl = x[["m20", "logv"]].values
    sw.append(np.corrcoef(resid(x.older.values, ctl), resid((x.m24 - x.m20).values, ctl))[0, 1])
tests = {"vs_vote_median_r": round(float(np.median(pv)), 3), "vs_swing_median_r": round(float(np.median(sw)), 3),
         "vs_swing_states_positive": int(np.sum(np.array(sw) > 0)), "n_states": len(sw),
         "heatmap_method": "Qloo age-group heatmaps failed the sanity check (The Villages read as average age), so they are not used."}
print("tests:", tests)

json.dump({"note": "Age/gender profile from the audiences of each county's tastes (Qloo urn:demographics), relative to the rest of its state. Context only: it does not predict swing.",
           "tastes": tastes, "check": check, "tests": tests,
           "counties": {f: {"older": round(float(o), 2), "female": round(float(fe), 2)} for f, o, fe in zip(P.fips, P.older, P.female)}},
          open("data/model/demographics.json", "w"))
print("wrote data/model/demographics.json")
