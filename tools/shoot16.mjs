import { createRequire } from "module"; const require = createRequire("/tmp/adflank-ui/tools/package.json"); const puppeteer = require("puppeteer-core");
const base = process.argv[2];
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
const errs = []; p.on("pageerror", (e) => errs.push("PAGEERR " + e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
const W = (ms) => new Promise((r) => setTimeout(r, ms));
await p.goto(base, { waitUntil: "networkidle2", timeout: 90000 }); await W(5000);
await p.screenshot({ path: "shots/q-hero.png" });
const n = await p.evaluate(() => document.querySelectorAll(".story-step").length);
for (let i = 0; i < n; i++) {
  await p.evaluate((i) => { const sc = document.querySelector(".story-scroll"); sc.style.scrollBehavior = "auto"; const s = document.querySelectorAll(".story-step")[i]; sc.scrollTop = s.offsetTop - (sc.clientHeight - s.offsetHeight) / 2; }, i);
  await W(i === 7 ? 8000 : 6000);
  console.log(`${i + 1}. ${await p.evaluate((i) => document.querySelectorAll(".story-step h2")[i].innerText, i)}\n   ${await p.evaluate((i) => document.querySelectorAll(".story-step p")[i].innerText, i)}`);
  await p.screenshot({ path: `shots/q-${i + 1}.png` });
}
await p.evaluate(() => document.querySelector(".story-close").click()); await W(1500);
await p.evaluate(() => document.querySelector("#predictions").scrollIntoView()); await W(500);
await p.evaluate(() => document.querySelector('[data-sort="agree"]').click()); await W(500);
console.log("agreement sort top rows:", await p.evaluate(() => [...document.querySelectorAll("#ptable tbody tr")].slice(0, 5).map((tr) => tr.querySelector("th").innerText + ":" + tr.lastElementChild.innerText).join(" | ")));
console.log("errors:", JSON.stringify(errs.slice(0, 8)));
await b.close();
