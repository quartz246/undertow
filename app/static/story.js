/* Undertow story mode: a scroll-driven, newspaper-style walkthrough over the full-screen map.
   Text steps scroll on the left; as each reaches the middle of the screen the map eases to its scene,
   layers cross-fade, callouts draw in, and comparison sliders sweep on their own. Uses app.js state. */
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const ptag = (m) => `<span class="pty ${m > 0 ? "d" : "r"}">${fmtM(m)}</span>`;
const ST = { on: false, active: -1, callouts: [], sweep: null, io: null };

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
function crossfade(fn) { // fade the data layers out, change them, fade back in
  const L = ["states-fill", "counties-fill", "cells-fill", "live-fill"];
  if (reduceMotion()) return fn();
  const saved = L.map((l) => map.getPaintProperty(l, "fill-opacity"));
  for (const l of L) map.setPaintProperty(l, "fill-opacity", 0);
  setTimeout(() => { fn(); recolor(); L.slice(2).forEach((l, i) => map.setPaintProperty(l, "fill-opacity", saved[i + 2])); }, 420);
}
function clearCallouts() { ST.callouts.forEach((m) => m.remove()); ST.callouts = []; }
function callout(lngLat, html, side = "right", delay = 0) {
  const el = document.createElement("div"); el.className = `callout ${side}`; el.style.animationDelay = `${delay}ms`;
  el.innerHTML = `<i class="cdot"></i><i class="cline"></i><div class="clab">${html}</div>`;
  ST.callouts.push(new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat(lngLat).addTo(map));
}
function centroid(feat) { const b = bbox(feat.geometry); return [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2]; }
const stateFeat = (name) => S.geo.st.features.find((f) => f.properties.name === name);
function sweep(from, to, ms = 2600) { // auto-move the comparison handle
  cancelAnimationFrame(ST.sweep);
  const w = document.getElementById("map").clientWidth;
  if (reduceMotion()) { setSwipe(w * to); return; }
  const t0 = performance.now();
  const step = (t) => { const k = Math.min(1, (t - t0) / ms); setSwipe(w * (from + (to - from) * ease(k))); if (k < 1) ST.sweep = requestAnimationFrame(step); };
  ST.sweep = requestAnimationFrame(step);
}
function scene(mode, cmp) { // put the map in a given layer + comparison state
  const want = cmp || null;
  if (S.cmp && S.cmpKind !== want) toggleCompare(S.cmpKind);
  if (mode !== S.mode && mode !== "q24") crossfade(() => setMode(mode));
  if (want && !S.cmp) toggleCompare(want);
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
  const dSeats = n.D + HOLD.D, rSeats = n.R + HOLD.R;
  return [
    { k: "The forecast", h: `${dSeats >= 51 ? "Democrats are on course to take the Senate" : "Republicans are on course to hold the Senate"}`,
      p: `Our model reads every public general-election poll for the ${fc.races.length} Senate races on Nov. 3 and projects <b>${dSeats} Democratic seats to ${rSeats} Republican</b>${n.I ? ` and ${n.I} independent` : ""}. The closest contests: ${close.map((r) => `${r.state} (${fmtM(final(r).margin_d)})`).join(", ")}.`,
      go: () => { scene("forecast"); home(); fly({ center: [-96.5, 38.4], zoom: window.innerWidth > 900 ? 3.4 : 2.6, padding: storyPad() }); } },
    { k: "Taste as a map of politics", h: "What people watch, read and buy nearly redraws the 2024 map",
      p: `Using nothing but Qloo's data on the tastes of each place, from <i>Duck Dynasty</i> and Dan Bongino to Beyoncé and <i>Succession</i>, a model that never saw a state's results picked the right 2024 winner in <b>${right} of ${q24.length} states</b>. Left of the line: the map tastes predict. Right: the real result.`,
      go: () => { S.mode = "q24"; if (S.cmp && S.cmpKind !== "q24") toggleCompare(S.cmpKind); if (!S.cmp) toggleCompare("q24"); fly({ center: [-96.5, 38.4], zoom: window.innerWidth > 900 ? 3.4 : 2.6, padding: storyPad() }); setTimeout(() => sweep(0.15, 0.8, 3200), 900); } },
    { k: "The undertow", h: "Where the culture and the vote part ways",
      p: `Some states' tastes look bluer than they voted in 2024, led by ${us.slice(0, 2).map(([s_, v]) => `${s_} ${ptag(v)}`).join(" and ")}. Others look redder, led by ${us.slice(-2).reverse().map(([s_, v]) => `${s_} ${ptag(v)}`).join(" and ")}. We call that gap the undertow. It is a clue, not a verdict: tested on 2020 to 2024, the statewide gap did not predict which way states moved.`,
      go: () => { scene("undertow"); fly({ center: [-96.5, 38.4], zoom: window.innerWidth > 900 ? 3.4 : 2.6, padding: storyPad() });
        setTimeout(() => { [...us.slice(0, 1), ...us.slice(-1)].forEach(([s_, v], i) => { const f = stateFeat(s_); if (f) callout(centroid(f), `<b>${esc(s_)}</b><span>Tastes ${v > 0 ? "bluer" : "redder"} than the vote by ${Math.abs(v).toFixed(0)} pts</span>`, i ? "left" : "right", i * 350); }); }, 1800); } },
    md ? { k: "Miami-Dade", h: "The vote moved right. The tastes did not.",
      p: `Miami-Dade County voted ${ptag(md.m24)} for president in 2024, a historic swing. Its tastes still look like a place that votes ${ptag(md.pred)}. Heavily Hispanic counties in Texas's Rio Grande Valley show the same gap. Either the 2024 shift is fragile, or culture lags behind the ballot box.`,
      go: () => { scene("undertow"); const cf = S.geo.co.features.find((x) => x.properties.fips === "12086"); if (cf) fitTo(cf, storyPad(), 8.6);
        setTimeout(() => callout([-80.21, 25.77], `<b>Miami-Dade</b><span>Voted ${fmtM(md.m24)} · Tastes ${fmtM(md.pred)}</span>`, "right"), 2400); } } : null,
    dis ? { k: dis.r.state, h: `In ${dis.r.state}, the polls and the culture disagree`,
      p: `The polls put the race at ${ptag(dis.f)}${dis.r.main ? `, ${esc(dis.r.main.d.name)} against ${esc(dis.r.main.r.name)}` : ""}. The state's tastes, adjusted for the national mood, point to ${ptag(dis.q)}${(dis.q > 0) !== (dis.f > 0) ? ", a different winner" : ""}. We keep the polls' call. Left of the line is the polling forecast, right is the forecast from tastes alone.`,
      go: () => { scene("forecast", "qloo"); openRace(dis.r.id, false); const f = stateFeat(dis.r.state); if (f) fitTo(f, storyPad(), 6.6); setTimeout(() => sweep(0.85, 0.35, 2800), 1600);
        setTimeout(() => { if (f) callout(centroid(f), `<b>${esc(dis.r.state)}</b><span>Polls ${fmtM(dis.f)} · Tastes ${fmtM(dis.q)}</span>`, "right"); }, 2600); } } : null,
    { k: "Down to the block", h: "A forecast you can walk through",
      p: "Zoom into a neighborhood, or search a ZIP code, and Undertow queries Qloo live for cells about 150 meters across. Each block is shaded by whether its tastes run bluer or redder than the rest of its county. This is downtown Detroit, in Michigan's Senate race.",
      go: () => { scene("forecast"); fly({ center: [-83.0458, 42.3314], zoom: 13, pitch: reduceMotion() ? 0 : 40, bearing: reduceMotion() ? 0 : -18, padding: storyPad(), duration: 3200 });
        setTimeout(() => callout([-83.0458, 42.3314], `<b>Downtown Detroit</b><span>Live Qloo scan · ~150 m cells</span>`, "right"), 3400); } },
    { k: "What history says", h: "How far to trust the undertow",
      p: `We fit the taste model to 2020 and checked it against 2024. Inside states it helped: counties whose tastes ran bluer than their vote moved toward Democrats in ${N ? N.within_state_positive : bt.states_positive} of ${N ? N.within_state_n : Object.keys(bt.states).length} states, by fractions of a point. Statewide it did not (r = ${N ? N.state_r_controlled : "—"}). That is why polls make every call here, and Qloo shows where the vote is moving.`,
      go: () => { scene("forecast"); fly({ center: [-96.5, 38.4], zoom: window.innerWidth > 900 ? 3.4 : 2.6, pitch: 0, bearing: 0, padding: storyPad() }); } },
  ].filter(Boolean);
}

