"""Undertow Campaign Strategist: an agent that plans where a campaign should spend its last ad dollars, ZIP code by ZIP code.

Undertow AI (an LLM with tool calling) plans and decides; every fact comes from a tool:
  get_race         our call, the cultural read, the Qloo-only forecast
  rank_counties    persuasion and turnout targets for the chosen candidate (Qloo tastes vs the vote)
  scan_zips        live Qloo heatmaps across target counties, scored ZIP by ZIP
  find_channels    what a target area over-indexes on (shows, podcasts, brands, artists), from Qloo
  allocate_budget  splits the budget across the chosen ZIPs
The final plan is validated: ZIPs and channels must come from tool results, and budgets are rescaled to the total.
No personal data is used anywhere: Qloo works on aggregate taste data.
"""
import asyncio, json, math, os, re, time, uuid
from pathlib import Path
import httpx, numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
LLM_URL = "https://opencode.ai/zen/go/v1/chat/completions"
LLM_MODEL = os.environ.get("UNDERTOW_MODEL", "deepseek-v4.1-flash")
LLM_KEY = os.environ.get("OPENCODE_GO_KEY", "")
QLOO = "https://hackathon.api.qloo.com"

def _j(p): return json.loads((DATA / p).read_text())
ZIPS = {}
for line in (DATA / "geo/us_zips.tsv").read_text().splitlines()[1:]:
    z, place, st, lat, lon = line.split("\t"); ZIPS[z] = {"zip": z, "place": place, "st": st, "lat": float(lat), "lon": float(lon)}
ZIP_COUNTY = _j("geo/zip_county.json")
COUNTY_ZIPS = {}
for z, f in ZIP_COUNTY.items(): COUNTY_ZIPS.setdefault(f, []).append(z)
_COUNTY_GEO = {str(f["id"]).zfill(5): f["geometry"] for f in _j("raw/counties.geojson")["features"]}

def county_center(f):
    g = _COUNTY_GEO.get(f); pts = []
    def walk(c):
        if isinstance(c[0], (int, float)): pts.append(c)
        else:
            for x in c: walk(x)
    if g: walk(g["coordinates"])
    a = np.array(pts) if pts else np.zeros((1, 2))
    lon0, lat0, lon1, lat1 = a[:, 0].min(), a[:, 1].min(), a[:, 0].max(), a[:, 1].max()
    span_km = max((lon1 - lon0) * 111 * math.cos(math.radians((lat0 + lat1) / 2)), (lat1 - lat0) * 111)
    return (lat0 + lat1) / 2, (lon0 + lon1) / 2, span_km

def fm(m): return "even" if m is None or abs(m) < 0.05 else ("D+" if m > 0 else "R+") + f"{abs(m):.1f}"

class Ctx:
    """Everything the tools read, loaded fresh per run so a forecast refresh is picked up."""
    def __init__(self):
        self.fc = {o: _j(f"forecast/{o}.json") for o in ("senate", "governor")}
        self.culture = {o: (_j(f"forecast/culture_{o}.json") if (DATA / f"forecast/culture_{o}.json").exists() else {"reads": {}}) for o in ("senate", "governor")}
        self.counties = _j("model/counties.json"); self.states = _j("model/states.json")
        self.qn = _j("model/qloo_national.json"); self.demo = _j("model/demographics.json")
        self.races = {r["id"]: (o, r) for o in self.fc for r in self.fc[o]["races"]}
    def race(self, rid):
        o, r = self.races[rid]; return o, r, (r.get("verdict") or r["script"])
    def shift(self, office): return self.fc[office]["national"]["median_poll_swing_since_2024"]
    def county_est(self, rid, f):
        o, r, f_ = self.race(rid); c = self.counties[f]; st = self.states[c["state"]]
        return c["m24"] + (f_["margin_d"] - st["m24"]) + (c["swing_est"] - st["qloo_swing"])
    def county_qloo(self, rid, f):
        o = self.races[rid][0]; q = self.qn["counties"].get(f)
        return None if q is None else q + self.shift(o)
    def profile(self, f):
        d = self.demo["counties"].get(f)
        if not d: return None
        a = "about average age" if abs(d["older"]) < 0.35 else ("older" if d["older"] > 0 else "younger") + " than the state"
        return a + ("" if abs(d["female"]) < 0.5 else (", leans female" if d["female"] > 0 else ", leans male"))

