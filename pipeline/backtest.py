import numpy as np, pandas as pd, sys
sys.path.insert(0, "pipeline"); from features import *; from modelkit import select, ridge, partial
import modelkit
cells = cell_rows(["data/raw/heat_ent.jsonl", "data/raw/heat_ent2.jsonl"]); P, ents = county_table(cells); modelkit.ents = ents
r20 = pd.read_csv("data/raw/county20.csv", dtype={"county_fips": str}); r20["m20"] = -r20.per_point_diff * 100
r24 = results24().rename(columns={"margin_d": "m24", "total_votes": "v24"})
M = P.merge(r20[["county_fips", "m20", "total_votes"]].rename(columns={"county_fips": "fips"}), on="fips").merge(r24, on="fips")
M["logv"] = np.log(M.total_votes); M["margin_d"] = M.m20; M["swing"] = M.m24 - M.m20
def resid(y, X):
    A = np.c_[np.ones(len(X)), X]; return y - A @ np.linalg.lstsq(A, y, rcond=None)[0]
out = []
for st in M.state.unique():
    tr = M.state != st; te = ~tr; y = M.m20.values; w = M.total_votes.values
    sel, _ = select(M[tr], 20, ents); cols = ["logv"] + sel
    pq = np.c_[np.ones(te.sum()), M.loc[te, cols].values] @ ridge(M.loc[tr, cols].values, y[tr], w[tr], 30)
    pd0 = np.c_[np.ones(te.sum()), M.loc[te, ["logv"]].values] @ ridge(M.loc[tr, ["logv"]].values, y[tr], w[tr], 30)
    T = M[te].copy(); T["qloo_gap"] = pq - T.m20; T["qloo_extra"] = pq - pd0
    ctrl = T[["m20", "logv"]].values
    rs = resid(T.swing.values, ctrl)
    pc_gap = np.corrcoef(resid(T.qloo_gap.values, ctrl), rs)[0, 1]
    pc_extra = np.corrcoef(resid(T.qloo_extra.values, ctrl), rs)[0, 1]
    raw = np.corrcoef(T.qloo_gap, T.swing)[0, 1]
    # direction hit-rate among the most out-of-step counties (top/bottom 20% of controlled gap)
    g = resid(T.qloo_gap.values, ctrl); q1, q4 = np.quantile(g, [.2, .8])
    hit = np.mean(np.sign(rs[(g <= q1) | (g >= q4)]) == np.sign(g[(g <= q1) | (g >= q4)]))
    out.append((st, len(T), raw, pc_gap, pc_extra, hit, np.average(T.swing, weights=T.v24)))
print(f"{'state':15s} {'n':>4s} {'raw r(gap,swing)':>17s} {'controlled r':>13s} {'Qloo-only r':>12s} {'direction hit (extremes)':>25s} {'actual state swing':>19s}")
for st, n, a, b, c, h, s in out: print(f"{st:15s} {n:4d} {a:17.2f} {b:13.2f} {c:12.2f} {h:25.0%} {s:+19.1f}")
