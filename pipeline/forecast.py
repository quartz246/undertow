"""Assemble the race-by-race forecast from polls + 2024 baseline (Qloo county layer attached for the map). Pure script; no LLM here.
Writes data/forecast/script.json (synth.py adds the final-judgement layer and writes senate.json)."""
import json, math, re, statistics, sys
from datetime import date, datetime, timezone

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
OFFICE = "governor" if "--governor" in sys.argv else "senate"
TODAY = date.fromisoformat(ARGS[0]) if ARGS else date.today()
HALF_LIFE, WINDOW = 21.0, 60
POP_W = {"LV": 1.0, "RV": 0.8, "A": 0.6}

polls = json.load(open(f"data/polls/{OFFICE}_2026.json"))
states = json.load(open("data/model/states.json"))
model = json.load(open("data/model/model.json"))
stfips = {f["properties"]["name"]: str(f["id"]).zfill(2) for f in json.load(open("data/raw/states.geojson"))["features"]}

# statewide 2024 result from the full county file (the model's county join drops some, e.g. Alaska's districts)
import csv
_tot = {}
for row in csv.DictReader(open("data/raw/county24.csv")):
    t = _tot.setdefault(row["state_name"], [0, 0, 0]); t[0] += int(row["votes_dem"]); t[1] += int(row["votes_gop"]); t[2] += int(row["total_votes"])
for name, (dv, gv, tv) in _tot.items():
    if name not in states:   # e.g. Connecticut: results come by planning region, so the county model has no entry
        states[name] = {"qloo_swing": 0.0, "qloo_swing_lo": 0.0, "qloo_swing_hi": 0.0, "share_moving_d": None,
                        "out_of_step_d": [], "out_of_step_r": [], "backtest": None, "counties": 0}
    states[name]["m24"] = round((dv - gv) / tv * 100, 1)

def phi(x): return 0.5 * (1 + math.erf(x / math.sqrt(2)))

def sides(race):
    """The R nominee and the strongest non-R nominee (a D, or an independent like Osborn where no D runs)."""
    share = {}
    for p in race["polls"]:
        for n, v in p["pct"].items(): share.setdefault(n, []).append(v)
    avg = {n: statistics.mean(v) for n, v in share.items()}
    cands = race["candidates"]
    rs = sorted([c for c in cands if c["party"] == "R"], key=lambda c: (-avg.get(c["name"], -1), not c["incumbent"]))
    others = [c for c in cands if c["party"] != "R"]
    ds = sorted(others, key=lambda c: (-avg.get(c["name"], -1), c["party"] != "D"))
    r = rs[0] if rs else None
    # an independent only counts as the main opponent if polls show them ahead of any Democrat
    d = ds[0] if ds else None
    return d, r

def poll_avg(race, d, r):
    rows = []
    seen = set()
    for p in sorted(race["polls"], key=lambda p: p["end_date"] or "", reverse=True):
        if not p.get("end_date") or d["name"] not in p["pct"] or r["name"] not in p["pct"]: continue
        end = date.fromisoformat(p["end_date"])
        if end > TODAY: continue
        age = (TODAY - end).days
        key = re.sub(r"\s*\(.*?\)", "", p["pollster"]).strip().lower()
        recent = age <= WINDOW
        if recent and key in seen: continue   # one poll per pollster in the window: its latest
        if recent: seen.add(key)
        w = 0.5 ** (age / HALF_LIFE) * math.sqrt(min(p.get("sample") or 600, 2000) / 600) * POP_W.get(p.get("population"), 0.8)
        if re.search(r"\((D|R)\)", p["pollster"]): w *= 0.6   # partisan-sponsored polls count less
        rows.append({"pollster": p["pollster"], "end_date": p["end_date"], "sample": p.get("sample"), "population": p.get("population"),
                     "margin_d": round(p["pct"][d["name"]] - p["pct"][r["name"]], 1), "w": w, "recent": recent})
    use = [x for x in rows if x["recent"]] or rows[:5]
    if not use: return None, rows, 0
    m = sum(x["margin_d"] * x["w"] for x in use) / sum(x["w"] for x in use)
    return round(m, 1), rows, sum(1 for x in rows if x["recent"])

out = []
for race in polls["races"]:
    d, r = sides(race)
    if not d or not r: continue
    st = states.get(race["state"])
    if not st: print("no model for", race["state"]); continue
    avg, rows, n_recent = poll_avg(race, d, r)
    out.append({"race": race, "d": d, "r": r, "avg": avg, "rows": rows, "n_recent": n_recent, "st": st})

# relative signals: compare each state with the typical race, so the national midterm mood does not count as "skew"
poll_sw = [x["avg"] - x["st"]["m24"] for x in out if x["avg"] is not None and x["n_recent"] >= 2]
nat_poll_swing = statistics.median(poll_sw) if poll_sw else 0.0
def fmt(m): return "even" if abs(m) < 0.05 else ("D+" if m > 0 else "R+") + f"{abs(m):.1f}"

