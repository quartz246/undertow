/* Undertow story mode: a scroll-driven, newspaper-style walkthrough over the full-screen map.
   Text steps scroll on the left; as each reaches the middle of the screen the map eases to its scene,
   layers cross-fade, callouts draw in, and comparison sliders sweep on their own. Uses app.js state. */
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const gtag = (v) => `<span class="pty ${v > 0 ? "d" : "r"}">${Math.abs(v).toFixed(0)} pts ${v > 0 ? "bluer" : "redder"}</span>`; // taste-vs-vote gap
const ptag = (m) => `<span class="pty ${m > 0 ? "d" : "r"}">${fmtM(m)}</span>`;
const ST = { on: false, active: -1, callouts: [], sweep: null, sweepT: null, io: null };
function stopSweep() { cancelAnimationFrame(ST.sweep); clearTimeout(ST.sweepT); }

function fly(opts) { // cinematic camera move
  if (reduceMotion()) map.jumpTo(opts);
  else map.flyTo({ ...opts, duration: opts.duration ?? 2600, curve: 1.35, speed: 0.6, essential: true, easing: ease });
}
function fitTo(geom, padding, maxZoom) {
  const zero = { top: 0, bottom: 0, left: 0, right: 0 };
  map.setPadding(zero); // camera maths below assumes no persistent padding
  const cam = map.cameraForBounds(bbox(geom.geometry || geom), { padding, maxZoom });
  fly({ center: cam.center, zoom: cam.zoom, padding: zero });
}
function storyPad() { // keep scenes clear of the text column on wide screens
  const w = window.innerWidth; return w > 900 ? { top: 70, bottom: 70, left: Math.min(520, w * 0.42), right: 70 } : { top: 60, bottom: Math.round(window.innerHeight * 0.45), left: 30, right: 30 };
}
/* Cross-fades. Data-driven colours can't be animated by MapLibre, so the old picture is copied into the "-b"
   layers, the new picture is drawn underneath at zero opacity, and constant opacities are tweened between them. */
