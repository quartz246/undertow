/* Undertow charts (D3): polls vs Qloo this year, Qloo vs the real 2024 result, and the 2020→2024 track record.
   Reads the shared state `S` from app.js. Colours: party blue/red; polls amber, Qloo teal (validated pair). */
const C = { d: "#2160b8", r: "#c23a2f", poll: "#b8661a", qloo: "#0e8a7a", ink: "#1d1f24", muted: "#5d6270", grid: "#e6e2d9", surf: "#ffffff" };
const tipEl = () => document.getElementById("ctip");
function ctip(ev, html) {
  const t = tipEl(); t.innerHTML = html; t.hidden = false;
  const x = Math.min(ev.clientX + 14, window.innerWidth - t.offsetWidth - 10), y = ev.clientY + 14;
  t.style.left = x + "px"; t.style.top = y + window.scrollY + "px";
}
const chide = () => (tipEl().hidden = true);
const afmt = (m) => (m === 0 ? "Even" : (m > 0 ? "D+" : "R+") + Math.abs(m).toFixed(0)); // axis ticks
const mfmt = (m) => (m == null || isNaN(m) ? "—" : Math.abs(m) < 0.05 ? "Even" : (m > 0 ? "D+" : "R+") + Math.abs(m).toFixed(1));

function frame(sel, h, m = { t: 16, r: 18, b: 40, l: 48 }) {
  const el = document.querySelector(sel); el.innerHTML = "";
  const w = Math.max(300, el.clientWidth);
  const svg = d3.select(el).append("svg").attr("width", w).attr("height", h).attr("viewBox", `0 0 ${w} ${h}`).attr("role", "img");
  return { svg, w, h, m, iw: w - m.l - m.r, ih: h - m.t - m.b, g: svg.append("g").attr("transform", `translate(${m.l},${m.t})`) };
}
function axes(f, x, y, xl, yl, fmtX = afmt, fmtY = afmt) {
  const gx = f.g.append("g").attr("transform", `translate(0,${f.ih})`).call(d3.axisBottom(x).ticks(6).tickFormat(fmtX).tickSize(-f.ih));
  const gy = f.g.append("g").call(d3.axisLeft(y).ticks(6).tickFormat(fmtY).tickSize(-f.iw));
  for (const g of [gx, gy]) { g.select(".domain").remove(); g.selectAll("line").attr("stroke", C.grid); g.selectAll("text").attr("fill", C.muted).attr("font-size", 11); }
  f.g.append("text").attr("x", f.iw).attr("y", f.ih + 32).attr("text-anchor", "end").attr("fill", C.muted).attr("font-size", 12).text(xl);
  f.g.append("text").attr("x", -f.m.l + 4).attr("y", -6).attr("fill", C.muted).attr("font-size", 12).text(yl);
}
function quadrants(f, x, y) { // light party washes: both D top-right, both R bottom-left
  const [x0, x1] = x.domain(), [y0, y1] = y.domain();
  f.g.append("rect").attr("x", x(0)).attr("y", y(y1)).attr("width", x(x1) - x(0)).attr("height", y(0) - y(y1)).attr("fill", C.d).attr("opacity", 0.06);
  f.g.append("rect").attr("x", x(x0)).attr("y", y(0)).attr("width", x(0) - x(x0)).attr("height", y(y0) - y(0)).attr("fill", C.r).attr("opacity", 0.06);
}
function diag(f, x, y, lo, hi, label) {
  f.g.append("line").attr("x1", x(lo)).attr("y1", y(lo)).attr("x2", x(hi)).attr("y2", y(hi)).attr("stroke", C.muted).attr("stroke-width", 1).attr("stroke-dasharray", null).attr("opacity", 0.6);
  f.g.append("text").attr("x", x(hi) - 4).attr("y", y(hi) + 14).attr("text-anchor", "end").attr("fill", C.muted).attr("font-size", 11).text(label);
}

