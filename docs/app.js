/* 神经生物学学习 · 纯前端版
 * 所有逻辑在浏览器里完成：pdf.js 解析 PDF、canvas 叠中文、直连模型接口。
 * 数据只存本机 IndexedDB / localStorage，不上传任何服务器。
 */
import * as pdfjs from "./vendor/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.min.mjs", import.meta.url).href;

/* ============================ 小工具 ============================ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let toastTimer = null;
function toast(msg, ms = 3200) {
  let el = $("#toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.style.cssText = `position:fixed;left:50%;bottom:28px;transform:translateX(-50%);
      background:#1c1c1e;color:#fff;padding:10px 18px;border-radius:10px;font-size:13.5px;
      z-index:99;box-shadow:0 8px 26px rgba(0,0,0,.22);max-width:70vw;transition:opacity .4s`;
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = "1";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.style.opacity = "0"), ms);
}

/* ============================ 存储层 ============================ */
const IDB = (() => {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open("neuro-learning", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function run(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", mode);
      const store = tx.objectStore("kv");
      let out;
      try { out = fn(store); } catch (e) { reject(e); return; }
      // 注意：键不存在时 out.result 为 undefined，绝不能回退成请求对象本身
      tx.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
      tx.onerror = () => reject(tx.error);
    });
  }
  return {
    get: (k) => run("readonly", (s) => s.get(k)),
    set: (k, v) => run("readwrite", (s) => s.put(v, k)),
    del: (k) => run("readwrite", (s) => s.delete(k)),
  };
})();

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const DEFAULT_SETTINGS = {
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  apiKey: "",
  mock: false,
  startDate: "",
};

const S = {
  corpus: null,
  plan: [],
  current: null,
  paper: null,
  settings: { ...DEFAULT_SETTINGS },
  progress: { read: [], history: [] },
  job: { status: "idle", stage: "", progress: 0, message: "" },
  pdfDoc: null,
  pdfPmid: null,
  blocks: [],          // 当前 PDF 的块（scale=1 坐标系）
  pageCount: 0,
  page: 1,
  mode: "translated",
  translations: null,  // {blockId: zh}
  textTranslation: null,
  interpretation: null,
  chatBusy: false,
};

/* ============================ 设置 / 进度 ============================ */
function loadSettings() {
  S.settings = { ...DEFAULT_SETTINGS, ...LS.get("ns.settings", {}) };
  if (!S.settings.startDate) {
    S.settings.startDate = new Date().toISOString().slice(0, 10);
    LS.set("ns.settings", S.settings);
  }
}
const saveSettings = () => LS.set("ns.settings", S.settings);
const hasKey = () => !!(S.settings.apiKey || S.settings.mock);

function loadProgress() {
  S.progress = { read: [], history: [], ...LS.get("ns.progress", {}) };
}
const saveProgress = () => LS.set("ns.progress", S.progress);

/* ============================ 语料 ============================ */
async function loadCorpus() {
  const res = await fetch("data/papers.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("语料加载失败：" + res.status);
  S.corpus = await res.json();
  S.plan = S.corpus.papers;
}

const dayFor = (d = new Date()) => {
  const start = new Date(S.settings.startDate + "T00:00:00");
  const today = new Date(d.toISOString().slice(0, 10) + "T00:00:00");
  const idx = Math.round((today - start) / 86400000) + 1;
  return Math.max(1, Math.min(idx, S.plan.length));
};

const paperByDay = (day) => S.plan[day - 1];
const paperById = (id) => S.plan.find((p) => p.id === id);
const resolvePaper = (key) => {
  const k = String(key).trim();
  if (/^\d+$/.test(k)) return paperByDay(Number(k));
  return paperById(k.toUpperCase());
};

/* ============================ 任务进度条 ============================ */
function setJob(status, stage, progress, message) {
  S.job = { status, stage, progress, message };
  const bar = $("#jobBar");
  const dot = $("#statusDot");
  if (status === "idle") { bar.hidden = true; $("#jobText").textContent = ""; dot.className = "status-dot"; return; }
  bar.hidden = false;
  $("#jobFill").style.width = Math.round(progress * 100) + "%";
  $("#jobLabel").textContent = status === "error" ? `失败：${message}` : `${stage} · ${message || ""}`;
  $("#jobText").textContent = status === "running" ? "处理中…" : status === "done" ? "已就绪" : "出错了";
  dot.className = "status-dot " + status;
}

/* ============================ 模型接口 ============================ */
function apiUrl() {
  return S.settings.baseUrl.replace(/\/+$/, "") + "/chat/completions";
}
function usingMock() {
  return S.settings.mock || !S.settings.apiKey;
}

async function llm({ messages, json = false, stream = false, onDelta = null, temperature = 0.2 }) {
  if (usingMock()) throw new Error("MOCK");
  const body = { model: S.settings.model, messages, temperature, stream };
  if (json && !stream) body.response_format = { type: "json_object" };

  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${S.settings.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`接口返回 ${res.status}：${t.slice(0, 200)}`);
  }
  if (!stream) {
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? "";
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", acc = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i).trim();
      buf = buf.slice(i + 2);
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload);
          const delta = obj?.choices?.[0]?.delta?.content;
          if (delta) { acc += delta; onDelta?.(delta); }
        } catch {}
      }
    }
  }
  return acc;
}

function extractJson(text) {
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  throw new Error("模型没有返回可解析的 JSON");
}

/* ============================ 提示词 ============================ */
const SYS_TRANSLATE =
  "你是神经科学领域的专业学术翻译，把英文文献译成简体中文。必须遵守：\n" +
  "1. 术语用学界通行译法，关键术语首次出现可在括号内保留英文。\n" +
  "2. 完整保留数字、单位、基因/蛋白/通道名、缩写、统计符号与文献引用标记（如 [12]、(Fig. 2)）。\n" +
  "3. 不增删、不加译者注、不解释、不总结。\n" +
  "4. 保持学术语气与信息密度。\n5. 只输出译文。";

const SYS_INTERPRET =
  "你是资深神经科学研究者，带一名有生物学背景但缺神经科学训练的学生精读文献。" +
  "解读必须紧扣原文，不许编造数据或结论，不确定处写「原文未明确」。只输出严格 JSON。";

const SYS_CHAT =
  "你是这位学习者的神经科学导师。他有生物学背景（分子、细胞、遗传学扎实），缺神经科学系统训练。" +
  "回答要求：优先依据给出的论文内容，引用时指明章节/图号；论文没写的必须明说「这篇没提到」；" +
  "补充的领域常识要用「（领域常识）」标注；不许编造数据、图号、统计值；中文回答，术语保留英文；简明直接。";

