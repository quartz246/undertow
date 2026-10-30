"""Cultural read: for every race, Undertow AI turns Qloo-derived facts into a short explanation and a Nov. 3 watch list.
The model sees Qloo signals only (tastes pulling each way, out-of-step counties and who lives there, the statewide
undertow, the Qloo-only forecast vs our call, and how the signal did in that state on 2020->2024). It does not change
the call. Answers are validated: places must come from the packet, and the call it describes must match ours.
Writes data/forecast/culture_{office}.json."""
import concurrent.futures as cf, json, os, re, sys, uuid
import httpx

MODEL = os.environ.get("UNDERTOW_MODEL", "deepseek-v4.1-flash")
URL = "https://opencode.ai/zen/go/v1/chat/completions"
KEY = os.environ.get("OPENCODE_GO_KEY") or json.load(open(os.path.expanduser("~/.local/share/opencode/auth.json")))["opencode-go"]["key"]
SESSION = "undertow-culture-" + uuid.uuid4().hex[:12]
OFFICE = "governor" if "--governor" in sys.argv else "senate"

fc = json.load(open(f"data/forecast/{OFFICE}.json"))
counties = json.load(open("data/model/counties.json"))
states = json.load(open("data/model/states.json"))
qn = json.load(open("data/model/qloo_national.json"))
demo = json.load(open("data/model/demographics.json"))
model = json.load(open("data/model/model.json"))
shift = fc["national"]["median_poll_swing_since_2024"]

def fm(m): return "even" if abs(m) < 0.05 else ("D+" if m > 0 else "R+") + f"{abs(m):.1f}"
def prof(f):
    d = demo["counties"].get(f)
    if not d: return None
    a = "about average age" if abs(d["older"]) < 0.35 else ("older" if d["older"] > 0 else "younger") + " than the state"
    return a + ("" if abs(d["female"]) < 0.5 else (", leans female" if d["female"] > 0 else ", leans male"))

# each state's over/under-index on the model's tastes vs the nation (nationwide Qloo heatmaps, vote-weighted)
sys.path.insert(0, "pipeline")
import numpy as np, pandas as pd
from national import national_county_table
_C, _E = national_county_table()
_r24 = pd.read_csv("data/raw/county24.csv", dtype={"county_fips": str}).rename(columns={"county_fips": "fips"})[["fips", "state_name", "total_votes"]]
_C = _C.merge(_r24, on="fips")
LEAN = {n: e["lean"] for n, e in model["entities"].items()}
IDX = {st: {n: float(np.average(x[n], weights=x.total_votes)) for n in LEAN if n in x} for st, x in _C.groupby("state_name")}

def state_tastes(st):
    """Tastes this state loves more (and less) than the nation, each tagged with its partisan lean and audience age."""
    idx = IDX.get(st, {}); ranked = sorted(idx.items(), key=lambda kv: kv[1])
    tag = lambda n, v: {"taste": n, "leans": "Democratic" if LEAN[n] == "D" else "Republican", "vs_nation": f"{'+' if v > 0 else ''}{v:.1f} sd",
                        "audience": (lambda a: None if a is None else ("older" if a > 0 else "younger"))(demo["tastes"].get(n, {}).get("age_lean"))}
    return {"loves_more_than_nation": [tag(n, v) for n, v in ranked[::-1][:5] if v > 0], "loves_less_than_nation": [tag(n, v) for n, v in ranked[:5] if v < 0]}

def packet(r):
    st = states.get(r["state"], {}); f = r.get("verdict") or r["script"]
    q = qn["states"].get(r["state"]); q26 = None if q is None else round(q + shift, 1)
    ood = lambda lst: [{"county": n, "voted_2024": fm(m24), "qloo_expects": fm(pred), "who_lives_here": prof(fp)} for fp, n, gap, pred, m24 in lst[:3]]
    return {"race": f"{r['state']} {'governor' if OFFICE == 'governor' else 'Senate'}",
            "our_call": {"winner": (r["main"]["d"] if f["winner_party"] != "R" else r["main"]["r"])["name"], "margin": fm(f["margin_d"]), "chance": round(f["p_win"], 2)},
            "qloo_only_forecast": None if q26 is None else fm(q26), "qloo_vs_our_call_pts": None if q26 is None else round(q26 - f["margin_d"], 1),
            "statewide_undertow_pts": qn.get("state_undertow", {}).get(r["state"]),
            "tastes": state_tastes(r["state"]),
            "counties_tastes_bluer_than_vote": ood(st.get("out_of_step_d", [])), "counties_tastes_redder_than_vote": ood(st.get("out_of_step_r", [])),
            "track_record_here_2020_2024": None if not st.get("backtest") else f"counties flagged here moved the flagged way {round(st['backtest']['hit'] * 100)}% of the time from 2020 to 2024",
            "notes": "Qloo signals describe places, not voters. Inside states, out-of-step counties moved the flagged way in most states on 2020->2024; statewide gaps did not predict swings."}

SYSTEM = """You write the cultural read for one 2026 race on an election site powered by Qloo's taste data. The call itself is already made
from the polls; you explain what the culture says. You get JSON with Qloo-derived facts only: the tastes this state loves more and less than the nation (each tagged
with the party its fans lean toward and whether its audience skews older or younger), counties whose tastes look bluer or redder than their 2024 vote, the statewide undertow,
the Qloo-only forecast vs our call, and the 2020->2024 track record of the signal in this state.
Rules: use only places, tastes and numbers that appear in the JSON; do not restate the poll numbers beyond our call; be concrete and plain;
say when the culture and the call agree or disagree. Answer JSON only:
{"headline": "<= 12 words", "read": "<= 80 words", "watch": [{"place": "<a county or the state, exactly as named in the JSON>", "why": "<= 22 words"}] (2 or 3 items)}"""

def ask(r):
    p = packet(r); allowed = {c["county"] for k in ("counties_tastes_bluer_than_vote", "counties_tastes_redder_than_vote") for c in p[k]} | {r["state"]}
    body = {"model": MODEL, "max_tokens": 4000, "temperature": 0.3, "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": json.dumps(p)}]}
    hdr = {"Authorization": "Bearer " + KEY, "x-opencode-session": SESSION, "User-Agent": "undertow-synth/0.1"}
    for _ in range(3):
        try:
            res = httpx.post(URL, headers=hdr, json=body, timeout=150)
            if res.status_code != 200: continue
            m = re.search(r"\{.*\}", res.json()["choices"][0]["message"]["content"] or "", re.S)
            v = json.loads(m.group(0)) if m else None
            if not v or not isinstance(v.get("watch"), list): continue
            v["watch"] = [w for w in v["watch"] if isinstance(w, dict) and w.get("place") in allowed][:3]
            if v.get("headline") and v.get("read") and v["watch"]:
                return {"headline": v["headline"].strip()[:120], "read": v["read"].strip()[:700], "watch": [{"place": w["place"], "why": str(w.get("why", "")).strip()[:200]} for w in v["watch"]]}
        except Exception:
            pass
    return None

with cf.ThreadPoolExecutor(4) as ex:
    out = dict(zip([r["id"] for r in fc["races"]], ex.map(ask, fc["races"])))
ok = {k: v for k, v in out.items() if v}
json.dump({"office": OFFICE, "by": "Undertow AI", "source": "Qloo taste data", "reads": ok}, open(f"data/forecast/culture_{OFFICE}.json", "w"), indent=1)
print(f"{OFFICE}: cultural reads {len(ok)}/{len(out)}")
for k in list(ok)[:3]: print(" ", k, "|", ok[k]["headline"], "|", [w["place"] for w in ok[k]["watch"]])
