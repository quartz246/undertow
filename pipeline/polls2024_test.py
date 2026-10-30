"""Did Qloo see where the 2024 polls would miss? Final 2024 state poll averages (Wikipedia: aggregator averages where
listed, else the mean of October-November polls) vs the actual result, against a Qloo forecast trained only on 2020
results (+ the national shift the 2024 polls implied). History (the 2020 result + the same shift) is the baseline.
Writes data/raw/polls2024_final.json and data/model/polls2024_test.json."""
import json, re, statistics, subprocess
import numpy as np, pandas as pd
from bs4 import BeautifulSoup

URL = "https://en.wikipedia.org/w/api.php?action=parse&page=Statewide_opinion_polling_for_the_2024_United_States_presidential_election&prop=text&format=json"
raw = subprocess.run(["curl", "-s", "-m", "120", "-A", "undertow-research/0.1 (hackathon project)", URL], capture_output=True, text=True).stdout
soup = BeautifulSoup(json.loads(raw)["parse"]["text"]["*"], "lxml")
pct = lambda s: float(re.sub(r"[^\d.]", "", s)) if re.search(r"\d", s or "") else None
cur = None; agg = {}; polls = {}
for el in soup.find_all(["h2", "table"]):
    if el.name == "h2": cur = el.get_text(" ", strip=True).replace("[edit]", "").strip(); continue
    if not cur or not el.find("tr"): continue
    ths = [th.get_text(" ", strip=True) for th in el.find_all("tr")[0].find_all(["th", "td"])]
    hl = " | ".join(ths).lower()
    if "kamala harris" not in hl or "donald trump" not in hl: continue
    ih = next(i for i, h in enumerate(ths) if "harris" in h.lower()); it = next(i for i, h in enumerate(ths) if "trump" in h.lower())
    if "source of poll aggregation" in hl:
        if cur in agg: continue                                   # first (head-to-head) aggregate table only
        for tr in el.find_all("tr")[1:]:
            c = [td.get_text(" ", strip=True) for td in tr.find_all(["td", "th"])]
            if c and c[0].lower().startswith("average") and len(c) >= 3 and pct(c[1]) and pct(c[2]): agg[cur] = pct(c[1]) - pct(c[2])
        continue
    if "poll source" not in hl or len(ths) > 12: continue
    if any(x in hl for x in ("kennedy", "stein", "oliver", "west")) and cur in polls: continue
    for tr in el.find_all("tr")[1:]:
        c = [td.get_text(" ", strip=True) for td in tr.find_all("td")]
        if len(c) < max(ih, it) + 1: continue
        off = len(ths) - len(c); date = " ".join(c[:3])
        if not re.search(r"(October|Oct|November|Nov)", date) or "2023" in date: continue
        try: h, t = pct(c[ih - off]), pct(c[it - off])
        except IndexError: continue
        if h and t and 15 < h < 85 and 15 < t < 85: polls.setdefault(cur, []).append(h - t)
fin = {st: {"poll": round(agg[st], 2), "src": "aggregate"} if st in agg else {"poll": round(statistics.mean(polls[st]), 2), "src": f"{len(polls[st])} polls"}
       for st in set(agg) | {k for k, v in polls.items() if len(v) >= 2}}
json.dump(fin, open("data/raw/polls2024_final.json", "w"), indent=1)

q = json.load(open("data/model/qloo_national.json"))
r = pd.read_csv("data/raw/county24.csv"); g = r.groupby("state_name")[["votes_dem", "votes_gop", "total_votes"]].sum()
a24 = (g.votes_dem - g.votes_gop) / g.total_votes * 100
D = pd.DataFrame({s: {"poll": v["poll"], "actual": a24.get(s), "m20": q["states_m20"].get(s), "q20": q["states_2020model"].get(s)} for s, v in fin.items()}).T.dropna().astype(float)
shift = (D.poll - D.m20).mean()
D["err"] = D.actual - D.poll; D["qgap"] = D.q20 + shift - D.poll; D["hgap"] = D.m20 + shift - D.poll
rel = lambda s: s - s.mean()
out = {"n_states": int(len(D)), "avg_poll_error": round(float(D.err.mean()), 2), "poll_mae": round(float(D.err.abs().mean()), 2),
       "states_polls_too_democratic": int((D.err < 0).sum()),
       "qloo_r": round(float(np.corrcoef(rel(D.qgap), rel(D.err))[0, 1]), 2), "history_r": round(float(np.corrcoef(rel(D.hgap), rel(D.err))[0, 1]), 2),
       "history_k": round(float(np.polyfit(rel(D.hgap), rel(D.err), 1)[0]), 2),
       "rows": {s: {k: round(float(v), 1) for k, v in row.items()} for s, row in D[["poll", "actual", "err", "qgap", "hgap"]].iterrows()}}
# winner calls: polls vs Qloo (2020-trained) vs a plain half-and-half blend (chosen after seeing the data; small sample)
D["qloo"] = D.poll + D.qgap; D["blend"] = (D.poll + D.qloo) / 2; close = D.actual.abs() < 5
def score(col):
    right = np.sign(D[col]) == np.sign(D.actual)
    return {"winners": int(right.sum()), "wrong": list(D.index[~right]), "close_right": int((np.sign(D[col][close]) == np.sign(D.actual[close])).sum()),
            "avg_miss": round(float((D[col] - D.actual).abs().mean()), 1)}
out["calls"] = {"polls": score("poll"), "qloo": score("qloo"), "blend": score("blend"), "n_close": int(close.sum()),
                "close_states": list(D.index[close]), "qloo_caught": [s for s in D.index if np.sign(D.qloo[s]) == np.sign(D.actual[s]) and np.sign(D.poll[s]) != np.sign(D.actual[s])]}
json.dump(out, open("data/model/polls2024_test.json", "w"), indent=1)
print({k: v for k, v in out.items() if k != "rows"})
json.dump(out, open("data/model/polls2024_test.json", "w"), indent=1)
print({k: v for k, v in out.items() if k != "rows"})
