/**
 * 端到端验收：用无头 Chromium 真实加载 docs/ 站点，拦截模型接口返回假数据，
 * 走完「打开今日论文 → 拖入 PDF → 翻译 → 叠字渲染 → 解读 → 对话」全流程。
 *
 * 用法: node scripts/e2e_test.mjs [port]
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const PORT = process.argv[2] || "8899";
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT = "data/e2e";
fs.mkdirSync(OUT, { recursive: true });

const ZH = "突触传递要求钙内流与囊泡融合精确耦联，本文综述突触前释放机器的结构、膜融合的能量学，以及在亚毫秒尺度上支撑递质释放的分子编排。";

function segReply(bodyText) {
  const ids = [...bodyText.matchAll(/<seg id="([^"]+)">/g)].map((m) => m[1]);
  const segments = ids.map((id, i) => ({
    id,
    zh: ZH + (i % 3 === 0 ? "（示例译文）" : ""),
  }));
  return { segments };
}

const INTERP = {
  one_liner: "钙内流与 SNARE 机器共同决定释放的速度与保真度。",
  question: "突触前末梢如何在亚毫秒尺度上把钙信号转成囊泡融合？",
  background: ["SNARE 复合体与膜融合", "钙纳米域的概念", "突触前活性区的结构"],
  methods: [{ name: "结构与功能综述", what: "梳理活性区构架与融合能量学", why: "把散落的机制串成因果链" }],
  findings: [{ point: "钙通道与释放位点空间耦联", evidence: "纳米域成像数据" }],
  figures: [{ label: "Figure 1", caption_zh: "释放位点构架示意图", read_this: "注意囊泡与钙通道的相对位置" }],
  caveats: "活体末梢中装配的动态过程仍不清楚。",
  connection: "承接 M02 的囊泡循环，向后连接到 M12 的方法学。",
  glossary: [{ term: "active zone", zh: "活性区", note: "囊泡锚定与融合的特化膜区" }],
  quiz: ["为什么钙通道要靠近囊泡？", "SNARE 拉链提供什么能量？"],
};

const errors = [];
let apiCalls = 0;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});
page.on("requestfailed", (r) => {
  if (!r.url().includes("deepseek")) errors.push("requestfailed: " + r.url() + " " + r.failure()?.errorText);
});

// 拦截模型接口
await page.route("**/api.deepseek.com/**", async (route) => {
  apiCalls++;
  const req = route.request();
  let body = {};
  try { body = JSON.parse(req.postData() || "{}"); } catch {}
  const userMsg = (body.messages || []).filter((m) => m.role === "user").map((m) => m.content).join("\n");

  if (body.stream) {
    const text = "这篇的结论是：释放速度与保真度由钙通道定位和 SNARE 装配共同决定（领域常识）。";
    const chunks = text.match(/.{1,8}/gs) || [];
    let sse = "";
    for (const c of chunks) {
      sse += `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`;
    }
    sse += "data: [DONE]\n\n";
    return route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: sse });
  }
  if (userMsg.includes("<seg id=")) {
    return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(segReply(userMsg)) } }] }) });
  }
  return route.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(INTERP) } }] }) });
});

const step = async (name, fn) => {
  process.stdout.write(`  ${name} … `);
  try { await fn(); console.log("OK"); }
  catch (e) { console.log("FAIL: " + e.message); throw e; }
};

try {
  await step("加载首页", async () => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForSelector("#paperTitle", { timeout: 15000 });
    const title = await page.textContent("#paperTitle");
    if (!title || title === "—") throw new Error("标题未渲染");
    await page.screenshot({ path: `${OUT}/01-home.png` });
  });

  await step("语料与目录", async () => {
    const items = await page.$$eval(".plan .item", (els) => els.length);
    if (items !== 98) throw new Error(`目录条目应为 98，实际 ${items}`);
  });

  await step("配置 Key", async () => {
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("ns.settings") || "{}");
      Object.assign(s, { apiKey: "sk-test-fake", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", mock: false });
      localStorage.setItem("ns.settings", JSON.stringify(s));
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#paperTitle");
    const hidden = await page.getAttribute("#noKeyBanner", "hidden");
    if (hidden === null) throw new Error("配置后提示条未隐藏");
  });

  await step("上传 PDF 并生成译文", async () => {
    await page.setInputFiles("#fileInput", path.resolve("data/test_paper.pdf"));
    await page.waitForFunction(
      () => document.querySelector("#jobText")?.textContent?.includes("已就绪"),
      { timeout: 90000 }
    );
    const size = await page.$eval("#pageCanvas", (c) => ({ w: c.width, h: c.height }));
    if (!size.w || !size.h) throw new Error("画布未绘制");
    console.log(`\n    画布 ${size.w}x${size.h}, 模型调用 ${apiCalls} 次`);
  });

  await step("切到译文页并截图", async () => {
    await page.click('.tab[data-tab="translation"]');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/02-translated.png` });
    const label = await page.textContent("#pageLabel");
    if (!label.includes("/")) throw new Error("页码异常");
  });

  await step("对比原文模式", async () => {
    await page.click('#modeSeg button[data-mode="original"]');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/03-original.png` });
    await page.click('#modeSeg button[data-mode="translated"]');
  });

  await step("翻页", async () => {
    await page.click("#btnNext");
    await page.waitForTimeout(1500);
    const label = await page.textContent("#pageLabel");
    if (!label.startsWith("2")) throw new Error("翻页失败：" + label);
    await page.screenshot({ path: `${OUT}/04-page2.png` });
    await page.click("#btnPrev");
  });

  await step("图文解读", async () => {
    await page.click('.tab[data-tab="interpret"]');
    await page.waitForTimeout(400);
    const cards = await page.$$eval("#interpBody .card", (els) => els.length);
    if (cards < 5) throw new Error("解读卡片过少：" + cards);
    await page.screenshot({ path: `${OUT}/05-interpret.png` });
  });

  await step("对话流式回答", async () => {
    await page.click("#chatFab");
    await page.waitForTimeout(400);
    await page.fill("#chatText", "这篇的一句话结论是什么？");
    await page.click("#chatSend");
    await page.waitForFunction(
      () => !document.querySelector("#chatSend").disabled,
      { timeout: 30000 }
    );
    const bubbles = await page.$$eval(".msg.bot .bubble", (els) => els.map((e) => e.textContent));
    const last = bubbles[bubbles.length - 1] || "";
    if (!last.includes("释放速度")) throw new Error("对话回答为空或异常：" + last.slice(0, 60));
    await page.screenshot({ path: `${OUT}/06-chat.png` });
  });

  await step("标记已读与进度", async () => {
    await page.click("#chatClose");
    await page.click("#btnRead");
    await page.waitForTimeout(300);
    const txt = await page.textContent("#progText");
    if (!txt.includes("1 / 98")) throw new Error("进度未更新：" + txt);
  });

  console.log("\n=== 结果 ===");
  console.log("  控制台错误:", errors.length ? errors : "无");
  console.log("  截图目录  :", OUT);
} catch (e) {
  console.log("\n=== 失败 ===");
  console.log(e.message);
  console.log("控制台错误:", errors);
  await page.screenshot({ path: `${OUT}/failure.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}