/* 1. This year: polls vs Qloo-only, as a dumbbell per race (sorted by the gap) */
function chartDumbbell() {
  const races = S.fc.races.map((r) => ({ r, poll: (r.verdict || r.script).margin_d, q: qlooState(r.state) })).filter((d) => d.q != null)
    .map((d) => ({ ...d, gap: d.q - d.poll, flip: (d.q > 0) !== (d.poll > 0) })).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  const rowH = 22, f = frame("#ch-dumb", races.length * rowH + 60, { t: 28, r: 24, b: 30, l: 112 });
  const ext = d3.extent(races.flatMap((d) => [d.poll, d.q])); const lim = Math.max(30, Math.ceil(Math.max(-ext[0], ext[1]) / 10) * 10);
  const x = d3.scaleLinear().domain([-lim, lim]).range([0, f.iw]), y = d3.scaleBand().domain(races.map((d) => d.r.id)).range([0, f.ih]).padding(0.3);
  const gx = f.g.append("g").attr("transform", `translate(0,${f.ih})`).call(d3.axisBottom(x).ticks(6).tickFormat(afmt).tickSize(-f.ih));
  gx.select(".domain").remove(); gx.selectAll("line").attr("stroke", C.grid); gx.selectAll("text").attr("fill", C.muted).attr("font-size", 11);
  f.g.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", 0).attr("y2", f.ih).attr("stroke", C.ink).attr("opacity", 0.5);
  const row = f.g.selectAll(".row").data(races).join("g").attr("transform", (d) => `translate(0,${y(d.r.id) + y.bandwidth() / 2})`);
  row.append("text").attr("x", -10).attr("dy", "0.32em").attr("text-anchor", "end").attr("font-size", 12).attr("font-weight", (d) => (d.flip ? 700 : 400)).attr("fill", C.ink).text((d) => d.r.state);
  row.append("line").attr("x1", (d) => x(d.poll)).attr("x2", (d) => x(d.q)).attr("stroke", C.muted).attr("stroke-width", 2).attr("opacity", 0.55);
  row.append("circle").attr("cx", (d) => x(d.poll)).attr("r", 5.5).attr("fill", C.poll).attr("stroke", C.surf).attr("stroke-width", 2);
  row.append("circle").attr("cx", (d) => x(d.q)).attr("r", 5.5).attr("fill", C.qloo).attr("stroke", C.surf).attr("stroke-width", 2);
  row.filter((d) => d.flip).append("text").attr("x", f.iw + 2).attr("dy", "0.32em").attr("text-anchor", "end").attr("font-size", 11).attr("fill", C.ink).text("different winner");
  row.append("rect").attr("x", 0).attr("y", -rowH / 2).attr("width", f.iw).attr("height", rowH).attr("fill", "transparent")
    .on("mousemove", (ev, d) => ctip(ev, `<b>${d.r.state}</b><br>Our call (polls): <b>${mfmt(d.poll)}</b><br>Qloo-only: <b>${mfmt(d.q)}</b><br>Gap ${d.gap > 0 ? "+" : ""}${d.gap.toFixed(1)} pts${d.flip ? "<br><b>Different winner</b>" : ""}`))
    .on("mouseleave", chide).on("click", (ev, d) => { openRace(d.r.id, true); document.getElementById("map").scrollIntoView({ behavior: "smooth" }); }).style("cursor", "pointer");
  const lg = f.svg.append("g").attr("transform", `translate(${f.m.l},12)`);
  [[C.poll, "Our call (polls)"], [C.qloo, "Qloo-only (tastes + national shift)"]].forEach(([c, t], i) => {
    const g = lg.append("g").attr("transform", `translate(${i * 150},0)`);
    g.append("circle").attr("r", 5).attr("cy", -4).attr("fill", c); g.append("text").attr("x", 10).attr("font-size", 12).attr("fill", C.ink).text(t);
  });
}

