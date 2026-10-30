"""Trend analysis on Qloo's monthly popularity data: a culture barometer (Republican- vs Democratic-leaning tastes over
time), risers and fallers, and political names. Coverage is patchy, so every result carries its coverage.
Undertow AI (the final-judgement LLM) writes a short synthesis from these numbers only.
Writes data/model/trends.json."""
import json, os, re, sys, uuid
import numpy as np, httpx

T = json.load(open("data/qloo/trends.json")); months = T["months"]; series = T["series"]
model = json.load(open("data/model/model.json"))["entities"]
POL = {"Donald Trump": "R", "J. D. Vance": "R", "JD Vance": "R", "Ron DeSantis": "R", "Truth Social": "R", "Fox & Friends": "R",
       "Kamala Harris": "D", "Joe Biden": "D", "Gavin Newsom": "D", "Josh Shapiro": "D", "Zohran Mamdani": "D", "Pete Buttigieg": "D", "The View": "D"}
def lean(n):
    if n in POL: return POL[n]
    if n in model: return model[n]["lean"]
    return None

def ser(n):
    s = series.get(n, {}); return [s[m]["pct"] if m in s else None for m in months]

# per-entity standardised series, so tastes with different popularity levels can be averaged
Z = {}
for n in series:
    v = np.array([x if x is not None else np.nan for x in ser(n)], dtype=float)
    if np.sum(~np.isnan(v)) >= 4 and np.nanstd(v) > 1e-6:
        Z[n] = (v - np.nanmean(v)) / np.nanstd(v)

baro = []
for i, m in enumerate(months):
    row = {"month": m}
    for side in ("R", "D"):
        vals = [Z[n][i] for n in Z if lean(n) == side and not np.isnan(Z[n][i])]
        row[side] = round(float(np.mean(vals)), 3) if len(vals) >= 3 else None
        row[f"n{side}"] = len(vals)
    baro.append(row)

def period_mean(n, lo, hi):
    s = series.get(n, {}); v = [s[m]["pct"] for m in months if lo <= m <= hi and m in s]
    return float(np.mean(v)) if v else None
movers = []
for n in series:
    a, b = period_mean(n, "2024-01", "2024-12"), period_mean(n, "2025-07", "2026-10")
    if a is not None and b is not None:
        movers.append({"name": n, "lean": lean(n), "type": T["entities"].get(n, {}).get("type"), "pct_2024": round(a, 4), "pct_recent": round(b, 4), "change": round(b - a, 4)})
movers.sort(key=lambda x: x["change"])
pol = {n: [{"month": m, "pct": series[n][m]["pct"], "rank": series[n][m]["rank"]} for m in months if m in series[n]] for n in series if n in POL}
cov = {"entities_total": len(T["entities"]), "with_any_data": len(series), "with_4plus_months": len(Z),
       "with_recent_data": sum(1 for n in series if any(m >= "2025-07" for m in series[n])), "gender_split": bool(T.get("gender_test"))}
print("coverage:", cov)
print("barometer months with both sides:", sum(1 for r in baro if r["R"] is not None and r["D"] is not None))
print("movers:", len(movers), "| top risers:", [(m["name"], m["change"]) for m in movers[-5:]], "| fallers:", [(m["name"], m["change"]) for m in movers[:5]])

# Undertow AI synthesis from the numbers only
summary = None
try:
    key = os.environ.get("OPENCODE_GO_KEY") or json.load(open(os.path.expanduser("~/.local/share/opencode/auth.json")))["opencode-go"]["key"]
    packet = {"coverage": cov, "barometer_by_month": [r for r in baro if r["R"] is not None or r["D"] is not None],
              "risers": movers[-8:], "fallers": movers[:8], "political_names_months_with_data": {n: [p["month"] for p in v] for n, v in pol.items()}}
    sysmsg = ("You summarise Qloo cultural-trend data for an election site. You get monthly popularity (z-scores within each taste) for "
              "Republican-leaning (R) and Democratic-leaning (D) tastes, plus risers and fallers between 2024 and mid-2025 onward, and coverage counts. "
              "Write what the data shows and how much to trust it. Never invent numbers or events not in the JSON; say plainly where coverage is thin. "
              'Answer JSON only: {"headline": "<= 12 words", "summary": "<= 90 words", "caveat": "<= 35 words"}')
    r = httpx.post("https://opencode.ai/zen/go/v1/chat/completions", timeout=120,
                   headers={"Authorization": "Bearer " + key, "x-opencode-session": "undertow-trends-" + uuid.uuid4().hex[:10], "User-Agent": "undertow-synth/0.1"},
                   json={"model": "deepseek-v4.1-flash", "max_tokens": 4000, "temperature": 0.2,
                         "messages": [{"role": "system", "content": sysmsg}, {"role": "user", "content": json.dumps(packet)}]})
    m = re.search(r"\{.*\}", r.json()["choices"][0]["message"]["content"] or "", re.S)
    summary = json.loads(m.group(0)) if m else None
except Exception as e:
    print("synthesis failed:", e)
print("synthesis:", summary)
json.dump({"months": months, "coverage": cov, "barometer": baro, "movers": movers, "political": pol, "summary": summary, "by": "Undertow AI"},
          open("data/model/trends.json", "w"), indent=1)