const FADE = 900;
const targets = (z) => (z < 4.8 ? { "states-fill": 0.9, "counties-fill": 0 } : { "states-fill": 0, "counties-fill": z > 10 ? 0.22 : 0.82 });
function setOp(layer, v, ms) { map.setPaintProperty(layer, "fill-opacity-transition", { duration: ms, delay: 0 }); map.setPaintProperty(layer, "fill-opacity", v); }
function applyTargets(z, ms = 1100) { const T = targets(z); ST.op = T; for (const l in T) setOp(l, T[l], reduceMotion() ? 0 : ms); }
const snap = (fc) => ({ type: "FeatureCollection", features: fc.features.map((f) => ({ type: "Feature", geometry: f.geometry, properties: { v: f.properties.v } })) });
function crossfade(fn, z) {
  const T = targets(z);
  if (reduceMotion()) { fn(); applyTargets(z, 0); return; }
  const old = ST.op || T;
  map.getSource("states-b").setData(snap(S.geo.st)); map.getSource("counties-b").setData(snap(S.geo.co));
  map.setPaintProperty("states-fill-b", "fill-color", map.getPaintProperty("states-fill", "fill-color"));
  map.setPaintProperty("counties-fill-b", "fill-color", map.getPaintProperty("counties-fill", "fill-color"));
  setOp("states-fill-b", old["states-fill"], 0); setOp("counties-fill-b", old["counties-fill"], 0);
  setOp("states-fill", 0, 0); setOp("counties-fill", 0, 0);
  fn(); // the main layers now hold the new picture, invisible
  ST.op = T;
  setTimeout(() => { // give the new data a moment to reach the map, then fade old out and new in together
    setOp("states-fill", T["states-fill"], FADE); setOp("counties-fill", T["counties-fill"], FADE);
    setOp("states-fill-b", 0, FADE); setOp("counties-fill-b", 0, FADE);
  }, 120);
}
function clearCallouts() { // fade out, then remove
  const gone = ST.callouts; ST.callouts = [];
  gone.forEach((m) => m.getElement().classList.add("out")); setTimeout(() => gone.forEach((m) => m.remove()), 320);
}
function callout(lngLat, html, side = "right", delay = 0, down = false) {
  const el = document.createElement("div"); el.className = `callout ${side}${down ? " down" : ""}`; el.style.animationDelay = `${delay}ms`;
  el.innerHTML = `<i class="cdot"></i><i class="cline"></i><div class="clab">${html}</div>`;
  ST.callouts.push(new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat(lngLat).addTo(map));
}
function centroid(feat) { const b = bbox(feat.geometry); return [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2]; }
const stateFeat = (name) => S.geo.st.features.find((f) => f.properties.name === name);
function sweep(from, to, ms = 2600, delay = 0) { // auto-move the comparison handle (any touch on the handle stops it)
  stopSweep();
  if (delay) { ST.sweepT = setTimeout(() => sweep(from, to, ms), delay); return; }
  const w = document.getElementById("map").clientWidth;
  if (reduceMotion()) { setSwipe(w * to); return; }
  const t0 = performance.now();
  const step = (t) => { const k = Math.min(1, (t - t0) / ms); setSwipe(w * (from + (to - from) * ease(k))); if (k < 1) ST.sweep = requestAnimationFrame(step); };
  ST.sweep = requestAnimationFrame(step);
}
// where an automatic sweep starts and stops: clear of the text card on wide screens
const sweepRange = () => (window.innerWidth > 900 ? [0.93, 0.56] : [0.9, 0.3]);
function scene(mode, cmp, z) { // move the map to a layer + comparison state; cross-fade whenever the picture changes
  const want = cmp || null;
  const modeChange = want === "q24" ? S.mode !== "q24" : mode !== S.mode;
  const cmpChange = want ? !(S.cmp && S.cmpKind === want) : !!S.cmp;
  if (!modeChange && !cmpChange) { applyTargets(z); return; }
  crossfade(() => {
    if (S.cmp && S.cmpKind !== want) toggleCompare(S.cmpKind); // fades the comparison out
    if (want === "q24") { if (!S.cmp) toggleCompare("q24", sweepRange()[0]); return; }
    if (mode !== S.mode) setMode(mode);
    if (want && !S.cmp) toggleCompare(want, sweepRange()[0]);
  }, z);
}

