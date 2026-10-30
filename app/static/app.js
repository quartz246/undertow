/* Undertow front end: MapLibre map (states -> counties -> Qloo cells -> live block scan) + race panel. */
const HOLD = { D: 34, R: 31 }; // seats not up in 2026 (Democrats incl. the two independents who caucus with them)
const S = { mode: "forecast", office: "senate", fcs: {}, mkt: null, fc: null, model: null, counties: null, states: null, raceBy: {}, sel: null,
            geo: null, cellsLoaded: {}, cellFeats: [], liveCtl: null, liveTimer: null, nameToFips: {} };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtM = (m) => (m == null || isNaN(m) ? "—" : Math.abs(m) < 0.05 ? "Even" : (m > 0 ? "D+" : "R+") + Math.abs(m).toFixed(1));
const fmtS = (m, d = 1) => (m == null ? "—" : (m > 0 ? "+" : m < 0 ? "−" : "±") + Math.abs(m).toFixed(d));
const pty = (p) => (p === "D" ? "Democrat" : p === "R" ? "Republican" : p === "I" ? "Independent" : p);
const pct = (p) => Math.round(p * 100) + "%";
const OFF = { senate: "Senate", governor: "Governor" };
const pD = (f) => (f.winner_party !== "R" ? f.p_win : 1 - f.p_win); // chance the non-Republican side wins

const RAMP = [[-30, "#7d1a13"], [-15, "#c23a2f"], [-6, "#ec9f97"], [-1.5, "#f6e0dc"], [0, "#efece6"], [1.5, "#dbe6f6"], [6, "#8fb3e6"], [15, "#2160b8"], [30, "#123e7c"]];
const RAMP_US = [[-14, "#c23a2f"], [-7, "#ec9f97"], [-2, "#f6e0dc"], [0, "#efece6"], [2, "#dbe6f6"], [7, "#8fb3e6"], [14, "#2160b8"]]; // statewide undertow
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
  const [senate, governor, model, counties, states, topo] = await Promise.all(
    ["/api/forecast", "/api/forecast?office=governor", "/api/model", "/api/counties", "/api/states", "/geo/counties-10m.json"].map((u) => fetch(u).then((r) => r.json())));
  Object.assign(S, { fcs: { senate, governor }, fc: senate, model, counties, states });
  S.qn = await fetch("/api/qloo").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  S.mkt = await fetch("/api/markets").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  S.natbt = await fetch("/api/backtest").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  indexRaces();
  const st = topojson.feature(topo, topo.objects.states), co = topojson.feature(topo, topo.objects.counties);
  st.features.forEach((f) => { f.id = +f.id; f.properties.fips = String(f.id).padStart(2, "0"); S.nameToFips[f.properties.name] = f.properties.fips; });
  co.features.forEach((f) => { f.properties.fips = String(f.id).padStart(5, "0"); f.id = +f.id; });
  S.geo = { st, co };
}
function indexRaces() { S.raceBy = {}; for (const r of S.fc.races) (S.raceBy[r.stfips] ||= []).push(r); }
function setOffice(o) {
  S.office = o; S.fc = S.fcs[o]; indexRaces();
  document.querySelectorAll(".office button").forEach((x) => x.setAttribute("aria-checked", x.dataset.office === o));
  if (map?.getLayer("race-line")) { map.setFilter("race-line", ["in", ["get", "fips"], ["literal", Object.keys(S.raceBy)]]); recolor(); }
  if (S.cmp) paint24();
  tally(); home(); if (typeof renderCharts === "function") renderCharts();
}
const final = (r) => r.verdict || r.script;
// Qloo-only: expected 2024 margin from tastes alone (nationwide model) + the national shift the polls show for this office
const natSwing = () => S.fc.national.median_poll_swing_since_2024;
const qlooState = (name) => (S.qn?.states?.[name] != null ? S.qn.states[name] + natSwing() : null);
const qlooCounty = (fips) => (S.qn?.counties?.[fips] != null ? S.qn.counties[fips] + natSwing() : null);
const stateFinal = (fips) => (S.raceBy[fips] ? final(S.raceBy[fips][0]).margin_d : null);

function countyEst(fips) {
  const c = S.counties[fips]; if (!c) return null;
  const st = S.states[c.state], sf = stateFinal(fips.slice(0, 2));
  return (sf == null ? c.m24 + natSwing() : c.m24 + (sf - st.m24)) + (c.swing_est - st.qloo_swing);
}
function countyValue(f) {
  if (S.mode === "q24") return S.qn?.counties?.[f.properties.fips] ?? null;
  const c = S.counties[f.properties.fips]; if (!c) return null;
  if (S.mode === "r24") return c.m24;
  if (S.mode === "undertow") return c.gap; // Qloo-expected minus 2024 actual, within its state
  return countyEst(f.properties.fips);
}
function stateValue(f) {
  const name = f.properties.name, st = S.states[name];
  if (S.mode === "q24") return name === "District of Columbia" ? null : S.qn?.states?.[name] ?? null;
  if (S.mode === "r24") return st ? st.m24 : null;
  if (S.mode === "undertow") return S.qn?.state_undertow?.[name] ?? null; // statewide undertow (nationwide taste model)
  const sf = stateFinal(f.properties.fips);
  return sf != null ? sf : st ? st.m24 + natSwing() : null; // no race this year: generic estimate, drawn faded

}
function cellValue(c) {
  const co = S.counties[c.fips]; if (!co) return null;
  if (S.mode === "q24") return S.qn?.counties?.[c.fips] != null ? S.qn.counties[c.fips] + (c.est - co.m24) : null;
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
    map.addLayer({ id: "states-fill", type: "fill", source: "states", paint: { "fill-color": expr(RAMP), "fill-opacity": ["interpolate", ["linear"], ["zoom"], 4.2, ["case", ["==", ["get", "norace"], 1], 0.35, 0.92], 5.2, 0] } }, before);
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
  for (const f of S.geo.st.features) { f.properties.v = stateValue(f); f.properties.norace = S.mode === "forecast" && !S.raceBy[f.properties.fips] ? 1 : 0; }
  for (const f of S.geo.co.features) f.properties.v = countyValue(f);
  for (const f of S.cellFeats) f.properties.v = cellValue(f.properties);
}
function recolor() {
  setValues();
  const ramp = S.mode === "undertow" ? RAMP_U : RAMP;
  for (const l of ["states-fill", "counties-fill", "cells-fill"]) map.setPaintProperty(l, "fill-color", expr(ramp));
  if (S.mode === "undertow") map.setPaintProperty("states-fill", "fill-color", expr(RAMP_US));
  map.setPaintProperty("live-fill", "fill-color", expr(RAMP_U));
  map.getSource("states").setData(S.geo.st);
  map.getSource("counties").setData(S.geo.co);
  map.getSource("cells").setData({ type: "FeatureCollection", features: S.cellFeats });
  if (S.liveData) drawLive(S.liveData);
  legend();
}

