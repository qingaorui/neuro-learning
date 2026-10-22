"use strict";

/* ---------------- 基础工具 ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body && !(opts.body instanceof Blob)
      ? { "Content-Type": "application/json" }
      : undefined,
    ...opts,
  });
  if (!res.ok) {
    let msg = res.status + "";
    try { msg = (await res.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

const state = {
  current: null,       // 当前打开的 day 序号
  paper: null,
  status: null,
  job: null,
  page: 1,
  pageCount: 1,
  mode: "translated",
  translation: null,
  pollTimer: null,
  version: 0,          // 用于给页面图片加缓存失效参数
};

/* ---------------- 启动 ---------------- */
document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  bindChat();
  await refresh();
  loadPlan();
});

async function refresh() {
  try {
    const data = await api("/api/state");
    applyState(data);
    if (state.current === null) {
      state.current = data.today.day;
      await openPaper(data.today.day);
    }
  } catch (err) {
    toast("加载失败：" + err.message);
  }
}

function applyState(data) {
  const { today, config, stats, job } = data;

  $("#brandSub").textContent = `${today.total} 篇 · 每日一篇`;
  // 顶栏显示的是「正在看的那篇」；只有还没选篇目时才回落到今日
  if (state.current === null) {
    $("#dayPill").textContent = today.paper.id;
    $("#dateText").textContent = `${today.date} · 第 ${today.day} / ${today.total} 天`;
  }

  const pct = stats.percent || 0;
  $("#progBar").style.width = pct + "%";
  $("#progText").textContent = `${stats.read} / ${stats.total} 已读（${pct}%）`;
  $("#streakText").textContent = stats.streak ? `连续 ${stats.streak} 天` : "";

  const hasKey = config.llm.has_key;
  $("#noKeyBanner").hidden = hasKey || config.llm.mock;

  if (!$("#cfgBaseUrl").value) {
    $("#cfgBaseUrl").value = config.llm.base_url;
    $("#cfgModel").value = config.llm.model;
    $("#cfgStart").value = config.schedule.start_date;
    $("#cfgMock").checked = !!config.llm.mock;
    $("#keyHint").textContent = config.llm.key_hint ? `（已保存 ${config.llm.key_hint}）` : "（未设置）";
  }

  if (job) setJob(job);
}

/* ---------------- 侧栏目录 ---------------- */
async function loadPlan() {
  const [{ modules }, { plan }] = await Promise.all([api("/api/modules"), api("/api/plan")]);
  const nav = $("#plan");
  nav.innerHTML = "";
  const byModule = {};
  plan.forEach((p) => (byModule[p.module] = byModule[p.module] || []).push(p));

  modules.forEach((mod) => {
    const items = byModule[mod.id] || [];
    if (!items.length) return;
    const head = document.createElement("div");
    head.className = "mod";
    head.textContent = `${mod.id === "M00" ? "原典" : mod.name} · ${mod.count}`;
    nav.appendChild(head);
    items.forEach((p) => {
      const el = document.createElement("div");
      el.className = "item" + (p.read ? " done" : "") + (String(state.current) === p.id ? " active" : "");
      el.dataset.id = p.id;
      el.innerHTML = `<span class="d">${p.id}</span><span class="t" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</span>`;
      el.addEventListener("click", () => openPaper(p.id));
      nav.appendChild(el);
    });
  });
}

/* ---------------- 打开某篇 ---------------- */
async function openPaper(dayOrId) {
  stopPolling();
  const data = await api(`/api/paper/${dayOrId}`);
  state.current = data.paper.id;
  state.paper = data.paper;
  state.status = data.status;
  state.job = data.job;

  renderPaper();
  renderAbstract();
  await renderTranslation();
  renderInterpretation();
  markActiveInPlan();
  setJob(data.job);
  if ($("#chatDrawer").classList.contains("open")) await loadChat();
  else $("#chatPaperId").textContent = state.current;
}

