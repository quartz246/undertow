/* Undertow front end: MapLibre map (states -> counties -> Qloo cells -> live block scan) + race panel. */
const HOLD = { D: 34, R: 31 }; // seats not up in 2026 (Democrats incl. the two independents who caucus with them)
const S = { mode: "forecast", fc: null, model: null, counties: null, states: null, raceBy: {}, sel: null,
            geo: null, cellsLoaded: {}, cellFeats: [], liveCtl: null, liveTimer: null, nameToFips: {} };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtM = (m) => (m == null || isNaN(m) ? "—" : Math.abs(m) < 0.05 ? "Even" : (m > 0 ? "D+" : "R+") + Math.abs(m).toFixed(1));
const fmtS = (m, d = 1) => (m == null ? "—" : (m > 0 ? "+" : m < 0 ? "−" : "±") + Math.abs(m).toFixed(d));
const pty = (p) => (p === "D" ? "Democrat" : p === "R" ? "Republican" : p === "I" ? "Independent" : p);
const pct = (p) => Math.round(p * 100) + "%";

const RAMP = [[-30, "#7d1a13"], [-15, "#c23a2f"], [-6, "#ec9f97"], [-1.5, "#f6e0dc"], [0, "#efece6"], [1.5, "#dbe6f6"], [6, "#8fb3e6"], [15, "#2160b8"], [30, "#123e7c"]];
const RAMP_U = [[-20, "#c23a2f"], [-10, "#ec9f97"], [-3, "#f6e0dc"], [0, "#efece6"], [3, "#dbe6f6"], [10, "#8fb3e6"], [20, "#2160b8"]];
const expr = (ramp, prop = "v") => ["case", ["==", ["get", prop], null], "#e4e1d9", ["interpolate", ["linear"], ["get", prop], ...ramp.flat()]];

/* ---------------- geohash ---------------- */
const B32 = "0123456789bcdefghjkmnpqrstuvwxyz";
function ghBox(gh) {
  let even = true, lat = [-90, 90], lon = [-180, 180];
  for (const ch of gh) {
    const cd = B32.indexOf(ch);
    for (let m = 16; m >= 1; m >>= 1) {
      const r = even ? lon : lat, mid = (r[0] + r[1]) / 2;
      if (cd & m) r[0] = mid; else r[1] = mid;
      even = !even;
    }
  }
  return [[lon[0], lat[0]], [lon[1], lat[0]], [lon[1], lat[1]], [lon[0], lat[1]], [lon[0], lat[0]]];
}

/* ---------------- data ---------------- */
async function load() {
  const [fc, model, counties, states, topo] = await Promise.all(
    ["/api/forecast", "/api/model", "/api/counties", "/api/states", "/geo/counties-10m.json"].map((u) => fetch(u).then((r) => r.json())));
  Object.assign(S, { fc, model, counties, states });
  S.natbt = await fetch("/api/backtest").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  for (const r of fc.races) (S.raceBy[r.stfips] ||= []).push(r);
  const st = topojson.feature(topo, topo.objects.states), co = topojson.feature(topo, topo.objects.counties);
  st.features.forEach((f) => { f.id = +f.id; f.properties.fips = String(f.id).padStart(2, "0"); S.nameToFips[f.properties.name] = f.properties.fips; });
  co.features.forEach((f) => { f.properties.fips = String(f.id).padStart(5, "0"); f.id = +f.id; });
  S.geo = { st, co };
}
const final = (r) => r.verdict || r.script;
const stateFinal = (fips) => (S.raceBy[fips] ? final(S.raceBy[fips][0]).margin_d : null);