function storySteps() {
  if (S.office !== "senate") setOffice("senate");
  const fc = S.fc, n = { D: 0, R: 0, I: 0 }; for (const r of fc.races) { const p = final(r).winner_party; n[p in n ? p : "I"]++; }
  const U = S.qn?.state_undertow || {}, us = Object.entries(U).sort((a, b) => b[1] - a[1]);
  const q24 = Object.entries(S.qn?.states || {}).filter(([k]) => k !== "District of Columbia" && S.states[k]);
  const right = q24.filter(([k, q]) => (q > 0) === (S.states[k].m24 > 0)).length;
  const dis = fc.races.map((r) => ({ r, f: final(r).margin_d, q: qlooState(r.state) })).filter((x) => x.q != null)
    .sort((a, b) => ((b.q > 0) !== (b.f > 0)) - ((a.q > 0) !== (a.f > 0)) || Math.abs(b.q - b.f) - Math.abs(a.q - a.f))[0];
  const close = [...fc.races].sort((a, b) => Math.abs(final(a).margin_d) - Math.abs(final(b).margin_d)).slice(0, 4);
  const md = S.counties["12086"], N = S.natbt, bt = S.model.backtest;
  const drill = (() => { // the biggest county in the closest race
    const r = close[0]; if (!r) return null;
    const best = Object.entries(S.counties).filter(([, c]) => c.state === r.state).sort((a, b) => b[1].votes - a[1].votes)[0];
    if (!best) return null;
    return { r, f: best[0], c: best[1], top: (best[1].drivers || []).slice(0, 3).map(([n]) => n) };
  })();
  const dSeats = n.D + HOLD.D, rSeats = n.R + HOLD.R, P24 = S.p24;
  // the state where the 2020-trained taste model best foresaw which counties would move in 2024 (and that has a race)
  const showcase = Object.entries(bt.states || {}).filter(([s_, v]) => v.n >= 40 && S.raceBy[S.nameToFips[s_]] && S.states[s_]?.out_of_step_d?.length).sort((a, b) => b[1].r - a[1].r)[0];
  const flagged = fc.races.filter((r) => { const q = qlooState(r.state), f = final(r).margin_d; return q != null && (q > 0) !== (f > 0); });
  const C24 = P24?.calls, R24 = P24?.rows || {};
  const caught = (C24?.qloo_caught || []).filter((s_) => R24[s_]);
  const gapRaces = fc.races.map((r) => ({ r, f: final(r).margin_d, q: qlooState(r.state) })).filter((x) => x.q != null && (x.q > 0) === (x.f > 0))
    .sort((a, b) => Math.abs(b.q - b.f) - Math.abs(a.q - a.f)).slice(0, 2);
  const usView = () => fly({ center: [-96.5, 38.4], zoom: window.innerWidth > 900 ? 3.4 : 2.6, pitch: 0, bearing: 0, padding: storyPad() });
  return [
    { k: "Taste as a map of politics", h: "What people watch, read and buy nearly redraws the 2024 map",
      p: `Qloo tracks the tastes of every corner of America: the shows, podcasts, music, brands and films people love. Feed a model nothing but those tastes, from <i>Duck Dynasty</i> and Dan Bongino to Beyoncé and <i>Succession</i>, and it redraws the 2024 electoral map: the right winner in <b>${right} of ${q24.length} states</b>, each one predicted by a model that never saw that state's results. Left of the line: the map tastes predict. Right: the real result.`,
      go: () => { scene("q24", "q24", 3.4); usView(); const [a, b] = sweepRange(); sweep(a, b, 3400, 2200); } },
    caught.length ? { k: "Where the tastes beat the polls", h: `The polls missed ${caught.join(" and ")}. The tastes did not.`,
      p: `In 2024 the final polls had Harris ahead in ${caught.map((s_) => `${s_} (${ptag(R24[s_].poll)})`).join(" and ")}. Trump won both. A taste model trained only on <b>2020</b>, and nudged by the polls' national mood, called both for Trump. It wasn't perfect: it missed ${C24.qloo.wrong.filter((s_) => !caught.includes(s_)).slice(0, 2).join(" and ")}. But the two read the close states differently, and <b>half polls, half tastes would have called ${C24.blend.close_right} of ${C24.n_close}</b> of 2024's closest states, one more than the polls alone.`,
      go: () => { scene("r24", null, 5); fly({ center: [-86.6, 44.2], zoom: window.innerWidth > 900 ? 5.1 : 4.3, padding: storyPad() });
        setTimeout(() => caught.forEach((s_, i) => { const f = stateFeat(s_), row = R24[s_]; if (f) callout(centroid(f), `<b>${esc(s_)} 2024</b><span>Polls ${fmtM(row.poll)} · Tastes ${fmtM(row.poll + row.qgap)}</span><span>Result ${fmtM(row.actual)}</span>`, i ? "left" : "right", i * 450); }), 2400); } } : null,
    showcase ? { k: "It saw the swing coming", h: `Inside ${showcase[0]}, the tastes knew which way places would move`,
      p: `We trained the taste model on the <b>2020</b> vote, then flagged counties whose tastes didn't match it. In 2024 those counties really did move the way their tastes pointed, in <b>${N ? N.within_state_positive : bt.states_positive} of ${N ? N.within_state_n : Object.keys(bt.states).length} states</b>. ${esc(showcase[0])} was one of the clearest: the flagged counties moved the flagged way ${pct(showcase[1].hit)} of the time. Blue counties here have tastes bluer than their vote; red, redder.`,
      go: () => { scene("undertow", null, 6); const f = stateFeat(showcase[0]); if (f) fitTo(f, storyPad(), 6.6);
        setTimeout(() => { const st = S.states[showcase[0]]; [[st.out_of_step_d[0], "right"], [st.out_of_step_r[0], "left"]].forEach(([c, side], i) => { if (!c) return; const cf = S.geo.co.features.find((x) => x.properties.fips === c[0]); if (cf) callout(centroid(cf), `<b>${esc(c[1])}</b><span>Voted ${fmtM(c[4])} · Tastes ${fmtM(c[3])}</span>`, side, i * 400); }); }, 2600); } } : null,
    md ? { k: "Miami-Dade", h: "The vote moved right. The tastes did not.",
      p: `Miami-Dade County voted ${ptag(md.m24)} for president in 2024, a historic swing. Its tastes still look like a place that votes ${ptag(md.pred)}. Heavily Hispanic counties in Texas's Rio Grande Valley show the same gap. Either the 2024 shift is fragile, or culture lags behind the ballot box. Nov. 3 is the first test.`,
      go: () => { scene("undertow", null, 8.6); const cf = S.geo.co.features.find((x) => x.properties.fips === "12086"); if (cf) fitTo(cf, storyPad(), 8.6);
        setTimeout(() => callout([-80.21, 25.77], `<b>Miami-Dade</b><span>Voted ${fmtM(md.m24)} · Tastes ${fmtM(md.pred)}</span>`, "right"), 2400); } } : null,
    { k: "The undertow", h: "Whole states whose culture and vote part ways",
      p: `Add up the counties and some states' tastes look bluer than they voted in 2024, led by ${us.slice(0, 2).map(([s_, v]) => `${s_} (${gtag(v)})`).join(" and ")}. Others look redder, led by ${us.slice(-2).reverse().map(([s_, v]) => `${s_} (${gtag(v)})`).join(" and ")}. At this scale the undertow is a clue, not a verdict: statewide, it did not foretell 2024's moves.`,
      go: () => { scene("undertow", null, 3.4); usView();
        setTimeout(() => { [...us.slice(0, 1), ...us.slice(-1)].forEach(([s_, v], i) => { const f = stateFeat(s_); if (f) callout(centroid(f), `<b>${esc(s_)}</b><span>Tastes ${v > 0 ? "bluer" : "redder"} than the vote by ${Math.abs(v).toFixed(0)} pts</span>`, i ? "left" : "right", i * 350); }); }, 1800); } },
    { k: "2026", h: "The polls missed in 2024. Here is every race through both lenses.",
      p: `${P24 ? `In 2024 the polls leaned too Democratic in <b>${P24.states_polls_too_democratic} of ${P24.n_states}</b> states, by ${Math.abs(P24.avg_poll_error).toFixed(1)} points on average. ` : ""}So every 2026 race is set beside what its tastes say. This map shows only where they disagree: strong colour where the culture picks a different winner, light where the two are far apart. ${flagged.length ? `In ${flagged.map((r) => r.state).join(" and ")}, the tastes pick a different winner.` : ""} Undertow AI's projection: <b>${dSeats} Democratic seats to ${rSeats} Republican</b>${n.I ? ` and ${n.I} independent` : ""}.`,
      go: () => { scene("disagree", null, 3.4); home(); usView();
        setTimeout(() => [...flagged.map((r) => ({ r, tag: "Different winner" })), ...gapRaces.map((x) => ({ r: x.r, tag: `${Math.abs(x.q - x.f).toFixed(0)} pts apart` }))].slice(0, 3).forEach(({ r, tag }, i) => {
          const f = stateFeat(r.state), cr = cread(r);
          if (f) callout(centroid(f), `<b>${esc(r.state)} · ${tag}</b><span>Polls ${fmtM(final(r).margin_d)} · Tastes ${fmtM(qlooState(r.state))}</span>${cr ? `<span class="cr">${esc(cr.headline)}</span>` : ""}`, i % 2 ? "left" : "right", i * 450, i === 2);
        }), 1800); } },
    dis ? { k: dis.r.state, h: `In ${dis.r.state}, the polls and the culture disagree`,
      p: `The polls put the race at ${ptag(dis.f)}${dis.r.main ? `, ${esc(dis.r.main.d.name)} against ${esc(dis.r.main.r.name)}` : ""}. The state's tastes, adjusted for the national mood, point to ${ptag(dis.q)}${(dis.q > 0) !== (dis.f > 0) ? ", a different winner" : ""}.${cread(dis.r) ? ` Undertow AI's cultural read: <i>"${esc(cread(dis.r).headline)}."</i> Watch ${cread(dis.r).watch.map((w) => esc(w.place)).join(", ")}.` : ""} Left of the line is the polling forecast, right is the forecast from tastes alone.`,
      go: () => { scene("forecast", "qloo", 4.4); openRace(dis.r.id, false); closePanel(); const f = stateFeat(dis.r.state); if (f) fitTo(f, storyPad(), 4.4); { const [a, b] = sweepRange(); sweep(a, b, 3000, 2800); }
        setTimeout(() => { if (f) callout(centroid(f), `<b>${esc(dis.r.state)}</b><span>Polls ${fmtM(dis.f)} · Tastes ${fmtM(dis.q)}</span>`, "left"); }, 2600); } } : null,
    drill ? { k: `Inside ${drill.r.state}`, h: `${drill.c.name}: one county in the closest race`,
      p: `${esc(drill.r.state)} is the tightest race on the board (${ptag(final(drill.r).margin_d)}). Its biggest county, ${esc(drill.c.name)}, voted ${ptag(drill.c.m24)} in 2024; our 2026 estimate is ${ptag(countyEst(drill.f))}. Qloo reads who lives here from the audiences of the local tastes: ${esc(profile(drill.f, drill.r.state) || "about average")}, with ${drill.top.map((t) => `<i>${esc(t)}</i>`).join(", ")} pulling hardest.`,
      go: () => { scene("forecast", null, 9); openRace(drill.r.id, false); closePanel(); const cf = S.geo.co.features.find((x) => x.properties.fips === drill.f); if (cf) fitTo(cf, storyPad(), 9.4);
        setTimeout(() => callout(centroid(cf), `<b>${esc(drill.c.name)}</b><span>2024 ${fmtM(drill.c.m24)} · 2026 est. ${fmtM(countyEst(drill.f))}</span><span>${esc(profile(drill.f, drill.r.state) || "")}</span>`, "right"), 2600); } } : null,
    { k: "Down to the block", h: "A forecast you can walk through",
      p: "Zoom into a neighborhood, or search a ZIP code, and Undertow queries Qloo live for cells about 150 meters across. Each block is shaded by whether its tastes run bluer or redder than the rest of its county. This is downtown Detroit, in Michigan's Senate race.",
      go: () => { scene("forecast", null, 13); fly({ center: [-83.0458, 42.3314], zoom: 13, pitch: reduceMotion() ? 0 : 40, bearing: reduceMotion() ? 0 : -18, padding: storyPad(), duration: 3200 });
        setTimeout(() => callout([-83.0458, 42.3314], `<b>Downtown Detroit</b><span>Live Qloo scan · ~150 m cells</span>`, "right"), 3400); } },
    S.stratEx ? { k: "From map to media plan", h: "An AI strategist that spends a campaign's last dollars, ZIP by ZIP",
      p: `Undertow's Campaign Strategist is an agent. Asked how ${esc(S.stratEx.plan.candidate)} should spend ${fmtUSD(S.stratEx.plan.budget)} in the final days, Undertow AI read the race, ranked Iowa's counties, ran live Qloo scans across ${Object.keys(S.stratEx.plan.counties || {}).length} of them, asked Qloo what each target area watches and listens to, and split the budget across ${S.stratEx.plan.rows.length} ZIP codes: <i>"${esc(S.stratEx.plan.headline)}."</i> No voter files, no personal data. Every ZIP and channel it names is checked against its own tool results.`,
      go: () => { scene("forecast", null, 7.5); stratLayers(); const rows = S.stratEx.plan.rows;
        map.getSource("strat").setData({ type: "FeatureCollection", features: rows.map((z) => ({ type: "Feature", properties: { zip: z.zip, place: z.place, county: z.county, budget: z.budget, goal: z.goal, segment: z.segment, lean: z.lean_toward_you }, geometry: { type: "Point", coordinates: [z.lon, z.lat] } })) });
        map.setFilter("strat-county", ["in", ["get", "fips"], ["literal", Object.keys(S.stratEx.plan.counties || {})]]);
        const xs = rows.map((z) => z.lon), ys = rows.map((z) => z.lat); const zero = { top: 0, bottom: 0, left: 0, right: 0 }; map.setPadding(zero);
        const cam = map.cameraForBounds([[Math.min(...xs) - 0.4, Math.min(...ys) - 0.3], [Math.max(...xs) + 0.4, Math.max(...ys) + 0.3]], { padding: storyPad(), maxZoom: 8 }); fly({ center: cam.center, zoom: cam.zoom, padding: zero });
        setTimeout(() => { const segs = S.stratEx.plan.segments; segs.slice(0, 2).forEach((sg, i) => { const r = rows.filter((x) => x.segment === sg.name).sort((a, b) => b.budget - a.budget)[0]; if (r) callout([r.lon, r.lat], `<b>${esc(sg.name)}</b><span>${fmtUSD(rows.filter((x) => x.segment === sg.name).reduce((a, x) => a + x.budget, 0))} · ${sg.goal === "turnout" ? "turnout" : "persuasion"}</span><span class="cr">${esc(sg.channels.slice(0, 3).join(" · "))}</span>`, i ? "left" : "right", i * 450); }); }, 2600); } } : null,
    { k: "The scorecard", h: "What the tastes got right, and what to watch on Nov. 3",
      p: `Tastes alone drew the 2024 map (${right} of ${q24.length} states), foresaw which counties would move inside ${N ? `${N.within_state_positive} of ${N.within_state_n}` : "most"} states, and caught ${caught.length ? caught.join(" and ") : "swing states"} where the polls failed. Blended half and half with the polls, they called ${C24 ? `${C24.blend.close_right} of ${C24.n_close}` : "more"} of 2024's close states. Their weak spot: on margins the polls were closer (${C24 ? `${C24.polls.avg_miss} vs ${C24.qloo.avg_miss} pts` : "smaller misses"}), so our headline call keeps the polls and shows the blend beside it. Watch ${flagged.length ? flagged.map((r) => r.state).join(", ") : "the closest races"} and counties like Miami-Dade: if they break the way their tastes point, the undertow was real.`,
      go: () => { scene("forecast", null, 3.4); usView(); } },
  ].filter(Boolean);
}

