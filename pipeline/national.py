"""Nationally comparable features (one US-wide Qloo query per taste) -> county table; state-level backtest."""
import json, numpy as np, pandas as pd
from shapely.geometry import shape, Point
from shapely.strtree import STRtree
def national_county_table(path="data/qloo/national.jsonl"):
    feats = json.load(open("data/raw/counties.geojson"))["features"]
    geoms = [shape(f["geometry"]) for f in feats]; tree = STRtree(geoms); ids = [str(f["id"]).zfill(5) for f in feats]
    cent = np.array([[g.centroid.y, g.centroid.x] for g in geoms])
    rows, gh2f, cells = [], {}, {}
    for l in open(path):
        d = json.loads(l); n = d["name"].split("|")[1]
        for c in d["data"]["results"]["heatmap"]:
            gh = c["location"]["geohash"]; lat, lon = c["location"]["latitude"], c["location"]["longitude"]
            cells[gh] = (lat, lon)
            if gh not in gh2f:
                idx = tree.query(Point(lon, lat), predicate="intersects"); gh2f[gh] = ids[idx[0]] if len(idx) else None
            rows.append((n, gh, c["query"]["affinity"]))
    df = pd.DataFrame(rows, columns=["ent", "gh", "aff"])
    G = df.pivot_table(index="gh", columns="ent", values="aff")
    ents = list(G.columns)
    G = G.fillna(G.min())
    # county value: mean of cells inside; counties with no cell centre inside take their nearest cell
    gh_list = list(G.index); cxy = np.array([cells[g] for g in gh_list])
    inside = pd.Series({g: gh2f[g] for g in gh_list}).dropna()
    C = G.loc[inside.index].groupby(inside.values).mean()
    missing = [i for i in ids if i not in C.index]
    if missing:
        mi = np.array([ids.index(m) for m in missing])
        d2 = ((cent[mi, None, :] - cxy[None, :, :]) ** 2).sum(-1); near = d2.argmin(1)
        C = pd.concat([C, pd.DataFrame(G.values[near], index=missing, columns=ents)])
    C = (C - C.mean()) / (C.std() + 1e-9)
    C.index.name = "fips"
    return C.reset_index(), ents
