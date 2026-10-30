import { createRequire } from "module"; const require = createRequire("/tmp/adflank-ui/tools/package.json"); const puppeteer = require("puppeteer-core");
const base = process.argv[2]; const tag = process.argv[3] || "before";
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const W = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
for (const [w, h] of [[1440, 900], [400, 860]]) {
  const p = await b.newPage(); await p.setViewport({ width: w, height: h });
  p.on("pageerror", (e) => errs.push("PAGEERR " + e.message));
  await p.goto(base, { waitUntil: "networkidle2", timeout: 90000 }); await W(3000);
  await p.evaluate(() => document.querySelector("#welcome-go").click()); await W(600);
  await p.evaluate(() => document.querySelector('[data-cmp="r24"]').click()); await W(5000);
  await p.screenshot({ path: `shots/sw-${tag}-${w}-mid.png` });
  // drag handle far left, near the legend
  const g = await p.$("#swipe .grip"); const bb = await g.boundingBox();
  await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await p.mouse.down();
  await p.mouse.move(5, bb.y + bb.height / 2, { steps: 10 }); await p.mouse.up(); await W(1000);
  await p.screenshot({ path: `shots/sw-${tag}-${w}-left.png` });
  await p.close();
}
console.log("errors:", JSON.stringify(errs));
await b.close();
