import { chromium } from "playwright";
import fs from "node:fs";
const b = await chromium.launch();
const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 960 } });
const page = await ctx.newPage();
page.on("console", (m) => console.log("[console." + m.type() + "]", m.text().slice(0, 300)));
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 300)));
const TR = [["Neuron 80","Neuron 80, 1-18 · 综述"],["Structure and Function","突触释放机器的结构与功能"]];
await page.route("**/api.deepseek.com/**", async (r) => {
  const body = JSON.parse(r.request().postData() || "{}");
  const u = (body.messages || []).filter(m=>m.role==="user").map(m=>m.content).join("\n");
  if (body.stream) return r.fulfill({status:200, headers:{"Content-Type":"text/event-stream"}, body:"data: [DONE]\n\n"});
  if (u.includes("<seg id=")) {
    const segs=[...u.matchAll(/<seg id="([^"]+)">([\s\S]*?)<\/seg>/g)].map(m=>({id:m[1], zh:(TR.find(([k])=>m[2].trim().startsWith(k))||[,"中文译文示例"])[1]}));
    return r.fulfill({status:200, contentType:"application/json", body: JSON.stringify({choices:[{message:{content:JSON.stringify({segments:segs})}}]})});
  }
  return r.fulfill({status:200, contentType:"application/json", body: JSON.stringify({choices:[{message:{content:"{}"}}]})});
});
await page.goto("http://127.0.0.1:8899/", { waitUntil: "networkidle" });
await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem("ns.settings")||"{}");Object.assign(s,{apiKey:"sk-x",mock:false});localStorage.setItem("ns.settings",JSON.stringify(s));});
await page.reload({ waitUntil: "networkidle" });
await page.setInputFiles("#fileInput", "data/test_paper.pdf");
await page.waitForFunction(()=>document.querySelector("#jobText")?.textContent?.includes("已就绪"),{timeout:90000});
await page.click('.tab[data-tab="translation"]');
await page.waitForTimeout(800);
const [dl] = await Promise.all([page.waitForEvent("download",{timeout:120000}), page.click("#btnExportPdf")]);
await dl.saveAs("data/e2e/diag.pdf");
await page.waitForTimeout(500);
console.log("状态栏:", await page.textContent("#jobLabel"));
await b.close();