function renderPaper() {
  const p = state.paper;
  $("#dayPill").textContent = p.id;
  $("#dateText").textContent = `${p.journal} · ${p.year}`;

  const tags = [
    `<span class="tag ${p.type}">${p.type_name}</span>`,
    `<span class="tag${p.level === 3 ? " lv3" : ""}">${p.level_name}</span>`,
    `<span class="tag">${escapeHtml(p.journal)} ${p.year}</span>`,
  ];
  if (state.status && state.status.has_pdf) tags.push(`<span class="tag">PDF 已就位</span>`);
  $("#paperMeta").innerHTML = tags.join("");

  $("#paperTitle").textContent = p.title;
  $("#paperSub").textContent = (p.authors || []).slice(0, 6).join(", ") +
    (p.authors && p.authors.length > 6 ? " 等" : "") + (p.doi ? ` · DOI ${p.doi}` : "");
  $("#paperNote").textContent = p.note;
  $("#btnPubmed").href = p.url;

  const read = state.status && state.status.read;
  $("#btnRead").textContent = read ? "已读 ✓" : "标记已读";
}

function renderAbstract() {
  const p = state.paper;
  const body = $("#abstractBody");
  if (!p.abstract) {
    body.innerHTML = `<p>${escapeHtml(p.abstract_note || "该条目在 PubMed 上没有摘要。")}</p>`;
  } else {
    body.innerHTML = p.abstract.split(/\n{2,}/).map((x) => `<p>${escapeHtml(x)}</p>`).join("");
  }

  const cells = [
    ["PMID", p.pmid],
    ["DOI", p.doi || "—"],
    ["期刊", `${p.journal} (${p.year})`],
    ["课程位置", `${p.module} · ${p.id}`],
    ["全文可得性", (state.status && state.status.fulltext_available) ? "PMC 全文" : "仅摘要"],
    ["免费全文", p.pdf_free ? `<a href="${p.pdf_free}" target="_blank" rel="noopener">PMC 链接</a>` : "无"],
  ];
  $("#metaGrid").innerHTML = cells
    .map(([k, v]) => `<div class="cell"><b>${k}</b>${v}</div>`)
    .join("");
}