function countyValue(f) {
  const c = S.counties[f.properties.fips]; if (!c) return null;
  const st = S.states[c.state];
  if (S.mode === "r24") return c.m24;
  if (S.mode === "undertow") return c.gap; // Qloo-expected minus 2024 actual, within its state
  const sf = stateFinal(f.properties.fips.slice(0, 2));
  const base = sf == null ? c.m24 : c.m24 + (sf - st.m24);
  return base + (c.swing_est - st.qloo_swing);
}
function stateValue(f) {
  const name = f.properties.name, st = S.states[name];
  if (S.mode === "r24") return st ? st.m24 : null;
  if (S.mode === "undertow") return null; // the undertow is a within-state signal: states stay clear so counties show
  return stateFinal(f.properties.fips);
}
function cellValue(c) {
  const co = S.counties[c.fips]; if (!co) return null;
  const st = S.states[co.state];
  if (S.mode === "r24") return c.est;
  if (S.mode === "undertow") return co.gap + (c.est - co.m24);
  const sf = stateFinal(c.fips.slice(0, 2));
  return c.est + (sf == null ? 0 : sf - st.m24) + (co.swing_est - st.qloo_swing);
}

/* ---------------- map ---------------- */
let map;
function initMap() {
  map = new maplibregl.Map({ container: "map", style: "https://tiles.openfreemap.org/styles/positron", center: [-96.5, 38.6], zoom: 3.6, minZoom: 2.5, maxZoom: 16.5, attributionControl: { compact: true } });
  window.__map = map;
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.on("load", () => {
    const before = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
    map.addSource("states", { type: "geojson", data: S.geo.st });
    map.addSource("counties", { type: "geojson", data: S.geo.co });
    map.addSource("cells", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addSource("live", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "counties-fill", type: "fill", source: "counties", paint: { "fill-color": expr(RAMP), "fill-opacity": ["interpolate", ["linear"], ["zoom"], 4.2, 0, 5.2, 0.85, 7.5, 0.55, 10, 0.12] } }, before);
    map.addLayer({ id: "cells-fill", type: "fill", source: "cells", minzoom: 6.3, maxzoom: 11.2, paint: { "fill-color": expr(RAMP), "fill-opacity": ["interpolate", ["linear"], ["zoom"], 6.3, 0, 7.3, 0.8, 10.6, 0.8, 11.2, 0] } }, before);
    map.addLayer({ id: "live-fill", type: "fill", source: "live", minzoom: 9.8, paint: { "fill-color": expr(RAMP), "fill-opacity": ["interpolate", ["linear"], ["zoom"], 9.8, 0, 10.6, 0.75, 15, 0.6] } }, before);
    map.addLayer({ id: "states-fill", type: "fill", source: "states", paint: { "fill-color": expr(RAMP), "fill-opacity": ["interpolate", ["linear"], ["zoom"], 4.2, 0.92, 5.2, 0] } }, before);
    map.addLayer({ id: "counties-line", type: "line", source: "counties", minzoom: 5, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.2, 9, 1] } }, before);
    map.addLayer({ id: "states-line", type: "line", source: "states", paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.8, 8, 2.5] } });
    map.addLayer({ id: "race-line", type: "line", source: "states", filter: ["in", ["get", "fips"], ["literal", Object.keys(S.raceBy)]], paint: { "line-color": "#1d1f24", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.9, 8, 2] } });
    map.addLayer({ id: "sel-line", type: "line", source: "states", filter: ["==", ["get", "fips"], ""], paint: { "line-color": "#0f7b6c", "line-width": 3 } });
    recolor();
    map.on("click", "states-fill", (e) => { const f = e.features[0]; if (map.getZoom() < 5.2 && S.raceBy[f.properties.fips]) openRace(S.raceBy[f.properties.fips][0].id, true); });
    map.on("click", "counties-fill", (e) => { if (map.getZoom() >= 5.2) { const fp = e.features[0].properties.fips.slice(0, 2); if (S.raceBy[fp] && S.sel?.stfips !== fp) openRace(S.raceBy[fp][0].id, false); } });
    for (const l of ["states-fill", "counties-fill", "cells-fill", "live-fill"]) { map.on("mousemove", l, (e) => hover(e, l)); map.on("mouseleave", l, () => ($("#tip").hidden = true)); }
    map.on("moveend", onMove);
  });
}

