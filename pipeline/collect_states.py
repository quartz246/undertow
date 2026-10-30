"""Pull Qloo state-level heatmaps (geohash5) for every entity in data/raw/entities.json, one jsonl per state.
Keeps good rows already on disk and only fetches entities that are missing or came back broken."""
import json, os, sys, urllib.parse
sys.path.insert(0, "pipeline"); from qfetch import fetch
ents = json.load(open("data/raw/entities.json"))
states = [f["properties"]["name"] for f in json.load(open("data/raw/states.geojson"))["features"]]
states = [s for s in states if s not in ("Puerto Rico", "United States Virgin Islands", "Guam", "American Samoa", "Commonwealth of the Northern Mariana Islands")]
os.makedirs("data/qloo/states", exist_ok=True)
def good(d): return isinstance(d.get("results"), dict) and "heatmap" in d["results"]
for st in sorted(states):
    out = f"data/qloo/states/{st.replace(' ', '_')}.jsonl"
    have = {}
    if os.path.exists(out):
        for l in open(out):
            try: d = json.loads(l)
            except Exception: continue
            if "|" in d.get("name", "") and good(d["data"]): have[d["name"]] = d["data"]
    q = urllib.parse.quote(st)
    pairs = [(f"{st}|{n}", f"/v2/insights?filter.type=urn:heatmap&signal.interests.entities={i}&filter.location.query={q}")
             for n, (i, t) in ents.items() if f"{st}|{n}" not in have]
    if not pairs: continue
    for _ in range(2):
        res = fetch(pairs, parallel=8)
        have.update({n: d for n, d in res.items() if good(d)})
        pairs = [p for p in pairs if p[0] not in have]
        if not pairs: break
    with open(out, "w") as f:
        for n, d in have.items(): f.write(json.dumps({"name": n, "data": d}) + "\n")
    print(st, len(have), "missing", len(pairs), flush=True)