/* ---------------- 译文 ---------------- */
async function renderTranslation() {
  const data = await api(`/api/paper/${state.current}/translation`);
  state.translation = data;

  const toolbar = $("#tlToolbar");
  const empty = $("#tlEmpty");
  const pageView = $("#pageView");
  const textView = $("#textView");

  if (data.mode === "none") {
    toolbar.hidden = true; pageView.hidden = true; textView.hidden = true;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  if (data.mode === "pdf") {
    toolbar.hidden = false;
    pageView.hidden = false;
    textView.hidden = true;
    state.pageCount = data.page_count || 1;
    state.page = Math.min(state.page, state.pageCount);
    $("#btnPdfDown").href = `/api/pdf/${state.current}/translated.pdf`;
    await showPage();
  } else {
    toolbar.hidden = true;
    pageView.hidden = true;
    textView.hidden = false;
    renderTextTranslation(data);
  }
}

function renderTextTranslation(data) {
  const tv = $("#textView");
  tv.innerHTML = "";
  const note = data.note && data.note.note ? data.note.note : "";
  if (note) {
    const tip = document.createElement("div");
    tip.className = "tl-empty";
    tip.style.padding = "12px";
    tip.style.fontSize = "12.5px";
    tip.textContent = note;
    tv.appendChild(tip);
  }
  (data.items || []).forEach((it) => {
    const div = document.createElement("div");
    div.className = "seg-block " + it.kind;
    const label = it.label ? `<span class="label">${escapeHtml(it.label)}</span>` : "";
    const zh = it.zh ? `<div class="zh">${escapeHtml(it.zh)}</div>` : "";
    const en = it.en ? `<div class="en">${escapeHtml(it.en)}</div>` : "";
    div.innerHTML = label + (zh || `<div class="zh" style="color:#8a8a92">（此段待翻译）</div>`) + en;
    tv.appendChild(div);
  });
}

async function showPage() {
  const img = $("#pageImg");
  img.src = `/api/paper/${state.current}/page/${state.page}.png?mode=${state.mode}&v=${state.version}`;
  $("#pageLabel").textContent = `${state.page} / ${state.pageCount}`;
  $("#btnPrev").disabled = state.page <= 1;
  $("#btnNext").disabled = state.page >= state.pageCount;
}

/* ---------------- 解读 ---------------- */
async function renderInterpretation() {
  const { interpretation } = await api(`/api/paper/${state.current}/interpretation`);
  const body = $("#interpBody");
  const empty = $("#ipEmpty");
  if (!interpretation) {
    empty.hidden = false;
    body.innerHTML = "";
    return;
  }
  empty.hidden = true;
  const d = interpretation;
  const parts = [];

  if (d.mock) {
    parts.push(`<div class="banner" style="margin:0">当前是占位解读。配置 API Key 后重新生成即可得到真实内容。</div>`);
  }
  if (d.one_liner) parts.push(`<div class="card oneliner">${escapeHtml(d.one_liner)}</div>`);
  if (d.question) parts.push(card("要回答的问题", `<p>${escapeHtml(d.question)}</p>`));
  if (d.background && d.background.length) parts.push(card("前置知识", list(d.background)));
  if (d.methods && d.methods.length) {
    parts.push(card("方法拆解", d.methods.map((m) =>
      `<div class="kv"><b>${escapeHtml(m.name || "")}</b><div>${escapeHtml(m.what || "")}</div>
       <div class="sub">为什么用：${escapeHtml(m.why || "")}</div></div>`).join("")));
  }
  if (d.findings && d.findings.length) {
    parts.push(card("关键结果", d.findings.map((f) =>
      `<div class="kv"><b>${escapeHtml(f.point || "")}</b>
       <div class="sub">证据：${escapeHtml(f.evidence || "")}</div></div>`).join("")));
  }
  if (d.figures && d.figures.length) {
    parts.push(card("图表逐张读法", d.figures.map((f) =>
      `<div class="kv"><b>${escapeHtml(f.label || "")}</b>
       <div>${escapeHtml(f.caption_zh || "")}</div>
       <div class="sub">怎么看：${escapeHtml(f.read_this || "")}</div></div>`).join("")));
  }
  if (d.caveats) parts.push(card("局限与争议", `<p>${escapeHtml(d.caveats)}</p>`));
  if (d.connection) parts.push(card("在课程里的位置", `<p>${escapeHtml(d.connection)}</p>`));
  if (d.glossary && d.glossary.length) {
    parts.push(card("术语表", `<div class="gloss">${d.glossary.map((g) =>
      `<div class="row"><span class="term">${escapeHtml(g.term || "")}</span>
       <span><b>${escapeHtml(g.zh || "")}</b> ${escapeHtml(g.note || "")}</span></div>`).join("")}</div>`));
  }
  if (d.quiz && d.quiz.length) parts.push(card("自测问题", list(d.quiz, "ol")));

  body.innerHTML = parts.join("");
}

function card(title, inner) {
  return `<div class="card"><h3>${title}</h3>${inner}</div>`;
}
function list(arr, tag = "ul") {
  return `<${tag}>${arr.map((x) => `<li>${escapeHtml(String(x))}</li>`).join("")}</${tag}>`;
}

/* ---------------- 任务 ---------------- */
function setJob(job) {
  state.job = job;
  const dot = $("#statusDot");
  const bar = $("#jobBar");
  dot.className = "status-dot " + (job && job.status === "running" ? "running"
    : job && job.status === "done" ? "done"
    : job && job.status === "error" ? "error" : "");

  if (!job || job.status === "idle") {
    bar.hidden = true;
    $("#jobText").textContent = "";
    return;
  }
  bar.hidden = false;
  $("#jobFill").style.width = Math.round((job.progress || 0) * 100) + "%";
  $("#jobLabel").textContent = job.status === "error"
    ? `失败：${job.message}`
    : `${job.stage} · ${job.message || ""}`;
  $("#jobText").textContent = job.status === "running" ? "处理中…"
    : job.status === "done" ? "已就绪" : "出错了";

  if (job.status === "running") startPolling();
  if (job.status === "done") stopPolling();
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    try {
      const { job } = await api(`/api/paper/${state.current}/job`);
      setJob(job);
      if (job.status === "done") {
        stopPolling();
        await openPaper(state.current);
        await loadPlan();
        await refresh();
      }
      if (job.status === "error") stopPolling();
    } catch (_) { /* 轮询失败忽略，下一次再试 */ }
  }, 1300);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function startPrepare() {
  const btn = $("#btnPrepare");
  btn.disabled = true;
  try {
    const { job } = await api(`/api/paper/${state.current}/prepare`, {
      method: "POST",
      body: JSON.stringify({ translate: true, interpret: true }),
    });
    setJob(job);
  } catch (err) {
    toast("启动失败：" + err.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 上传 PDF ---------------- */
async function uploadPdf(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    return toast("请选择 PDF 文件");
  }
  toast(`正在上传 ${file.name}（${(file.size / 1048576).toFixed(1)} MB）…`);
  try {
    await api(`/api/paper/${state.current}/pdf`, { method: "POST", body: file });
    toast("PDF 已保存，开始生成对照译文…");
    state.version = Date.now();
    await startPrepare();
  } catch (err) {
    toast("上传失败：" + err.message);
  }
}

async function autoPdf() {
  toast("正在查询开放获取版本…");
  try {
    const res = await api(`/api/paper/${state.current}/autopdf`, { method: "POST" });
    toast(res.message || (res.ok ? "已获取" : "未获取到"));
    if (res.ok) await openPaper(state.current);
  } catch (err) {
    toast("查询失败：" + err.message);
  }
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((t) => t.classList.remove("active"));
      $$(".panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      $("#panel-" + tab.dataset.tab).classList.add("active");
      if (tab.dataset.tab === "translation" && state.translation) {
        if (state.translation.mode === "pdf") showPage();
      }
    });
  });

  $("#btnToday").addEventListener("click", async () => {
    const data = await api("/api/state");
    await openPaper(data.today.day);
  });

  $("#btnPrepare").addEventListener("click", startPrepare);
  ["#btnPrepare2", "#btnPrepare3"].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener("click", () => {
      $$(".tab")[1].click();
      startPrepare();
    });
  });

  $("#btnUpload").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", (e) => uploadPdf(e.target.files[0]));
  $("#btnAutoPdf").addEventListener("click", autoPdf);

  $("#btnRead").addEventListener("click", async () => {
    const read = !(state.status && state.status.read);
    await api(`/api/paper/${state.current}/read`, {
      method: "POST",
      body: JSON.stringify({ read }),
    });
    await openPaper(state.current);
    await loadPlan();
    await refresh();
  });

  // 拖拽上传
  const card = $("#paperCard");
  ["dragenter", "dragover"].forEach((ev) =>
    card.addEventListener(ev, (e) => { e.preventDefault(); card.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) =>
    card.addEventListener(ev, (e) => { e.preventDefault(); card.classList.remove("dragover"); }));
  card.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    uploadPdf(file);
  });

  // 页码与模式
  $("#btnPrev").addEventListener("click", () => { if (state.page > 1) { state.page--; showPage(); } });
  $("#btnNext").addEventListener("click", () => { if (state.page < state.pageCount) { state.page++; showPage(); } });
  $$("#modeSeg button").forEach((b) => {
    b.addEventListener("click", () => {
      $$("#modeSeg button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      state.mode = b.dataset.mode;
      showPage();
    });
  });
  $("#zoom").addEventListener("input", (e) => {
    $("#pageImg").style.width = e.target.value + "%";
  });

  // 设置
  const dlg = $("#settingsDlg");
  const openSettings = () => dlg.showModal();
  $("#btnSettings").addEventListener("click", openSettings);
  $("#btnBannerSettings").addEventListener("click", openSettings);
  $("#dlgCancel").addEventListener("click", () => dlg.close());
  $("#dlgSave").addEventListener("click", async () => {
    const payload = {
      base_url: $("#cfgBaseUrl").value.trim(),
      model: $("#cfgModel").value.trim(),
      mock: $("#cfgMock").checked,
      start_date: $("#cfgStart").value,
    };
    const key = $("#cfgKey").value.trim();
    if (key) payload.api_key = key;
    await api("/api/config", { method: "POST", body: JSON.stringify(payload) });
    dlg.close();
    $("#cfgKey").value = "";
    toast("设置已保存");
    await refresh();
  });
}