# ------------------------------------------------------------------ tools
def t_get_race(ctx, race_id):
    o, r, f = ctx.race(race_id); cr = ctx.culture[o]["reads"].get(race_id) or {}
    q = ctx.qn["states"].get(r["state"])
    return {"race": f"{r['state']} {'governor' if o == 'governor' else 'Senate'}", "candidates": [{"name": c["name"], "party": c["party"]} for c in r["candidates"]],
            "our_call": {"winner": (r["main"]["d"] if f["winner_party"] != "R" else r["main"]["r"])["name"], "margin": fm(f["margin_d"]), "chance": round(f["p_win"], 2)},
            "poll_average": fm(r["polls"]["avg_margin_d"]) if r["polls"]["avg_margin_d"] is not None else None,
            "qloo_only_forecast": None if q is None else fm(q + ctx.shift(o)),
            "cultural_read": cr.get("headline"), "watch": [w["place"] for w in cr.get("watch", [])]}

def t_rank_counties(ctx, race_id, side):
    """Persuasion: tastes lean toward our side more than the place's expected vote, and the place is in play.
    Turnout: the place already leans our way in both vote and tastes, and is big."""
    o, r, f = ctx.race(race_id); sgn = 1 if side != "R" else -1
    rows = []
    for fips, c in ctx.counties.items():
        if c["state"] != r["state"]: continue
        est, q = ctx.county_est(race_id, fips), ctx.county_qloo(race_id, fips)
        if q is None: continue
        lean = sgn * (q - est); e = sgn * est
        rows.append({"fips": fips, "county": c["name"], "votes_2024": c["votes"], "voted_2024": fm(c["m24"]), "estimate_2026": fm(est), "qloo_expects": fm(q),
                     "who_lives_here": ctx.profile(fips), "_lean": lean, "_e": e, "_v": c["votes"]})
    pers = [x for x in rows if x["_lean"] > 0 and -25 <= x["_e"] <= 12]
    for x in pers: x["score"] = round(x["_lean"] * math.sqrt(x["_v"]) / (1 + abs(x["_e"]) / 15) / 100, 2)
    turn = [x for x in rows if x["_e"] > 5 and sgn * (ctx.county_qloo(race_id, x["fips"]) or 0) > 0]
    for x in turn: x["score"] = round(math.sqrt(x["_v"]) * min(x["_e"], 40) / 400, 2)
    clean = lambda L: [{k: v for k, v in x.items() if not k.startswith("_")} for x in sorted(L, key=lambda x: -x["score"])[:6]]
    return {"side": side, "persuasion_targets": clean(pers), "turnout_targets": clean(turn),
            "how_scored": "persuasion = tastes lean your way more than the county's expected 2026 vote, in a county that is in play; turnout = already leans your way in vote and tastes, weighted by size"}

async def _heat(client, key, ent_id, lat, lon, radius, sem):
    params = {"filter.type": "urn:heatmap", "signal.interests.entities": ent_id, "filter.location": f"POINT({lon:.5f} {lat:.5f})", "filter.location.radius": str(radius)}
    async with sem:
        for _ in range(2):
            try:
                r = await client.get(QLOO + "/v2/insights", params=params, headers={"X-Api-Key": key}, timeout=30)
                if r.status_code == 200: return (r.json().get("results") or {}).get("heatmap") or []
            except httpx.HTTPError: pass
            await asyncio.sleep(0.4)
    return []