function activate(i, steps) {
  if (i === ST.active) return; ST.active = i;
  cancelAnimationFrame(ST.sweep); clearCallouts();
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
      <h1>The Polls Say One Thing. America's Tastes Say Another.</h1>
      <p class="dek">We compared every 2026 Senate poll with what ${S.model.n_counties.toLocaleString()} counties watch, read and buy. Here is where the two part ways, and what history says about trusting either.</p>
      <p class="byline">By <b>Undertow AI</b> · Data: Qloo, public polls · ${esc(d.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" }))}</p>
      <div class="scrollcue" aria-hidden="true">Scroll<i></i></div>
    </div></header>
    ${steps.map((s, i) => `<section class="story-step" data-i="${i}"><div class="story-card"><div class="kicker">${esc(s.k)}</div><h2>${esc(s.h)}</h2><p>${s.p}</p></div></section>`).join("")}
    <footer class="story-end"><div class="story-card"><h2>Now explore it yourself</h2><p>Every race, every county, and a live block-level scan anywhere in the country.</p>
      <div class="story-cta"><button class="go" id="story-map">Explore the map</button><button class="ghost" id="story-charts">See the charts</button></div></div></footer>`;
  document.body.classList.add("story-on"); ov.hidden = false; ST.on = true; ST.active = -1;
  setTimeout(() => map.resize(), 50);
  for (const l of ["states-fill", "counties-fill", "cells-fill", "live-fill"]) map.setPaintProperty(l, "fill-opacity-transition", { duration: 700, delay: 0 });
  // the hero shows the national forecast
  scene("forecast"); setTimeout(() => fly({ center: [-96.5, 38.4], zoom: window.innerWidth > 900 ? 3.6 : 2.6, padding: storyPad(), duration: 1200 }), 80);
  const sc = ov.querySelector(".story-scroll"); sc.scrollTop = 0;
  ST.io?.disconnect();
  ST.io = new IntersectionObserver((ents) => { for (const e of ents) if (e.isIntersecting) activate(+e.target.dataset.i, steps); },
    { root: sc, rootMargin: "-48% 0px -48% 0px", threshold: 0 });
  ov.querySelectorAll(".story-step").forEach((s) => ST.io.observe(s));
  const bar = ov.querySelector(".story-progress i");
  sc.onscroll = () => { bar.style.transform = `scaleX(${Math.min(1, sc.scrollTop / Math.max(1, sc.scrollHeight - sc.clientHeight))})`;
    if (sc.scrollTop < sc.clientHeight * 0.4 && ST.active !== -1) { activate(-1, steps); scene("forecast"); } };
  $("#story-map").onclick = () => endStory();
  $("#story-charts").onclick = () => { endStory(); setTimeout(() => $("#charts").scrollIntoView({ behavior: "smooth" }), 300); };
  ov.querySelector(".story-close").onclick = () => endStory();
  document.addEventListener("keydown", storyKeys);
  ov.querySelector(".story-close").focus();
}
function storyKeys(e) { if (e.key === "Escape" && ST.on) endStory(); }
function endStory() {
  if (!ST.on) return; ST.on = false;
  ST.io?.disconnect(); cancelAnimationFrame(ST.sweep); clearCallouts();
  document.removeEventListener("keydown", storyKeys);
  $("#story").hidden = true; document.body.classList.remove("story-on");
  if (S.cmp) toggleCompare(S.cmpKind);
  setMode("forecast"); recolor(); home();
  setTimeout(() => { map.resize(); map.flyTo({ center: [-96.5, 38.6], zoom: 3.6, pitch: 0, bearing: 0, padding: 0, duration: 1200 }); }, 60);
}