function markActiveInPlan() {
  $$(".plan .item").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === state.current);
  });
}

/* ---------------- 对话 ---------------- */
const CHAT_QUICK = [
  "一句话讲清这篇到底做了什么",
  "带我读其中一张图",
  "这个方法的局限在哪",
  "它和课程里哪几篇呼应",
  "给我出 3 道自测题",
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
  wrap.appendChild(who);
  wrap.appendChild(bubble);
  return wrap;
}

function renderMd(src) {
  const esc = escapeHtml(src);
  const parts = esc.split("```");
  let out = "";
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out += "<pre>" + part.replace(/^[a-zA-Z]*\n/, "") + "</pre>";
    } else {
      out += inlineMd(part);
    }
  });
  return out;
}

function inlineMd(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .split(/\n{2,}/)
    .filter((b) => b.trim() !== "")
    .map((block) => {
      const lines = block.split("\n").filter((l) => l.trim() !== "");
      if (lines.length && lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
        return "<ul>" + lines.map((l) => "<li>" + l.replace(/^\s*[-*•]\s+/, "") + "</li>").join("") + "</ul>";
      }
      if (lines.length && lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
        return "<ol>" + lines.map((l) => "<li>" + l.replace(/^\s*\d+[.)]\s+/, "") + "</li>").join("") + "</ol>";
      }
      return "<p>" + block.replace(/\n/g, "<br>") + "</p>";
    })
    .join("");
}