_scan_cache = {}
async def t_scan_zips(ctx, race_id, county_fips, side, qkey, live_entities):
    """Live Qloo heatmaps for the model's strongest tastes across each county; each ~1 km cell is scored with the taste
    model, cells are assigned to the nearest ZIP in the county, and ZIPs are ranked by how far their tastes lean our way
    compared with the rest of the county."""
    sgn = 1 if side != "R" else -1; out = []
    sem = asyncio.Semaphore(8)
    async with httpx.AsyncClient(headers={"User-Agent": "undertow/0.1"}) as client:
        for fips in county_fips[:4]:
            zips = [ZIPS[z] for z in COUNTY_ZIPS.get(fips, []) if z in ZIPS]
            if not zips or fips not in ctx.counties: continue
            if fips not in _scan_cache:
                lat, lon, span = county_center(fips); radius = int(min(30000, max(6000, span * 600)))
                res = await asyncio.gather(*[_heat(client, qkey, e["id"], lat, lon, radius, sem) for _, e in live_entities])
                cells = {}
                for (name, e), h in zip(live_entities, res):
                    for c in h:
                        g = c["location"]["geohash"]; cell = cells.setdefault(g, {"lat": c["location"]["latitude"], "lon": c["location"]["longitude"], "aff": {}, "pop": 0.0})
                        cell["aff"][name] = c["query"]["affinity"]; cell["pop"] += c["query"].get("popularity", 0)
                _scan_cache[fips] = cells
            cells = _scan_cache[fips]
            if not cells: continue
            names = [n for n, _ in live_entities]; gh = list(cells)
            A = np.array([[cells[g]["aff"].get(n, np.nan) for n in names] for g in gh], dtype=float)
            mn = np.nanmin(np.where(np.isnan(A), np.inf, A), axis=0); mn[~np.isfinite(mn)] = 0; A = np.where(np.isnan(A), mn, A)
            Z = (A - A.mean(0)) / (A.std(0) + 1e-9); raw = Z @ np.array([e["weight"] for _, e in live_entities])
            zl = np.array([[z["lat"], z["lon"]] for z in zips])
            per = {}
            for g, s in zip(gh, raw):
                d = ((zl[:, 0] - cells[g]["lat"]) ** 2 + ((zl[:, 1] - cells[g]["lon"]) * math.cos(math.radians(cells[g]["lat"]))) ** 2)
                i = int(d.argmin())
                if d[i] < 0.12 ** 2: per.setdefault(i, []).append((s, cells[g]["pop"]))
            mu = float(np.mean(raw))
            for i, v in per.items():
                if len(v) < 2: continue
                lean = sgn * (float(np.mean([s for s, _ in v])) - mu)
                out.append({"zip": zips[i]["zip"], "place": zips[i]["place"], "county": ctx.counties[fips]["name"], "fips": fips, "lat": zips[i]["lat"], "lon": zips[i]["lon"],
                            "lean_toward_you": round(lean, 2), "activity": round(sum(p for _, p in v), 2), "cells": len(v)})
    out.sort(key=lambda x: -x["lean_toward_you"])
    top = []
    for fips in county_fips[:4]:   # keep the best few per county so every target county is represented
        top += [x for x in out if x["fips"] == fips][:6]
    return {"zips": sorted(top, key=lambda x: -x["lean_toward_you"]), "scanned_cells": sum(len(_scan_cache.get(f, {})) for f in county_fips[:4]),
            "how_scored": "lean_toward_you = how much the ZIP's tastes lean your way vs the rest of its county (Qloo heatmaps, ~1 km cells); activity = Qloo popularity summed over its cells"}

_chan_cache = {}
async def t_find_channels(ctx, lat, lon, qkey, audience=None):
    """What an area over-indexes on, by Qloo: TV shows, podcasts, brands and artists near a point (optionally among a
    political-preference audience: progressive / center / conservative)."""
    key = (round(lat, 2), round(lon, 2), audience)
    if key in _chan_cache: return _chan_cache[key]
    aud = {"progressive": "urn:audience:political_preferences:politically_progressive", "center": "urn:audience:political_preferences:politically_center",
           "conservative": "urn:audience:political_preferences:politically_conservative"}.get(audience or "")
    out = {}
    async with httpx.AsyncClient(headers={"User-Agent": "undertow/0.1"}) as client:
        async def one(t):
            p = {"filter.type": f"urn:entity:{t}", "signal.location": f"POINT({lon:.4f} {lat:.4f})", "signal.location.radius": "12000", "take": "6"}
            if aud: p["signal.demographics.audiences"] = aud
            try:
                r = await client.get(QLOO + "/v2/insights", params=p, headers={"X-Api-Key": qkey}, timeout=30)
                return t, [e["name"] for e in ((r.json().get("results") or {}).get("entities") or [])][:6]
            except Exception:
                return t, []
        for t, names in await asyncio.gather(*[one(t) for t in ("tv_show", "podcast", "brand", "artist")]): out[t] = names
    res = {"near": f"{lat:.3f},{lon:.3f}", "audience": audience or "everyone", "tv_shows": out.get("tv_show", []), "podcasts": out.get("podcast", []),
           "brands": out.get("brand", []), "artists": out.get("artist", [])}
    _chan_cache[key] = res
    return res

