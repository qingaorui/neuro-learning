/** 线上地址冒烟测试：直接打 GitHub Pages，确认部署产物可用。 */
import { chromium } from "playwright";
import fs from "node:fs";

const URL = "https://qingaorui.github.io/neuro-learning/";
const OUT = "data/e2e";
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

console.log("打开", URL);
await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForSelector("#paperTitle", { timeout: 30000 });

const info = await page.evaluate(() => ({
  title: document.querySelector("#paperTitle")?.textContent?.trim(),
  brand: document.querySelector(".brand-title")?.textContent?.trim(),
  items: document.querySelectorAll(".plan .item").length,
  modules: document.querySelectorAll(".plan .mod").length,
  dayPill: document.querySelector("#dayPill")?.textContent?.trim(),
  noKeyBannerVisible: document.querySelector("#noKeyBanner")?.hidden === false,
  pdfjsLoaded: typeof window.__NL === "object",
}));

console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: `${OUT}/live-home.png`, fullPage: false });

// 切一篇看看目录跳转
await page.click('.plan .item:nth-of-type(12)').catch(() => {});
await page.waitForTimeout(800);
const after = await page.textContent("#paperTitle");
console.log("点击目录后:", after?.trim().slice(0, 60));

console.log("控制台错误:", errors.length ? errors : "无");
await browser.close();
