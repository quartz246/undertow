"""Polymarket odds for each race (and county-level markets where they exist), for COMPARISON ONLY in the Tools panel.
Nothing here feeds the forecast. Public gamma API, no key. Writes data/forecast/markets.json."""
import json, re, time
from datetime import datetime, timezone
import httpx

API = "https://gamma-api.polymarket.com/public-search"
H = {"User-Agent": "undertow-research/0.1 (hackathon project)"}
counties = json.load(open("data/model/counties.json"))
by_name = {}
for f, c in counties.items():
    by_name[(c["state"], re.sub(r"\s+(County|Parish|Borough|Census Area|Municipality)$", "", c["name"]).lower())] = f

def search(q, n=20):
    for _ in range(3):
        try:
            r = httpx.get(API, params={"q": q, "limit_per_type": n, "events_status": "active"}, headers=H, timeout=30)
            if r.status_code == 200: return r.json().get("events") or []
        except httpx.HTTPError:
            pass
        time.sleep(2)
    return []

def yes(m):
    try: return float(json.loads(m.get("outcomePrices") or "[]")[0])
    except Exception: return None

def side(title, race):
    t = (title or "").lower()
    d, r = race["main"]["d"], race["main"]["r"]
    if d["name"].split()[-1].lower() in t or (d["party"] == "D" and "democrat" in t): return "d"
    if r["name"].split()[-1].lower() in t or "republican" in t: return "r"
    if d["party"] == "I" and "independent" in t: return "d"
    return None

def odds(markets, race):
    p = {"d": 0.0, "r": 0.0}; vol = 0.0
    for m in markets:
        if m.get("closed"): continue
        s, y = side(m.get("groupItemTitle") or m.get("question"), race), yes(m)
        if s and y is not None: p[s] += y
        vol += float(m.get("volumeNum") or m.get("volume") or 0)
    tot = p["d"] + p["r"]
    return (round(p["d"] / tot, 3), round(vol)) if tot > 0.2 else (None, round(vol))

def main():
    out = {"fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "source": "Polymarket (gamma API)", "races": {}, "counties": {}}
    for office, word in (("senate", "Senate"), ("governor", "Governor")):
        fc = json.load(open(f"data/forecast/script_{office}.json"))
        for race in fc["races"]:
            st = race["state"]
            evs = search(f"{st} {word} Election Winner")
            main_ev = [e for e in evs if not e.get("closed") and e.get("title", "").startswith(f"{st} {word}") and "Winner" in e.get("title", "")
                       and "County" not in e["title"] and "Primary" not in e["title"]]
            if main_ev:
                e = max(main_ev, key=lambda e: len(e.get("markets") or []))
                p_d, vol = odds(e.get("markets") or [], race)
                if p_d is not None:
                    out["races"][race["id"]] = {"p_d": p_d, "volume": vol, "title": e["title"], "url": f"https://polymarket.com/event/{e['slug']}"}
            # county-level markets ("Texas Senate Election: Tarrant County Winner")
            cev = search(f"{st} {word} Election County Winner", 50)
            for e in cev:
                m = re.match(rf"^{re.escape(st)} {word} Election: (.+?) (County|Parish|Borough) Winner$", e.get("title", ""))
                if not m or e.get("closed"): continue
                fips = by_name.get((st, m.group(1).lower()))
                p_d, vol = odds(e.get("markets") or [], race)
                if fips and p_d is not None:
                    out["counties"][f"{race['id']}:{fips}"] = {"race": race["id"], "fips": fips, "name": counties[fips]["name"], "state": st, "p_d": p_d,
                                                               "volume": vol, "url": f"https://polymarket.com/event/{e['slug']}"}
            time.sleep(0.4)
    json.dump(out, open("data/forecast/markets.json", "w"), indent=1)
    print(f"race markets {len(out['races'])}, county markets {len(out['counties'])}")

if __name__ == "__main__":
    main()