const INTERPRET_SCHEMA = {
  one_liner: "一句话结论（30 字以内）",
  question: "这篇要回答什么问题，为什么值得问",
  background: ["读它之前需要的前置知识"],
  methods: [{ name: "方法名", what: "具体做了什么", why: "为什么用这个方法" }],
  findings: [{ point: "关键结果", evidence: "支撑它的图/数据" }],
  figures: [{ label: "图号", caption_zh: "图注中文", read_this: "这张图怎么看" }],
  caveats: "局限、争议或作者承认的问题",
  connection: "它在课程里的位置，与哪些篇目呼应",
  glossary: [{ term: "英文术语", zh: "中文", note: "一句话解释" }],
  quiz: ["自测问题"],
};

/* ============================ 全文（JATS） ============================ */
function parseJats(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) return [];
  const items = [];
  const tag = (el) => (el.localName || el.nodeName || "").toLowerCase();
  const text = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();

  const abstracts = doc.getElementsByTagName("abstract");
  if (abstracts.length) {
    const ps = abstracts[0].getElementsByTagName("p");
    for (const p of ps) { const t = text(p); if (t) items.push({ kind: "para", text: t }); }
  }

  const walk = (el, level) => {
    for (const child of el.children) {
      const n = tag(child);
      if (n === "sec") {
        const titleEl = Array.from(child.children).find((c) => tag(c) === "title");
        if (titleEl) items.push({ kind: "heading", level: Math.min(level, 4), text: text(titleEl) });
        walk(child, level + 1);
      } else if (n === "p") {
        const t = text(child);
        if (t.length > 1) items.push({ kind: "para", text: t });
      } else if (n === "fig") {
        let label = "", caption = "";
        for (const c of child.children) {
          if (tag(c) === "label") label = text(c);
          else if (tag(c) === "caption") caption = text(c);
        }
        items.push({ kind: "figure", level, label: label || "Figure", text: caption });
      } else if (n === "table-wrap") {
        let label = "", caption = "";
        for (const c of child.children) {
          if (tag(c) === "label") label = text(c);
          else if (tag(c) === "caption") caption = text(c);
        }
        items.push({ kind: "table", level, label: label || "Table", text: caption });
      } else if (n === "app-group" || n === "back") {
        /* 参考文献与附录不翻译 */
      } else if (n === "floats-group") {
        walk(child, level);
      } else if (child.children.length) {
        walk(child, level);
      }
    }
  };

  const bodies = doc.getElementsByTagName("body");
  if (bodies.length) walk(bodies[0], 1);
  const floats = doc.getElementsByTagName("floats-group");
  if (floats.length) walk(floats[0], 1);

  return items;
}

