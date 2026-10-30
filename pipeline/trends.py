"""Qloo trend data (/v2/trending): monthly popularity percentile for every model taste plus political names,
Aug 2023 - Oct 2026. Saves the raw monthly series to data/qloo/trends.json (coverage is patchy per entity)."""
import json, sys, urllib.parse
sys.path.insert(0, "pipeline"); from qfetch import fetch
ents = {n: (i, t.split(":")[-1]) for n, (i, t) in json.load(open("data/raw/entities.json")).items()}
extra = [("Donald Trump", "person"), ("Kamala Harris", "person"), ("JD Vance", "person"), ("Joe Biden", "person"), ("Gavin Newsom", "person"), ("Elon Musk", "person"),
         ("Ron DeSantis", "person"), ("Josh Shapiro", "person"), ("Robert F. Kennedy Jr.", "person"), ("Zohran Mamdani", "person"), ("Pete Buttigieg", "person"),
         ("Bud Light", "brand"), ("Target", "brand"), ("Tesla", "brand"), ("Costco", "brand"), ("Walmart", "brand"), ("CNN", "brand"), ("Truth Social", "brand"),
         ("The View", "tv_show"), ("Fox & Friends", "tv_show")]
res = fetch([(f"{n}|{t}", f"/search?query={urllib.parse.quote(n)}&types=urn:entity:{t}&take=1") for n, t in extra], parallel=6)
for k, d in res.items():
    r = d.get("results") or []
    if r and k.split("|")[0] not in ents: ents[r[0]["name"]] = (r[0]["entity_id"], k.split("|")[1])
months = [f"{y}-{m:02d}" for y in (2023, 2024, 2025, 2026) for m in range(1, 13) if "2023-08" <= f"{y}-{m:02d}" <= "2026-10"]
pairs = [(f"{n}|{mo}", f"/v2/trending?entity_ids={i}&filter.type=urn:entity:{t}&filter.start_date={mo}-01&filter.end_date={mo}-28&take=50") for n, (i, t) in ents.items() for mo in months]
# gender split check on a month known to have data
tr_id = ents.get("Donald Trump", (None,))[0]
if tr_id: pairs += [("Donald Trump|gender-test", f"/v2/trending?entity_ids={tr_id}&filter.type=urn:entity:person&filter.start_date=2024-01-01&filter.end_date=2024-01-28&take=50&signal.demographics.gender=female")]
res = fetch(pairs, parallel=8)
out = {"months": months, "entities": {n: {"id": i, "type": t} for n, (i, t) in ents.items()}, "series": {}}
for k, d in res.items():
    n, mo = k.split("|"); tr = (d.get("results") or {}).get("trending") if isinstance(d.get("results"), dict) else None
    if mo == "gender-test": out["gender_test"] = bool(tr) and tr[0]; continue
    if tr: out["series"].setdefault(n, {})[mo] = {"pct": round(sum(x["population_percentile"] for x in tr) / len(tr), 5), "rank": int(tr[0]["population_rank"]), "n": len(tr)}
json.dump(out, open("data/qloo/trends.json", "w"))
print("entities", len(ents), "with any data", len(out["series"]), "| gender test:", str(out.get("gender_test"))[:200])
