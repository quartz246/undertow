"""County model: Qloo taste maps -> expected 2024 margin, and the "undertow" gap vs the real 2024 result.

Steps (all automatic, no LLM):
  1. county x entity affinity table from the state-level Qloo heatmaps (standardized within each state)
  2. pick entities whose partisan pull (partial corr with D margin, controlling for county size) has the same sign
     in >= 80% of states
  3. leave-one-state-out ridge: every county's expected margin comes from a model that never saw its state
  4. gap = expected - actual 2024, minus what 2024 margin and county size explain (regression to the mean)
  5. calibrate gap -> swing with the 2020 fit vs the 2020->2024 swing, and turn each county's 2026 gap into an
     estimated swing since 2024
Writes data/model/{counties,states,model}.json and per-state cell layers in data/model/cells/.
"""
import glob, json, os, sys
import numpy as np, pandas as pd
sys.path.insert(0, "pipeline")
from features import cell_rows, county_table, results24, STFIPS

K, LAM = 24, 30.0
os.makedirs("data/model/cells", exist_ok=True)

def ridge(X, y, w, lam=LAM):
    X = np.c_[np.ones(len(X)), X]; W = w / w.mean(); I = np.eye(X.shape[1]); I[0, 0] = 0
    return np.linalg.solve((X * W[:, None]).T @ X + lam * I, (X * W[:, None]).T @ y)

def resid(y, X):
    A = np.c_[np.ones(len(X)), X]; return y - A @ np.linalg.lstsq(A, y, rcond=None)[0], np.linalg.lstsq(A, y, rcond=None)[0]

def partials(df, ents):
    out = {}
    for st, x in df.groupby("state"):
        if len(x) < 8: continue
        A = np.c_[np.ones(len(x)), x.logv]
        ry = x.margin - A @ np.linalg.lstsq(A, x.margin, rcond=None)[0]
        row = {}
        for e in ents:
            rx = x[e] - A @ np.linalg.lstsq(A, x[e], rcond=None)[0]
            row[e] = np.corrcoef(rx, ry)[0, 1] if rx.std() > 1e-9 else 0.0
        out[st] = row
    return pd.DataFrame(out).fillna(0)

def select(df, ents, k=K):
    pc = partials(df, ents)
    sgn = np.sign(pc.mean(axis=1)); cons = np.sign(pc).eq(sgn, axis=0).mean(axis=1)
    score = pc.mean(axis=1).abs() * (cons >= 0.8)
    return list(score.sort_values(ascending=False).index[:k]), pc

def loso(M, ents, label):
    """Out-of-state expected margin per county (+ the density-only baseline)."""
    M = M.assign(margin=M[label])
    pred = pd.Series(np.nan, index=M.index)
    for st in M.state.unique():
        tr, te = M.state != st, M.state == st
        sel, _ = select(M[tr], ents); cols = ["logv"] + sel
        b = ridge(M.loc[tr, cols].values, M.loc[tr, "margin"].values, M.loc[tr, "w"].values)
        pred[te] = np.c_[np.ones(te.sum()), M.loc[te, cols].values] @ b
    return pred

