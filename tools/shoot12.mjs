import { createRequire } from "module"; const require = createRequire("/tmp/adflank-ui/tools/package.json"); const puppeteer = require("puppeteer-core");
const base = process.argv[2];
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
const errs = []; p.on("pageerror", (e) => errs.push("PAGEERR " + e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
const W = (ms) => new Promise((r) => setTimeout(r, ms));
await p.goto(base, { waitUntil: "networkidle2", timeout: 90000 }); await W(5000);
const go = (i) => p.evaluate((i) => { const sc = document.querySelector(".story-scroll"); const s = document.querySelectorAll(".story-step")[i]; sc.scrollTop = s.offsetTop - (sc.clientHeight - s.offsetHeight) / 2; }, i);
await go(0); await W(5000);
for (const [i, tag] of [[1, "1to2"], [2, "2to3"], [3, "3to4"]]) {
  await go(i); let t0 = 0;
  for (const t of [250, 600, 1000, 1600]) { await W(t - t0); t0 = t; await p.screenshot({ path: `shots/fade-${tag}-${t}.png`, clip: { x: 500, y: 150, width: 900, height: 600 } }); }
  await W(5000);
}
console.log("errors:", JSON.stringify(errs.slice(0, 8)));
await b.close();
