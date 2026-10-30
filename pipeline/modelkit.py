import numpy as np, pandas as pd, sys
sys.path.insert(0, "pipeline"); from features import *
def partial(df, e):
    out = {}
    for st, x in df.groupby("state"):
        A = np.c_[np.ones(len(x)), x.logv]
        ry = x.margin_d - A @ np.linalg.lstsq(A, x.margin_d, rcond=None)[0]
        rx = x[e] - A @ np.linalg.lstsq(A, x[e], rcond=None)[0]
        out[st] = np.corrcoef(rx, ry)[0, 1]
    return out
def select(df, k=25, ents=None):
    pc = pd.DataFrame({e: partial(df, e) for e in ents}).T.fillna(0)
    sgn = np.sign(pc.mean(axis=1)); cons = (np.sign(pc).eq(sgn, axis=0)).sum(axis=1)
    sc = pc.mean(axis=1).abs() * (cons >= len(pc.columns) - 1)
    return list(sc.sort_values(ascending=False).index[:k]), pc
def ridge(X, y, w, lam):
    X = np.c_[np.ones(len(X)), X]; W = w / w.mean(); I = np.eye(X.shape[1]); I[0, 0] = 0
    return np.linalg.solve((X * W[:, None]).T @ X + lam * I, (X * W[:, None]).T @ y)
