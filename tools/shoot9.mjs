import { createRequire } from "module"; const require = createRequire("/tmp/adflank-ui/tools/package.json"); const puppeteer = require("puppeteer-core");
const base = process.argv[2]; const [w, h] = (process.argv[3] || "1440x900").split("x").map(Number);
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const p = await b.newPage(); await p.setViewport({ width: w, height: h });
const errs = []; p.on("pageerror", (e) => errs.push("PAGEERR " + e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
const W = (ms) => new Promise((r) => setTimeout(r, ms));
await p.goto(base, { waitUntil: "networkidle2", timeout: 90000 }); await W(3000);
await p.evaluate(() => document.querySelector("#welcome-tour").click()); await W(3000);
await p.screenshot({ path: `shots/story-${w}-0.png` });
const n = await p.evaluate(() => document.querySelectorAll(".story-step").length);
for (let i = 0; i < n; i++) {
  await p.evaluate((i) => { const sc = document.querySelector(".story-scroll"); const s = document.querySelectorAll(".story-step")[i]; sc.scrollTop = s.offsetTop - (sc.clientHeight - s.offsetHeight) / 2; }, i);
  await W(i === 5 ? 9000 : 5500);
  const t = await p.evaluate(() => document.querySelector(".story-step.on h2")?.innerText);
  console.log("step", i + 1, t);
  await p.screenshot({ path: `shots/story-${w}-${i + 1}.png` });
}
await p.evaluate(() => document.querySelector(".story-close").click()); await W(2000);
console.log("after exit, story hidden:", await p.evaluate(() => document.querySelector("#story").hidden), "body class:", await p.evaluate(() => document.body.className));
console.log("errors:", JSON.stringify(errs.slice(0, 8)));
await b.close();