async function fetchFulltext(paper) {
  const key = `ft:${paper.pmid}`;
  const cached = await IDB.get(key);
  if (cached) return cached;

  let items = [], source = "abstract", note = "";
  if (paper.pmcid) {
    const id = String(paper.pmcid).replace(/^PMC/i, "");
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${id}&retmode=xml`;
    try {
      const xml = await (await fetch(url)).text();
      const parsed = parseJats(xml);
      if (parsed.some((x) => x.kind === "para")) {
        items = parsed; source = "jats";
        note = "全文来自 PMC 的 JATS XML。";
      }
    } catch (e) { note = "PMC 全文抓取失败：" + e.message; }
  }
  if (!items.length) {
    const ab = (paper.abstract || "").trim();
    items = ab ? ab.split(/\n{2,}/).map((t) => ({ kind: "para", text: t })) : [];
    source = "abstract";
    note = paper.pmcid
      ? "未能取得 PMC 全文，仅能翻译摘要。拖入 PDF 可获得逐页对照译文。"
      : "该篇没有 PMC 全文，仅能翻译摘要。拖入 PDF 可获得逐页对照译文。";
  }
  const out = { source, items, note };
  await IDB.set(key, out);
  return out;
}

/* ============================ PDF 解析 ============================ */
const MIN_CHARS = 8;   // 低于此长度视为图内标签/刻度；阈值不能太高，否则短标题会被漏掉

async function openPdf(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  return await pdfjs.getDocument({ data: buf }).promise;
}

function extractBlocksFromPage(textContent, viewport) {
  const items = [];
  for (const it of textContent.items) {
    const str = (it.str || "").trim();
    if (!str) continue;
    const tx = pdfjs.Util.transform(viewport.transform, it.transform);
    const h = Math.hypot(tx[2], tx[3]) || it.height || 10;
    const x = tx[4];
    const baseline = tx[5];
    items.push({ str, x, y: baseline - h, w: (it.width || 0) * viewport.scale, h, baseline });
  }

  // 先聚成行
  items.sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const lines = [];
  for (const it of items) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(it.baseline - last.baseline) <= Math.max(1.5, it.h * 0.45)) {
      last.parts.push(it);
      last.x0 = Math.min(last.x0, it.x);
      last.x1 = Math.max(last.x1, it.x + it.w);
      last.y0 = Math.min(last.y0, it.y);
      last.y1 = Math.max(last.y1, it.y + it.h);
      last.h = Math.max(last.h, it.h);
    } else {
      lines.push({
        baseline: it.baseline, parts: [it], x0: it.x, x1: it.x + it.w,
        y0: it.y, y1: it.y + it.h, h: it.h,
      });
    }
  }
  // 同一基线上可能有左右两栏、甚至图内标签。必须先按水平间距切成「段」，
  // 否则左栏正文会和右侧图内文字并成一个跨栏的块，白色遮盖区会把插图吃掉。
  const segments = [];
  for (const l of lines) {
    l.parts.sort((a, b) => a.x - b.x);
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      let text = "", prevEnd = null;
      for (const p of cur) {
        if (prevEnd !== null && p.x - prevEnd > l.h * 0.28) text += " ";
        text += p.str;
        prevEnd = p.x + p.w;
      }
      segments.push({
        baseline: l.baseline, h: l.h,
        x0: Math.min(...cur.map((p) => p.x)),
        x1: Math.max(...cur.map((p) => p.x + p.w)),
        y0: Math.min(...cur.map((p) => p.y)),
        y1: Math.max(...cur.map((p) => p.y + p.h)),
        text: text.replace(/\s+/g, " ").trim(),
      });
      cur = [];
    };
    for (const p of l.parts) {
      const prev = cur[cur.length - 1];
      if (prev && p.x - (prev.x + prev.w) > Math.max(14, l.h * 2.4)) flush();
      cur.push(p);
    }
    flush();
  }

  // 再把段聚成段落块
  const blocks = [];
  for (const line of segments) {
    if (!line.text) continue;
    const last = blocks[blocks.length - 1];
    if (last) {
      const gap = line.y0 - last.y1;
      const overlap = Math.min(last.x1, line.x1) - Math.max(last.x0, line.x0);
      const minW = Math.min(last.x1 - last.x0, line.x1 - line.x0);
      const sameCol = overlap > minW * 0.45;
      if (gap >= -2 && gap <= last.h * 1.15 && sameCol) {
        last.text += " " + line.text;
        last.x0 = Math.min(last.x0, line.x0); last.x1 = Math.max(last.x1, line.x1);
        last.y1 = Math.max(last.y1, line.y1);
        last.h = Math.max(last.h, line.h);
        continue;
      }
    }
    blocks.push({
      x0: line.x0, y0: line.y0, x1: line.x1, y1: line.y1, h: line.h, text: line.text,
    });
  }
  return blocks;
}

async function extractPdfBlocks(doc, onProgress) {
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    let blocks = extractBlocksFromPage(tc, viewport);
    blocks = blocks.filter((b) => b.text.length >= MIN_CHARS && /[A-Za-z]/.test(b.text));
    blocks.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    // 允许向下借用空白：到下一个块上边缘为止
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      let bottom = viewport.height - 20;
      for (let j = i + 1; j < blocks.length; j++) {
        const o = blocks[j];
        const ov = !(o.x1 < b.x0 || o.x0 > b.x1);
        if (o.y0 >= b.y1 - 0.5 && ov) { bottom = Math.min(bottom, o.y0 - 2); break; }
      }
      b.bottom = Math.max(bottom, b.y1);
      b.id = `p${p}b${i + 1}`;
      b.page = p;
    }
    pages.push(blocks);
    onProgress?.(p, doc.numPages);
  }
  return pages;
}

/* ============================ 译文排版 ============================ */
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  let cur = "";
  for (const ch of text) {
    if (ch === "\n") { lines.push(cur); cur = ""; continue; }
    const cand = cur + ch;
    if (cur && ctx.measureText(cand).width > maxWidth) { lines.push(cur); cur = ch; }
    else cur = cand;
  }
  if (cur) lines.push(cur);
  return lines;
}

function fitText(ctx, text, maxWidth, maxHeight, startSize, minSize) {
  const family = '"Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif';
  let size = startSize;
  while (size >= minSize) {
    ctx.font = `${size}px ${family}`;
    const lines = wrapText(ctx, text, maxWidth);
    if (lines.length * size * 1.3 <= maxHeight + 0.5) return { size, lines, family };
    size -= 0.5;
  }
  ctx.font = `${minSize}px ${family}`;
  return { size: minSize, lines: wrapText(ctx, text, maxWidth), family };
}

/* 渲染串行化：绝不并发操作同一个 canvas。
 * 每次请求带一个序号，排队执行时若已有更新的请求，直接跳过——保证最后落在画布上的
 * 一定是最新那次完整渲染，而不是被中途取消的半成品。 */
let renderQueue = Promise.resolve();
let renderGen = 0;

function renderPage(scaleHint = 1) {
  const my = ++renderGen;
  renderQueue = renderQueue
    .then(async () => {
      if (my !== renderGen) return;      // 有更新的请求排在后面，这次作废
      await doRenderPage(scaleHint);
    })
    .catch((e) => console.warn("render 失败:", e));
  return renderQueue;
}

async function doRenderPage(scaleHint = 1) {
  if (!S.pdfDoc) return;
  const canvas = $("#pageCanvas");
  const page = await S.pdfDoc.getPage(S.page);
  const base = page.getViewport({ scale: 1 });
  const wrap = $("#pageView");
  const cssWidth = Math.max(320, Math.min(wrap.clientWidth - 24 || 800, 1100)) * scaleHint;
  const dpr = window.devicePixelRatio || 1;

  await drawPageTo(canvas, S.page, S.mode, cssWidth * dpr);
  canvas.style.width = cssWidth + "px";
  canvas.style.height = Math.floor((canvas.height / dpr)) + "px";
}

/** 把某一页画到指定 canvas。targetWidthPx 决定分辨率，mode 决定是否叠中文。
 *  屏幕显示和 PDF 导出共用这一段，保证「所见即所得」。 */
async function drawPageTo(canvas, pageNum, mode, targetWidthPx) {
  const page = await S.pdfDoc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const scale = targetWidthPx / base.width;
  const vp = page.getViewport({ scale });

  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;

  if (mode !== "translated") return;
  const blocks = S.blocks[pageNum - 1] || [];
  const map = S.translations || {};
  const px = scale;                       // 1 个 PDF 点 = px 像素
  const minFont = Math.max(5.5, 6.5 * scale / 1.67);

  for (const b of blocks) {
    const zh = (map[b.id] || "").trim();
    if (!zh) continue;
    const x0 = b.x0 * px, y0 = b.y0 * px, x1 = b.x1 * px;
    const bottom = (b.bottom || b.y1) * px;
    // 白色遮盖只覆盖原文字块，不动插图
    ctx.fillStyle = "#fff";
    ctx.fillRect(x0 - 1, y0 - 1, x1 - x0 + 2, (b.y1 - b.y0) * px + 2);

    const maxW = Math.max(x1 - x0 - 1, 12);
    const maxH = Math.max(bottom - y0, 10);
    // 从原文字号起步，装不下再缩；上限放宽，否则标题会被压成小字
    const start = Math.min(b.h * px * 0.95, 40 * scale / 1.67);
    const { size, lines, family } = fitText(ctx, zh, maxW, maxH, start, minFont);
    ctx.fillStyle = "#111";
    ctx.font = `${size}px ${family}`;
    ctx.textBaseline = "top";
    let y = y0;
    for (const line of lines) {
      if (y + size > bottom + size * 0.6) break;
      ctx.fillText(line, x0, y);
      y += size * 1.3;
    }
  }
}

/* ============================ 导出整份 PDF ============================ */
function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

async function exportPdf() {
  if (!S.pdfDoc || !S.pageCount) return toast("请先拖入 PDF 并生成译文");

  const btn = $("#btnExportPdf");
  const old = btn.textContent;
  btn.disabled = true;
  const bar = $("#jobBar");
  const fill = $("#jobFill");
  const label = $("#jobLabel");
  bar.hidden = false;
  label.textContent = "导出 PDF · 准备中…";

  try {
    let bytes, mode;
    try {
      // 首选：把原 PDF 的页面整页搬过来（插图仍是矢量），再盖中文文字层
      bytes = await exportPdfVector(fill, label);
      mode = "矢量";
    } catch (e) {
      console.warn("矢量导出失败，回退到图片模式：", e);
      bytes = await exportPdfRaster(fill, label);
      mode = "图片";
    }

    fill.style.width = "100%";
    const mb = (bytes.length / 1048576).toFixed(2);
    const name = `${S.paper.id}-${S.mode === "translated" ? "译文" : "原文"}.pdf`;
    downloadBlob(new Blob([bytes], { type: "application/pdf" }), name);
    label.textContent = `已导出 ${name}（${mode}模式，${mb} MB）`;
    setTimeout(() => { bar.hidden = true; }, 5000);
  } catch (e) {
    console.error(e);
    label.textContent = "导出失败：" + e.message;
    toast("导出 PDF 失败：" + e.message, 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

let _cjkFontBytes = null;
function wrapPdf(font, text, size, maxW) {
  const lines = [];
  let cur = "";
  for (const ch of text) {
    if (ch === "\n") { lines.push(cur); cur = ""; continue; }
    const cand = cur + ch;
    if (cur && font.widthOfTextAtSize(cand, size) > maxW) { lines.push(cur); cur = ch; }
    else cur = cand;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** 矢量导出：复制原页 → 白底遮盖原文字块 → 用内嵌中文字体写译文。
 *  插图与线条保持矢量，另附可选中/可搜索的中文文字层。 */
async function exportPdfVector(fill, label) {
  const { PDFDocument, rgb } = await import("./vendor/pdf-lib.esm.min.js");
  const fontkit = window.fontkit;
  if (!fontkit) throw new Error("fontkit 未加载（vendor/fontkit.umd.min.js）");

  const blob = await IDB.get(`pdf:${S.paper.pmid}`);
  if (!blob) throw new Error("本机没有缓存原始 PDF");

  if (!_cjkFontBytes) {
    label.textContent = "导出 PDF · 加载中文字体（约 2 MB，仅首次）…";
    const r = await fetch("vendor/NotoSansSC.ttf");
    if (!r.ok) throw new Error("中文字体加载失败 " + r.status);
    _cjkFontBytes = new Uint8Array(await r.arrayBuffer());
  }

  label.textContent = "导出 PDF · 解析原始文件…";
  const src = await PDFDocument.load(await blob.arrayBuffer(), { ignoreEncryption: true });
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  out.setTitle(S.paper.title || "");
  out.setSubject(`${S.paper.journal} ${S.paper.year} · 机器辅助翻译，仅供个人学习`);
  out.setCreator("神经生物学学习");
  out.setProducer("神经生物学学习 · pdf-lib + Noto Sans SC");

  // 注意：pdf-lib 对这款 CJK 字体做 subset 会丢失字形（只画出每块头几个字），
  // 必须整包嵌入；字体已在构建时裁剪到常用字，约 2 MB。
  const font = await out.embedFont(_cjkFontBytes, { subset: false });
  const copied = await out.copyPages(src, Array.from({ length: src.getPageCount() }, (_, i) => i));
  for (const p of copied) out.addPage(p);

  const pages = out.getPageCount();
  const map = S.translations || {};
  for (let i = 0; i < pages; i++) {
    fill.style.width = Math.round(((i + 1) / pages) * 100) + "%";
    label.textContent = `导出 PDF · 第 ${i + 1}/${pages} 页`;
    const page = out.getPage(i);
    const { height } = page.getSize();
    const blocks = S.blocks[i] || [];

    for (const b of blocks) {
      const zh = (map[b.id] || "").trim();
      if (!zh) continue;
      const x0 = b.x0;
      const w = Math.max(b.x1 - b.x0, 12);
      const topY = height - b.y0;            // PDF 坐标（原点左下）
      const bottomY = height - (b.bottom || b.y1);

      page.drawRectangle({
        x: x0 - 1, y: height - b.y1 - 1,
        width: w + 2, height: (b.y1 - b.y0) + 2,
        color: rgb(1, 1, 1),
      });

      const maxH = Math.max((b.bottom || b.y1) - b.y0, 8);
      let size = Math.min(b.h * 0.95, 40);
      let lines = [];
      while (size >= 4.5) {
        lines = wrapPdf(font, zh, size, w - 1);
        if (lines.length * size * 1.25 <= maxH + 0.5) break;
        size -= 0.3;
      }
      let y = topY - size * 0.82;
      for (const line of lines) {
        if (y < bottomY - size * 0.25) break;
        page.drawText(line, { x: x0, y, size, font, color: rgb(0, 0, 0) });
        y -= size * 1.25;
      }
    }
  }
  label.textContent = "导出 PDF · 写入文件…";
  return await out.save();
}

/** 兜底导出：每页渲染成图片再装进 PDF。所见即所得，但没有文字层。 */
async function exportPdfRaster(fill, label) {
  const { PDFDocument } = await import("./vendor/pdf-lib.esm.min.js");
  const out = await PDFDocument.create();
  out.setTitle(S.paper.title || "");
  out.setCreator("神经生物学学习");

  const canvas = document.createElement("canvas");
  const TARGET_W = 1600;   // ≈200 DPI
  for (let p = 1; p <= S.pageCount; p++) {
    fill.style.width = Math.round(((p - 1) / S.pageCount) * 100) + "%";
    label.textContent = `导出 PDF（图片模式）· 第 ${p}/${S.pageCount} 页`;
    await drawPageTo(canvas, p, S.mode, TARGET_W);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("画布转 PNG 失败");
    const img = await out.embedPng(new Uint8Array(await blob.arrayBuffer()));
    const base = (await S.pdfDoc.getPage(p)).getViewport({ scale: 1 });
    const page = out.addPage([base.width, base.height]);
    page.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
  }
  return await out.save();
}

/* ============================ 翻译流程 ============================ */
async function translateUnit(texts, onProgress) {
  // texts: [{id, text}] → {id: zh}
  const BATCH = 12;
  const out = {};
  if (usingMock()) {
    for (const t of texts) out[t.id] = `【未配置模型，此处为占位译文】${t.text.slice(0, 40)}……`;
    onProgress?.(texts.length, texts.length);
    return out;
  }
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const listing = batch.map((b) => `<seg id="${b.id}">${b.text}</seg>`).join("\n");
    const user =
      '把下面每个 <seg> 段落的英文译成中文。严格按此 JSON 返回：\n' +
      '{"segments":[{"id":"原样照抄的 id","zh":"中文译文"}]}\n' +
      "每个输入都要有对应输出，id 不许改动或遗漏。\n\n" + listing;
    try {
      const raw = await llm({
        messages: [{ role: "system", content: SYS_TRANSLATE }, { role: "user", content: user }],
        json: true,
      });
      const parsed = extractJson(raw);
      for (const seg of parsed.segments || []) {
        if (seg.id && seg.zh) out[seg.id] = String(seg.zh).trim();
      }
    } catch (e) {
      for (const b of batch) {
        if (!out[b.id]) out[b.id] = "【本批翻译失败：" + e.message.slice(0, 40) + "】";
      }
    }
    onProgress?.(Math.min(i + BATCH, texts.length), texts.length);
    await sleep(120);
  }
  return out;
}

async function prepare(paper) {
  try {
    setJob("running", "获取全文", 0.05, "正在拉取全文…");
    const ft = await fetchFulltext(paper);

    const pdfBlob = await IDB.get(`pdf:${paper.pmid}`);
    if (pdfBlob) {
      setJob("running", "解析 PDF", 0.12, "提取文本块与版面…");
      const doc = await openPdf(pdfBlob);
      const pages = await extractPdfBlocks(doc, (p, n) =>
        setJob("running", "解析 PDF", 0.12 + 0.1 * (p / n), `第 ${p}/${n} 页`));
      const flat = pages.flat();
      if (!flat.length) throw new Error("这个 PDF 没有可提取的文本层（可能是扫描件）");

      const zh = await translateUnit(flat.map((b) => ({ id: b.id, text: b.text })), (d, t) =>
        setJob("running", "翻译 PDF", 0.25 + 0.55 * (d / t), `${d}/${t} 块`));
      await IDB.set(`pages:${paper.pmid}`, { pages, translations: zh, pageCount: doc.numPages });
      S.blocks = pages;
      S.translations = zh;
      S.pageCount = doc.numPages;
      S.pdfDoc = doc;
      S.pdfPmid = paper.pmid;
    } else {
      setJob("running", "翻译全文", 0.2, "按段翻译…");
      const units = ft.items
        .map((it, i) => ({ id: `t${i}`, text: it.text, kind: it.kind, label: it.label || "" }))
        .filter((u) => u.text);
      const zh = await translateUnit(units.map((u) => ({ id: u.id, text: u.text })), (d, t) =>
        setJob("running", "翻译全文", 0.2 + 0.5 * (d / t), `${d}/${t} 段`));
      const items = ft.items.map((it, i) => ({
        kind: it.kind, level: it.level || 1, label: it.label || "",
        en: it.text || "", zh: zh[`t${i}`] || "",
      }));
      await IDB.set(`text:${paper.pmid}`, { items, source: ft.source, note: ft.note });
      S.textTranslation = { items, source: ft.source, note: ft.note };
    }

    setJob("running", "生成解读", 0.85, "正在生成详细解读…");
    S.interpretation = await buildInterpretation(paper, ft);
    await IDB.set(`interp:${paper.pmid}`, S.interpretation);

    setJob("done", "完成", 1, "译文与解读已就绪");
    // 处理完直接切到译文页，避免用户看到空白画布
    const tab = $$(".tab").find((t) => t.dataset.tab === "translation");
    if (tab && !tab.classList.contains("active")) tab.click();
    await refreshTranslationView();
    renderInterpretation();
  } catch (e) {
    console.error(e);
    setJob("error", "失败", 0, e.message);
    toast("处理失败：" + e.message, 6000);
  }
}

async function buildInterpretation(paper, ft) {
  if (usingMock()) {
    return {
      mock: true,
      one_liner: "（未配置模型）这是一段占位解读。",
      question: `占位：本文《${paper.title.slice(0, 50)}》试图回答的问题。`,
      background: ["配置 API Key 后，这里会给出真实的前置知识清单。"],
      methods: [], findings: [], figures: [], caveats: "占位。", connection: "占位。",
      glossary: [], quiz: ["配置模型后这里会生成自测问题。"],
    };
  }
  const body = ft.items.map((it) => `[${it.kind}] ${it.text}`).join("\n\n").slice(0, 24000);
  const figs = ft.items.filter((i) => i.kind === "figure" || i.kind === "table")
    .map((f) => `${f.label || "Figure"}: ${f.text}`).join("\n") || "（无图表信息）";
  const meta =
    `标题：${paper.title}\n期刊：${paper.journal} (${paper.year})\n` +
    `类型：${paper.type_name}；难度：${paper.level_name}\n课程位置：${paper.module} 第 ${paper.id} 天\n` +
    `编者导读：${paper.note}\n\n图表清单：\n${figs}\n\n正文/摘要：\n${body}`;
  const raw = await llm({
    messages: [
      { role: "system", content: SYS_INTERPRET },
      { role: "user", content: `按下面 JSON 结构输出详细解读，字段齐全：\n${JSON.stringify(INTERPRET_SCHEMA, null, 1)}\n\n文献信息：\n${meta}` },
    ],
    json: true,
    temperature: 0.3,
  });
  return { ...extractJson(raw), mock: false };
}

/* ============================ 视图渲染 ============================ */
function renderPlan() {
  const nav = $("#plan");
  nav.innerHTML = "";
  const byMod = {};
  for (const p of S.plan) (byMod[p.module] = byMod[p.module] || []).push(p);
  const readSet = new Set(S.progress.read);
  for (const m of S.corpus.modules) {
    const items = byMod[m.id] || [];
    if (!items.length) continue;
    const head = document.createElement("div");
    head.className = "mod";
    head.textContent = `${m.id === "M00" ? "原典" : m.name} · ${items.length}`;
    nav.appendChild(head);
    for (const p of items) {
      const el = document.createElement("div");
      el.className = "item" + (readSet.has(p.id) ? " done" : "") + (S.current === p.id ? " active" : "");
      el.dataset.id = p.id;
      el.innerHTML = `<span class="d">${p.id}</span><span class="t" title="${esc(p.title)}">${esc(p.title)}</span>`;
      el.onclick = () => openPaper(p.id);
      nav.appendChild(el);
    }
  }
  updateProgressBar();
}

function updateProgressBar() {
  const read = new Set(S.progress.read);
  const pct = S.plan.length ? (read.size * 100) / S.plan.length : 0;
  $("#progBar").style.width = pct + "%";
  $("#progText").textContent = `${read.size} / ${S.plan.length} 已读（${pct.toFixed(1)}%）`;
  const dates = [...new Set(S.progress.history.map((h) => h.date))].sort();
  let streak = 0;
  if (dates.length) {
    streak = 1;
    for (let i = dates.length - 1; i > 0; i--) {
      const d = (new Date(dates[i]) - new Date(dates[i - 1])) / 86400000;
      if (Math.round(d) === 1) streak++; else break;
    }
  }
  $("#streakText").textContent = streak ? `连续 ${streak} 天` : "";
}

function renderPaperHead() {
  const p = S.paper;
  const read = new Set(S.progress.read).has(p.id);
  $("#dayPill").textContent = p.id;
  $("#dateText").textContent = `${p.journal} · ${p.year}`;
  const tags = [
    `<span class="tag ${p.type}">${p.type_name}</span>`,
    `<span class="tag${p.level === 3 ? " lv3" : ""}">${p.level_name}</span>`,
    `<span class="tag">${esc(p.journal)} ${p.year}</span>`,
  ];
  if (S.pdfDoc && S.pdfPmid === p.pmid) tags.push(`<span class="tag zh">PDF 已载入</span>`);
  $("#paperMeta").innerHTML = tags.join("");
  $("#paperTitle").textContent = p.title;
  $("#paperSub").textContent =
    (p.authors || []).slice(0, 6).join(", ") + ((p.authors || []).length > 6 ? " 等" : "") +
    (p.doi ? ` · DOI ${p.doi}` : "");
  $("#paperNote").textContent = p.note;
  $("#btnPubmed").href = p.url;
  $("#btnRead").textContent = read ? "已读 ✓" : "标记已读";
  $("#brandSub").textContent = `${S.plan.length} 篇 · 每日一篇`;
}

function renderAbstract() {
  const p = S.paper;
  $("#abstractBody").innerHTML = p.abstract
    ? p.abstract.split(/\n{2,}/).map((x) => `<p>${esc(x)}</p>`).join("")
    : `<p>${esc(p.abstract_note || "该条目在 PubMed 上没有摘要。")}</p>`;
  const cells = [
    ["PMID", p.pmid], ["DOI", p.doi || "—"], ["期刊", `${p.journal} (${p.year})`],
    ["课程位置", `${p.module} · ${p.id}`],
    ["免费全文", p.pdf_free ? `<a href="${p.pdf_free}" target="_blank" rel="noopener">PMC 链接</a>` : "无"],
  ];
  $("#metaGrid").innerHTML = cells.map(([k, v]) => `<div class="cell"><b>${k}</b>${v}</div>`).join("");
}

async function refreshTranslationView() {
  const pmid = S.paper.pmid;
  const pages = await IDB.get(`pages:${pmid}`);
  const text = await IDB.get(`text:${pmid}`);

  const toolbar = $("#tlToolbar"), empty = $("#tlEmpty");
  const pageView = $("#pageView"), textView = $("#textView");

  if (pages) {
    S.blocks = pages.pages;
    S.translations = pages.translations;
    S.pageCount = pages.pageCount;
    const blob = await IDB.get(`pdf:${pmid}`);
    if (blob && (!S.pdfDoc || S.pdfPmid !== pmid)) {
      S.pdfDoc = await openPdf(blob);
      S.pdfPmid = pmid;
    }
    empty.hidden = true; toolbar.hidden = false;
    pageView.hidden = false; textView.hidden = true;
    S.page = Math.min(S.page, S.pageCount);
    await renderPage();
    $("#pageLabel").textContent = `${S.page} / ${S.pageCount}`;
    $("#btnPrev").disabled = S.page <= 1;
    $("#btnNext").disabled = S.page >= S.pageCount;
    return;
  }
  if (text) {
    empty.hidden = true; toolbar.hidden = true;
    pageView.hidden = true; textView.hidden = false;
    renderTextTranslation(text);
    return;
  }
  toolbar.hidden = true; pageView.hidden = true; textView.hidden = true;
  empty.hidden = false;
}

function renderTextTranslation(data) {
  const tv = $("#textView");
  tv.innerHTML = "";
  if (data.note) {
    const tip = document.createElement("div");
    tip.className = "tl-empty";
    tip.style.padding = "12px";
    tip.style.fontSize = "12.5px";
    tip.textContent = data.note;
    tv.appendChild(tip);
  }
  for (const it of data.items || []) {
    const div = document.createElement("div");
    div.className = "seg-block " + it.kind;
    const label = it.label ? `<span class="label">${esc(it.label)}</span>` : "";
    const zh = it.zh ? `<div class="zh">${esc(it.zh)}</div>` : `<div class="zh" style="color:#8a8a92">（待翻译）</div>`;
    const en = it.en ? `<div class="en">${esc(it.en)}</div>` : "";
    div.innerHTML = label + zh + en;
    tv.appendChild(div);
  }
}

function renderInterpretation() {
  const d = S.interpretation;
  const body = $("#interpBody"), empty = $("#ipEmpty");
  if (!d) { empty.hidden = false; body.innerHTML = ""; return; }
  empty.hidden = true;
  const card = (t, inner) => `<div class="card"><h3>${t}</h3>${inner}</div>`;
  const list = (arr, tag = "ul") => `<${tag}>${(arr || []).map((x) => `<li>${esc(x)}</li>`).join("")}</${tag}>`;
  const parts = [];
  if (d.mock) parts.push(`<div class="banner" style="margin:0">当前是占位解读。配置 API Key 后重新生成即可。</div>`);
  if (d.one_liner) parts.push(`<div class="card oneliner">${esc(d.one_liner)}</div>`);
  if (d.question) parts.push(card("要回答的问题", `<p>${esc(d.question)}</p>`));
  if (d.background?.length) parts.push(card("前置知识", list(d.background)));
  if (d.methods?.length) parts.push(card("方法拆解", d.methods.map((m) =>
    `<div class="kv"><b>${esc(m.name)}</b><div>${esc(m.what)}</div><div class="sub">为什么用：${esc(m.why)}</div></div>`).join("")));
  if (d.findings?.length) parts.push(card("关键结果", d.findings.map((f) =>
    `<div class="kv"><b>${esc(f.point)}</b><div class="sub">证据：${esc(f.evidence)}</div></div>`).join("")));
  if (d.figures?.length) parts.push(card("图表逐张读法", d.figures.map((f) =>
    `<div class="kv"><b>${esc(f.label)}</b><div>${esc(f.caption_zh)}</div><div class="sub">怎么看：${esc(f.read_this)}</div></div>`).join("")));
  if (d.caveats) parts.push(card("局限与争议", `<p>${esc(d.caveats)}</p>`));
  if (d.connection) parts.push(card("在课程里的位置", `<p>${esc(d.connection)}</p>`));
  if (d.glossary?.length) parts.push(card("术语表", `<div class="gloss">${d.glossary.map((g) =>
    `<div class="row"><span class="term">${esc(g.term)}</span><span><b>${esc(g.zh)}</b> ${esc(g.note)}</span></div>`).join("")}</div>`));
  if (d.quiz?.length) parts.push(card("自测问题", list(d.quiz, "ol")));
  body.innerHTML = parts.join("");
}

/* ============================ 打开某篇 ============================ */
async function openPaper(key) {
  // key 可能是论文对象、页码数字、或 "D007" / "7"
  const paper =
    key && typeof key === "object" ? key : resolvePaper(String(key)) || null;
  if (!paper || !paper.id) return;
  S.current = paper.id;
  S.paper = paper;
  S.page = 1;
  S.mode = "translated";
  $$("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === "translated"));

  S.blocks = [];
  S.translations = null;
  S.textTranslation = null;
  S.pdfDoc = null;
  S.pdfPmid = null;
  S.interpretation = await IDB.get(`interp:${paper.pmid}`);

  renderPaperHead();
  renderAbstract();
  renderInterpretation();
  await refreshTranslationView();
  renderPlan();
  if ($("#chatDrawer").classList.contains("open")) await loadChat();
  else $("#chatPaperId").textContent = paper.id;
}

/* ============================ 对话 ============================ */
const CHAT_QUICK = [
  "一句话讲清这篇到底做了什么", "带我读其中一张图", "这个方法的局限在哪",
  "它和课程里哪几篇呼应", "给我出 3 道自测题",
];

function bubbleEl(role, text) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + (role === "user" ? "user" : "bot");
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = role === "user" ? "我" : "导师";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "user") bubble.textContent = text;
  else bubble.innerHTML = renderMd(text);
  wrap.append(who, bubble);
  return wrap;
}

function renderMd(src) {
  const esc0 = esc(src);
  const parts = esc0.split("```");
  let out = "";
  parts.forEach((part, i) => {
    if (i % 2 === 1) out += "<pre>" + part.replace(/^[a-zA-Z]*\n/, "") + "</pre>";
    else out += inlineMd(part);
  });
  return out;
}
function inlineMd(t) {
  return t
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .split(/\n{2,}/).filter((b) => b.trim())
    .map((block) => {
      const lines = block.split("\n").filter((l) => l.trim());
      if (lines.length && lines.every((l) => /^\s*[-*•]\s+/.test(l)))
        return "<ul>" + lines.map((l) => "<li>" + l.replace(/^\s*[-*•]\s+/, "") + "</li>").join("") + "</ul>";
      if (lines.length && lines.every((l) => /^\s*\d+[.)]\s+/.test(l)))
        return "<ol>" + lines.map((l) => "<li>" + l.replace(/^\s*\d+[.)]\s+/, "") + "</li>").join("") + "</ol>";
      return "<p>" + block.replace(/\n/g, "<br>") + "</p>";
    }).join("");
}

