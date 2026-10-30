import { createRequire } from "module"; const require = createRequire("/tmp/adflank-ui/tools/package.json"); const puppeteer = require("puppeteer-core");
const base = process.argv[2];
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
const errs = []; p.on("pageerror", (e) => errs.push("PAGEERR " + e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
const W = (ms) => new Promise((r) => setTimeout(r, ms));
await p.goto(base, { waitUntil: "networkidle2", timeout: 90000 }); await W(4000);
await p.evaluate(() => document.querySelector("#welcome-tour").click()); await W(2500);
const go = (i) => p.evaluate((i) => { const sc = document.querySelector(".story-scroll"); const s = document.querySelectorAll(".story-step")[i]; sc.scrollTop = s.offsetTop - (sc.clientHeight - s.offsetHeight) / 2; }, i);
await go(0); await W(4500);
await go(1);
const xs = [];
for (const t of [300, 900, 1800, 2600, 3600, 4800, 6200]) { await W(t - (xs.length ? [300, 900, 1800, 2600, 3600, 4800, 6200][xs.length - 1] : 0));
  xs.push(await p.evaluate(() => ({ x: Math.round(S.swipeX), op: document.querySelector("#swipe").style.opacity, cmp: S.cmp, mode: S.mode, inStory: !!document.querySelector("#story #swipe") }))); }
console.log("handle over time:", JSON.stringify(xs));
await p.screenshot({ path: "shots/s2-after-sweep.png" });
// user drags the handle while the story is open
const g = await p.$("#swipe .grip"); const bb = await g.boundingBox();
await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await p.mouse.down(); await p.mouse.move(1250, bb.y + bb.height / 2, { steps: 12 }); await p.mouse.up(); await W(1500);
console.log("after drag:", await p.evaluate(() => Math.round(S.swipeX)));
await p.screenshot({ path: "shots/s2-dragged.png" });
await go(2); await W(4000); await go(1); await W(6500);
console.log("back on step 2:", await p.evaluate(() => ({ x: Math.round(S.swipeX), cmp: S.cmp, kind: S.cmpKind })));
await p.evaluate(() => document.querySelector(".story-close").click()); await W(1500);
console.log("after exit swipe back in mapwrap:", await p.evaluate(() => !!document.querySelector(".mapwrap #swipe")), "cmp:", await p.evaluate(() => S.cmp));
console.log("errors:", JSON.stringify(errs.slice(0, 8)));
await b.close();