function activate(i, steps) {
  if (i === ST.active) return; ST.active = i;
  if (map.getSource("strat")) { map.getSource("strat").setData({ type: "FeatureCollection", features: [] }); map.setFilter("strat-county", ["in", ["get", "fips"], ["literal", []]]); }
  stopSweep(); clearCallouts();
  document.querySelectorAll(".story-step").forEach((s, k) => s.classList.toggle("on", k === i));
  if (i >= 0 && steps[i]) steps[i].go();
}

function story() {
  if (!map?.loaded()) return;
  if ($("#welcome").open) $("#welcome").close();
  const steps = storySteps(), ov = $("#story");
  const d = new Date(S.fc.locked_at || S.fc.generated_at);
  ov.querySelector(".story-scroll").innerHTML = `
    <header class="story-hero"><div class="story-card hero">
      <div class="kicker">Election 2026 · Data</div>
      <h1>The Polls Missed in 2024. Here Is What America's Tastes Say About 2026.</h1>
      <p class="dek">Qloo knows what ${S.model.n_counties.toLocaleString()} counties watch, read and buy. We used it to redraw the electoral map from culture alone, find the places quietly drifting from their vote, and hold every 2026 race up against it, down to the block.</p>
      <p class="byline">By <b>Undertow AI</b> · Powered by <b>Qloo</b> · Data: Qloo, public polls · ${esc(d.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" }))}</p>
      <div class="scrollcue" aria-hidden="true">Scroll<i></i></div>
    </div></header>
    ${steps.map((s, i) => `<section class="story-step" data-i="${i}"><div class="story-card"><div class="kicker">${esc(s.k)}</div><h2>${esc(s.h)}</h2><p>${s.p}</p></div></section>`).join("")}
    <footer class="story-end"><div class="story-card"><h2>Now explore it yourself</h2><p>Every race, every county, and a live block-level scan anywhere in the country.</p>
      <div class="story-cta"><button class="go" id="story-strat">Try the Campaign Strategist</button><button class="ghost" id="story-map">Explore the map</button><button class="ghost" id="story-charts">See the charts</button></div></div></footer>`;
  document.body.classList.add("story-on"); ov.hidden = false; ST.on = true; ST.active = -1;
  ov.appendChild($("#swipe"));
  setTimeout(() => map.resize(), 50);
  ST.saved = ST.saved || { "states-fill": map.getPaintProperty("states-fill", "fill-opacity"), "counties-fill": map.getPaintProperty("counties-fill", "fill-opacity") };
  if (S.cmp) toggleCompare(S.cmpKind);
  if (S.mode !== "forecast") setMode("forecast");
  recolor(); applyTargets(3.6, 600);
  // the hero shows the national forecast
  setTimeout(() => fly({ center: [-96.5, 38.4], zoom: window.innerWidth > 900 ? 3.6 : 2.6, padding: storyPad(), duration: 1200 }), 80);
  const sc = ov.querySelector(".story-scroll"); sc.scrollTop = 0;
  ST.io?.disconnect();
  ST.io = new IntersectionObserver((ents) => { for (const e of ents) if (e.isIntersecting) activate(+e.target.dataset.i, steps); },
    { root: sc, rootMargin: "-48% 0px -48% 0px", threshold: 0 });
  ov.querySelectorAll(".story-step").forEach((s) => ST.io.observe(s));
  const bar = ov.querySelector(".story-progress i");
  sc.onscroll = () => { bar.style.transform = `scaleX(${Math.min(1, sc.scrollTop / Math.max(1, sc.scrollHeight - sc.clientHeight))})`;
    if (sc.scrollTop < sc.clientHeight * 0.4 && ST.active !== -1) { activate(-1, steps); scene("forecast", null, 3.6); fly({ center: [-96.5, 38.4], zoom: window.innerWidth > 900 ? 3.6 : 2.6, pitch: 0, bearing: 0, padding: storyPad() }); } };
  $("#story-map").onclick = () => endStory();
  $("#story-strat").onclick = () => { endStory(); setTimeout(() => strategist(), 400); };
  $("#story-charts").onclick = () => { endStory(); setTimeout(() => $("#charts").scrollIntoView({ behavior: "smooth" }), 300); };
  ov.querySelector(".story-close").onclick = () => endStory();
  document.addEventListener("keydown", storyKeys);
  ov.querySelector(".story-close").focus();
}
function storyKeys(e) { if (e.key === "Escape" && ST.on) endStory(); }
function endStory() {
  if (!ST.on) return; ST.on = false;
  ST.io?.disconnect(); stopSweep(); clearCallouts();
  if (map.getSource("strat")) { map.getSource("strat").setData({ type: "FeatureCollection", features: [] }); map.setFilter("strat-county", ["in", ["get", "fips"], ["literal", []]]); }
  document.removeEventListener("keydown", storyKeys);
  $(".mapwrap").insertBefore($("#swipe"), $("#map24").nextSibling);
  $("#story").hidden = true; document.body.classList.remove("story-on");
  if (S.cmp) toggleCompare(S.cmpKind);
  setMode("forecast"); recolor(); home();
  for (const l in ST.saved) setOp(l, ST.saved[l], 600); setOp("states-fill-b", 0, 0); setOp("counties-fill-b", 0, 0); ST.op = null;
  setTimeout(() => { map.resize(); map.flyTo({ center: [-96.5, 38.6], zoom: 3.6, pitch: 0, bearing: 0, padding: 0, duration: 1200 }); }, 60);
}