if __name__ == "__main__":
    import sys; sys.path.insert(0, "pipeline")
    C, ents = national_county_table()
    r20 = pd.read_csv("data/raw/county20.csv", dtype={"county_fips": str}); r20["m20"] = -r20.per_point_diff * 100
    r24 = pd.read_csv("data/raw/county24.csv", dtype={"county_fips": str}); r24["m24"] = -r24.per_point_diff * 100
    M = C.merge(r24[["county_fips", "state_name", "m24", "total_votes", "votes_dem", "votes_gop"]].rename(columns={"county_fips": "fips", "state_name": "state"}), on="fips")
    M = M.merge(r20[["county_fips", "m20", "votes_dem", "votes_gop", "total_votes"]].rename(columns={"county_fips": "fips", "votes_dem": "d20", "votes_gop": "g20", "total_votes": "v20"}), on="fips")
    M["logv"] = np.log(M.v20); w = M.v20.values
    print(len(M), "counties", M.state.nunique(), "states")
    def ridge(X, y, w, lam=30):
        X = np.c_[np.ones(len(X)), X]; W = w / w.mean(); I = np.eye(X.shape[1]); I[0, 0] = 0
        return np.linalg.solve((X * W[:, None]).T @ X + lam * I, (X * W[:, None]).T @ y)
    def sel(df, label, k=24):
        A = np.c_[np.ones(len(df)), df.logv]; ry = df[label] - A @ np.linalg.lstsq(A, df[label], rcond=None)[0]
        sc = {}
        for e in ents:
            rx = df[e] - A @ np.linalg.lstsq(A, df[e], rcond=None)[0]; sc[e] = np.corrcoef(rx, ry)[0, 1]
        return sorted(sc, key=lambda e: -abs(sc[e]))[:k]
    for label in ("m20",):
        pred = pd.Series(np.nan, index=M.index)
        for st in M.state.unique():
            tr, te = M.state != st, M.state == st
            cols = ["logv"] + sel(M[tr], label)
            pred[te] = np.c_[np.ones(te.sum()), M.loc[te, cols].values] @ ridge(M.loc[tr, cols].values, M.loc[tr, label].values, w[tr])
        M["pred20"] = pred
    print("county r (national features, out-of-state):", round(np.corrcoef(M.pred20, M.m20)[0, 1], 3))
    S = M.groupby("state").apply(lambda x: pd.Series({
        "m20": (x.d20.sum() - x.g20.sum()) / x.v20.sum() * 100, "m24": (x.votes_dem.sum() - x.votes_gop.sum()) / x.total_votes.sum() * 100,
        "pred20": np.average(x.pred20, weights=x.v20)}), include_groups=False)
    S["gap"] = S.pred20 - S.m20; S["swing"] = S.m24 - S.m20
    A = np.c_[np.ones(len(S)), S.m20]
    rg = S.gap - A @ np.linalg.lstsq(A, S.gap, rcond=None)[0]; rs = S.swing - A @ np.linalg.lstsq(A, S.swing, rcond=None)[0]
    print("STATE level (n=%d): r(gap, swing) raw %.2f | controlling for 2020 margin %.2f" % (len(S), np.corrcoef(S.gap, S.swing)[0, 1], np.corrcoef(rg, rs)[0, 1]))
    ext = (rg <= rg.quantile(.25)) | (rg >= rg.quantile(.75))
    print("direction hit on most out-of-step quartiles: %.0f%% of %d states" % (100 * np.mean(np.sign(rg[ext]) == np.sign(rs[ext])), ext.sum()))
    print("state-level pred r vs actual 2020:", round(np.corrcoef(S.pred20, S.m20)[0, 1], 2), " mean abs err", round(np.mean(np.abs(S.gap)), 1))
    # within-state county signal with national features
    rr = []; pa, pb = [], []
    for st, x in M.groupby("state"):
        if len(x) < 10: continue
        B = np.c_[np.ones(len(x)), x.m20, x.logv]; sw = x.m24 - x.m20; g = x.pred20 - x.m20
        a = g - B @ np.linalg.lstsq(B, g, rcond=None)[0]; b = sw - B @ np.linalg.lstsq(B, sw, rcond=None)[0]
        rr.append((st, np.corrcoef(a, b)[0, 1])); pa.extend(a); pb.extend(b)
    rr = pd.DataFrame(rr, columns=["state", "r"])
    print("within-state county r(gap,swing): median %.2f, positive in %d of %d states" % (rr.r.median(), (rr.r > 0).sum(), len(rr)))
    S.round(2).to_csv("data/raw/state_backtest.csv")
    json.dump({"n_states": int(len(S)), "county_r_out_of_state": round(float(np.corrcoef(M.pred20, M.m20)[0, 1]), 3),
               "state_r_raw": round(float(np.corrcoef(S.gap, S.swing)[0, 1]), 3), "state_r_controlled": round(float(np.corrcoef(rg, rs)[0, 1]), 3),
               "state_hit_extremes": round(float(np.mean(np.sign(rg[ext]) == np.sign(rs[ext]))), 3), "state_n_extremes": int(ext.sum()),
               "within_state_median_r": round(float(rr.r.median()), 3), "within_state_positive": int((rr.r > 0).sum()), "within_state_n": int(len(rr))},
              open("data/model/national_backtest.json", "w"), indent=1)
    # chart data: county test in ten bins, per-state r, and the statewide test points
    pa, pb = np.array(pa), np.array(pb); edges = np.quantile(pa, np.linspace(0, 1, 11)); bins = []
    for i in range(10):
        m_ = (pa >= edges[i]) & (pa <= edges[i + 1] if i == 9 else pa < edges[i + 1])
        v = pb[m_]; bins.append({"bin": i + 1, "gap": round(float(np.median(pa[m_])), 1), "swing": round(float(v.mean()), 2),
                                 "se": round(float(v.std() / np.sqrt(len(v))), 2), "n": int(len(v))})
    nb = json.load(open("data/model/national_backtest.json"))
    nb["county_bins"] = bins
    nb["within_state_r_by_state"] = [[s_, round(float(r_), 3)] for s_, r_ in rr.sort_values("r").itertuples(index=False)]
    nb["state_points"] = [{"state": s_, "gap": round(float(g_), 2), "swing": round(float(w_), 2), "m20": round(float(m_), 1)}
                          for s_, g_, w_, m_ in zip(S.index, rg, rs, S.m20)]
    json.dump(nb, open("data/model/national_backtest.json", "w"), indent=1)
    # Qloo-only map: out-of-state expected 2024 margin per county from nationally comparable tastes, and per state
    pred24 = pd.Series(np.nan, index=M.index); w24 = M.total_votes.values
    for st in M.state.unique():
        tr, te = M.state != st, M.state == st
        cols = ["logv"] + sel(M[tr], "m24")
        pred24[te] = np.c_[np.ones(te.sum()), M.loc[te, cols].values] @ ridge(M.loc[tr, cols].values, M.loc[tr, "m24"].values, w24[tr])
    M["pred24"] = pred24
    S24 = M.groupby("state").apply(lambda x: pd.Series({"pred": np.average(x.pred24, weights=x.total_votes),
        "m24": (x.votes_dem.sum() - x.votes_gop.sum()) / x.total_votes.sum() * 100}), include_groups=False)
    S24x = S24.drop(index="District of Columbia", errors="ignore")   # no race there; an outlier
    err = (S24x.pred - S24x.m24).abs()
    # fair baseline: the 2020 result plus the 2020->2024 national shift (Qloo's model also knew 2024's national mood)
    shift = (M.votes_dem.sum() - M.votes_gop.sum()) / M.total_votes.sum() * 100 - (M.d20.sum() - M.g20.sum()) / M.v20.sum() * 100
    base = (S.m20 + shift).reindex(S24x.index); bmask = base.notna()
    json.dump({"note": "Expected 2024 margin from Qloo tastes alone (leave-one-state-out, nationwide heatmaps).",
               "state_mae_2024": round(float(err.mean()), 1), "state_winner_right_2024": round(float(np.mean(np.sign(S24x.pred) == np.sign(S24x.m24))), 3),
               "state_n_2024": int(len(S24x)), "state_winner_right_n": int(np.sum(np.sign(S24x.pred) == np.sign(S24x.m24))),
               "baseline_2020_plus_shift": {"winner_right_n": int(np.sum(np.sign(base[bmask]) == np.sign(S24x.m24[bmask]))), "n": int(bmask.sum()),
                                            "mae": round(float((base[bmask] - S24x.m24[bmask]).abs().mean()), 1), "shift": round(float(shift), 1)},
               "county_r_2024": round(float(np.corrcoef(M.pred24, M.m24)[0, 1]), 3),
               "states": {s: round(float(v), 1) for s, v in S24.pred.items()},
               "counties": {f: round(float(v), 1) for f, v in zip(M.fips, M.pred24)}},
              open("data/model/qloo_national.json", "w"))
    print("Qloo-only 2024 check: state MAE %.1f, winner right %d/%d, county r %.2f | 2020+shift baseline: MAE %.1f" % (err.mean(), np.sum(np.sign(S24x.pred) == np.sign(S24x.m24)), len(S24x), np.corrcoef(M.pred24, M.m24)[0, 1], (base[bmask] - S24x.m24[bmask]).abs().mean()))
    # statewide undertow: Qloo-only expected 2024 minus actual, minus what the 2024 margin alone explains (DC excluded)
    q = json.load(open("data/model/qloo_national.json"))
    S24n = S24.drop(index="District of Columbia", errors="ignore")
    gap = S24n.pred - S24n.m24; A = np.c_[np.ones(len(S24n)), S24n.m24]
    res = gap - A @ np.linalg.lstsq(A, gap, rcond=None)[0]
    q["state_undertow"] = {s: round(float(v), 1) for s, v in res.items()}
    q["states_2020model"] = {s_: round(float(v), 2) for s_, v in S.pred20.items()}   # expected margin from a model trained on 2020 only
    q["states_m20"] = {s_: round(float(v), 2) for s_, v in S.m20.items()}
    q["state_undertow_note"] = ("Statewide undertow: Qloo-only expected 2024 margin minus actual 2024, minus what the 2024 margin alone explains "
                                "(regression to the mean). DC excluded. Backtest on 2020->2024: did not predict statewide swing.")
    json.dump(q, open("data/model/qloo_national.json", "w"))
    print("statewide undertow sd %.1f" % res.std())
