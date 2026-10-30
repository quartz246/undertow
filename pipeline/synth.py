"""Final judgement: DeepSeek (via OpenCode Go) reads each race's script numbers and makes the call.
The model gets numbers only, no tools; its answer is validated and the script call stands in if it fails.
Reads data/forecast/script.json, writes data/forecast/senate.json."""
import concurrent.futures as cf, json, os, re, sys, uuid
from datetime import datetime, timezone
import httpx

MODEL = "deepseek-v4.1-flash"
URL = "https://opencode.ai/zen/go/v1/chat/completions"
KEY = os.environ.get("OPENCODE_GO_KEY") or json.load(open(os.path.expanduser("~/.local/share/opencode/auth.json")))["opencode-go"]["key"]
SESSION = "undertow-synth-" + uuid.uuid4().hex[:12]

SYSTEM = """You are the final forecaster for a 2026 US Senate model. Election day is 2026-11-03. You get one race as JSON computed by scripts:
- polls: recency/sample-weighted average margin (positive = the non-Republican side ahead; partisan-sponsored polls already count 60%),
  the number of recent polls, the latest polls, "house" = how far Democratic- or Republican-sponsored polls differ from independent ones,
  and independent_avg = the average of independent polls only
- pres24_margin_d: the 2024 presidential margin in the state
- skew: the shift the polls imply since 2024 versus the typical polled race, and any flag the script raised
- ratings: published race ratings (Cook, Sabato, etc.), if any
- script: the deterministic call (polls only; with no polls, 2024 result plus the typical shift)
Make the final call. Several recent independent polls are the strongest evidence; with few or no polls, lean on ratings and the 2024
baseline. Incumbents and well-known candidates can outrun the typical shift. Do not invent facts that are not in the JSON.
Answer with JSON only:
{"winner_party": "D"|"R"|"I", "margin_d": number (non-Republican minus Republican, points), "p_win": number 0.5-0.99 (chance the winner wins),
 "confidence": "low"|"medium"|"high", "headline": "<= 12 words", "reasoning": "<= 70 words, plain English, cite the numbers you used"}"""

def packet(r):
    return {"race": f"{r['state']} Senate{' (special)' if r['special'] else ''}",
            "non_republican": f"{r['main']['d']['name']} ({r['main']['d']['party']}{', incumbent' if r['main']['d']['incumbent'] else ''})",
            "republican": f"{r['main']['r']['name']} (R{', incumbent' if r['main']['r']['incumbent'] else ''})",
            "polls": {k: r["polls"][k] for k in ("avg_margin_d", "n_recent", "n", "latest", "house", "independent_avg")} | {"latest_polls": r["polls"]["list"][:5]},
            "pres24_margin_d": r["pres24_margin_d"],
            "skew": {k: r["skew"][k] for k in ("poll_swing", "rel_poll_swing", "flag", "text")},
            "ratings": r["ratings"], "script": r["script"]}

def ask(r):
    body = {"model": MODEL, "max_tokens": 4000, "temperature": 0.2,
            "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": json.dumps(packet(r))}]}
    hdr = {"Authorization": "Bearer " + KEY, "x-opencode-session": SESSION, "User-Agent": "undertow-synth/0.1"}
    for _ in range(3):
        try:
            res = httpx.post(URL, headers=hdr, json=body, timeout=120)
            if res.status_code != 200: continue
            txt = res.json()["choices"][0]["message"]["content"] or ""
            m = re.search(r"\{.*\}", txt, re.S)
            v = json.loads(m.group(0)) if m else None
            if v and valid(v, r): return v
        except Exception:
            pass
    return None

def valid(v, r):
    try:
        allowed = {"R", r["main"]["d"]["party"]}
        ok = v["winner_party"] in allowed and 0.5 <= float(v["p_win"]) <= 0.995 and v["confidence"] in ("low", "medium", "high")
        m = float(v["margin_d"])
        ok = ok and ((m > 0) == (v["winner_party"] != "R") or abs(m) < 0.05) and abs(m - r["script"]["margin_d"]) <= 8
        return ok and isinstance(v["headline"], str) and isinstance(v["reasoning"], str)
    except Exception:
        return False

def main():
    fc = json.load(open("data/forecast/script.json"))
    with cf.ThreadPoolExecutor(4) as ex:
        verdicts = list(ex.map(ask, fc["races"]))
    n = 0
    for r, v in zip(fc["races"], verdicts):
        if v:
            n += 1
            r["verdict"] = {"winner_party": v["winner_party"], "margin_d": round(float(v["margin_d"]), 1), "p_win": round(float(v["p_win"]), 3),
                            "confidence": v["confidence"], "headline": v["headline"].strip()[:120], "reasoning": v["reasoning"].strip()[:600],
                            "model": MODEL, "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        else:
            r.pop("verdict", None)
    if "--lock" in sys.argv: fc["locked_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    json.dump(fc, open("data/forecast/senate.json", "w"), indent=1)
    print(f"verdicts {n}/{len(fc['races'])}")
    for r in fc["races"]:
        v = r.get("verdict") or {}
        print(f"{r['id']:6s} script {r['script']['margin_d']:+6.1f} {r['script']['winner_party']} | final {v.get('margin_d', '—')} {v.get('winner_party', '')} {v.get('p_win', '')} {v.get('confidence', '')} | {v.get('headline', '')}")

if __name__ == "__main__":
    main()
