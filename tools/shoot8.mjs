import { createRequire } from "module"; const require = createRequire("/tmp/adflank-ui/tools/package.json"); const puppeteer = require("puppeteer-core");
const base = process.argv[2];
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
const errs = []; p.on("pageerror", (e) => errs.push("PAGEERR " + e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
const W = (ms) => new Promise((r) => setTimeout(r, ms));
await p.goto(base, { waitUntil: "networkidle2", timeout: 90000 }); await W(3500);
await p.evaluate(() => document.querySelector("#welcome-tour").click()); await W(4500);
for (let i = 1; i <= 7; i++) {
  const t = await p.evaluate(() => document.querySelector("#tour h3")?.innerText);
  console.log("step", i, t);
  await p.screenshot({ path: `shots/tour-${i}.png` });
  const last = await p.evaluate(() => document.querySelector("#tour .next")?.innerText);
  if (!last || last === "See the charts") break;
  await p.evaluate(() => document.querySelector("#tour .next").click()); await W(i === 5 ? 9000 : 4000);
}
await p.evaluate(() => document.querySelector("#tour .next")?.click()); await W(1500);
const el = await p.$("#charts"); const bb = await el.boundingBox();
await p.setViewport({ width: 1440, height: Math.ceil(bb.height) + 40 });
await p.evaluate(() => document.querySelector("#charts").scrollIntoView()); await W(1500);
await p.screenshot({ path: "shots/charts.png", fullPage: false });
await p.evaluate(() => document.querySelector('#ch-24-toggle [data-level="counties"]').click()); await W(1500);
const e2 = await p.$("#ch-24"); await e2.screenshot({ path: "shots/charts-24-counties.png" });
console.log("errors:", JSON.stringify(errs.slice(0, 8)));
await b.close();