function setValues() {
  for (const f of S.geo.st.features) f.properties.v = stateValue(f);
  for (const f of S.geo.co.features) f.properties.v = countyValue(f);
  for (const f of S.cellFeats) f.properties.v = cellValue(f.properties);
}
function recolor() {
  setValues();
  const ramp = S.mode === "undertow" ? RAMP_U : RAMP;
  for (const l of ["states-fill", "counties-fill", "cells-fill"]) map.setPaintProperty(l, "fill-color", expr(ramp));
  const u = S.mode === "undertow";
  map.setPaintProperty("states-fill", "fill-opacity", u ? 0 : ["interpolate", ["linear"], ["zoom"], 4.2, 0.92, 5.2, 0]);
  map.setPaintProperty("counties-fill", "fill-opacity", u ? ["interpolate", ["linear"], ["zoom"], 3, 0.9, 7.5, 0.55, 10, 0.12] : ["interpolate", ["linear"], ["zoom"], 4.2, 0, 5.2, 0.85, 7.5, 0.55, 10, 0.12]);
  map.setPaintProperty("live-fill", "fill-color", expr(RAMP_U));
  map.getSource("states").setData(S.geo.st);
  map.getSource("counties").setData(S.geo.co);
  map.getSource("cells").setData({ type: "FeatureCollection", features: S.cellFeats });
  if (S.liveData) drawLive(S.liveData);
  legend();
}

function legend() {
  const u = S.mode === "undertow", ramp = u ? RAMP_U : RAMP;
  const title = u ? "Undertow: counties whose tastes don't match their 2024 vote (relative to their state)" : S.mode === "r24" ? "2024 presidential result" : "2026 Senate forecast (states) · estimated vote (counties, cells)";
  $("#legend").innerHTML = `<b>${esc(title)}</b><div class="ramp">${ramp.map(([, c]) => `<span style="background:${c}"></span>`).join("")}</div>
    <div class="ends"><span>${u ? "tastes redder" : "R+30"}</span><span>${u ? "matches" : "even"}</span><span>${u ? "tastes bluer" : "D+30"}</span></div>`;
}

async function onMove() {
  const z = map.getZoom(), c = map.getCenter();
  // load ~5 km cells for whichever state is under the map centre
  if (z >= 6.2) {
    const hit = map.queryRenderedFeatures(map.project(c), { layers: ["counties-fill", "states-fill"] })[0];
    const fp = hit?.properties?.fips?.slice(0, 2);
    if (fp) loadCells(fp);
  }
  clearTimeout(S.liveTimer);
  if (z >= 10.3) S.liveTimer = setTimeout(() => liveScan(c.lat, c.lng, z), 650);
  else { $("#scan").hidden = true; }
}

async function loadCells(fp) {
  if (S.cellsLoaded[fp]) return; S.cellsLoaded[fp] = "loading";
  const r = await fetch(`/api/cells/${fp}`); if (!r.ok) return;
  const d = await r.json();
  for (const row of d.rows) {
    const p = Object.fromEntries(d.cols.map((k, i) => [k, row[i]]));
    S.cellFeats.push({ type: "Feature", properties: p, geometry: { type: "Polygon", coordinates: [ghBox(p.gh)] } });
  }
  S.cellsLoaded[fp] = true; setValues();
  map.getSource("cells").setData({ type: "FeatureCollection", features: S.cellFeats });
}