def t_allocate_budget(budget, targets):
    w = [max(0.0, float(t.get("weight", 1))) for t in targets]; s = sum(w) or 1
    alloc = [{"zip": t["zip"], "budget": int(round(budget * x / s / 100.0)) * 100} for t, x in zip(targets, w)]
    return {"total": sum(a["budget"] for a in alloc), "allocation": alloc}

TOOLS = [
    {"type": "function", "function": {"name": "get_race", "description": "Our call, poll average, Qloo-only forecast and cultural read for the race.", "parameters": {"type": "object", "properties": {"race_id": {"type": "string"}}, "required": ["race_id"]}}},
    {"type": "function", "function": {"name": "rank_counties", "description": "Rank the state's counties into persuasion and turnout targets for the candidate's side, using Qloo tastes vs the expected vote.", "parameters": {"type": "object", "properties": {"race_id": {"type": "string"}, "side": {"type": "string", "enum": ["D", "R", "I"]}}, "required": ["race_id", "side"]}}},
    {"type": "function", "function": {"name": "scan_zips", "description": "Run live Qloo scans across up to 4 counties and rank their ZIP codes by how far local tastes lean toward the candidate.", "parameters": {"type": "object", "properties": {"race_id": {"type": "string"}, "county_fips": {"type": "array", "items": {"type": "string"}, "maxItems": 4}, "side": {"type": "string", "enum": ["D", "R", "I"]}}, "required": ["race_id", "county_fips", "side"]}}},
    {"type": "function", "function": {"name": "find_channels", "description": "What people near a point over-index on (TV shows, podcasts, brands, artists), from Qloo. Use a target ZIP's lat/lon. audience: progressive, center or conservative (center suits persuasion).", "parameters": {"type": "object", "properties": {"lat": {"type": "number"}, "lon": {"type": "number"}, "audience": {"type": "string", "enum": ["progressive", "center", "conservative"]}}, "required": ["lat", "lon"]}}},
    {"type": "function", "function": {"name": "allocate_budget", "description": "Split the budget across chosen ZIPs by weight.", "parameters": {"type": "object", "properties": {"targets": {"type": "array", "items": {"type": "object", "properties": {"zip": {"type": "string"}, "weight": {"type": "number"}}, "required": ["zip", "weight"]}}}, "required": ["targets"]}}},
]

SYSTEM = """You are Undertow's campaign strategist agent. A campaign gives you a race, its candidate's side and an ad budget for the final days.
Use the tools, in this order: get_race; rank_counties; scan_zips on the best 2-4 counties (mix persuasion and turnout targets);
find_channels for 2-3 of the strongest ZIPs (audience "center" for persuasion ZIPs, the side's own audience for turnout ZIPs);
allocate_budget over 6-14 ZIPs (weight = lean_toward_you x activity, persuasion ZIPs weighted up). Then answer.
Rules: every county, ZIP, number and channel you mention must come from a tool result. Be concrete and brief. No personal data exists or is used.
"message" is the creative angle and placement for the segment, not ad copy: tone, and which of that segment's channels to sponsor or advertise near.
Never invent the candidate's positions, record or promises; never offer anything of value for voting; nothing deceptive or aimed at discouraging anyone from voting.
In "message" mention only channels from that segment's own "channels" list. Do not put dollar amounts in the summary (the plan's table shows them).
Final answer: JSON only, no prose around it:
{"headline": "<= 14 words", "summary": "<= 70 words",
 "segments": [{"name": "<= 6 words", "goal": "persuade" | "turnout", "zips": ["<zip>", ...], "channels": ["<channel names from find_channels>", ...], "message": "<= 30 words: tone and placement, grounded in the area's tastes"}],
 "caveat": "<= 35 words, honest about what Qloo taste data can and cannot tell a campaign"}"""