/* 2. Qloo vs the real 2024 result: states or counties */
function chart2024(level) {
  const f = frame("#ch-24", 380, { t: 20, r: 18, b: 44, l: 56 });
  const pts = level === "counties"
    ? Object.entries(S.qn.counties).map(([fips, q]) => ({ k: fips, name: `${S.counties[fips]?.name || fips}, ${S.counties[fips]?.state || ""}`, a: S.counties[fips]?.m24, q, v: S.counties[fips]?.votes || 1 })).filter((d) => d.a != null)
    : Object.entries(S.qn.states).filter(([n]) => n !== "District of Columbia").map(([n, q]) => ({ k: n, name: n, a: S.states[n]?.m24, q })).filter((d) => d.a != null);
  const lim = level === "counties" ? 80 : 50;
  const x = d3.scaleLinear().domain([-lim, lim]).range([0, f.iw]).clamp(true), y = d3.scaleLinear().domain([-lim, lim]).range([f.ih, 0]).clamp(true);
  quadrants(f, x, y); axes(f, x, y, "Actual 2024 presidential margin →", "Qloo expected (tastes only)"); diag(f, x, y, -lim, lim, "perfect match");
  const rs = level === "counties" ? d3.scaleSqrt().domain([0, d3.max(pts, (d) => d.v)]).range([1.2, 9]) : null;
  const dots = f.g.selectAll("circle.p").data(pts).join("circle").attr("class", "p").attr("cx", (d) => x(d.a)).attr("cy", (d) => y(d.q))
    .attr("r", (d) => (rs ? rs(d.v) : 5.5)).attr("fill", (d) => (d.a > 0 ? C.d : C.r)).attr("fill-opacity", level === "counties" ? 0.45 : 0.9)
    .attr("stroke", C.surf).attr("stroke-width", level === "counties" ? 0.6 : 2)
    .on("mousemove", (ev, d) => ctip(ev, `<b>${d.name}</b><br>Actual 2024: <b>${mfmt(d.a)}</b><br>Qloo expected: <b>${mfmt(d.q)}</b><br>Miss: ${(d.q - d.a).toFixed(1)} pts${(d.q > 0) !== (d.a > 0) ? "<br>Wrong winner" : ""}`))
    .on("mouseleave", chide);
  if (level === "states") { // label the biggest misses
    const big = [...pts].sort((a, b) => Math.abs(b.q - b.a) - Math.abs(a.q - a.a)).slice(0, 5);
    f.g.selectAll("text.lb").data(big).join("text").attr("class", "lb").attr("x", (d) => x(d.a) + 8).attr("y", (d) => y(d.q) + 4).attr("font-size", 11).attr("fill", C.ink).text((d) => d.name);
  }
  const right = pts.filter((d) => (d.q > 0) === (d.a > 0)).length;
  document.getElementById("ch-24-note").innerHTML = level === "counties"
    ? `${pts.length.toLocaleString()} counties, dot size = votes cast. Correlation r = ${S.qn.county_r_2024}. Each county is predicted by a model that never saw its state.`
    : `${pts.length} states: Qloo's tastes alone picked the right 2024 winner in <b>${right} of ${pts.length}</b>, missing the margin by <b>${S.qn.state_mae_2024} pts</b> on average. Each state is predicted by a model that never saw it.`;
}

/* 3. Track record inside states: county gap bins (2020 fit) vs the real 2020→2024 swing */
function chartBins() {
  const B = S.natbt.county_bins, f = frame("#ch-bins", 300, { t: 20, r: 18, b: 52, l: 56 });
  const x = d3.scaleBand().domain(B.map((d) => d.bin)).range([0, f.iw]).padding(0.28);
  const ymax = Math.max(0.6, d3.max(B, (d) => Math.abs(d.swing) + 2 * d.se));
  const y = d3.scaleLinear().domain([-ymax, ymax]).range([f.ih, 0]);
  const gy = f.g.append("g").call(d3.axisLeft(y).ticks(5).tickFormat((v) => (v > 0 ? "D+" : v < 0 ? "R+" : "") + Math.abs(v).toFixed(1)).tickSize(-f.iw));
  gy.select(".domain").remove(); gy.selectAll("line").attr("stroke", C.grid); gy.selectAll("text").attr("fill", C.muted).attr("font-size", 11);
  f.g.append("line").attr("x1", 0).attr("x2", f.iw).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", C.ink).attr("opacity", 0.6);
  const bw = Math.min(24, x.bandwidth());
  f.g.selectAll("path.bar").data(B).join("path").attr("class", "bar").attr("fill", (d) => (d.swing > 0 ? C.d : C.r))
    .attr("d", (d) => { // 4px rounded data end, square at the baseline
      const x0 = x(d.bin) + (x.bandwidth() - bw) / 2, y0 = y(0), y1 = y(d.swing), r = Math.min(4, Math.abs(y1 - y0));
      return d.swing >= 0 ? `M${x0},${y0}V${y1 + r}Q${x0},${y1} ${x0 + r},${y1}H${x0 + bw - r}Q${x0 + bw},${y1} ${x0 + bw},${y1 + r}V${y0}Z`
                          : `M${x0},${y0}V${y1 - r}Q${x0},${y1} ${x0 + r},${y1}H${x0 + bw - r}Q${x0 + bw},${y1} ${x0 + bw},${y1 - r}V${y0}Z`; });
  f.g.selectAll("line.se").data(B).join("line").attr("class", "se").attr("x1", (d) => x(d.bin) + x.bandwidth() / 2).attr("x2", (d) => x(d.bin) + x.bandwidth() / 2)
    .attr("y1", (d) => y(d.swing - 1.96 * d.se)).attr("y2", (d) => y(d.swing + 1.96 * d.se)).attr("stroke", C.ink).attr("opacity", 0.45);
  f.g.selectAll("rect.hit").data(B).join("rect").attr("class", "hit").attr("x", (d) => x(d.bin)).attr("width", x.bandwidth()).attr("y", 0).attr("height", f.ih).attr("fill", "transparent")
    .on("mousemove", (ev, d) => ctip(ev, `<b>Bin ${d.bin} of 10</b> · ${d.n.toLocaleString()} counties<br>Tastes vs 2020 vote: ${d.gap > 0 ? "bluer" : "redder"} by ~${Math.abs(d.gap).toFixed(1)} pts<br>Actual 2020→2024 swing (beyond what the 2020 margin and size explain): <b>${d.swing > 0 ? "D+" : "R+"}${Math.abs(d.swing).toFixed(2)}</b> ± ${(1.96 * d.se).toFixed(2)}`))
    .on("mouseleave", chide);
  f.g.append("text").attr("x", 0).attr("y", f.ih + 18).attr("font-size", 11).attr("fill", C.muted).text("← tastes redder than the 2020 vote");
  f.g.append("text").attr("x", f.iw).attr("y", f.ih + 18).attr("text-anchor", "end").attr("font-size", 11).attr("fill", C.muted).text("tastes bluer than the 2020 vote →");
  f.g.append("text").attr("x", f.iw / 2).attr("y", f.ih + 40).attr("text-anchor", "middle").attr("font-size", 12).attr("fill", C.muted).text("Counties in 10 equal groups by Qloo gap (within their state)");
  f.g.append("text").attr("x", -f.m.l + 4).attr("y", -6).attr("fill", C.muted).attr("font-size", 12).text("Real swing 2020→2024");
}