async function liveScan(lat, lon, z) {
  const radius = z >= 12.3 ? 3000 : z >= 11.2 ? 7000 : 20000;
  S.liveCtl?.abort(); S.liveCtl = new AbortController();
  const box = $("#scan"); box.hidden = false; box.innerHTML = `Scanning this area with Qloo… <span class="note">(${radius / 1000} km radius)</span>`;
  try {
    const r = await fetch(`/api/live?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&radius=${radius}`, { signal: S.liveCtl.signal });
    if (!r.ok) { box.innerHTML = r.status === 503 ? "Live block scans are off on this server." : "Qloo scan failed; try moving the map."; return; }
    const d = await r.json(); S.liveData = d; drawLive(d);
    const size = d.precision === 7 ? "~150 m" : d.precision === 6 ? "~1.2 km" : "—";
    box.innerHTML = `<b>Live Qloo scan</b> · ${d.cells.length} cells (${size}) · ${d.entities.length} taste signals · ${(d.ms / 1000).toFixed(1)} s<div class="note">Blocks are coloured by how their tastes differ from the rest of their county: bluer or redder than the county. Hover for the estimated vote.</div>`;
  } catch (e) { if (e.name !== "AbortError") box.innerHTML = "Qloo scan failed; try moving the map."; }
}
function drawLive(d) {
  // block cells are coloured relative to their county: inside one county the differences are what the scan adds
  const feats = d.cells.map((c) => ({ type: "Feature", properties: { ...c, v: c.est - (S.counties[c.fips]?.m24 ?? c.est), est26: cellValue(c), top: JSON.stringify(c.top) }, geometry: { type: "Polygon", coordinates: [ghBox(c.gh)] } }));
  map.getSource("live").setData({ type: "FeatureCollection", features: feats });
}

function hover(e, layer) {
  const f = e.features[0], p = f.properties, tip = $("#tip");
  let h = "";
  if (layer === "states-fill") {
    if (map.getZoom() >= 5.2) return;
    const st = S.states[p.name], r = S.raceBy[p.fips]?.[0];
    h = `<b>${esc(p.name)}</b><br>${r ? `Forecast <b>${fmtM(final(r).margin_d)}</b> · ${esc(r.candidates.find((c) => c.party === final(r).winner_party)?.name || "")} ${pct(final(r).p_win)}<br>` : "<span class='k'>No Senate race in 2026</span><br>"}<span class="k">2024 president</span> ${fmtM(st?.m24)}`;
  } else if (layer === "counties-fill") {
    const c = S.counties[p.fips]; if (!c) return;
    const dr = (c.drivers || []).slice(0, 3).map(([n, v]) => `${esc(n)} ${v > 0 ? "→D" : "→R"}`).join(", ");
    h = `<b>${esc(c.name)}, ${esc(c.state)}</b><br><span class="k">2024</span> ${fmtM(c.m24)} · <span class="k">Qloo expects</span> ${fmtM(c.pred)}<br><span class="k">Out of step by</span> ${fmtS(c.gap)} (${c.gap > 0 ? "tastes bluer than its vote" : "tastes redder than its vote"})${S.mode === "forecast" ? `<br><span class="k">2026 estimate</span> ${fmtM(p.v)}` : ""}<br><span class="k">${dr}</span>`;
  } else {
    const co = S.counties[p.fips];
    let top = []; try { top = JSON.parse(p.top || "[]"); } catch {}
    const est = layer === "live-fill" ? p.est26 : p.v;
    h = `<b>${layer === "live-fill" ? "Block cell" : "Qloo cell"} · ${esc(co?.name || "")}</b><br><span class="k">Estimated vote</span> ${fmtM(est)}${layer === "live-fill" ? ` · <span class="k">vs county</span> ${p.v > 0 ? "bluer" : "redder"} by ${Math.abs(p.v).toFixed(1)}` : ""}${top.length ? `<br><span class="k">${top.map(([n, v]) => `${esc(n)} ${v > 0 ? "→D" : "→R"}`).join(", ")}</span>` : ""}`;
  }
  tip.innerHTML = h; tip.hidden = false;
  const r = $("#map").getBoundingClientRect();
  tip.style.left = Math.min(e.point.x + 14, r.width - 270) + "px"; tip.style.top = e.point.y + 14 + "px";
}