async function loadChat() {
  const log = $("#chatLog");
  log.innerHTML = "";
  $("#chatPaperId").textContent = state.current || "—";
  let history = [];
  try {
    history = (await api(`/api/paper/${state.current}/chat`)).history || [];
  } catch (_) { /* 没有历史也无妨 */ }
  if (!history.length) {
    const hint = bubbleEl("bot", "就这篇论文问我任何问题：结论、某张图怎么看、方法局限、和课程的关联，或者让我出题考你。\n\n回答会依据这篇的正文与图表，并标明出处；论文没写的内容我会直说。");
    log.appendChild(hint);
  } else {
    history.forEach((turn) => log.appendChild(bubbleEl(turn.role, turn.content)));
    log.scrollTop = log.scrollHeight;
  }
}

async function sendChat(text) {
  if (state.chatBusy) return;
  const question = (text || $("#chatText").value || "").trim();
  if (!question) return;
  $("#chatText").value = "";
  autoGrow($("#chatText"));

  const log = $("#chatLog");
  log.appendChild(bubbleEl("user", question));
  const botWrap = bubbleEl("bot", "");
  const bubble = botWrap.querySelector(".bubble");
  bubble.classList.add("typing");
  log.appendChild(botWrap);
  log.scrollTop = log.scrollHeight;

  state.chatBusy = true;
  $("#chatSend").disabled = true;
  $("#chatText").disabled = true;

  let acc = "";
  try {
    const res = await fetch(`/api/paper/${state.current}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: question }),
    });
    if (!res.ok) {
      let msg = String(res.status);
      try { msg = (await res.json()).error || msg; } catch (_) {}
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = raw.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
        if (obj.delta) {
          acc += obj.delta;
          bubble.classList.add("typing");
          bubble.innerHTML = renderMd(acc);
          log.scrollTop = log.scrollHeight;
        }
        if (obj.error) {
          const e = document.createElement("div");
          e.className = "err";
          e.textContent = "出错：" + obj.error;
          botWrap.appendChild(e);
        }
        if (obj.done) bubble.classList.remove("typing");
      }
    }
  } catch (err) {
    const e = document.createElement("div");
    e.className = "err";
    e.textContent = "请求失败：" + err.message;
    botWrap.appendChild(e);
  } finally {
    bubble.classList.remove("typing");
    if (!acc && !botWrap.querySelector(".err")) {
      bubble.textContent = "（没有收到内容，可能是网络或模型接口的问题）";
    }
    state.chatBusy = false;
    $("#chatSend").disabled = false;
    $("#chatText").disabled = false;
    $("#chatText").focus();
    loadPlan();
  }
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

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 140) + "px";
}

function bindChat() {
  $("#chatFab").addEventListener("click", openChat);
  $("#chatClose").addEventListener("click", closeChat);

  $("#chatClear").addEventListener("click", async () => {
    if (!confirm("清空这篇论文的对话记录？")) return;
    await api(`/api/paper/${state.current}/chat/clear`, { method: "POST", body: "{}" });
    await loadChat();
  });

  const quick = $("#chatQuick");
  CHAT_QUICK.forEach((q) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = q;
    b.addEventListener("click", () => sendChat(q));
    quick.appendChild(b);
  });

  $("#chatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    sendChat();
  });

  const ta = $("#chatText");
  ta.addEventListener("input", () => autoGrow(ta));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
    if (e.key === "Escape") closeChat();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#chatDrawer").classList.contains("open")) closeChat();
  });
}

/* ---------------- 杂项 ---------------- */
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

let toastTimer = null;
function toast(msg) {
  let el = $("#toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.style.cssText = `position:fixed;left:50%;bottom:28px;transform:translateX(-50%);
      background:#1c1c1e;color:#fff;padding:10px 18px;border-radius:10px;font-size:13.5px;
      z-index:99;box-shadow:0 8px 26px rgba(0,0,0,.22);max-width:70vw`;
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = "1";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .4s"; }, 3200);
}