def _fallback_plan(state):
    """Deterministic plan if the model fails: same tools, fixed choices."""
    zips = state.get("zips", [])[:10]; ch = next(iter(state.get("channels", {}).values()), {})
    return {"headline": f"Spend where {state.get('race', 'the race')}'s tastes lean your way", "summary": "Fixed-rule plan built from the same Qloo scans (the agent's answer did not validate).",
            "segments": [{"name": "Top-leaning ZIPs", "goal": "persuade", "zips": [z["zip"] for z in zips],
                          "channels": (ch.get("tv_shows", [])[:2] + ch.get("podcasts", [])[:2]), "message": "Meet these places where their tastes already point."}],
            "caveat": "Qloo describes places, not voters; inside states, taste gaps pointed the right way in most states, by small amounts."}

async def run(req, qkey, live_entities, emit):
    """Agent loop. emit(event) streams progress to the browser."""
    ctx = Ctx(); rid = req["race_id"]; side = req["side"]; budget = int(req["budget"])
    if rid not in ctx.races: raise ValueError("unknown race")
    o, r, f = ctx.race(rid)
    cand = next((c["name"] for c in r["candidates"] if (c["party"] == side) or (side == "I" and c["party"] not in ("D", "R"))), side)
    state = {"race": r["state"], "zips": [], "zip_index": {}, "channels": {}, "counties": {}}
    msgs = [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": json.dumps({"race_id": rid, "candidate": cand, "side": side, "budget_usd": budget, "campaign_note": (req.get("note") or "")[:200]})}]
    hdr = {"Authorization": "Bearer " + LLM_KEY, "x-opencode-session": "undertow-strategist-" + uuid.uuid4().hex[:10], "User-Agent": "undertow-agent/0.1"}
    final = None
    async with httpx.AsyncClient(timeout=150) as llm:
        for turn in range(10):
            await emit({"type": "think", "text": "Undertow AI is planning the next step…" if turn else f"Planning a ${budget:,} push for {cand}…"})
            resp = await llm.post(LLM_URL, headers=hdr, json={"model": LLM_MODEL, "max_tokens": 4000, "temperature": 0.2, "tools": TOOLS, "messages": msgs})
            if resp.status_code != 200: break
            m = resp.json()["choices"][0]["message"]; calls = m.get("tool_calls") or []
            msgs.append({k: v for k, v in m.items() if k in ("role", "content", "tool_calls")})
            if not calls:
                mm = re.search(r"\{.*\}", m.get("content") or "", re.S)
                try: final = json.loads(mm.group(0)) if mm else None
                except Exception: final = None
                break
            for c in calls:
                name = c["function"]["name"]
                try: args = json.loads(c["function"].get("arguments") or "{}")
                except Exception: args = {}
                t0 = time.time()
                try:
                    if name == "get_race": out = t_get_race(ctx, rid)
                    elif name == "rank_counties": out = t_rank_counties(ctx, rid, side)
                    elif name == "scan_zips":
                        fl = [x for x in args.get("county_fips", []) if x in ctx.counties and ctx.counties[x]["state"] == r["state"]][:4]
                        await emit({"type": "tool", "name": name, "text": f"Live Qloo scan across {', '.join(ctx.counties[x]['name'] for x in fl)}…", "pending": True})
                        out = await t_scan_zips(ctx, rid, fl, side, qkey, live_entities)
                        for z in out["zips"]: state["zip_index"][z["zip"]] = z
                        state["zips"] = sorted(state["zip_index"].values(), key=lambda z: -z["lean_toward_you"])
                        for x in fl: state["counties"][x] = ctx.counties[x]["name"]
                    elif name == "find_channels":
                        out = await t_find_channels(ctx, float(args.get("lat", 0)), float(args.get("lon", 0)), qkey, args.get("audience"))
                        state["channels"][out["near"]] = out
                    elif name == "allocate_budget":
                        tg = [t for t in args.get("targets", []) if t.get("zip") in state["zip_index"]]
                        out = t_allocate_budget(budget, tg); state["alloc"] = {a["zip"]: a["budget"] for a in out["allocation"]}
                    else: out = {"error": "unknown tool"}
                except Exception as e:
                    out = {"error": str(e)[:200]}
                ms = int((time.time() - t0) * 1000)
                await emit({"type": "tool", "name": name, "args": args, "ms": ms, "text": _describe(name, args, out, ctx), "result": _brief(name, out)})
                msgs.append({"role": "tool", "tool_call_id": c["id"], "content": json.dumps(out)[:12000]})
    plan = _validate(final, state, budget) or _validate(_fallback_plan(state), state, budget)
    plan["candidate"] = cand; plan["race"] = t_get_race(ctx, rid)["race"]; plan["budget"] = budget; plan["by"] = "Undertow AI × Qloo"
    await emit({"type": "plan", "plan": plan})

def _describe(name, args, out, ctx):
    if "error" in out: return f"{name}: {out['error']}"
    if name == "get_race": return f"Read the race: {out['our_call']['winner']} {out['our_call']['margin']}; tastes alone say {out['qloo_only_forecast']}."
    if name == "rank_counties": return f"Ranked counties: persuade {', '.join(x['county'] for x in out['persuasion_targets'][:3])}; turn out {', '.join(x['county'] for x in out['turnout_targets'][:2])}."
    if name == "scan_zips": return f"Scanned {out['scanned_cells']} Qloo cells; best ZIPs: {', '.join(z['zip'] + ' ' + z['place'] for z in out['zips'][:4])}."
    if name == "find_channels": return f"Near {out['near']} ({out['audience']}): {', '.join((out['tv_shows'][:2] + out['podcasts'][:2]) or ['nothing found'])}…"
    if name == "allocate_budget": return f"Split ${out['total']:,} across {len(out['allocation'])} ZIPs."
    return name

def _brief(name, out):
    if name == "scan_zips": return {"zips": [{k: z[k] for k in ("zip", "place", "county", "lat", "lon", "lean_toward_you")} for z in out.get("zips", [])]}
    if name == "rank_counties": return {"counties": [x["fips"] for x in out.get("persuasion_targets", [])[:4] + out.get("turnout_targets", [])[:2]]}
    return None

def _validate(plan, state, budget):
    if not isinstance(plan, dict) or not isinstance(plan.get("segments"), list): return None
    known_ch = {n for c in state["channels"].values() for k in ("tv_shows", "podcasts", "brands", "artists") for n in c[k]}
    segs = []
    for s in plan["segments"][:4]:
        zs = [z for z in s.get("zips", []) if z in state["zip_index"]]
        if not zs: continue
        segs.append({"name": str(s.get("name", ""))[:60], "goal": "turnout" if s.get("goal") == "turnout" else "persuade", "zips": zs,
                     "channels": [c for c in s.get("channels", []) if c in known_ch][:6], "message": str(s.get("message", ""))[:240]})
    if not segs: return None
    alloc = state.get("alloc") or {}
    allz = [z for s in segs for z in s["zips"]]
    if not alloc or not all(z in alloc for z in allz):  # fill any ZIP the allocation missed, weighted by lean x activity
        w = {z: max(0.05, state["zip_index"][z]["lean_toward_you"]) * max(0.5, state["zip_index"][z]["activity"]) for z in allz}
        s_ = sum(w.values()); alloc = {z: w[z] / s_ * budget for z in allz}
    tot = sum(alloc.get(z, 0) for z in allz) or 1
    b = {z: int(alloc.get(z, 0) * budget / tot // 100) * 100 for z in allz}
    if allz: b[max(allz, key=lambda z: b[z])] += budget - sum(b.values())   # rounding remainder to the biggest line
    rows = [{**{k: state["zip_index"][z][k] for k in ("zip", "place", "county", "lat", "lon", "lean_toward_you")}, "budget": b[z],
             "segment": s["name"], "goal": s["goal"], "channels": s["channels"]} for s in segs for z in s["zips"]]
    return {"headline": str(plan.get("headline", ""))[:140], "summary": str(plan.get("summary", ""))[:600], "segments": segs, "rows": rows,
            "caveat": str(plan.get("caveat", ""))[:300], "channels_seen": list(state["channels"].values()), "counties": state["counties"]}