/* ---------------- panel ---------------- */
function tally() {
  const n = { D: HOLD.D, R: HOLD.R, I: 0 };
  for (const r of S.fc.races) { const p = final(r).winner_party; n[p in n ? p : "I"]++; }
  const tot = n.D + n.R + n.I;
  const ctl = n.D >= 51 ? "Democrats win control" : n.R >= 50 ? "Republicans keep control" : "Control comes down to independents";
  $("#tally").innerHTML = `<div class="bar" role="img" aria-label="Projected Senate: ${n.D} Democratic, ${n.R} Republican, ${n.I} independent">
      <span style="width:${(n.D / tot) * 100}%;background:var(--d)"></span><span style="width:${(n.I / tot) * 100}%;background:var(--i)"></span><span style="width:${(n.R / tot) * 100}%;background:var(--r)"></span><i class="mid"></i></div>
    <div class="nums"><span><b class="D">${n.D}</b> D${n.I ? ` · <b class="I">${n.I}</b> I` : ""}</span><span>${ctl} (51 for D; R holds 50–50 with the VP)</span><span><b class="R">${n.R}</b> R</span></div>`;
}

function raceLine(r) {
  const f = final(r), w = r.candidates.find((c) => c.party === f.winner_party) || {};
  const skew = r.skew?.flag ? `<span class="flag">${esc(r.skew.short)}</span>` : "";
  const vs = r.candidates.filter((c) => ["D", "R", "I"].includes(c.party)).map((c) => `<span class="${c.party}">${esc(c.name.split(" ").slice(-1)[0])}</span>`).join(" v ");
  return `<button class="race" data-id="${esc(r.id)}"><span class="po">${esc(r.state_po)}${r.special ? "<sup>s</sup>" : ""}</span>
    <span class="who">${vs}${skew}<small>${r.polls.n ? `${r.polls.n} polls · avg ${fmtM(r.polls.avg_margin_d)}` : "no public polls"}</small></span>
    <span class="call ${f.winner_party}">${esc(w.name ? w.name.split(" ").slice(-1)[0] : f.winner_party)} ${pct(f.p_win)}</span></button>`;
}

function home() {
  S.sel = null; if (map?.getLayer("sel-line")) map.setFilter("sel-line", ["==", ["get", "fips"], ""]);
  const races = [...S.fc.races].sort((a, b) => Math.abs(final(a).p_win - 0.5) - Math.abs(final(b).p_win - 0.5));
  const grp = (lo, hi) => races.filter((r) => final(r).p_win >= lo && final(r).p_win < hi);
  const g = [["Toss-ups and leans", grp(0, 0.75)], ["Likely", grp(0.75, 0.92)], ["Safe", grp(0.92, 1.01)]];
  const skewN = S.fc.races.filter((r) => r.skew?.flag).length;
  $("#panel-body").innerHTML = `<h2>${S.fc.races.length} Senate races</h2>
    <p class="sub">Polls decide each call. Scripts check where the polls look skewed (${skewN} races flagged) and DeepSeek makes the final judgement. Qloo's taste data maps each state down to the block and shows which places no longer match their 2024 vote.</p>
    <div class="lock">Forecast locked ${esc(new Date(S.fc.locked_at || S.fc.generated_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }))} · polls through ${esc(S.fc.polls_through || "—")} · election Nov 3, 2026. <button class="howlink" id="how-open">How it works</button></div>
    ${g.filter(([, l]) => l.length).map(([t, l]) => `<div class="grouphead">${t}</div><div class="races">${l.map(raceLine).join("")}</div>`).join("")}`;
  $("#how-open").onclick = how;
  document.querySelectorAll(".race").forEach((b) => (b.onclick = () => openRace(b.dataset.id, true)));
}