async function loadChat() {
  const log = $("#chatLog");
  log.innerHTML = "";
  $("#chatPaperId").textContent = S.current || "—";
  const history = (await IDB.get(`chat:${S.paper.pmid}`)) || [];
  if (!history.length) {
    log.appendChild(bubbleEl("bot",
      "就这篇论文问我任何问题：结论、某张图怎么看、方法局限、和课程的关联，或者让我出题考你。\n\n回答依据这篇的正文与图表，并标明出处；论文没写的内容我会直说。"));
  } else {
    history.forEach((t) => log.appendChild(bubbleEl(t.role, t.content)));
    log.scrollTop = log.scrollHeight;
  }
}

async function sendChat(text) {
  if (S.chatBusy || !S.paper) return;
  const question = (text ?? $("#chatText").value ?? "").trim();
  if (!question) return;
  $("#chatText").value = "";
  $("#chatText").style.height = "auto";

  const log = $("#chatLog");
  log.appendChild(bubbleEl("user", question));
  const botWrap = bubbleEl("bot", "");
  const bubble = botWrap.querySelector(".bubble");
  bubble.classList.add("typing");
  log.appendChild(botWrap);
  log.scrollTop = log.scrollHeight;

  S.chatBusy = true;
  $("#chatSend").disabled = true;
  $("#chatText").disabled = true;

  let acc = "";
  const err = (m) => {
    const e = document.createElement("div");
    e.className = "err";
    e.textContent = m;
    botWrap.appendChild(e);
  };

  try {
    const ft = await fetchFulltext(S.paper);
    const ctxText = buildChatContext(ft.items);
    const history = (await IDB.get(`chat:${S.paper.pmid}`)) || [];

    if (usingMock()) {
      const fake = `【未配置模型，这是占位回答】\n\n你问的是：${question}\n\n配置 API Key 后会基于正文与图表回答。`;
      for (let i = 0; i < fake.length; i += 6) {
        acc += fake.slice(i, i + 6);
        bubble.innerHTML = renderMd(acc);
        log.scrollTop = log.scrollHeight;
        await sleep(16);
      }
    } else {
      const messages = [
        { role: "system", content: SYS_CHAT },
        { role: "system", content: "以下是本次对话要依据的论文材料：\n\n" + ctxText },
        ...history.slice(-12).map((t) => ({ role: t.role, content: String(t.content).slice(0, 4000) })),
        { role: "user", content: question },
      ];
      await llm({
        messages, stream: true, temperature: 0.3,
        onDelta: (d) => {
          acc += d;
          bubble.innerHTML = renderMd(acc);
          log.scrollTop = log.scrollHeight;
        },
      });
    }
  } catch (e) {
    err("请求失败：" + e.message);
  } finally {
    bubble.classList.remove("typing");
    if (!acc && !botWrap.querySelector(".err")) bubble.textContent = "（没有收到内容）";
    S.chatBusy = false;
    $("#chatSend").disabled = false;
    $("#chatText").disabled = false;
    $("#chatText").focus();
    if (acc) {
      const history = (await IDB.get(`chat:${S.paper.pmid}`)) || [];
      const ts = new Date().toISOString();
      history.push({ role: "user", content: question, ts });
      history.push({ role: "assistant", content: acc, ts });
      await IDB.set(`chat:${S.paper.pmid}`, history.slice(-200));
    }
  }
}