def main():
    files = sorted(glob.glob("data/qloo/states/*.jsonl"))
    cells = cell_rows(files)
    P, ents = county_table(cells)
    r20 = pd.read_csv("data/raw/county20.csv", dtype={"county_fips": str})
    r20 = r20.assign(m20=-r20.per_point_diff * 100)[["county_fips", "m20"]].rename(columns={"county_fips": "fips"})
    r24 = pd.read_csv("data/raw/county24.csv", dtype={"county_fips": str})
    r24 = r24.assign(m24=-r24.per_point_diff * 100)[["county_fips", "county_name", "m24", "total_votes", "votes_dem", "votes_gop"]].rename(columns={"county_fips": "fips"})
    M = P.merge(r24, on="fips").merge(r20, on="fips", how="left")
    M["logv"] = np.log(M.total_votes); M["w"] = M.total_votes
    print(f"{len(M)} counties, {M.state.nunique()} states, {len(ents)} entities", flush=True)

    # --- backtest calibration: fit 2020, does the gap predict the 2020->2024 swing? ---
    B = M.dropna(subset=["m20"]).copy()
    B["pred20"] = loso(B, ents, "m20")
    B["swing"] = B.m24 - B.m20
    g20, _ = resid((B.pred20 - B.m20).values, B[["m20", "logv"]].values)
    s_res, _ = resid(B.swing.values, B[["m20", "logv"]].values)
    beta = float(np.polyfit(g20, s_res, 1)[0])
    per_state = {}
    for st, idx in B.groupby("state").groups.items():
        g, s = g20[B.index.get_indexer(idx)], s_res[B.index.get_indexer(idx)]
        if len(g) >= 8:
            ext = (g <= np.quantile(g, .2)) | (g >= np.quantile(g, .8))
            per_state[st] = {"r": round(float(np.corrcoef(g, s)[0, 1]), 3), "hit": round(float(np.mean(np.sign(s[ext]) == np.sign(g[ext]))), 3), "n": int(len(g))}
    bt = {"beta": round(beta, 4), "r_pooled": round(float(np.corrcoef(g20, s_res)[0, 1]), 3),
          "hit_extremes": round(float(np.mean([v["hit"] for v in per_state.values()])), 3),
          "states_positive": int(sum(v["r"] > 0 for v in per_state.values())), "states": per_state}
    print("backtest", {k: v for k, v in bt.items() if k != "states"}, flush=True)

    # --- 2026: expected 2024 margin out-of-state, gap, estimated swing since 2024 ---
    M["pred"] = loso(M, ents, "m24")
    M0 = M.assign(margin=M.m24)
    b0 = ridge(M0[["logv"]].values, M0.margin.values, M0.w.values)
    M["pred_density"] = np.c_[np.ones(len(M)), M[["logv"]].values] @ b0
    gap, gcoef = resid((M.pred - M.m24).values, M[["m24", "logv"]].values)
    M["gap"] = gap; M["swing_est"] = beta * gap
    fit = {"r_county_qloo": round(float(np.corrcoef(M.pred, M.m24)[0, 1]), 3),
           "r_county_density": round(float(np.corrcoef(M.pred_density, M.m24)[0, 1]), 3)}
    print("fit", fit, flush=True)

    # national model (all states) for cells + live zoom, with per-county top drivers
    sel, pc = select(M.assign(margin=M.m24), ents); cols = ["logv"] + sel
    b = ridge(M[cols].values, M.m24.values, M.w.values)
    coef = dict(zip(sel, b[2:]))
    contrib = M[sel].values * b[2:]
    drivers = []
    for i in range(len(M)):
        o = np.argsort(-np.abs(contrib[i]))[:4]
        drivers.append([[sel[j], round(float(contrib[i, j]), 2)] for j in o])
    M["drivers"] = drivers
    lean = pc.loc[sel].mean(axis=1)
    model = {"entities": {e: {"id": json.load(open("data/raw/entities.json"))[e][0], "weight": round(float(coef[e]), 3),
                              "lean": "D" if lean[e] > 0 else "R", "partial_r": round(float(lean[e]), 3),
                              "states_consistent": round(float((np.sign(pc.loc[e]) == np.sign(lean[e])).mean()), 3)} for e in sel},
             "intercept": float(b[0]), "logv": float(b[1]), "beta_gap_to_swing": beta, "gap_coef": [float(x) for x in gcoef],
             "backtest": bt, "fit": fit, "n_counties": int(len(M)), "n_states": int(M.state.nunique()), "k": K, "lambda": LAM}
    json.dump(model, open("data/model/model.json", "w"), indent=1)

    out = {}
    for r in M.itertuples():
        out[r.fips] = {"name": r.county_name, "state": r.state, "m24": round(r.m24, 1), "m20": None if pd.isna(r.m20) else round(r.m20, 1),
                       "votes": int(r.total_votes), "pred": round(r.pred, 1), "gap": round(r.gap, 1), "swing_est": round(r.swing_est, 2),
                       "drivers": r.drivers}
    json.dump(out, open("data/model/counties.json", "w"))

    st = {}
    for s, x in M.groupby("state"):
        w = x.total_votes
        d24 = x.votes_dem.sum(); g24 = x.votes_gop.sum(); tot = x.total_votes.sum()
        sw = float(np.average(x.swing_est, weights=w))
        # county-bootstrap spread of the state signal
        rng = np.random.default_rng(0); bs = []
        for _ in range(300):
            i = rng.integers(0, len(x), len(x)); bs.append(np.average(x.swing_est.values[i], weights=w.values[i]))
        big = x[x.total_votes >= 15000] if (x.total_votes >= 15000).sum() >= 6 else x   # small counties have thin Qloo data
        top_d = big.sort_values("gap", ascending=False).head(5); top_r = big.sort_values("gap").head(5)
        full = r24.merge(pd.read_csv("data/raw/county24.csv", dtype={"county_fips": str})[["county_fips", "state_name"]].rename(columns={"county_fips": "fips"}), on="fips")
        f = full[full.state_name == s]
        if len(f): d24, g24, tot = f.votes_dem.sum(), f.votes_gop.sum(), f.total_votes.sum()   # whole state, incl. counties the join dropped
        st[s] = {"m24": round((d24 - g24) / tot * 100, 1), "qloo_swing": round(sw, 2), "qloo_swing_lo": round(float(np.percentile(bs, 10)), 2),
                 "qloo_swing_hi": round(float(np.percentile(bs, 90)), 2), "counties": int(len(x)),
                 "share_moving_d": round(float(np.average(x.gap > 0, weights=w)), 3),
                 "out_of_step_d": [[f, n, round(g, 1), round(p, 1), round(m, 1)] for f, n, g, p, m in zip(top_d.fips, top_d.county_name, top_d.gap, top_d.pred, top_d.m24)],
                 "out_of_step_r": [[f, n, round(g, 1), round(p, 1), round(m, 1)] for f, n, g, p, m in zip(top_r.fips, top_r.county_name, top_r.gap, top_r.pred, top_r.m24)],
                 "backtest": per_state.get(s)}
    json.dump(st, open("data/model/states.json", "w"), indent=1)

    # cell layer (geohash5): within-county Qloo difference anchored to the county's 2024 result
    cty = M.drop_duplicates("fips").set_index("fips")
    for s, cx in cells.groupby("state"):
        piv = cx.pivot_table(index=["gh", "fips", "lat", "lon"], columns="ent", values="aff").reset_index()
        for e in sel:
            if e not in piv: piv[e] = np.nan
        Z = piv[sel]; Z = Z.fillna(Z.min()); Z = ((Z - Z.mean()) / (Z.std() + 1e-9)).fillna(0)
        piv["raw"] = Z.values @ b[2:]
        piv = piv[piv.fips.isin(cty.index)]
        piv["dev"] = piv.raw - piv.groupby("fips").raw.transform("mean")
        piv["est"] = (cty.loc[piv.fips, "m24"].values + 0.5 * piv.dev.values).clip(-95, 95)
        piv["n"] = cx.groupby("gh").ent.nunique().reindex(piv.gh).values
        rows = [[g, round(a, 4), round(o, 4), round(e, 1), f, int(n)] for g, a, o, e, f, n in zip(piv.gh, piv.lat, piv.lon, piv.est, piv.fips, piv.n)]
        json.dump({"cols": ["gh", "lat", "lon", "est", "fips", "n_ent"], "rows": rows}, open(f"data/model/cells/{STFIPS[s]}.json", "w"))
    print("wrote model, counties, states, cells", flush=True)

if __name__ == "__main__":
    main()
