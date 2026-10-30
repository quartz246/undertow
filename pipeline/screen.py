import numpy as np, pandas as pd, sys
sys.path.insert(0, "pipeline"); from features import *
cells = cell_rows(["data/raw/heat_ent.jsonl", "data/raw/heat_ent2.jsonl"])
P, ents = county_table(cells); M = P.merge(results24(), on="fips"); M["logv"] = np.log(M.total_votes)
def partial(df, e):
    out = {}
    for st, x in df.groupby("state"):
        A = np.c_[np.ones(len(x)), x.logv]
        ry = x.margin_d - A @ np.linalg.lstsq(A, x.margin_d, rcond=None)[0]
        rx = x[e] - A @ np.linalg.lstsq(A, x[e], rcond=None)[0]
        out[st] = np.corrcoef(rx, ry)[0, 1]
    return out
def select(df, k=25):
    pc = pd.DataFrame({e: partial(df, e) for e in ents}).T.fillna(0)
    sgn = np.sign(pc.mean(axis=1)); cons = (np.sign(pc).eq(sgn, axis=0)).sum(axis=1)
    sc = pc.mean(axis=1).abs() * (cons >= len(pc.columns) - 1)
    return list(sc.sort_values(ascending=False).index[:k]), pc
def ridge(X, y, w, lam):
    X = np.c_[np.ones(len(X)), X]; W = w / w.mean(); I = np.eye(X.shape[1]); I[0, 0] = 0
    return np.linalg.solve((X * W[:, None]).T @ X + lam * I, (X * W[:, None]).T @ y)
y = M.margin_d.values; w = M.total_votes.values
for k in (10, 20, 30):
  for lam in (3, 30):
    rs = []; rs0 = []
    for st in M.state.unique():
        tr = M.state != st; te = ~tr
        sel, _ = select(M[tr], k); cols = ["logv"] + sel
        b = ridge(M.loc[tr, cols].values, y[tr], w[tr], lam); p = np.c_[np.ones(te.sum()), M.loc[te, cols].values] @ b
        b0 = ridge(M.loc[tr, ["logv"]].values, y[tr], w[tr], lam); p0 = np.c_[np.ones(te.sum()), M.loc[te, ["logv"]].values] @ b0
        rs.append(np.corrcoef(p, y[te])[0, 1]); rs0.append(np.corrcoef(p0, y[te])[0, 1])
    print(f"k={k:2d} lam={lam:2d}  density r={np.round(rs0,2)} mean {np.mean(rs0):.2f} | +Qloo r={np.round(rs,2)} mean {np.mean(rs):.2f}  states={list(M.state.unique())}")
sel, pc = select(M, 30)
print(pc.loc[sel].round(2).assign(mean=lambda t: t.mean(axis=1)).sort_values("mean").to_string())
M.to_csv("data/raw/county_train.csv", index=False)
