#!/usr/bin/env python3
"""Scrape 2026 US Senate / governor general-election polls from Wikipedia.

Usage:
  .venv/bin/python pipeline/polls.py                 # senate -> data/polls/senate_2026.json
  .venv/bin/python pipeline/polls.py --office governor
  .venv/bin/python pipeline/polls.py --offline       # reuse cached API responses in data/polls/cache/
  .venv/bin/python pipeline/polls.py --summary       # also print a verification table

Race id convention:
  Senate:   "<PO>-S"  regular (class) election, "<PO>-S2" special election (e.g. OH-S2, FL-S2)
  Governor: "<PO>-G"

Source: English Wikipedia parse API only (no betting/prediction markets).
 * Race list, general-election candidates, incumbents: the "2026 United States Senate elections"
   (or "... gubernatorial elections") overview page.
 * Ratings: the overview page's ratings table (column = rater short name as printed there).
 * Polls: the per-state page, "General election" section only. Each poll table's candidate
   columns are matched against the nominees; a table qualifies only if every person column is a
   nominee (so hypothetical / generic-ballot tables drop out). Collapsed "Hypothetical polling"
   tables and ranked-choice round tables are used only as a fallback. Among qualifying tables the
   one with the most rows wins (no merging, to avoid double counting).
Downloaded HTML is treated as untrusted data: it is only parsed with BeautifulSoup, never executed.
"""
import argparse, datetime as dt, json, pathlib, re, sys, time, unicodedata
import urllib.parse, urllib.request

from bs4 import BeautifulSoup

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "polls"
CACHE = OUT_DIR / "cache"
UA = "undertow-research/0.1 (hackathon project; Wikipedia poll tables)"
API = "https://en.wikipedia.org/w/api.php"
DELAY = 2.5

STATES = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA",
    "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE", "Florida": "FL", "Georgia": "GA",
    "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS",
    "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD", "Massachusetts": "MA",
    "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO", "Montana": "MT",
    "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM",
    "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK",
    "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC",
    "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX", "Utah": "UT", "Vermont": "VT",
    "Virginia": "VA", "Washington": "WA", "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY",
}
PARTY = {
    "democratic": "D", "democrat": "D", "dfl": "D", "democratic–farmer–labor": "D",
    "republican": "R", "independent": "I", "libertarian": "L", "green": "G", "constitution": "C",
}
MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september",
     "october", "november", "december"], 1)}
MONTHS.update({k[:3]: v for k, v in list(MONTHS.items())})
MONTHS["sept"] = 9

NON_CAND = re.compile(r"\b(other|others|undecided|margin|lead|someone else|would not vote|"
                      r"wouldn'?t vote|refused|none|neither|write-?in|don'?t know|unsure|not sure|"
                      r"no opinion|third party|another candidate|unknown)\b", re.I)


# ---------------------------------------------------------------- fetching
def fetch_page(title, offline=False):
    """Return (resolved_title, html) via the parse API, caching the raw JSON response."""
    CACHE.mkdir(parents=True, exist_ok=True)
    fn = CACHE / (re.sub(r"[^A-Za-z0-9_.-]", "_", title.replace(" ", "_")) + ".json")
    if offline and fn.exists():
        d = json.loads(fn.read_text())
    else:
        q = urllib.parse.urlencode({"action": "parse", "page": title, "prop": "text",
                                    "format": "json", "formatversion": "2", "redirects": "1"})
        req = urllib.request.Request(f"{API}?{q}", headers={"User-Agent": UA})
        d = None
        for attempt in range(5):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    d = json.loads(r.read().decode("utf-8"))
                break
            except Exception as e:  # network hiccup / 429: back off, honour Retry-After
                wait = 10 * 2 ** attempt
                ra = getattr(e, "headers", None) and e.headers.get("Retry-After")
                if ra and ra.isdigit(): wait = max(wait, int(ra))
                print(f"  fetch {title!r} failed ({e}); retry in {wait}s", file=sys.stderr)
                time.sleep(wait)
        time.sleep(DELAY)
        if d is None:
            if fn.exists():
                print(f"  using stale cache for {title!r}", file=sys.stderr)
                d = json.loads(fn.read_text())
            else:
                return None, None
        else:
            fn.write_text(json.dumps(d))
    if "error" in d:
        return None, None
    return d["parse"]["title"], d["parse"]["text"]


def soup_of(html):
    s = BeautifulSoup(html, "lxml")
    for t in s.select("sup.reference, style, link, script, span.sortkey, .mw-editsection"):
        t.decompose()
    for t in s.find_all(style=re.compile(r"display:\s*none")):
        t.decompose()
    return s


