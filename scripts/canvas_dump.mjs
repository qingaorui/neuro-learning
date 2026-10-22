/** 导出完整画布（绕开容器裁剪），用于检验逐页对照的真实渲染质量。
 * 假翻译按「英文前缀」匹配，而不是按 id —— 因为切段后块 id 会变。 */
import { chromium } from "playwright";
import fs from "node:fs";

const OUT = "data/e2e";
fs.mkdirSync(OUT, { recursive: true });

const TR = [
  ["Neuron 80", "Neuron 80, 1-18 · 综述"],
  ["Structure and Function", "突触释放机器的结构与功能"],
  ["A. Author", "作者 A，作者 B，作者 C ｜ Neuron 80, 1-18 (2013)"],
  ["Synaptic transmission requires", "突触传递要求钙内流与囊泡融合精确耦联。本文综述突触前释放机器的结构、膜融合的能量学，以及支撑亚毫秒级递质释放的分子编排。"],
  ["During an action potential", "动作电位期间，进入突触前末梢的钙离子以惊人的速度与可靠性触发囊泡融合，释放机器必须在钙信号到来前装配完毕。"],
  ["The core of the machinery", "机器的核心是一组介导膜融合的蛋白：SNARE 蛋白、SM 蛋白 Munc18-1 与钙感受器 synaptotagmin，它们构成最小催化单元。"],
  ["The active zone", "活性区是突触前膜上特化的区域，囊泡在此锚定并融合；其结构由支架蛋白组织，尺寸与释放位点数量相关。"],
  ["Functional imaging", "功能成像进一步显示，钙通道富集于释放位点附近，形成纳米域，局部钙浓度可比胞质本体高出一个数量级以上。"],
  ["Membrane fusion is", "膜融合在能量上不利，需要 SNARE 复合体提供驱动力。SNARE 组装经由拉链式机制把两层膜拉近。"],
  ["The field has converged", "该领域已趋于一致：机器装配、钙通道定位与钙感受器的生物物理性质，共同决定释放的速度与保真度。"],
  ["Figure 1.", "图 1. 释放位点的结构。"],
  ["Schematic of a presynaptic", "突触前末梢示意图，显示囊泡、钙通道与活性区。"],
  ["Presynaptic terminal", "突触前末梢"],
  ["1. Introduction", "1. 引言"],
  ["2. Organization", "2. 释放位点的组织"],
  ["3. Energetics", "3. 融合的能量学"],
  ["4. Conclusion", "4. 结论"],
  ["Review", "综述"],
  ["Ca2+", "Ca2+"],
];

function zhFor(en) {
  for (const [k, v] of TR) if (en.startsWith(k)) return v;
  return "（未匹配原文）";
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

await page.route("**/api.deepseek.com/**", async (route) => {
  const body = JSON.parse(route.request().postData() || "{}");
  const user = (body.messages || []).filter((m) => m.role === "user").map((m) => m.content).join("\n");
  if (body.stream) {
    return route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: "data: [DONE]\n\n" });
  }
  if (user.includes("<seg id=")) {
    const segs = [...user.matchAll(/<seg id="([^"]+)">([\s\S]*?)<\/seg>/g)].map((m) => ({
      id: m[1], zh: zhFor(m[2].trim()),
    }));
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ segments: segs }) } }] }),
    });
  }
  return route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
  });
});

await page.goto("http://127.0.0.1:8899/", { waitUntil: "networkidle" });
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem("ns.settings") || "{}");
  Object.assign(s, { apiKey: "sk-x", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", mock: false });
  localStorage.setItem("ns.settings", JSON.stringify(s));
});
await page.reload({ waitUntil: "networkidle" });
await page.setInputFiles("#fileInput", "data/test_paper.pdf");
await page.waitForFunction(() => document.querySelector("#jobText")?.textContent?.includes("已就绪"), { timeout: 90000 });
await page.waitForTimeout(1200);

async function dump(mode, pg, name) {
  await page.evaluate(([m, p]) => {
    window.__NL.S.mode = m;
    window.__NL.S.page = p;
    return window.__NL.renderPage();
  }, [mode, pg]);
  await page.waitForTimeout(900);
  const dataUrl = await page.evaluate(() => document.querySelector("#pageCanvas").toDataURL("image/png"));
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(dataUrl.split(",")[1], "base64"));
  console.log(name, "已导出");
}

await dump("translated", 1, "full-translated");
await dump("original", 1, "full-original");
await dump("translated", 2, "full-page2");

await browser.close();