function buildChatContext(items) {
  const p = S.paper;
  const head = [
    `当前论文：${p.title}`, `期刊年份：${p.journal} ${p.year}`,
    `类型：${p.type_name}；难度：${p.level_name}`, `课程位置：${p.module} 第 ${p.id} 天`,
    `编者导读：${p.note}`,
  ];
  if (S.interpretation && !S.interpretation.mock) {
    if (S.interpretation.one_liner) head.push(`已有解读·结论：${S.interpretation.one_liner}`);
    if (S.interpretation.caveats) head.push(`已有解读·局限：${S.interpretation.caveats}`);
  }
  let body = "";
  for (const it of items) {
    const line = `[${it.label || it.kind}] ${it.text}`;
    if (body.length + line.length > 18000) { body += "\n[正文过长已截断]"; break; }
    body += line + "\n\n";
  }
  return head.join("\n") + "\n\n论文正文：\n" + body;
}

/* ============================ 事件绑定 ============================ */
function bind() {
  $$(".tab").forEach((tab) => {
    tab.onclick = () => {
      $$(".tab").forEach((t) => t.classList.remove("active"));
      $$(".panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      $("#panel-" + tab.dataset.tab).classList.add("active");
      if (tab.dataset.tab === "translation" && S.pdfDoc) renderPage();
    };
  });

  $("#btnToday").onclick = () => openPaper(dayFor());
  $("#btnPrepare").onclick = () => prepare(S.paper);
  ["#btnPrepare2", "#btnPrepare3"].forEach((sel) => {
    const el = $(sel);
    if (el) el.onclick = () => { $$(".tab")[1].click(); prepare(S.paper); };
  });

  $("#btnUpload").onclick = () => $("#fileInput").click();
  $("#fileInput").onchange = (e) => uploadPdf(e.target.files[0]);

  const card = $("#paperCard");
  ["dragenter", "dragover"].forEach((ev) => card.addEventListener(ev, (e) => { e.preventDefault(); card.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) => card.addEventListener(ev, (e) => { e.preventDefault(); card.classList.remove("dragover"); }));
  card.addEventListener("drop", (e) => uploadPdf(e.dataTransfer.files?.[0]));

  $("#btnRead").onclick = () => {
    const id = S.paper.id;
    const set = new Set(S.progress.read);
    if (set.has(id)) set.delete(id);
    else { set.add(id); S.progress.history.push({ id, date: new Date().toISOString().slice(0, 10) }); }
    S.progress.read = [...set];
    saveProgress(); renderPaperHead(); renderPlan();
  };

  $("#btnClearCache").onclick = async () => {
    if (!confirm("清除这篇在本机缓存的 PDF、译文、解读与对话？")) return;
    const pmid = S.paper.pmid;
    for (const k of [`pdf:${pmid}`, `pages:${pmid}`, `text:${pmid}`, `interp:${pmid}`, `chat:${pmid}`, `ft:${pmid}`]) {
      await IDB.del(k);
    }
    S.pdfDoc = null; S.pdfPmid = null; S.blocks = []; S.translations = null;
    S.textTranslation = null; S.interpretation = null;
    toast("已清除");
    await openPaper(S.paper.id);
  };

  $("#btnPrev").onclick = () => { if (S.page > 1) { S.page--; pager(); } };
  $("#btnNext").onclick = () => { if (S.page < S.pageCount) { S.page++; pager(); } };
  $$("#modeSeg button").forEach((b) => {
    b.onclick = () => {
      $$("#modeSeg button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      S.mode = b.dataset.mode;
      renderPage();
    };
  });
  $("#zoom").oninput = (e) => $("#pageCanvas").style.width = e.target.value + "%";
  $("#btnExportPdf").onclick = exportPdf;
  $("#btnSavePng").onclick = () => {
    const c = $("#pageCanvas");
    if (!c.width) return;
    c.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${S.paper.id}-p${S.page}-${S.mode}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, "image/png");
  };

  $("#chatFab").onclick = openChat;
  $("#chatClose").onclick = closeChat;
  $("#chatClear").onclick = async () => {
    if (!confirm("清空这篇的对话记录？")) return;
    await IDB.set(`chat:${S.paper.pmid}`, []);
    await loadChat();
  };
  CHAT_QUICK.forEach((q) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = q;
    b.onclick = () => sendChat(q);
    $("#chatQuick").appendChild(b);
  });
  $("#chatForm").onsubmit = (e) => { e.preventDefault(); sendChat(); };
  const ta = $("#chatText");
  ta.oninput = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; };
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
    if (e.key === "Escape") closeChat();
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#chatDrawer").classList.contains("open")) closeChat();
  });

  const dlg = $("#settingsDlg");
  const openSettings = () => {
    $("#cfgBaseUrl").value = S.settings.baseUrl;
    $("#cfgModel").value = S.settings.model;
    $("#cfgStart").value = S.settings.startDate;
    $("#cfgMock").checked = !!S.settings.mock;
    $("#keyHint").textContent = S.settings.apiKey ? `（已保存 ${S.settings.apiKey.slice(0, 4)}…）` : "（未设置）";
    dlg.showModal();
  };
  $("#btnSettings").onclick = openSettings;
  $("#btnBannerSettings").onclick = openSettings;
  $("#dlgCancel").onclick = () => dlg.close();
  $("#dlgSave").onclick = () => {
    S.settings.baseUrl = $("#cfgBaseUrl").value.trim() || DEFAULT_SETTINGS.baseUrl;
    S.settings.model = $("#cfgModel").value.trim() || DEFAULT_SETTINGS.model;
    S.settings.mock = $("#cfgMock").checked;
    if ($("#cfgStart").value) S.settings.startDate = $("#cfgStart").value;
    const k = $("#cfgKey").value.trim();
    if (k) S.settings.apiKey = k;
    saveSettings();
    dlg.close();
    $("#cfgKey").value = "";
    updateKeyBanner();
    toast("设置已保存");
  };

  window.addEventListener("resize", () => { if (S.pdfDoc) renderPage(); });
}