function meter(r) {
  const f = final(r), lim = Math.max(20, Math.ceil(Math.max(Math.abs(f.margin_d), Math.abs(r.pres24_margin_d), Math.abs(r.polls.avg_margin_d ?? 0)) / 5) * 5 + 5);
  const x = (m) => 50 + (Math.max(-lim, Math.min(lim, m)) / lim) * 50;
  return `<div class="meter"><i class="z"></i>
      <i class="pt base" style="left:${x(r.pres24_margin_d)}%" title="2024 presidential"></i>
      ${r.polls.avg_margin_d != null ? `<i class="pt poll" style="left:${x(r.polls.avg_margin_d)}%" title="Poll average"></i>` : ""}
      <i class="pt fin" style="left:${x(f.margin_d)}%" title="Final call"></i></div>
    <div class="meter-l"><span>R+${lim}</span><span>even</span><span>D+${lim}</span></div>
    <div class="keys"><span><i style="border:2px solid var(--muted)"></i>2024 president ${fmtM(r.pres24_margin_d)}</span>${r.polls.avg_margin_d != null ? `<span><i style="background:var(--ink)"></i>Poll avg ${fmtM(r.polls.avg_margin_d)}</span>` : ""}<span><i style="background:var(--accent)"></i>Final ${fmtM(f.margin_d)}</span></div>`;
}