def text(el):
    t = el.get_text(" ", strip=True)
    t = re.sub(r"\[\s*[^\]]{0,6}\s*\]", "", t)  # leftover footnote markers like [a]
    return re.sub(r"\s+", " ", t.replace("\xa0", " ")).strip()


NICK = {"bobby": "robert", "bob": "robert", "rob": "robert", "robby": "robert", "bill": "william",
        "will": "william", "billy": "william", "jim": "james", "jimmy": "james", "mike": "michael",
        "tom": "thomas", "tommy": "thomas", "dan": "daniel", "danny": "daniel", "dave": "david",
        "joe": "joseph", "chris": "christopher", "matt": "matthew", "pat": "patrick",
        "tony": "anthony", "ed": "edward", "ted": "edward", "andy": "andrew", "rick": "richard",
        "dick": "richard", "rich": "richard", "steve": "stephen", "ken": "kenneth", "greg": "gregory",
        "jon": "jonathan", "nick": "nicholas", "ben": "benjamin", "sam": "samuel", "kate": "katherine",
        "katie": "katherine", "liz": "elizabeth", "beth": "elizabeth", "jen": "jennifer"}


def norm(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = re.sub(r"\b(jr|sr|ii|iii|iv)\b\.?", "", s.lower())
    w = re.sub(r"[^a-z ]", " ", s).split()
    if len(w) > 1:
        w[0] = NICK.get(w[0], w[0])
    return w


def grid(table):
    """Expand a table into rows of (cell_id, cell, is_th) with rowspan/colspan applied."""
    rows, pending = [], {}
    for tr in table.find_all("tr"):
        if tr.find_parent("table") is not table:
            continue
        row, col = [], 0
        cells = tr.find_all(["td", "th"], recursive=False)
        ci = 0
        while ci < len(cells) or col in pending:
            if col in pending:
                cid, cell, left = pending[col]
                row.append((cid, cell))
                if left > 1: pending[col] = (cid, cell, left - 1)
                else: del pending[col]
                col += 1
                continue
            cell = cells[ci]; ci += 1
            try: cs = max(1, int(cell.get("colspan", 1)))
            except ValueError: cs = 1
            try: rs = max(1, int(cell.get("rowspan", 1)))
            except ValueError: rs = 1
            for k in range(cs):
                row.append((id(cell), cell))
                if rs > 1: pending[col] = (id(cell), cell, rs - 1)
                col += 1
        rows.append(row)
    return rows


# ---------------------------------------------------------------- parsing helpers
def parse_party(p):
    p = p.strip()
    key = p.lower().replace(" party", "").strip()
    return PARTY.get(key, p)


def parse_dates(s):
    """'October 20–23, 2025' / 'Sep 30 – Oct 5, 2026' / 'Dec 28, 2025 – Jan 3, 2026' -> (start, end)."""
    s = re.sub(r"[‐-―−\-]|\bto\b", "–", s.replace("\xa0", " "))
    s = re.sub(r"\s+", " ", s).strip()
    parts = [p.strip(" ,") for p in s.split("–") if p.strip(" ,")]
    if not parts or len(parts) > 2:
        return None, None
    tok = r"(?:(?P<m>[A-Za-z]+)\.?\s*)?(?P<d>\d{1,2})?(?:,?\s*(?P<y>\d{4}))?$"

    def one(p):
        m = re.match(tok, p.strip())
        if not m or not (m.group("m") or m.group("d")):
            return None
        mon = MONTHS.get((m.group("m") or "").lower()) if m.group("m") else None
        if m.group("m") and mon is None:
            return None
        return [mon, int(m.group("d")) if m.group("d") else None,
                int(m.group("y")) if m.group("y") else None]
    end = one(parts[-1])
    if not end:
        return None, None
    start = one(parts[0]) if len(parts) == 2 else list(end)
    if not start:
        return None, None
    if end[0] is None: end[0] = start[0]
    if end[2] is None: end[2] = start[2]
    if start[2] is None and end[2] is not None:
        start[2] = end[2] - 1 if (start[0] or 0) > (end[0] or 0) else end[2]
    if start[0] is None: start[0] = end[0]
    if None in end or None in start:
        return None, None  # month-only or yearless: don't guess
    try:
        e = dt.date(end[2], end[0], end[1]); b = dt.date(start[2], start[0], start[1])
    except ValueError:
        return None, None
    if b > e:
        b = None
    return (b.isoformat() if b else None), e.isoformat()


def parse_sample(s):
    m_pop = re.search(r"\(\s*(LV|RV|A|V)\s*\)", s)
    pop = m_pop.group(1) if m_pop else None
    if pop == "V": pop = None
    m = re.search(r"\d[\d,]*", s.split("(")[0])
    n = int(m.group().replace(",", "")) if m else None
    return n, pop


def parse_pct(s):
    s = s.replace("\xa0", " ").strip()
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*%?", s)
    return float(m.group(1)) if m else None


def match_candidate(header, cands):
    """Map a poll-table column header to a nominee index; None if it's not one of them."""
    h = re.sub(r"\((?:[A-Z]{1,4}|[^)]{0,30})\)\s*$", "", header).strip()
    hn = norm(h)
    if not hn:
        return None
    best = []
    for i, c in enumerate(cands):
        cn = norm(c["name"])
        if not cn:
            continue
        if hn == cn:
            return i
        if hn[-1] == cn[-1] and (len(hn) == 1 or hn[0] == cn[0] or hn[0][0] == cn[0][0]):
            # same last name + first name/initial; check middle initials don't conflict
            hm, cm = hn[1:-1], cn[1:-1]
            if hm and cm and hm[0][0] != cm[0][0]:
                continue
            best.append(i)
    if len(best) == 1:
        return best[0]
    if len(best) > 1:
        inc = [i for i in best if cands[i]["incumbent"]]
        exact_mid = [i for i in best if norm(cands[i]["name"])[1:-1] == hn[1:-1]]
        if len(exact_mid) == 1: return exact_mid[0]
        if len(inc) == 1: return inc[0]
    return None


def is_hidden(t):
    for p in t.parents:
        cl = p.get("class") or []
        if "mw-collapsed" in cl or "hidden-begin" in cl:
            return True
    return False


def section_tables(soup, want=re.compile(r"general election", re.I),
                   skip=re.compile(r"primary|runoff|caucus", re.I)):
    """Wikitables under a 'General election' heading (any level) until the next heading of that
    level or higher. Falls back to every table not under a primary/runoff heading."""
    heads = soup.select("div.mw-heading")
    out = []
    for h in heads:
        ht = text(h)
        if not want.search(ht) or skip.search(ht):
            continue
        lvl = int(re.search(r"mw-heading(\d)", " ".join(h.get("class"))).group(1))
        for el in h.find_all_next():
            if el.name == "div" and "mw-heading" in (el.get("class") or []):
                l2 = int(re.search(r"mw-heading(\d)", " ".join(el.get("class"))).group(1))
                if l2 <= lvl:
                    break
            if el.name == "table" and "wikitable" in (el.get("class") or []):
                out.append(el)
    if out:
        return out, True
    # fallback: tables whose nearest headings are not primary-ish
    for t in soup.find_all("table", class_="wikitable"):
        hs, lvl_seen = [], 9
        for h in t.find_all_previous("div", class_="mw-heading"):
            l = int(re.search(r"mw-heading(\d)", " ".join(h.get("class"))).group(1))
            if l < lvl_seen:
                hs.append(text(h)); lvl_seen = l
            if l == 2: break
        if not any(skip.search(x) for x in hs):
            out.append(t)
    return out, False


def parse_poll_table(t, cands):
    """Return dict(ok, reason, polls, matched, rcv) for one wikitable."""
    g = grid(t)
    hdr_i = next((i for i, r in enumerate(g)
                  if any(re.search(r"poll\s*source|pollster", text(c), re.I) for _, c in r)), None)
    if hdr_i is None:
        return None
    hdr = [text(c) for _, c in g[hdr_i]]
    if not any(re.search(r"date", h, re.I) for h in hdr):
        return None
    cols = {"cand": {}, "other": None, "und": None, "rcv": None}
    unknown = []
    for j, h in enumerate(hdr):
        hl = h.lower()
        if j in (0,) or re.search(r"poll\s*source|pollster", hl): cols.setdefault("src", j); continue
        if "date" in hl and "date" not in cols: cols["date"] = j; continue
        if "sample" in hl: cols["sample"] = j; continue
        if "margin of error" in hl or hl.startswith("margin of") or "moe" == hl: continue
        if re.search(r"\brcv\b|^round\b|\bround$", hl): cols["rcv"] = j; continue
        if re.search(r"generic|hypothetical", hl):
            unknown.append(h); continue
        if re.search(r"undecided|don'?t know|unsure|not sure", hl): cols["und"] = j; continue
        ci = match_candidate(h, cands)
        if ci is not None:
            if ci in cols["cand"].values():
                unknown.append(h)  # two columns -> same nominee: ambiguous
            cols["cand"][j] = ci; continue
        if NON_CAND.search(hl):
            if re.search(r"^other", hl): cols["other"] = j
            continue
        if h:
            unknown.append(h)
    res = {"matched": sorted(set(cols["cand"].values())), "rcv": cols["rcv"] is not None,
           "header": hdr, "polls": [], "skipped_rows": 0}
    if unknown:
        res.update(ok=False, reason="non-nominee columns: " + "; ".join(unknown))
        return res
    if len(res["matched"]) < 2 or "date" not in cols:
        res.update(ok=False, reason="fewer than 2 nominee columns")
        return res
    for r in g[hdr_i + 1:]:
        if len(r) < len(hdr) or all(c.name == "th" for _, c in r):
            if len(r) and not all(c.name == "th" for _, c in r):
                res["skipped_rows"] += 1
            continue
        if cols["rcv"] is not None:
            rv = text(r[cols["rcv"]][1])
            if not re.match(r"^(1|1st|first)\b", rv, re.I):
                continue  # keep only first-choice round of RCV tables
        start, end = parse_dates(text(r[cols["date"]][1]))
        if not end:
            res["skipped_rows"] += 1
            res.setdefault("skipped_text", []).append(" | ".join(text(c) for _, c in r)[:160])
            continue
        sample, pop = parse_sample(text(r[cols["sample"]][1])) if "sample" in cols else (None, None)
        vals = {r[j][0] for j in cols["cand"]}
        if len(vals) == 1 and len(cols["cand"]) > 1:
            continue  # event/separator row ("Primary elections held") spanning all columns
        pct, seen = {}, set()
        for j, ci in cols["cand"].items():
            cid, cell = r[j]
            v = parse_pct(text(cell))
            if v is not None and cid not in seen:
                pct[cands[ci]["name"]] = v
            seen.add(cid)
        if len(pct) < 2:
            res["skipped_rows"] += 1
            res.setdefault("skipped_text", []).append(" | ".join(text(c) for _, c in r)[:160])
            continue
        und = None
        if cols["und"] is not None:
            cid, cell = r[cols["und"]]
            spans = sum(1 for x, _ in r if x == cid)
            if spans == 1:
                und = parse_pct(text(cell))
        res["polls"].append({"pollster": text(r[cols["src"]][1]), "end_date": end,
                             "start_date": start, "sample": sample, "population": pop,
                             "pct": pct, "undecided": und})
    res["ok"] = True
    res["reason"] = ""
    return res


def race_polls(html, cands, extra_htmls=()):
    soup = soup_of(html)
    tables, in_ge = section_tables(soup)
    notes = [] if in_ge else ["no 'General election' heading; scanned non-primary sections"]
    for eh in extra_htmls:
        es = soup_of(eh)
        tables += es.find_all("table", class_="wikitable")
    cand_tables = []
    for t in tables:
        r = parse_poll_table(t, cands)
        if r is None:
            continue
        r["hidden"] = is_hidden(t)
        cand_tables.append(r)
    good = [r for r in cand_tables if r.get("ok") and r["polls"]]
    rejected = [r for r in cand_tables if not r.get("ok")]
    pick = None
    for tier in (lambda r: not r["hidden"] and not r["rcv"], lambda r: not r["hidden"],
                 lambda r: True):
        pool = [r for r in good if tier(r)]
        if pool:
            pick = max(pool, key=lambda r: (len(r["polls"]), len(r["matched"])))
            break
    if pick:
        if pick["hidden"]: notes.append("used a collapsed (hypothetical-styled) table")
        if pick["rcv"]: notes.append("ranked-choice table; first-round rows only")
        if pick["skipped_rows"]: notes.append(f"{pick['skipped_rows']} row(s) skipped (unparsable date/values)")
        others = [r for r in good if r is not pick and not r["hidden"]]
        if others:
            notes.append(f"{len(others)} other visible nominee-only table(s) ignored "
                         f"(sizes {[len(r['polls']) for r in others]})")
    elif cand_tables:
        notes.append(f"{len(cand_tables)} poll table(s) in general section, none nominee-only")
    polls = pick["polls"] if pick else []
    polls.sort(key=lambda p: p["end_date"], reverse=True)
    return polls, notes, soup


def polling_subpages(soup):
    """'Main article: Opinion polling for ...' hatnotes inside the general-election section."""
    out = []
    for a in soup.select("div.hatnote a, div.rellink a"):
        tt = a.get("title") or ""
        if re.search(r"polling", tt, re.I) and "2026" in tt:
            out.append(tt)
    return list(dict.fromkeys(out))


# ---------------------------------------------------------------- overview page
def header_grid_names(g):
    """Column names from the last all-th header row(s) of a grid."""
    names = None
    for r in g:
        if r and all(c.name == "th" for _, c in r):
            names = [text(c) for _, c in r]
        elif names is not None:
            break
    return names


def overview_ratings(soup, office):
    """{(state, special): {rater: rating}} from the ratings table."""
    out = {}
    for t in soup.find_all("table", class_="wikitable"):
        g = grid(t)
        names = header_grid_names(g)
        if not names or not any(n.startswith("Cook") for n in names) or not any(n.startswith("Sabato") for n in names):
            continue
        idx = {}
        for j, n in enumerate(names):
            m = re.match(r"([A-Za-z&.' ]+?)\s+(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d|$)", n)
            key = (m.group(1) if m else n.split()[0]).strip()
            if j >= 2 and key and key.lower() not in ("state", "pvi", "senator", "governor",
                                                     "incumbent", "last election", "last race"):
                if not re.search(r"pvi|senator|governor|incumbent|last", key, re.I):
                    idx[j] = key
        for r in g:
            if not r or all(c.name == "th" for _, c in r) and len(r) < 3:
                continue
            st = text(r[0][1])
            m = re.match(r"([A-Za-z .]+?)\s*(\((special)\))?$", st)
            if not m or m.group(1).strip() not in STATES:
                continue
            special = bool(m.group(3))
            out[(m.group(1).strip(), special)] = {k: text(r[j][1]) for j, k in idx.items() if j < len(r)}
        if out:
            break
    return out


def overview_races(soup, office):
    races = []
    pat = "Senate" if office == "senate" else "gubernatorial"
    for t in soup.find_all("table", class_="wikitable"):
        g = grid(t)
        names = header_grid_names(g) or []
        top = [text(c) for _, c in g[0]] if g else []
        if not any(re.fullmatch(r"Candidates", n) for n in names + top):
            continue
        cand_j = (names or top).index("Candidates") if "Candidates" in (names or top) else len(g[0]) - 1
        for r in g:
            if not r or r[0][1].name != "th" and r[0][1].name != "td":
                continue
            head = r[0][1]
            a = head.find("a", href=re.compile(r"/wiki/2026_.*" + pat, re.I))
            if not a:
                continue
            href = a["href"]
            title = urllib.parse.unquote(href.split("/wiki/")[1]).replace("_", " ")
            st = text(head)
            stn = re.sub(r"\s*\(.*\)$", "", st).strip()
            if stn not in STATES:
                continue
            special = "special" in title.lower()
            inc_cell = r[1][1] if len(r) > 1 else None
            # incumbent link(s): the first cell after the PVI column that has a person link
            inc_hrefs = set()
            for _, c in r[1:4]:
                for la in c.find_all("a", href=True):
                    if "/wiki/" in la["href"] and "election" not in la["href"]:
                        inc_hrefs.add(la["href"])
            inc_names = [text(c) for _, c in r[1:4]]
            ccell = r[min(cand_j, len(r) - 1)][1] if cand_j < len(r) else r[-1][1]
            cands = []
            for li in ccell.find_all("li"):
                tx = text(li).lstrip("▌").strip()
                m = re.match(r"(.+?)\s*\(([^()]+)\)\s*$", tx)
                if not m:
                    continue
                name, party = m.group(1).strip(), m.group(2).strip()
                la = li.find("a", href=True)
                inc = bool(la and la["href"] in inc_hrefs) or (not la and name in inc_names)
                cands.append({"name": name, "party": parse_party(party), "incumbent": inc,
                              "party_full": party})
            races.append({"state": stn, "special": special, "title": title, "candidates": cands})
    return races


# ---------------------------------------------------------------- main
def build(office, offline=False):
    main_title = ("2026 United States Senate elections" if office == "senate"
                  else "2026 United States gubernatorial elections")
    _, html = fetch_page(main_title, offline)
    soup = soup_of(html)
    races = overview_races(soup, office)
    ratings = overview_ratings(soup, office)
    out = []
    for rc in races:
        po = STATES[rc["state"]]
        rid = f"{po}-G" if office == "governor" else (f"{po}-S2" if rc["special"] else f"{po}-S")
        print(f"[{rid}] {rc['title']}", file=sys.stderr)
        ttl, page = fetch_page(rc["title"], offline)
        notes, polls = [], []
        if page is None:
            notes.append("state page fetch failed")
        else:
            psoup = soup_of(page)
            subs = [s for s in polling_subpages(psoup) if s != ttl]
            extra = []
            for s in subs:
                _, h = fetch_page(s, offline)
                if h: extra.append(h); notes.append(f"also scanned polling page: {s}")
            polls, n2, _ = race_polls(page, rc["candidates"], extra)
            notes += n2
        rt = ratings.get((rc["state"], rc["special"]))
        if rt is None and office == "governor":
            rt = ratings.get((rc["state"], False))
        out.append({
            "id": rid, "state": rc["state"], "state_po": po, "special": rc["special"],
            "wiki_url": "https://en.wikipedia.org/wiki/" + urllib.parse.quote((ttl or rc["title"]).replace(" ", "_")),
            "candidates": rc["candidates"], "ratings": rt or {}, "polls": polls,
            "parse_notes": notes,
        })
    out.sort(key=lambda r: r["id"])
    return {
        "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source_note": (f"English Wikipedia ('{main_title}' for races/nominees/ratings; per-state "
                        "pages' General election > Polling tables for polls), via the MediaWiki parse "
                        "API. Only polls whose candidate columns are all general-election nominees are "
                        "kept; hypothetical/generic/primary tables are dropped. Ids: <PO>-S regular, "
                        "<PO>-S2 special (senate); <PO>-G (governor). 'pct' keys equal candidate names. "
                        "'party' is a 1-letter code for D/R/I/L/G/C (DFL->D), else the party name; "
                        "'party_full' is as printed. Rows with '<1%' or unparsable values omit that entry; "
                        "LV and RV versions of one poll are separate entries. No betting/prediction markets."),
        "office": office,
        "races": out,
    }


def summary(doc, today=None):
    today = today or dt.date.today()
    cut = (today - dt.timedelta(days=45)).isoformat()
    print(f"{'id':7} {'nominees (D vs R / top two)':52} {'#pl':>3} {'latest':10} {'avgD-R45d':>9} n45")
    for r in doc["races"]:
        c = r["candidates"]
        polls = r["polls"]

        def top(pred):
            # highest mean polled share among candidates matching pred (first listed if unpolled)
            xs = [x["name"] for x in c if pred(x)]
            sc = {n: [p["pct"][n] for p in polls if n in p["pct"]] for n in xs}
            sc = {n: sum(v) / len(v) for n, v in sc.items() if v}
            return max(sc, key=sc.get) if sc else (xs[0] if xs else None)
        d = top(lambda x: x["party"] == "D")
        rr = top(lambda x: x["party"] == "R")
        # independent-vs-R races (no D polled, e.g. NE/ID/SD): use the leading non-R candidate
        if polls and not any(d in p["pct"] for p in polls if d):
            d = top(lambda x: x["party"] != "R") or d
        best = {}
        for p in polls:
            if p["end_date"] < cut or d not in p["pct"] or rr not in p["pct"]:
                continue
            k = (p["pollster"], p["end_date"])
            rank = {"LV": 0, "RV": 1, "A": 2}.get(p["population"], 3)
            if k not in best or rank < best[k][0]:
                best[k] = (rank, p["pct"][d] - p["pct"][rr])
        avg = (sum(v for _, v in best.values()) / len(best)) if best else None
        latest = polls[0]["end_date"] if polls else "-"
        nm = f"{d or '?'} vs {rr or '?'}"
        print(f"{r['id']:7} {nm[:52]:52} {len(polls):>3} {latest:10} "
              f"{(f'{avg:+.1f}' if avg is not None else '-'):>9} {len(best):>3}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--office", choices=["senate", "governor"], default="senate")
    ap.add_argument("--offline", action="store_true", help="use cached API responses when present")
    ap.add_argument("--summary", action="store_true")
    a = ap.parse_args()
    doc = build(a.office, a.offline)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fn = OUT_DIR / f"{a.office}_2026.json"
    tmp = fn.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, indent=1, ensure_ascii=False))
    tmp.replace(fn)
    print(f"wrote {fn} ({len(doc['races'])} races, "
          f"{sum(len(r['polls']) for r in doc['races'])} polls)", file=sys.stderr)
    if a.summary:
        summary(doc)


if __name__ == "__main__":
    main()