def house_skew(rows):
    """Partisan-sponsored polls vs independent ones in the recent window (pollster names carry Wikipedia's (D)/(R) tags)."""
    rec = [p for p in rows if p["recent"]]
    tag = lambda p: (re.search(r"\((D|R)\)", p["pollster"]) or [None, None])[1]
    ind = [p for p in rec if not tag(p)]
    out = {}
    for t in ("D", "R"):
        sp = [p["margin_d"] for p in rec if tag(p) == t]
        if len(sp) >= 3 and len(ind) >= 3:
            out[t] = {"n": len(sp), "diff": round(statistics.mean(sp) - statistics.mean(p["margin_d"] for p in ind), 1)}
    ind_avg = round(sum(p["margin_d"] * p["w"] for p in ind) / sum(p["w"] for p in ind), 1) if ind else None
    return out, len(ind), ind_avg

races = []
for x in out:
    race, d, r, st, avg = x["race"], x["d"], x["r"], x["st"], x["avg"]
    poll_swing = None if avg is None else round(avg - st["m24"], 1)
    rel_poll = None if poll_swing is None else poll_swing - nat_poll_swing
    dn, rn = d["name"].split()[-1], r["name"].split()[-1]
    hs, n_ind, ind_avg = house_skew(x["rows"])
    flag, short, text = None, None, None
    # 1) poll-house skew: the side a sponsor favours looks better in that sponsor's polls
    big = [(t, v) for t, v in hs.items() if (v["diff"] >= 4 and t == "D") or (v["diff"] <= -4 and t == "R")]
    if big:
        t, v = max(big, key=lambda tv: abs(tv[1]["diff"]))
        fav = dn if t == "D" else rn
        flag, short = "house", f"{t}-sponsored polls lean {fav}"
        text = (f"{v['n']} {'Democratic' if t == 'D' else 'Republican'}-sponsored polls show {fav} {abs(v['diff']):.1f} pts better than the {n_ind} "
                f"independent polls. The average already counts them at 60%; the independent polls alone say {fmt(ind_avg)}.")
    # 2) shift since 2024 far out of line with the typical polled race
    elif rel_poll is not None and abs(rel_poll) >= 9 and x["n_recent"] >= 2:
        flag = "shift"; who = dn if rel_poll > 0 else rn
        short = f"Unusual shift toward {who}"
        text = (f"Polls have {race['state_po']} {abs(rel_poll):.1f} pts further toward {who} than the typical race moved since 2024 "
                f"(typical: {nat_poll_swing:+.1f}). That can be a real candidate effect or a polling miss; candidate-driven Senate races often break this way.")
    elif avg is None:
        text = f"No recent polls. The call uses the 2024 result ({fmt(st['m24'])}) plus the typical shift in polled races ({nat_poll_swing:+.1f})."
    else:
        text = f"Polls here moved {poll_swing:+.1f} pts since 2024, close to the typical race ({nat_poll_swing:+.1f}); no sign of house skew."
    if avg is not None and x["n_recent"] >= 1:
        margin = avg; sigma = 5.0 if x["n_recent"] >= 3 else 6.5
    elif avg is not None:
        margin = 0.5 * avg + 0.5 * (st["m24"] + nat_poll_swing); sigma = 7.5
    else:
        margin = st["m24"] + nat_poll_swing; sigma = 9.0
    p_d = phi(margin / sigma)
    wp = d["party"] if margin > 0 else "R"
    races.append({
        "id": race["id"], "state": race["state"], "state_po": race["state_po"], "stfips": stfips[race["state"]], "special": race["special"],
        "wiki_url": race.get("wiki_url"), "ratings": race.get("ratings") or {},
        "candidates": [c for c in race["candidates"] if c["name"] in (d["name"], r["name"])],
        "main": {"d": d, "r": r},
        "polls": {"n": len(x["rows"]), "n_recent": x["n_recent"], "avg_margin_d": avg, "latest": x["rows"][0]["end_date"] if x["rows"] else None,
                  "house": hs, "independent_avg": ind_avg, "list": [{k: v for k, v in p.items() if k not in ("w", "recent")} for p in x["rows"][:8]]},
        "pres24_margin_d": st["m24"],
        "qloo": {"share_moving_d": st["share_moving_d"], "out_of_step_d": st["out_of_step_d"], "out_of_step_r": st["out_of_step_r"], "backtest": st["backtest"]},
        "skew": {"poll_swing": poll_swing, "rel_poll_swing": None if rel_poll is None else round(rel_poll, 1), "flag": flag, "short": short, "text": text},
        "script": {"margin_d": round(margin, 1), "p_win": round(max(p_d, 1 - p_d), 3), "winner_party": wp, "sigma": sigma},
    })

latest = max((r["polls"]["latest"] for r in races if r["polls"]["latest"]), default=None)
json.dump({"office": OFFICE, "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "polls_through": latest, "polls_fetched_at": polls.get("fetched_at"),
           "national": {"median_poll_swing_since_2024": round(nat_poll_swing, 1)},
           "races": races}, open(f"data/forecast/script_{OFFICE}.json", "w"), indent=1)
for r in sorted(races, key=lambda r: r["script"]["margin_d"]):
    print(f"{r['id']:6s} polls {str(r['polls']['avg_margin_d']):>6s} ({r['polls']['n_recent']:2d}) 24 {r['pres24_margin_d']:+6.1f} -> {r['script']['margin_d']:+6.1f} p {r['script']['p_win']:.2f} {r['script']['winner_party']}  {r['skew']['short'] or ''}")
print("national poll swing since 2024:", round(nat_poll_swing, 1))