/* 4. Statewide: state gap (2020 fit) vs the real 2020→2024 state swing — the test that failed */
function chartStates() {
  const P = S.natbt.state_points, f = frame("#ch-states", 300, { t: 20, r: 18, b: 44, l: 56 });
  const gx = d3.max(P, (d) => Math.abs(d.gap)) * 1.1, gy = d3.max(P, (d) => Math.abs(d.swing)) * 1.15;
  const x = d3.scaleLinear().domain([-gx, gx]).range([0, f.iw]), y = d3.scaleLinear().domain([-gy, gy]).range([f.ih, 0]);
  const sf = (v) => (v > 0 ? "+" : "") + v.toFixed(0);
  axes(f, x, y, "State's Qloo gap vs its 2020 vote →", "Real state swing 2020→2024", sf, sf);
  const mx = d3.mean(P, (d) => d.gap), my = d3.mean(P, (d) => d.swing);
  const b = d3.sum(P, (d) => (d.gap - mx) * (d.swing - my)) / d3.sum(P, (d) => (d.gap - mx) ** 2);
  f.g.append("line").attr("x1", x(-gx)).attr("y1", y(my + b * (-gx - mx))).attr("x2", x(gx)).attr("y2", y(my + b * (gx - mx))).attr("stroke", C.qloo).attr("stroke-width", 2);
  f.g.selectAll("circle").data(P).join("circle").attr("cx", (d) => x(d.gap)).attr("cy", (d) => y(d.swing)).attr("r", 4.5).attr("fill", C.muted).attr("fill-opacity", 0.75).attr("stroke", C.surf).attr("stroke-width", 2)
    .on("mousemove", (ev, d) => ctip(ev, `<b>${d.state}</b><br>Qloo gap: ${sf(d.gap)}<br>Real swing (beyond what its 2020 margin explains): ${d.swing > 0 ? "+" : ""}${d.swing.toFixed(1)}`)).on("mouseleave", chide);
  f.g.append("text").attr("x", f.iw - 4).attr("y", 14).attr("text-anchor", "end").attr("font-size", 12).attr("fill", C.ink).text(`r = ${S.natbt.state_r_controlled} · ${S.natbt.n_states} states`);
}

let chartLevel = "states";
function renderCharts() {
  if (!window.d3 || !S.qn || !S.natbt) return;
  document.getElementById("ch-office").textContent = OFF[S.office];
  chartDumbbell(); chart2024(chartLevel); chartBins(); chartStates();
}
document.querySelectorAll("#ch-24-toggle button").forEach((b) => (b.onclick = () => {
  chartLevel = b.dataset.level; document.querySelectorAll("#ch-24-toggle button").forEach((x) => x.setAttribute("aria-checked", x === b)); chart2024(chartLevel);
}));
let chartTimer; window.addEventListener("resize", () => { clearTimeout(chartTimer); chartTimer = setTimeout(renderCharts, 200); });
