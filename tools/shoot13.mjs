import { createRequire } from "module"; const require = createRequire("/tmp/adflank-ui/tools/package.json"); const puppeteer = require("puppeteer-core");
const base = process.argv[2];
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
const errs = []; p.on("pageerror", (e) => errs.push("PAGEERR " + e.message));
const W = (ms) => new Promise((r) => setTimeout(r, ms));
await p.goto(base, { waitUntil: "networkidle2", timeout: 90000 }); await W(5000);
const go = (i) => p.evaluate((i) => { const sc = document.querySelector(".story-scroll"); sc.style.scrollBehavior = "auto"; const s = document.querySelectorAll(".story-step")[i]; sc.scrollTop = s.offsetTop - (sc.clientHeight - s.offsetHeight) / 2; }, i);
const n = await p.evaluate(() => document.querySelectorAll(".story-step").length);
for (let i = 0; i < n; i++) {
  await go(i); await W(6500);
  const st = await p.evaluate(() => ({ active: ST.active, mode: S.mode, cmp: S.cmp, kind: S.cmpKind, m24: [document.querySelector("#map24").hidden, document.querySelector("#map24").style.opacity],
    swipeX: Math.round(S.swipeX || 0), op: ["states-fill", "counties-fill", "states-fill-b", "counties-fill-b"].map((l) => JSON.stringify(__map.getPaintProperty(l, "fill-opacity"))).join(" | "), zoom: __map.getZoom().toFixed(1) }));
  console.log(i + 1, JSON.stringify(st));
  await p.screenshot({ path: `shots/settle-${i + 1}.png` });
}
console.log("errors:", JSON.stringify(errs.slice(0, 8)));
await b.close();
