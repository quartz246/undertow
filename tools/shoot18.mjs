import { createRequire } from "module"; const require = createRequire("/tmp/adflank-ui/tools/package.json"); const puppeteer = require("puppeteer-core");
const base = process.argv[2];
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
const errs = []; p.on("pageerror", (e) => errs.push("PAGEERR " + e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
const W = (ms) => new Promise((r) => setTimeout(r, ms));
await p.goto(base, { waitUntil: "networkidle2", timeout: 90000 }); await W(5000);
const n = await p.evaluate(() => document.querySelectorAll(".story-step").length);
for (let i = 0; i < n; i++) {
  await p.evaluate((i) => { const sc = document.querySelector(".story-scroll"); sc.style.scrollBehavior = "auto"; const s = document.querySelectorAll(".story-step")[i]; sc.scrollTop = s.offsetTop - (sc.clientHeight - s.offsetHeight) / 2; }, i);
  await W(6500);
  const h = await p.evaluate((i) => document.querySelectorAll(".story-step h2")[i].innerText, i);
  console.log(`${i + 1}. ${h}`);
  if (/missed|Here is every race/.test(h)) { console.log("   " + (await p.evaluate((i) => document.querySelectorAll(".story-step p")[i].innerText, i)).slice(0, 420)); await p.screenshot({ path: `shots/s-${i + 1}.png` }); }
}
await p.evaluate(() => document.querySelector(".story-close").click()); await W(1500);
await p.evaluate(() => openRace("IA-S", true)); await W(2500);
console.log("IA cultural card:", await p.evaluate(() => document.querySelector(".card.culture")?.innerText.slice(0, 300)));
await p.screenshot({ path: "shots/ia-panel.png" });
console.log("table sub:", await p.evaluate(() => document.querySelector("#preds-sub").innerText));
console.log("errors:", JSON.stringify(errs.slice(0, 8)));
await b.close();