function legend() {
  const u = S.mode === "undertow", ramp = u ? RAMP_U : RAMP;
  const title = S.mode === "q24" ? "Qloo expected 2024: the vote each place's tastes alone predict" : u ? (map && map.getZoom() < 5 ? "Undertow, statewide: tastes vs the 2024 vote (zoom in for counties)" : "Undertow: counties whose tastes don't match their 2024 vote (relative to their state)") : S.mode === "r24" ? "2024 presidential result" : `2026 ${OFF[S.office]} forecast (states) · estimated vote (counties, cells)`;
  $("#legend").innerHTML = `<b>${esc(title)}</b><div class="ramp">${ramp.map(([, c]) => `<span style="background:${c}"></span>`).join("")}</div>
    ${u ? `<div class="note">Statewide view is for exploring only: on 2020→2024 it did not predict statewide swing.</div>` : ""}<div class="ends"><span>${u ? "tastes redder" : "R+30"}</span><span>${u ? "matches" : "even"}</span><span>${u ? "tastes bluer" : "D+30"}</span></div>${S.mode === "forecast" ? `<div class="note">Faded states: no ${S.office === "senate" ? "Senate" : "governor"} race this year (2024 result + typical shift)</div>` : ""}`;
}

async function onMove() {
  const z = map.getZoom(), c = map.getCenter();
  if (S.mode === "undertow") legend();
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
    if (S.mode === "undertow") {
      const u = S.qn?.state_undertow?.[p.name];
      tip.innerHTML = `<b>${esc(p.name)}</b><br>${u == null ? "<span class='k'>No statewide undertow (no county-level taste data)</span>" : `Statewide undertow <b>${fmtS(u)}</b>: tastes look ${Math.abs(u).toFixed(1)} pts ${u > 0 ? "bluer" : "redder"} than its 2024 vote (${fmtM(st?.m24)})`}<br><span class="k">Exploratory: did not predict statewide swing on 2020→2024. Zoom in for counties.</span>`;
      tip.hidden = false; const rr = $("#map").getBoundingClientRect();
      tip.style.left = Math.min(e.point.x + 14, rr.width - 270) + "px"; tip.style.top = e.point.y + 14 + "px"; return;
    }
    h = `<b>${esc(p.name)}</b><br>${r ? `Forecast <b>${fmtM(final(r).margin_d)}</b> · ${esc(r.candidates.find((c) => c.party === final(r).winner_party)?.name || "")} ${pct(final(r).p_win)}<br>` : `<span class='k'>No ${S.office === "senate" ? "Senate" : "governor"} race in 2026. Faded colour: 2024 result + the typical shift (${fmtS(natSwing())}) = ${fmtM(st ? st.m24 + natSwing() : null)}</span><br>`}<span class="k">2024 president</span> ${fmtM(st?.m24)}`;
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
  if (S.office === "governor") {
    const g = { D: 0, R: 0, I: 0 }; for (const r of S.fc.races) { const p = final(r).winner_party; g[p in g ? p : "I"]++; }
    const t = g.D + g.R + g.I;
    $("#tally").innerHTML = `<div class="bar" role="img" aria-label="Governor races: ${g.D} Democratic, ${g.R} Republican"><span style="width:${(g.D / t) * 100}%;background:var(--d)"></span><span style="width:${(g.I / t) * 100}%;background:var(--i)"></span><span style="width:${(g.R / t) * 100}%;background:var(--r)"></span></div>
      <div class="nums"><span><b class="D">${g.D}</b> D</span><span>Projected winners of the ${t} governor races</span><span><b class="R">${g.R}</b> R</span></div>`;
    return;
  }
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
  $("#panel-body").innerHTML = `<h2>${S.fc.races.length} ${OFF[S.office]} races</h2>
    <p class="sub">Polls decide each call. Scripts check where the polls look skewed (${skewN} races flagged) and Undertow AI makes the final judgement. Qloo's taste data maps each state down to the block and shows which places no longer match their 2024 vote.</p>
    <div class="lock">Forecast locked ${esc(new Date(S.fc.locked_at || S.fc.generated_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }))} · polls through ${esc(S.fc.polls_through || "—")} · election Nov 3, 2026. <button class="howlink" id="how-open">How it works</button> · <button class="howlink" id="tools-open2">Where we disagree</button></div>
    ${g.filter(([, l]) => l.length).map(([t, l]) => `<div class="grouphead">${t}</div><div class="races">${l.map(raceLine).join("")}</div>`).join("")}`;
  $("#how-open").onclick = how; $("#tools-open2").onclick = tools;
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
  const r = S.fc.races.find((x) => x.id === id) || S.fcs.senate.races.concat(S.fcs.governor.races).find((x) => x.id === id); if (!r) return;
  const off = r.id.endsWith("-G") ? "governor" : "senate"; if (off !== S.office) setOffice(off);
  S.sel = r; if (map?.getLayer("sel-line")) map.setFilter("sel-line", ["==", ["get", "fips"], r.stfips]);
  if (fly && map?.loaded()) {
    const f = S.geo.st.features.find((x) => x.properties.fips === r.stfips);
    if (f) map.fitBounds(bbox(f.geometry), { padding: 40, duration: 900, maxZoom: 7.2 });
  }
  const f = final(r), v = r.verdict, q = r.qloo, w = r.candidates.find((c) => c.party === f.winner_party) || {};
  const ood = (list, dir) => list.map(([fips, name, gap, pred, m24]) => `<tr><td><button data-fips="${fips}">${esc(name)}</button></td><td>${fmtM(m24)}</td><td class="${dir}">${fmtM(pred)}</td></tr>`).join("");
  const bt = q.backtest;
  $("#panel-body").innerHTML = `<button class="back" id="back">← All races</button>
    <h2>${esc(r.state)} ${r.id.endsWith("-G") ? "governor" : "Senate"}${r.special ? " (special)" : ""}</h2>
    <p class="sub">${r.candidates.map((c) => `<span class="${c.party}">${esc(c.name)}</span> (${c.party}${c.incumbent ? ", incumbent" : ""})`).join(" · ")}</p>
    <div class="card verdict"><div class="head ${f.winner_party}">${esc(w.name || pty(f.winner_party))} wins · ${fmtM(f.margin_d)} · ${pct(f.p_win)}</div>
      ${v ? `<p><b>${esc(v.headline)}</b></p><p>${esc(v.reasoning)}</p><div class="by">Final judgement: Undertow AI (confidence ${esc(v.confidence)}), from the numbers below. The script's own call: ${fmtM(r.script.margin_d)}, ${pct(r.script.p_win)} ${esc(r.script.winner_party)}.</div>`
          : `<p class="note">Script call (the final-judgement step has not run for this race).</p>`}
      ${meter(r)}${S.mkt?.races?.[r.id] ? `<p class="note">For comparison only (not used in the call): Polymarket gives ${esc(r.main.d.name.split(" ").slice(-1)[0])} ${pct(S.mkt.races[r.id].p_d)}, we give ${pct(pD(f))}. <a href="${esc(S.mkt.races[r.id].url)}" target="_blank" rel="noopener">Market</a></p>` : ""}</div>
    <div class="card"><h3>Where the polls may be skewed</h3><div class="kv">
      <span class="k">Poll average (${r.polls.n_recent} recent of ${r.polls.n})</span><b>${fmtM(r.polls.avg_margin_d)}</b>
      <span class="k">Independent polls only</span><b>${fmtM(r.polls.independent_avg)}</b>
      ${Object.entries(r.polls.house || {}).map(([t, h]) => `<span class="k">${t === "D" ? "Democratic" : "Republican"}-sponsored polls (${h.n}) vs independent</span><b>${fmtS(h.diff)} pts</b>`).join("")}
      <span class="k">2024 presidential in ${esc(r.state_po)}</span><b>${fmtM(r.pres24_margin_d)}</b>
      <span class="k">Shift since 2024 (typical race ${fmtS(S.fc.national.median_poll_swing_since_2024)})</span><b>${r.skew.poll_swing == null ? "—" : fmtS(r.skew.poll_swing)} pts</b>
      <span class="k">Qloo-only forecast (tastes + national shift)</span><b>${fmtM(qlooState(r.state))}</b></div>
      <p class="note">${r.skew.flag ? `<span class="flag">${esc(r.skew.short)}</span> ` : ""}${esc(r.skew.text)}</p></div>
    <div class="card"><h3>Inside ${esc(r.state)}: places out of step with their 2024 vote</h3>
      <table class="counties"><tr><th></th><th>Voted 2024</th><th>Qloo expects</th></tr>${ood(q.out_of_step_d.slice(0, 4), "D")}${ood(q.out_of_step_r.slice(0, 4), "R")}</table>
      ${S.qn?.state_undertow?.[r.state] != null ? `<div class="kv"><span class="k">Statewide undertow (tastes vs 2024 vote)</span><b>${fmtS(S.qn.state_undertow[r.state])} pts ${S.qn.state_undertow[r.state] > 0 ? "bluer" : "redder"}</b></div>` : ""}
      <p class="note">Given what their residents watch, read and buy, Qloo expects these counties to vote differently from how they did in 2024, relative to the rest of the state.${bt ? ` 2020→2024 check here: flagged counties moved the flagged way ${pct(bt.hit)} of the time (r = ${bt.r.toFixed(2)}).` : ""} This shows where inside the state the vote may be moving. Neither this nor the statewide undertow moves the call: statewide, the signal did not predict 2020→2024 swing (see How it works). Click a county to zoom in; zoom further for a live block-level scan.</p></div>
    ${r.polls.list.length ? `<div class="card"><h3>Latest polls</h3><table class="polls"><tr><th>Pollster</th><th>End</th><th>n</th><th>Margin</th></tr>
      ${r.polls.list.map((p) => `<tr><td>${esc(p.pollster)}</td><td>${esc(p.end_date)}</td><td>${p.sample ? esc(p.sample) + (p.population ? " " + esc(p.population) : "") : "—"}</td><td>${fmtM(p.margin_d)}</td></tr>`).join("")}</table>
      <p class="note">Source: Wikipedia polling tables, ${esc(r.wiki_url ? new URL(r.wiki_url).pathname.split("/").pop().replaceAll("_", " ") : "")}.</p></div>` : `<div class="card"><h3>Polls</h3><p class="note">No public general-election polls found, so this call starts from the 2024 result plus the typical shift in polled races.</p></div>`}`;
  $("#back").onclick = () => { home(); map?.flyTo({ center: [-96.5, 38.6], zoom: 3.6 }); };
  bindCountyLinks();
}
function bindCountyLinks() {
  document.querySelectorAll("[data-fips]").forEach((b) => (b.onclick = () => {
    const cf = S.geo.co.features.find((x) => x.properties.fips === b.dataset.fips);
    if (cf && map) map.fitBounds(bbox(cf.geometry), { padding: 60, duration: 900, maxZoom: 10.6 });
  }));
}

/* ---------------- tools: where we disagree ---------------- */
function tools() {
  const fc = S.fc, M = S.mkt, name = (r) => `${esc(r.state)}`;
  const last = (n) => esc(n.split(" ").slice(-1)[0]);
  // 1. vs betting markets (comparison only)
  const vm = fc.races.filter((r) => M?.races?.[r.id]).map((r) => ({ r, us: pD(final(r)), mk: M.races[r.id].p_d, url: M.races[r.id].url }))
    .map((x) => ({ ...x, diff: x.us - x.mk, flip: (x.us > 0.5) !== (x.mk > 0.5) })).sort((a, b) => (b.flip - a.flip) || Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 12);
  // 2. vs the poll average
  const vp = fc.races.map((r) => ({ r, f: final(r), avg: r.polls.avg_margin_d })).filter((x) => x.avg == null || Math.abs(x.f.margin_d - x.avg) >= 1 || (x.f.margin_d > 0) !== (x.avg > 0))
    .sort((a, b) => (a.avg == null) - (b.avg == null) || Math.abs(b.f.margin_d - (b.avg ?? 0)) - Math.abs(a.f.margin_d - (a.avg ?? 0)));
  // 3. county markets vs our county estimate
  const cm = Object.values(M?.counties || {}).filter((c) => fc.races.some((r) => r.id === c.race)).map((c) => ({ ...c, est: countyEst(c.fips) }))
    .map((c) => ({ ...c, flip: c.est != null && (c.est > 0) !== (c.p_d > 0.5) })).sort((a, b) => b.flip - a.flip || Math.abs(b.p_d - 0.5) - Math.abs(a.p_d - 0.5));
  // 4. places most out of step with their 2024 vote (big enough to have solid Qloo data)
  const big = Object.entries(S.counties).filter(([, c]) => c.votes >= 50000);
  const blu = [...big].sort((a, b) => b[1].gap - a[1].gap).slice(0, 6), red = [...big].sort((a, b) => a[1].gap - b[1].gap).slice(0, 6);
  const skew = fc.races.filter((r) => r.skew?.flag && r.skew.flag !== "agree");
  $("#panel-body").innerHTML = `<button class="back" id="back">← All races</button>
    <h2>Where we disagree</h2>
    <p class="sub">${OFF[S.office]} races. Every place where our call, the polls, the betting markets or a county's own history point different ways.</p>
    <div class="card"><h3>Our call vs betting markets</h3>
      ${vm.length ? `<table class="polls"><tr><th>Race</th><th>Us</th><th>Market</th><th></th></tr>${vm.map((x) => `<tr><td><button class="lnk" data-race="${x.r.id}">${name(x.r)}</button>${x.flip ? ' <span class="flag">different winner</span>' : ""}</td><td>${last(x.r.main.d.name)} ${pct(x.us)}</td><td>${pct(x.mk)}</td><td><a href="${esc(x.url)}" target="_blank" rel="noopener">odds</a></td></tr>`).join("")}</table>` : `<p class="note">No market data loaded.</p>`}
      <p class="note">Chance the non-Republican candidate wins. Polymarket prices${M ? ` fetched ${esc(new Date(M.fetched_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }))}` : ""}. Shown for comparison only; markets never feed the forecast.</p></div>
    <div class="card"><h3>Polls vs Qloo-only</h3>
      <table class="polls"><tr><th>Race</th><th>Our call</th><th>Qloo-only</th><th>Gap</th></tr>${fc.races.map((r) => ({ r, f: final(r).margin_d, q: qlooState(r.state) })).filter((x) => x.q != null)
        .map((x) => ({ ...x, flip: (x.f > 0) !== (x.q > 0) })).sort((a, b) => b.flip - a.flip || Math.abs(b.q - b.f) - Math.abs(a.q - a.f)).slice(0, 12)
        .map((x) => `<tr><td><button class="lnk" data-race="${x.r.id}">${name(x.r)}</button>${x.flip ? ' <span class="flag">different winner</span>' : ""}</td><td>${fmtM(x.f)}</td><td>${fmtM(x.q)}</td><td>${fmtS(x.q - x.f)}</td></tr>`).join("")}</table>
      <p class="note">Qloo-only = what each state's tastes alone predict (the 2024-style vote from the nationwide taste model, which missed 2024 states by ${S.qn?.state_mae_2024 ?? "—"} pts on average and picked the right winner in ${S.qn ? pct(S.qn.state_winner_right_2024) : "—"} of them), plus the national shift the polls show (${fmtS(natSwing())}). A gap means the polls see something the tastes don't, or the reverse. Compare the two maps with the <b>Polls ↔ Qloo</b> slider.</p></div>
    <div class="card"><h3>Final call vs the poll average</h3>
      <table class="polls"><tr><th>Race</th><th>Polls</th><th>Final</th><th>Why</th></tr>${vp.slice(0, 12).map((x) => `<tr><td><button class="lnk" data-race="${x.r.id}">${name(x.r)}</button></td><td>${x.avg == null ? "none" : fmtM(x.avg)}</td><td>${fmtM(x.f.margin_d)}</td><td class="note">${x.avg == null ? "no polls: 2024 + typical shift" : esc(x.f.headline || "")}</td></tr>`).join("")}</table>
      <p class="note">Where Undertow AI's final judgement moved away from the script's poll average, or there were no polls.</p></div>
    <div class="card"><h3>Polls that look skewed</h3>${skew.length ? skew.map((r) => `<p class="note"><button class="lnk" data-race="${r.id}">${name(r)}</button> <span class="flag">${esc(r.skew.short)}</span> ${esc(r.skew.text)}</p>`).join("") : `<p class="note">None flagged.</p>`}</div>
    <div class="card"><h3>Counties: our estimate vs county betting markets</h3>
      ${cm.length ? `<table class="polls"><tr><th>County</th><th>Our estimate</th><th>Market (D wins)</th></tr>${cm.map((c) => `<tr><td><button class="lnk" data-fips="${c.fips}">${esc(c.name)}, ${esc(c.state)}</button>${c.flip ? ' <span class="flag">different winner</span>' : ""}</td><td>${fmtM(c.est)}</td><td><a href="${esc(c.url)}" target="_blank" rel="noopener">${pct(c.p_d)}</a></td></tr>`).join("")}</table>` : `<p class="note">No county-level markets for these races.</p>`}</div>
    <div class="card"><h3>Statewide undertow</h3>${(() => {
      const u = Object.entries(S.qn?.state_undertow || {}).sort((a, b) => b[1] - a[1]);
      const row = ([n, v]) => { const r = fc.races.find((x) => x.state === n); return `<tr><td>${r ? `<button class="lnk" data-race="${r.id}">${esc(n)}</button>` : esc(n)}</td><td class="${v > 0 ? "D" : "R"}">${fmtS(v)}</td><td>${fmtM(S.states[n]?.m24)}</td><td>${r ? fmtM(final(r).margin_d) : "no race"}</td></tr>`; };
      return u.length ? `<table class="polls"><tr><th>State</th><th>Undertow</th><th>2024</th><th>Our call</th></tr>${u.slice(0, 6).map(row).join("")}<tr><td colspan="4" class="note">…</td></tr>${u.slice(-6).map(row).join("")}</table>` : "";
    })()}
      <p class="note">States whose tastes look bluer (+) or redder (−) than their 2024 vote, after removing ordinary regression to the mean. Exploratory: on 2020→2024 this did not predict statewide swing, so it never moves a call.</p></div>
    <div class="card"><h3>Places most out of step with their 2024 vote</h3>
      <table class="counties"><tr><th>County (50k+ votes)</th><th>Voted 2024</th><th>Qloo expects</th></tr>${blu.concat(red).map(([f, c]) => `<tr><td><button data-fips="${f}">${esc(c.name)}, ${esc(c.state)}</button></td><td>${fmtM(c.m24)}</td><td class="${c.gap > 0 ? "D" : "R"}">${fmtM(c.pred)}</td></tr>`).join("")}</table>
      <p class="note">Nationwide, counties whose tastes look most unlike their 2024 vote, relative to their state. Click to zoom; zoom further for a live block scan.</p></div>`;
  $("#back").onclick = home;
  document.querySelectorAll("[data-race]").forEach((b) => (b.onclick = () => openRace(b.dataset.race, true)));
  bindCountyLinks();
}

/* ---------------- 2024 vs 2026 swipe ---------------- */
let map24;
const CMP = { r24: { l: "2026 forecast", r: "2024 president" }, qloo: { l: "Polls forecast", r: "Qloo-only forecast" }, q24: { l: "Qloo expected 2024", r: "Actual 2024" } };
function data24() {
  const q = S.cmpKind === "qloo";
  const sv = (f) => (q ? qlooState(f.properties.name) : S.states[f.properties.name]?.m24 ?? null);
  const cv = (f) => (q ? qlooCounty(f.properties.fips) : S.counties[f.properties.fips]?.m24 ?? null);
  const st = { type: "FeatureCollection", features: S.geo.st.features.map((f) => ({ ...f, properties: { ...f.properties, v: sv(f) } })) };
  const co = { type: "FeatureCollection", features: S.geo.co.features.map((f) => ({ ...f, properties: { ...f.properties, v: cv(f) } })) };
  return { st, co };
}
function paint24() {
  if (!map24?.getSource("states")) return;
  const d = data24(); map24.getSource("states").setData(d.st); map24.getSource("counties").setData(d.co);
  $("#swipe .lab.l").textContent = CMP[S.cmpKind].l; $("#swipe .lab.r").textContent = CMP[S.cmpKind].r;
}
function syncSwipe() {
  if (!map24) return;
  map24.jumpTo({ center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() });
}
function setSwipe(x) {
  const w = $("#map").clientWidth, pad = 24;
  S.swipeX = Math.max(pad, Math.min(w - pad, x));             // the handle never leaves the map
  $("#map24").style.clipPath = `inset(0 0 0 ${S.swipeX}px)`; // compare map shows to the right of the handle
  $("#swipe").style.left = S.swipeX + "px";
  // labels ride with the handle; fade one out when there is no room for it on its side
  const l = $("#swipe .lab.l"), r = $("#swipe .lab.r");
  l.classList.toggle("off", S.swipeX < l.offsetWidth + 40);
  r.classList.toggle("off", w - S.swipeX < r.offsetWidth + 40);
}
function toggleCompare(kind) {
  S.cmp = S.cmpKind === kind ? !S.cmp : true; S.cmpKind = kind;
  document.querySelectorAll(".cmp").forEach((b) => b.setAttribute("aria-pressed", S.cmp && b.dataset.cmp === kind));
  $("#map24").hidden = !S.cmp; $("#swipe").hidden = !S.cmp;
  if (!S.cmp) { if (S.mode === "q24") document.querySelector('.seg [data-mode="forecast"]').click(); return; }
  if (kind !== "q24" && S.mode === "q24") document.querySelector('.seg [data-mode="forecast"]').click();
  paint24();
  if (kind === "q24") { S.mode = "q24"; document.querySelectorAll(".mapbar .seg button").forEach((x) => x.setAttribute("aria-checked", "false")); recolor(); }
  else if (S.mode !== "forecast") document.querySelector('.seg [data-mode="forecast"]').click();
  if (!map24) {
    map24 = new maplibregl.Map({ container: "map24", style: "https://tiles.openfreemap.org/styles/positron", interactive: false, attributionControl: false,
                                 center: map.getCenter(), zoom: map.getZoom() });
    map24.on("load", () => {
      const before = map24.getStyle().layers.find((l) => l.type === "symbol")?.id, d = data24();
      map24.addSource("states", { type: "geojson", data: d.st }); map24.addSource("counties", { type: "geojson", data: d.co });
      map24.addLayer({ id: "c", type: "fill", source: "counties", paint: { "fill-color": expr(RAMP), "fill-opacity": ["interpolate", ["linear"], ["zoom"], 4.2, 0, 5.2, 0.85, 10, 0.3] } }, before);
      map24.addLayer({ id: "s", type: "fill", source: "states", paint: { "fill-color": expr(RAMP), "fill-opacity": ["interpolate", ["linear"], ["zoom"], 4.2, 0.92, 5.2, 0] } }, before);
      map24.addLayer({ id: "cl", type: "line", source: "counties", minzoom: 5, paint: { "line-color": "#fff", "line-width": 0.4 } }, before);
      map24.addLayer({ id: "sl", type: "line", source: "states", paint: { "line-color": "#fff", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.8, 8, 2.5] } });
      syncSwipe(); paint24();
    });
    map.on("move", syncSwipe);
  }
  map24.resize(); syncSwipe(); setSwipe($("#map").clientWidth / 2);
}
function initSwipeDrag() {
  const sw = $("#swipe"), grip = $("#swipe .grip"); let drag = false;
  const at = (e) => setSwipe(e.clientX - $("#map").getBoundingClientRect().left);
  sw.addEventListener("pointerdown", (e) => { drag = true; sw.classList.add("drag"); sw.setPointerCapture(e.pointerId); at(e); e.preventDefault(); });
  sw.addEventListener("pointermove", (e) => { if (drag) { at(e); e.preventDefault(); } });
  const end = () => { drag = false; sw.classList.remove("drag"); };
  sw.addEventListener("pointerup", end); sw.addEventListener("pointercancel", end);
  grip.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 120 : 30;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { setSwipe(S.swipeX + (e.key === "ArrowLeft" ? -step : step)); e.preventDefault(); }
    if (e.key === "Home" || e.key === "End") { setSwipe(e.key === "Home" ? 0 : 1e6); e.preventDefault(); }
  });
  window.addEventListener("resize", () => S.cmp && setSwipe(S.swipeX));
}

/* ---------------- place search (ZIP / city / state) ---------------- */
function initSearch() {
  const q = $("#q"), ul = $("#sugg"); let items = [], sel = -1, timer, ctl;
  const close = () => { ul.hidden = true; sel = -1; q.setAttribute("aria-expanded", "false"); };
  const draw = () => {
    ul.innerHTML = items.map((r, i) => `<li role="option" id="sg${i}" aria-selected="${i === sel}" data-i="${i}">${esc(r.label)}<small>${r.type === "zip" ? "ZIP" : r.type === "state" ? "state" : "city"}</small></li>`).join("");
    ul.hidden = !items.length; q.setAttribute("aria-expanded", String(!!items.length));
    if (sel >= 0) q.setAttribute("aria-activedescendant", `sg${sel}`); else q.removeAttribute("aria-activedescendant");
    ul.querySelectorAll("li").forEach((li) => li.addEventListener("mousedown", (e) => { e.preventDefault(); go(items[+li.dataset.i]); }));
  };
  q.addEventListener("input", () => {
    clearTimeout(timer); const v = q.value.trim(); if (v.length < 2) { items = []; close(); return; }
    timer = setTimeout(async () => {
      ctl?.abort(); ctl = new AbortController();
      try { items = (await fetch(`/api/search?q=${encodeURIComponent(v)}`, { signal: ctl.signal }).then((r) => r.json())).results || []; sel = items.length ? 0 : -1; draw(); } catch {}
    }, 160);
  });
  q.addEventListener("keydown", (e) => {
    if (ul.hidden) return;
    if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === "Escape") close();
  });
  q.addEventListener("blur", () => setTimeout(close, 120));
  $("#search").addEventListener("submit", (e) => { e.preventDefault(); if (items[sel >= 0 ? sel : 0]) go(items[sel >= 0 ? sel : 0]); });
  function go(r) {
    close(); q.value = r.label; q.blur();
    const fp = S.nameToFips[r.state];
    if (fp && S.raceBy[fp]) openRace(S.raceBy[fp][0].id, false);
    if (!map) return;
    if (r.type === "state") {
      const f = S.geo.st.features.find((x) => x.properties.fips === fp);
      if (f) map.fitBounds(bbox(f.geometry), { padding: 40, duration: 1200, maxZoom: 7.2 });
      return;
    }
    S.pin?.remove();
    const el = document.createElement("div"); el.className = "pin"; el.setAttribute("aria-hidden", "true");
    S.pin = new maplibregl.Marker({ element: el }).setLngLat([r.lon, r.lat]).addTo(map);
    map.flyTo({ center: [r.lon, r.lat], zoom: r.type === "zip" ? 12.8 : 11.6, duration: 1600 }); // lands in live block-scan range
  }
}

/* ---------------- guided tour ---------------- */
function setMode(m) { const b = document.querySelector(`.mapbar .seg [data-mode="${m}"]`); if (b && S.mode !== m) b.click(); }
function compareOff() { if (S.cmp) toggleCompare(S.cmpKind); }
function flyUS() { map.flyTo({ center: [-96.5, 38.6], zoom: 3.6, duration: 1400 }); }
function tourSteps() {
  if (S.office !== "senate") setOffice("senate");
  const fc = S.fc, U = S.qn?.state_undertow || {}, us = Object.entries(U).sort((a, b) => b[1] - a[1]);
  const blue = us.slice(0, 2), red = us.slice(-2).reverse();
  const q24 = Object.entries(S.qn?.states || {}).filter(([n]) => n !== "District of Columbia" && S.states[n]);
  const right = q24.filter(([n, q]) => (q > 0) === (S.states[n].m24 > 0)).length;
  const dis = fc.races.map((r) => ({ r, f: final(r).margin_d, q: qlooState(r.state) })).filter((x) => x.q != null)
    .sort((a, b) => ((b.q > 0) !== (b.f > 0)) - ((a.q > 0) !== (a.f > 0)) || Math.abs(b.q - b.f) - Math.abs(a.q - a.f))[0];
  const md = S.counties["12086"], n = { D: 0, R: 0, I: 0 }; for (const r of fc.races) { const p = final(r).winner_party; n[p in n ? p : "I"]++; }
  const stateFit = (name, z = 7) => { const f = S.geo.st.features.find((x) => x.properties.name === name); if (f) map.fitBounds(bbox(f.geometry), { padding: 60, duration: 1400, maxZoom: z }); };
  return [
    { t: "Polls make the call", p: `Every race is called from the polls, with Undertow AI making the final judgement. Projected Senate: ${n.D + HOLD.D} D, ${n.R + HOLD.R} R${n.I ? `, ${n.I} independent` : ""}. Qloo's job is different: to show what the places themselves are like.`,
      go: () => { compareOff(); setMode("forecast"); home(); flyUS(); } },
    { t: "Tastes alone redraw the 2024 map", p: `Left of the line: the 2024 vote Qloo predicts from nothing but what each place watches, reads, listens to and buys. Right: what actually happened. Tastes alone picked the right winner in ${right} of ${q24.length} states. Drag the line.`,
      go: () => { if (!(S.cmp && S.cmpKind === "q24")) { compareOff(); toggleCompare("q24"); } flyUS(); } },
    { t: "The statewide undertow", p: `States whose tastes look bluer or redder than their 2024 vote: ${blue.map(([s_, v]) => `${s_} ${fmtS(v)}`).join(", ")} lean bluer; ${red.map(([s_, v]) => `${s_} ${fmtS(v)}`).join(", ")} lean redder. Exploratory only: statewide, this did not predict the 2020→2024 swing.`,
      go: () => { compareOff(); setMode("undertow"); flyUS(); } },
    md ? { t: "Miami-Dade: the vote moved, the tastes didn't", p: `Miami-Dade voted ${fmtM(md.m24)} in 2024, yet its tastes look like ${fmtM(md.pred)}. Several heavily Hispanic counties show the same gap: either the 2024 shift could reverse, or tastes lag the vote. Inside states, gaps like this did point the right way from 2020 to 2024.`,
      go: () => { compareOff(); setMode("undertow"); const cf = S.geo.co.features.find((x) => x.properties.fips === "12086"); if (cf) map.fitBounds(bbox(cf.geometry), { padding: 80, duration: 1600, maxZoom: 8.5 }); } } : null,
    dis ? { t: `${dis.r.state}: polls and tastes disagree`, p: `Our call from the polls: ${fmtM(dis.f)}. Qloo-only: ${fmtM(dis.q)}${(dis.q > 0) !== (dis.f > 0) ? ", a different winner" : ""}. Left of the line is the polls forecast, right is the taste forecast. We keep the polls' call; the gap is the thing to watch on election night.`,
      go: () => { if (!(S.cmp && S.cmpKind === "qloo")) { compareOff(); toggleCompare("qloo"); } openRace(dis.r.id, false); stateFit(dis.r.state); } } : null,
    { t: "Down to the block", p: "Zoom into any neighbourhood, or search a ZIP code, and Qloo is queried live for ~150 m cells. Each block is coloured by whether its tastes run bluer or redder than the rest of its county. Here: Detroit.",
      go: () => { compareOff(); setMode("forecast"); map.flyTo({ center: [-83.0458, 42.3314], zoom: 12.8, duration: 2200 }); } },
    { t: "How it did in the past", p: "Below the map: a chart for each test. Tastes vs the real 2024 result, how out-of-step counties actually swung from 2020 to 2024, and the statewide test that failed.",
      go: () => { compareOff(); setMode("forecast"); flyUS(); }, last: true },
  ].filter(Boolean);
}
function tour() {
  if (!map?.loaded()) return;
  $("#welcome").open && $("#welcome").close();
  const steps = tourSteps(); let i = 0;
  let card = $("#tour"); if (!card) { card = document.createElement("div"); card.id = "tour"; card.className = "tour"; card.setAttribute("role", "dialog"); card.setAttribute("aria-label", "Guided tour"); $(".mapwrap").appendChild(card); }
  const show = () => {
    const st = steps[i]; st.go();
    card.innerHTML = `<div class="step">Tour · ${i + 1} of ${steps.length}</div><h3>${esc(st.t)}</h3><p>${esc(st.p)}</p>
      <div class="nav"><button class="end">Exit</button><span class="dots">${steps.map((_, k) => `<i class="${k === i ? "on" : ""}"></i>`).join("")}</span>
      <span>${i ? '<button class="prev">Back</button> ' : ""}<button class="next">${st.last ? "See the charts" : "Next"}</button></span></div>`;
    card.querySelector(".end").onclick = end;
    card.querySelector(".prev") && (card.querySelector(".prev").onclick = () => { i--; show(); });
    card.querySelector(".next").onclick = () => { if (st.last) { end(); $("#charts").scrollIntoView({ behavior: "smooth" }); } else { i++; show(); } };
    card.querySelector(".next").focus();
  };
  const end = () => { card.remove(); document.removeEventListener("keydown", esc_); };
  const esc_ = (e) => { if (e.key === "Escape") end(); };
  document.addEventListener("keydown", esc_);
  show();
}