function pager() {
  $("#pageLabel").textContent = `${S.page} / ${S.pageCount}`;
  $("#btnPrev").disabled = S.page <= 1;
  $("#btnNext").disabled = S.page >= S.pageCount;
  renderPage();
}

function openChat() {
  $("#chatDrawer").classList.add("open");
  $("#chatDrawer").setAttribute("aria-hidden", "false");
  document.body.classList.add("chat-open");
  document.querySelector(".app").classList.add("chat-open");
  loadChat();
  $("#chatText").focus();
}
function closeChat() {
  $("#chatDrawer").classList.remove("open");
  $("#chatDrawer").setAttribute("aria-hidden", "true");
  document.body.classList.remove("chat-open");
  document.querySelector(".app").classList.remove("chat-open");
}

function updateKeyBanner() {
  $("#noKeyBanner").hidden = hasKey();
}

async function uploadPdf(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return toast("请选择 PDF 文件");
  if (file.size > 120 * 1024 * 1024) return toast("文件过大（>120MB）");
  toast(`已载入 ${file.name}，开始处理…`);
  await IDB.set(`pdf:${S.paper.pmid}`, new Blob([await file.arrayBuffer()], { type: "application/pdf" }));
  S.page = 1;
  await prepare(S.paper);
}

/* ============================ 调试句柄 ============================ */
window.__NL = { S, renderPage };

/* ============================ 启动 ============================ */
(async function main() {
  bind();
  loadSettings();
  loadProgress();
  updateKeyBanner();

  if (location.protocol === "file:") $("#localBanner").hidden = false;

  try {
    await loadCorpus();
  } catch (e) {
    $("#brandSub").textContent = "语料加载失败";
    toast("语料加载失败：" + e.message + "（请通过 http:// 访问，而不是双击打开文件）", 8000);
    return;
  }
  renderPlan();
  await openPaper(dayFor());
})();