function openRace(id, fly) {
  const r = S.fc.races.find((x) => x.id === id); if (!r) return;
  S.sel = r; if (map?.getLayer("sel-line")) map.setFilter("sel-line", ["==", ["get", "fips"], r.stfips]);
  if (fly && map?.loaded()) {
    const f = S.geo.st.features.find((x) => x.properties.fips === r.stfips);
    if (f) map.fitBounds(bbox(f.geometry), { padding: 40, duration: 900, maxZoom: 7.2 });
  }
  const f = final(r), v = r.verdict, q = r.qloo, w = r.candidates.find((c) => c.party === f.winner_party) || {};
  const ood = (list, dir) => list.map(([fips, name, gap, pred, m24]) => `<tr><td><button data-fips="${fips}">${esc(name)}</button></td><td>${fmtM(m24)}</td><td class="${dir}">${fmtM(pred)}</td></tr>`).join("");
  const bt = q.backtest;
  $("#panel-body").innerHTML = `<button class="back" id="back">← All races</button>
    <h2>${esc(r.state)}${r.special ? " (special)" : ""}</h2>
    <p class="sub">${r.candidates.map((c) => `<span class="${c.party}">${esc(c.name)}</span> (${c.party}${c.incumbent ? ", incumbent" : ""})`).join(" · ")}</p>
    <div class="card verdict"><div class="head ${f.winner_party}">${esc(w.name || pty(f.winner_party))} wins · ${fmtM(f.margin_d)} · ${pct(f.p_win)}</div>
      ${v ? `<p><b>${esc(v.headline)}</b></p><p>${esc(v.reasoning)}</p><div class="by">Final judgement: ${esc(v.model)} (confidence ${esc(v.confidence)}), from the numbers below. The script's own call: ${fmtM(r.script.margin_d)}, ${pct(r.script.p_win)} ${esc(r.script.winner_party)}.</div>`
          : `<p class="note">Script call (the final-judgement step has not run for this race).</p>`}
      ${meter(r)}</div>
    <div class="card"><h3>Where the polls may be skewed</h3><div class="kv">
      <span class="k">Poll average (${r.polls.n_recent} recent of ${r.polls.n})</span><b>${fmtM(r.polls.avg_margin_d)}</b>
      <span class="k">Independent polls only</span><b>${fmtM(r.polls.independent_avg)}</b>
      ${Object.entries(r.polls.house || {}).map(([t, h]) => `<span class="k">${t === "D" ? "Democratic" : "Republican"}-sponsored polls (${h.n}) vs independent</span><b>${fmtS(h.diff)} pts</b>`).join("")}
      <span class="k">2024 presidential in ${esc(r.state_po)}</span><b>${fmtM(r.pres24_margin_d)}</b>
      <span class="k">Shift since 2024 (typical race ${fmtS(S.fc.national.median_poll_swing_since_2024)})</span><b>${r.skew.poll_swing == null ? "—" : fmtS(r.skew.poll_swing)} pts</b></div>
      <p class="note">${r.skew.flag ? `<span class="flag">${esc(r.skew.short)}</span> ` : ""}${esc(r.skew.text)}</p></div>
    <div class="card"><h3>Inside ${esc(r.state)}: places out of step with their 2024 vote</h3>
      <table class="counties"><tr><th></th><th>Voted 2024</th><th>Qloo expects</th></tr>${ood(q.out_of_step_d.slice(0, 4), "D")}${ood(q.out_of_step_r.slice(0, 4), "R")}</table>
      <p class="note">Given what their residents watch, read and buy, Qloo expects these counties to vote differently from how they did in 2024, relative to the rest of the state.${bt ? ` 2020→2024 check here: flagged counties moved the flagged way ${pct(bt.hit)} of the time (r = ${bt.r.toFixed(2)}).` : ""} This shows where inside the state the vote may be moving. It does not move the statewide call (see How it works). Click a county to zoom in; zoom further for a live block-level scan.</p></div>
    ${r.polls.list.length ? `<div class="card"><h3>Latest polls</h3><table class="polls"><tr><th>Pollster</th><th>End</th><th>n</th><th>Margin</th></tr>
      ${r.polls.list.map((p) => `<tr><td>${esc(p.pollster)}</td><td>${esc(p.end_date)}</td><td>${p.sample ? esc(p.sample) + (p.population ? " " + esc(p.population) : "") : "—"}</td><td>${fmtM(p.margin_d)}</td></tr>`).join("")}</table>
      <p class="note">Source: Wikipedia polling tables, ${esc(r.wiki_url ? new URL(r.wiki_url).pathname.split("/").pop().replaceAll("_", " ") : "")}.</p></div>` : `<div class="card"><h3>Polls</h3><p class="note">No public general-election polls found, so this call leans on the 2024 baseline and the Qloo shift.</p></div>`}`;
  $("#back").onclick = () => { home(); map?.flyTo({ center: [-96.5, 38.6], zoom: 3.6 }); };
  document.querySelectorAll("[data-fips]").forEach((b) => (b.onclick = () => {
    const cf = S.geo.co.features.find((x) => x.properties.fips === b.dataset.fips);
    if (cf && map) map.fitBounds(bbox(cf.geometry), { padding: 60, duration: 900, maxZoom: 10.6 });
  }));
}

function bbox(g) {
  let a = [180, 90, -180, -90];
  const walk = (c) => (typeof c[0] === "number" ? (a = [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[2], c[0]), Math.max(a[3], c[1])]) : c.forEach(walk));
  walk(g.coordinates); return [[a[0], a[1]], [a[2], a[3]]];
}

function how() {
  const m = S.model, bt = m.backtest, N = S.natbt, ents = Object.entries(m.entities).sort((a, b) => a[1].partial_r - b[1].partial_r);
  $("#how-body").innerHTML = `<h2>How Undertow works</h2>
    <p>Polls tell you who is ahead. Undertow asks a second question: <b>has the place itself changed?</b> Qloo knows what people in every part of the country watch, read, listen to and buy. We learn which tastes go with how a county voted, then look for counties whose tastes no longer match their 2024 vote.</p>
    <h3>1. Learn the taste → vote link (automatic)</h3>
    <p>For ${m.n_counties.toLocaleString()} counties in ${m.n_states} states we pulled Qloo heatmaps for ${Object.keys(m.entities).length} selected tastes. A taste is only used if its pull has the same direction in at least 80% of states, after removing county size. Each county's expected vote comes from a model that <b>never saw its state</b>.</p>
    <p>Ranking counties by how they voted: county size alone r = ${m.fit.r_county_density}, with Qloo r = ${m.fit.r_county_qloo}.</p>
    <h3>2. Find the undertow, and test it honestly</h3>
    <p>The gap between what Qloo expects and a county's 2024 result (after removing ordinary regression to the mean) is the undertow. We tested whether it predicts real change: fit the model to <b>2020</b> results, then check the actual 2020→2024 swing.</p>
    <table><tr><th>Question</th><th>Result</th><th>Verdict</th></tr>
      <tr><td>Inside a state: did out-of-step counties swing the flagged way?</td><td>yes in ${bt.states_positive} of ${Object.keys(bt.states).length} states; ${pct(bt.hit_extremes)} on the most extreme counties${N ? `; nationwide-query version: ${N.within_state_positive} of ${N.within_state_n} states, median r ${N.within_state_median_r}` : ""}</td><td>weak but consistent: used on the map</td></tr>
      ${N ? `<tr><td>Statewide: did states with a bigger average gap swing that way?</td><td>r = ${N.state_r_controlled} across ${N.n_states} states; right direction ${pct(N.state_hit_extremes)} of the time on the most out-of-step states</td><td>no: not used for the calls</td></tr>` : ""}</table>
    <p class="note">So Undertow does not let Qloo move a statewide call. Doing that would have added noise to the predictions. Caveat on the county result: Qloo's data reflects tastes today, not in 2020, so this is not a clean forecast test.</p>
    <h3>3. Polls make the call; scripts look for skew</h3>
    <p>For each race the script averages recent general-election polls (weighted by recency and sample size, one poll per pollster, partisan-sponsored polls at 60%). It then checks two kinds of skew: whether Democratic- or Republican-sponsored polls differ from independent ones by 4+ points, and whether the race's shift since 2024 is far (9+ points) from the typical polled race (${fmtS(S.fc.national.median_poll_swing_since_2024)}). With no polls, the call is the 2024 result plus the typical shift. DeepSeek (deepseek-v4.1-flash) then reads only those numbers plus published ratings and makes the final judgement with a short reason. It cannot fetch anything or change the data, and an answer more than 8 points from the script's call is rejected.</p>
    <h3>4. Down to the block</h3>
    <p>States → counties → Qloo's ~5 km cells → a live scan at ~150 m when you zoom into a neighbourhood. Below the county, a cell shows its county's result shifted by how its tastes differ from its neighbours'. That is relative, not a separate poll.</p>
    <h3>The tastes</h3>
    <table><tr><th>Taste</th><th>Pulls</th><th>Strength</th><th>Same direction in</th></tr>${ents.map(([n, e]) => `<tr><td>${esc(n)}</td><td class="${e.lean}">${e.lean}</td><td>${Math.abs(e.partial_r).toFixed(2)}</td><td>${pct(e.states_consistent)} of states</td></tr>`).join("")}</table>
    <h3>Data</h3><p class="note">Qloo Insights API (hackathon endpoint: heatmaps, search). 2020 and 2024 county presidential results: github.com/tonmcg/US_County_Level_Election_Results_08-24. Polls: Wikipedia general-election polling tables. County shapes: us-atlas. Basemap: OpenFreeMap / OpenStreetMap.</p>`;
  $("#how").showModal();
}

document.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => {
  document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-checked", x === b));
  S.mode = b.dataset.mode; if (map) recolor();
}));

load().then(() => {
  tally(); home();
  try { initMap(); } catch (e) { map = null; $("#map").innerHTML = `<p class="note" style="padding:60px 20px">The map needs WebGL, which this browser has turned off. The race list and calls still work.</p>`; }
}).catch((e) => { $("#panel-body").innerHTML = `<p>Could not load the forecast: ${esc(e.message)}</p>`; });