/* ---------------- welcome ---------------- */
function welcome(force) {
  let hide = false; try { hide = localStorage.getItem("undertow-welcome") === "hide"; } catch {}
  if (hide && !force) return;
  const m = S.model, N = S.natbt, top = (lean) => Object.entries(m.entities).filter(([, e]) => e.lean === lean).sort((a, b) => Math.abs(b[1].partial_r) - Math.abs(a[1].partial_r)).slice(0, 4).map(([n]) => esc(n)).join(", ");
  $("#welcome-body").innerHTML = `<h2>Undertow</h2>
    <p class="lede">Polls ask people how they'll vote. <b>Qloo shows what places actually live like:</b> what they watch, read, listen to and buy. Undertow puts the two side by side, from the whole country down to a city block.</p>
    <h3>The theory</h3>
    <p>Taste and politics travel together. A county that loves <span class="R">${top("R")}</span> votes differently from one that loves <span class="D">${top("D")}</span>. If a place's tastes no longer match how it voted in 2024, it may be changing underneath its own history. That's the <b>undertow</b>.</p>
    <h3>How Qloo is used</h3>
    <ol>
      <li><b>77 tastes tested, mapped everywhere.</b> Qloo heatmaps for TV shows, podcasts, media figures, music, brands and films across every state: about 3,900 API calls, mapped onto ${m.n_counties.toLocaleString()} counties. The model keeps the ${Object.keys(m.entities).length} whose pull points the same way in at least 80% of states.</li>
      <li><b>Taste → vote model.</b> It learns how tastes predict a county's vote, always tested on states it never saw. Ranking counties: r = ${N?.county_r_out_of_state ?? m.fit.r_county_qloo} with Qloo vs ~0.55 from county size alone.</li>
      <li><b>Down to the block.</b> Zoom into any neighbourhood and Qloo is queried live for ~150 m cells: which blocks lean redder or bluer than their county.</li>
    </ol>
    <h3>What we found, honestly</h3>
    <p>On 2020→2024, out-of-step counties tended to move the way Qloo flagged <i>inside</i> a state (${m.backtest.states_positive} of ${Object.keys(m.backtest.states).length} states). Statewide, the signal predicted nothing${N ? ` (r = ${N.state_r_controlled})` : ""}. So <b>polls decide who wins</b>. Scripts check the polls for skew and Undertow AI makes each final call. Qloo shows <i>where</i> the vote is moving.</p>
    <h3>Try it</h3>
    <ul class="try"><li>Click a state, or switch <b>Senate / Governor</b></li><li><b>2026 ↔ 2024</b> and <b>Polls ↔ Qloo</b>: drag the line across the map to compare</li><li><b>Undertow</b> layer: places out of step with their vote</li><li><b>Tools</b>: where our calls, the polls and the betting markets disagree</li><li>Scroll below the map for <b>charts</b>: polls vs taste, Qloo vs the real 2024 result, and the track record</li><li>Search a <b>ZIP code or city</b>, or zoom in anywhere, for a live block scan</li></ul>
    <div class="wfoot"><label><input type="checkbox" id="welcome-hide"${hide ? " checked" : ""}> Don't show this again</label><span><button class="tourbtn" id="welcome-tour">Take the 1-minute tour</button> <button class="go" id="welcome-go">Explore the map</button></span></div>`;
  $("#welcome-tour").onclick = () => { try { localStorage.setItem("undertow-welcome", $("#welcome-hide").checked ? "hide" : "show"); } catch {} $("#welcome").close(); const t = () => (map?.loaded() ? tour() : setTimeout(t, 300)); t(); };
  $("#welcome-go").onclick = () => { try { localStorage.setItem("undertow-welcome", $("#welcome-hide").checked ? "hide" : "show"); } catch {} $("#welcome").close(); };
  $("#welcome").showModal();
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
    <p>For each race the script averages recent general-election polls (weighted by recency and sample size, one poll per pollster, partisan-sponsored polls at 60%). It then checks two kinds of skew: whether Democratic- or Republican-sponsored polls differ from independent ones by 4+ points, and whether the race's shift since 2024 is far (9+ points) from the typical polled race (${fmtS(S.fc.national.median_poll_swing_since_2024)}). With no polls, the call is the 2024 result plus the typical shift. Undertow AI then reads only those numbers plus published ratings and makes the final judgement with a short reason. It cannot fetch anything or change the data, and an answer more than 8 points from the script's call is rejected.</p>
    <h3>4. Down to the block</h3>
    <p>States → counties → Qloo's ~5 km cells → a live scan at ~150 m when you zoom into a neighbourhood. Below the county, a cell shows its county's result shifted by how its tastes differ from its neighbours'. That is relative, not a separate poll.</p>
    <h3>The tastes</h3>
    <table><tr><th>Taste</th><th>Pulls</th><th>Strength</th><th>Same direction in</th></tr>${ents.map(([n, e]) => `<tr><td>${esc(n)}</td><td class="${e.lean}">${e.lean}</td><td>${Math.abs(e.partial_r).toFixed(2)}</td><td>${pct(e.states_consistent)} of states</td></tr>`).join("")}</table>
    <h3>Data</h3><p class="note">Qloo Insights API (hackathon endpoint: heatmaps, search). 2020 and 2024 county presidential results: github.com/tonmcg/US_County_Level_Election_Results_08-24. Polls: Wikipedia general-election polling tables. County shapes: us-atlas. ZIP and city search: GeoNames US postal codes (CC BY 4.0). Market odds in Tools (comparison only): Polymarket. Basemap: OpenFreeMap / OpenStreetMap.</p>`;
  $("#how").showModal();
}

document.querySelectorAll(".mapbar .seg button").forEach((b) => (b.onclick = () => {
  if (S.cmp && S.cmpKind === "q24" && b.dataset.mode !== "forecast") toggleCompare("q24");
  document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-checked", x === b));
  S.mode = b.dataset.mode; if (map) recolor();
}));

document.querySelectorAll(".office button").forEach((b) => (b.onclick = () => setOffice(b.dataset.office)));
$("#tools-btn").onclick = () => tools();
$("#about-btn").onclick = () => welcome(true);
document.querySelectorAll(".cmp").forEach((b) => (b.onclick = () => map && toggleCompare(b.dataset.cmp)));
initSwipeDrag();
initSearch();

load().then(() => {
  tally(); home(); welcome(false);
  setTimeout(() => typeof renderCharts === "function" && renderCharts(), 0);
  try { initMap(); } catch (e) { map = null; $("#map").innerHTML = `<p class="note" style="padding:60px 20px">The map needs WebGL, which this browser has turned off. The race list and calls still work.</p>`; }
}).catch((e) => { $("#panel-body").innerHTML = `<p>Could not load the forecast: ${esc(e.message)}</p>`; });
