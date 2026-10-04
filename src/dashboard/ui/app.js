/* MCP-Server 控制中心前端 */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------- 基础 ---------- */
/** 主题：dark/light，存 localStorage，实时生效 */
function applyTheme() {
  let t = "dark";
  try { t = localStorage.getItem("theme") || "dark"; } catch { /* ignore */ }
  document.documentElement.dataset.theme = t;
  return t;
}
async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `请求失败 ${r.status}`);
  return data;
}
function toast(msg, ok = true) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span class="dot ${ok ? "green" : "red"}"></span>${msg}`;
  $("#toast-wrap").appendChild(el);
  setTimeout(() => el.remove(), 2600);
}
/** 一键部署拉取源：GitHub（国外服务器）/ Gitee（国内服务器） */
const GW_SOURCES = {
  github: {
    label: "GitHub",
    hint: "国外服务器",
    script: "https://raw.githubusercontent.com/bhh3349/MCP-Server/main/scripts/quick_start.sh",
    bundle: "https://raw.githubusercontent.com/bhh3349/MCP-Server/main/release/gateway.cjs",
  },
  gitee: {
    label: "Gitee",
    hint: "国内服务器",
    script: "https://gitee.com/bhh3349/MCP-Server/raw/main/scripts/quick_start.sh",
    bundle: "https://gitee.com/bhh3349/MCP-Server/raw/main/release/gateway.cjs",
  },
};
function gwSource() {
  const k = localStorage.getItem("gwSource");
  return GW_SOURCES[k] ? k : "gitee";
}
/** 系统内置的部署命令：重复执行=升级，自动沿用服务器上已有的 token 和端口（没有才用默认值） */
function gwDeployCommand() {
  const src = GW_SOURCES[gwSource()];
  return `OLD_TOKEN=$(grep GATEWAY_TOKENS ~/mcp-gateway/gateway.env 2>/dev/null | cut -d= -f2); OLD_PORT=$(grep GATEWAY_PORT ~/mcp-gateway/gateway.env 2>/dev/null | cut -d= -f2); GATEWAY_PORT=\${OLD_PORT:-8080} GATEWAY_TOKEN="$OLD_TOKEN" BUNDLE_URL="${src.bundle}" bash -c "$(curl -sSL ${src.script})"`;
}
/** 读取 SSH 表单（密码只留内存，不持久化） */
function readSshCfg() {
  const num = (v, d) => (/^\d{1,5}$/.test(v.trim()) ? parseInt(v.trim(), 10) : d);
  return {
    host: $("#gw-ip").value.trim() || "23.251.34.248",
    sshPort: num($("#gw-sshport").value, 22),
    username: $("#gw-user").value.trim() || "root",
    password: $("#gw-pass").value,
  };
}
/** 一键部署网关：经 SSH 在服务器上执行，后台轮询输出 */
async function gwDeployRun() {
  const cfg = readSshCfg();
  if (!cfg.password) { toast("请填写 SSH 密码", false); return; }
  const custom = $("#gw-custom-cmd").value.trim();
  const command = custom || gwDeployCommand();
  localStorage.setItem("gwSsh", JSON.stringify({ host: $("#gw-ip").value.trim(), sshPort: $("#gw-sshport").value.trim(), username: $("#gw-user").value.trim() }));
  // 用户主动点的按钮，不走审批，直接弹终端执行
  openSshTerminal({ title: "一键部署", runCommand: command });
}
/** 内置 SSH 终端（xterm.js + WebSocket + ssh2 shell） */
/** 内置 SSH 终端（xterm.js + WebSocket + ssh2 shell）；传 runCommand 则连上后自动执行（用于一键部署） */
async function openSshTerminal(opts = {}) {
  const { title = "SSH 终端", runCommand = "" } = opts;
  const cfg = readSshCfg();
  if (!cfg.password) { toast("请填写 SSH 密码", false); return; }
  let token;
  try {
    token = (await api("/api/ssh/terminal", { method: "POST", body: cfg })).token;
  } catch (e) { toast(e.message, false); return; }
  openModal(`<div class="modal-title" style="margin-bottom:10px">${esc(title)} <span class="hint mono" style="font-weight:400">${esc(cfg.username)}@${esc(cfg.host)}:${cfg.sshPort}</span></div>
    <div id="ssh-term" class="ssh-term"></div>
    <div class="modal-actions"><button class="btn ghost sm" id="ssh-close">断开</button></div>`);
  $("#modal-box").classList.add("set-wide");
  const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "'JetBrains Mono', monospace", theme: { background: "#0b0b10" } });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open($("#ssh-term"));
  fitAddon.fit();
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/ssh/terminal/ws?token=${token}`);
  ws.binaryType = "arraybuffer";
  const dec = new TextDecoder();
  let dead = false;
  let output = "";
  let deployDone = false;
  let cmdSent = false;
  const fullCmd = runCommand ? `${runCommand}; echo "MCP_DEPLOY_EXIT:$?"` : "";
  const sendCmd = () => {
    if (cmdSent || !fullCmd || ws.readyState !== 1) return;
    cmdSent = true;
    ws.send(JSON.stringify({ t: "in", d: fullCmd + "\n" }));
  };
  const saveGateway = (connToken, host, port) => {
    const url = `ws://${host}:${port}`;
    localStorage.setItem("dfGwUrl", url);
    localStorage.setItem("dfGwToken", connToken);
    ChannelsPage.dfGw = { url, token: connToken };
  };
  const cleanup = () => {
    if (dead) return;
    dead = true;
    try { ws.close(); } catch { /* ignore */ }
    try { term.dispose(); } catch { /* ignore */ }
    window.removeEventListener("resize", onResize);
    $("#modal-overlay").removeEventListener("click", onOverlay);
  };
  const onOverlay = (e) => { if (e.target.id === "modal-overlay") { cleanup(); } };
  const onResize = () => {
    try {
      fitAddon.fit();
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: "rs", c: term.cols, r: term.rows }));
    } catch { /* ignore */ }
  };
  $("#modal-overlay").addEventListener("click", onOverlay);
  window.addEventListener("resize", onResize);
  term.write("正在连接 SSH…\r\n");
  ws.onopen = () => { term.reset(); onResize(); };
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      try {
        const o = JSON.parse(ev.data);
        if (o.t === "ready") { sendCmd(); return; }
        if (o.t === "err") term.write(`\r\n\x1b[31m${o.m}\x1b[0m\r\n`);
      } catch { /* ignore */ }
      return;
    }
    const text = dec.decode(new Uint8Array(ev.data), { stream: true });
    output += text;
    if (output.length > 300000) output = output.slice(-300000);
    term.write(text);
    if (fullCmd && !deployDone) {
      const dm = output.match(/MCP_DEPLOY_EXIT:(\d+)/);
      if (dm) {
        deployDone = true;
        if (dm[1] === "0") {
          const cm = output.match(/mcp-gw:\/\/([^@\s]+)@([^\s:]+):(\d+)/);
          if (cm) {
            saveGateway(cm[1], cm[2], cm[3]);
            term.write("\r\n\x1b[32m[部署成功，网关信息已自动填入默认网关]\x1b[0m\r\n");
          } else {
            term.write("\r\n\x1b[32m[部署成功]\x1b[0m\r\n");
          }
        } else {
          term.write(`\r\n\x1b[31m[部署失败，exit=${dm[1]}]\x1b[0m\r\n`);
        }
      }
    }
  };
  ws.onclose = () => term.write("\r\n\x1b[2m[连接已断开]\x1b[0m\r\n");
  ws.onerror = () => term.write("\r\n\x1b[31m[WebSocket 错误]\x1b[0m\r\n");
  term.onData((d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: "in", d })); });
  $("#ssh-close").addEventListener("click", () => { cleanup(); closeModal(); });
}
/** 解析粘贴的网关信息：mcp-gw://token@host:port / 部署输出 / 地址+Token */
function parseGwImport(text) {
  const t = (text || "").trim();
  if (!t) return null;
  const clean = (u) => u.replace(/\/+$/, "");
  // 1) mcp-gw://token@host:port
  let m = t.match(/mcp-gw:\/\/([^@\s]+)@([^\s"']+)/i);
  if (m) {
    let host = clean(m[2]);
    if (!/^wss?:\/\//i.test(host)) host = "ws://" + host;
    return { url: host, token: m[1].trim() };
  }
  // 2) 文本中的 URL + 64 位 hex token
  const um = t.match(/(wss?:\/\/[^\s"']+|https?:\/\/[^\s"']+)/i);
  const tm = t.match(/\b([0-9a-fA-F]{64})\b/);
  if (um && tm) {
    let url = clean(um[1]).replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
    return { url, token: tm[1] };
  }
  // 3) 兜底：两行分别是地址和 token
  const lines = t.split("\n").map((s) => s.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const ui = lines.findIndex((l) => /^(wss?:\/\/|https?:\/\/|[^/\s]+:\d+)/i.test(l));
    if (ui >= 0) {
      const ti = lines.findIndex((l, i) => i !== ui && l.length >= 8);
      if (ti >= 0) {
        let url = clean(lines[ui]);
        if (!/^wss?:\/\//i.test(url)) url = url.replace(/^https?:\/\//i, (s) => s.toLowerCase().startsWith("https") ? "wss://" : "ws://");
        if (!/^wss?:\/\//i.test(url)) url = "ws://" + url;
        return { url, token: lines[ti] };
      }
    }
  }
  return null;
}
/** 自定义下拉（替代原生 select，无原生样式） */
function initCSelect(id, { value, options, onChange }) {
  const root = document.getElementById(id);
  if (!root) return null;
  root.innerHTML = `<button type="button" class="cselect-btn"><span class="cselect-val"></span><span class="cselect-arrow"></span></button>
    <div class="cselect-list hidden">${options.map((o) => `<div class="cselect-opt" data-v="${o.value}">${esc(o.label)}</div>`).join("")}</div>`;
  const btn = root.querySelector(".cselect-btn");
  const valEl = root.querySelector(".cselect-val");
  const list = root.querySelector(".cselect-list");
  const setVal = (v, fire = true) => {
    const opt = options.find((o) => o.value === v) || options[0];
    root.dataset.value = opt.value;
    valEl.textContent = opt.label;
    list.querySelectorAll(".cselect-opt").forEach((el) => el.classList.toggle("sel", el.dataset.v === opt.value));
    if (fire) onChange?.(opt.value);
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllCSelect(root);
    const opening = list.classList.contains("hidden");
    if (opening) {
      // fixed 定位，避免被滚动容器裁掉；空间不足时向上展开
      const r = btn.getBoundingClientRect();
      const h = Math.min(190, options.length * 36 + 8);
      list.style.position = "fixed";
      list.style.width = Math.max(r.width, 120) + "px";
      list.style.left = Math.min(r.left, window.innerWidth - Math.max(r.width, 120) - 12) + "px";
      list.style.top = (r.bottom + 6 + h > window.innerHeight ? r.top - 6 - h : r.bottom + 6) + "px";
      list.style.maxHeight = h + "px";
    }
    root.classList.toggle("open", opening);
    list.classList.toggle("hidden", !opening);
  });
  list.querySelectorAll(".cselect-opt").forEach((el) => el.addEventListener("click", (e) => {
    e.stopPropagation();
    setVal(el.dataset.v);
    root.classList.remove("open");
    list.classList.add("hidden");
  }));
  setVal(value, false);
  root._setVal = (v) => setVal(v, false);
  root._getVal = () => root.dataset.value;
  return root;
}
function closeAllCSelect(except) {
  document.querySelectorAll(".cselect.open").forEach((el) => {
    if (el === except) return;
    el.classList.remove("open");
    el.querySelector(".cselect-list")?.classList.add("hidden");
  });
}
document.addEventListener("click", () => closeAllCSelect());
function copyText(t) {
  navigator.clipboard.writeText(t).then(() => toast("已复制"), () => toast("复制失败", false));
}
function openModal(html) {
  $("#modal-box").innerHTML = html;
  $("#modal-overlay").classList.remove("hidden");
}
function closeModal() { $("#modal-overlay").classList.add("hidden"); $("#modal-box").classList.remove("set-wide"); }
$("#modal-overlay").addEventListener("click", (e) => { if (e.target.id === "modal-overlay") closeModal(); });

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return d > 0 ? `${d}天 ${h}时` : h > 0 ? `${h}时 ${m}分` : `${m}分`;
}
function fmtTime(ts) {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function dotFor(ch) {
  if (ch.liveness === "closed" || ch.liveness === "mcp_lost") return "red";
  if (ch.kind === "local") return "green";
  if (ch.paired) return "green";
  return "yellow";
}

/* ---------- 路由 ---------- */
const PAGE_TITLES = { overview: "概览", channels: "信道", plugins: "插件", skills: "技能", connectors: "连接器", tools: "工具", logs: "日志", errors: "错误" };
let currentPage = "overview";
const pageInited = {};
function navTo(page) {
  currentPage = page;
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${page}`));
  $("#crumb-page").textContent = PAGE_TITLES[page];
  if (!pageInited[page]) { pageInited[page] = true; PAGES[page].init?.(); }
  PAGES[page].show?.();
  stopLive();
  LogsPage.stop(); ErrorsPage.stop();
  if (page === "overview") startLive();
  if (page === "logs") LogsPage.start();
  if (page === "errors") ErrorsPage.start();
}
$$(".nav-item").forEach((b) => b.addEventListener("click", () => { if (b.dataset.page) navTo(b.dataset.page); }));
$("#collapse-btn").addEventListener("click", () => {
  const sb = $("#sidebar");
  sb.classList.toggle("collapsed");
  $("#collapse-btn").textContent = sb.classList.contains("collapsed") ? "»" : "«";
});

/* ---------- Cmd+K ---------- */
let cmdkIndex = [];
async function buildCmdkIndex() {
  try {
    const ov = await api("/api/overview");
    const chs = await api("/api/channels");
    cmdkIndex = [
      ...ov.tools.list.map((t) => ({ label: t.name, sub: t.description?.slice(0, 40) || "", type: "tool", data: t })),
      ...chs.map((c) => ({ label: c.name, sub: c.bindingId, type: "channel", data: c })),
    ];
  } catch { /* ignore */ }
}
function openCmdk() {
  $("#cmdk-overlay").classList.remove("hidden");
  $("#cmdk-input").value = "";
  renderCmdk("");
  setTimeout(() => $("#cmdk-input").focus(), 30);
}
function closeCmdk() { $("#cmdk-overlay").classList.add("hidden"); }
function renderCmdk(q) {
  const list = cmdkIndex.filter((i) => i.label.toLowerCase().includes(q.toLowerCase())).slice(0, 12);
  $("#cmdk-list").innerHTML = list.map((i, n) =>
    `<div class="cmdk-item${n === 0 ? " sel" : ""}" data-n="${n}"><span class="k">${esc(i.label)}</span><span>${esc(i.sub)}</span><span class="t">${i.type === "tool" ? "工具" : "信道"}</span></div>`
  ).join("") || `<div class="hint" style="padding:16px">无匹配</div>`;
  $$(".cmdk-item").forEach((el) => el.addEventListener("click", () => {
    const item = list[+el.dataset.n];
    closeCmdk();
    if (item.type === "tool") { navTo("tools"); ToolsPage.openPlayground(item.data); }
    else navTo("channels");
  }));
}
$("#cmdk-btn").addEventListener("click", openCmdk);
$("#cmdk-overlay").addEventListener("click", (e) => { if (e.target.id === "cmdk-overlay") closeCmdk(); });
$("#cmdk-input").addEventListener("input", (e) => renderCmdk(e.target.value));
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openCmdk(); }
  if (e.key === "Escape") { closeCmdk(); closeModal(); }
});

/* ---------- 画布图表 ---------- */
function setupCanvas(cv, h) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || cv.parentElement.clientWidth;
  cv.width = w * dpr; cv.height = h * dpr;
  cv.style.height = h + "px";
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  return { ctx, w, h };
}
function smoothPath(ctx, pts, w, h, max) {
  ctx.beginPath();
  pts.forEach((v, i) => {
    const x = (i / (pts.length - 1)) * w, y = h - (v / max) * (h - 8) - 4;
    if (i === 0) ctx.moveTo(x, y);
    else {
      const px = ((i - 1) / (pts.length - 1)) * w, py = h - (pts[i - 1] / max) * (h - 8) - 4;
      ctx.bezierCurveTo(px + (x - px) / 2, py, px + (x - px) / 2, y, x, y);
    }
  });
}
function drawLineChart(cv, series, colors) {
  const { ctx, w, h } = setupCanvas(cv, 150);
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(10, ...series.flat());
  series.forEach((pts, si) => {
    smoothPath(ctx, pts, w, h, max);
    ctx.strokeStyle = colors[si]; ctx.lineWidth = 2; ctx.stroke();
    // 面积渐变
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, colors[si] + "44"); g.addColorStop(1, colors[si] + "00");
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.fillStyle = g; ctx.fill();
  });
}
function drawSpark(cv, pts, color) {
  const { ctx, w, h } = setupCanvas(cv, 34);
  ctx.clearRect(0, 0, w, h);
  if (pts.length < 2) return;
  const max = Math.max(...pts, 1);
  smoothPath(ctx, pts, w, h, max);
  ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.stroke();
}
function drawDonut(rate) {
  const arc = $("#ov-donut-arc");
  if (!arc) return;
  const C = 326.73;
  arc.style.strokeDashoffset = String(C * (1 - rate));
  arc.style.stroke = rate > 0.95 ? "#4ade80" : rate > 0.8 ? "#facc15" : "#f87171";
}
/* MCP CORE 紫色仪表盘 */
/* 吞吐：柱状 + 双线 + 坐标轴（图一还原） */
function drawThroughput(cv, req, ok) {
  const box = cv.closest(".inner-box");
  const H = box ? Math.max(120, box.clientHeight - 40) : 150;
  const { ctx, w, h } = setupCanvas(cv, H);
  ctx.clearRect(0, 0, w, h);
  const padL = 30, padB = 18, padT = 8, cw = w - padL - 8, ch = h - padT - padB;
  const max = Math.max(10, ...req, ...ok);
  const n = req.length, bw = Math.max(2, (cw / n) * 0.45);
  // 网格 + Y 轴刻度
  ctx.font = "9px JetBrains Mono, monospace"; ctx.fillStyle = "rgba(255,255,255,.35)";
  ctx.strokeStyle = "rgba(255,255,255,.07)"; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (ch / 4) * i, v = Math.round(max * (1 - i / 4));
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - 8, y); ctx.stroke();
    ctx.fillText(String(v), 4, y + 3);
  }
  // 坐标轴
  ctx.strokeStyle = "rgba(255,255,255,.25)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + ch); ctx.stroke(); // Y 轴
  ctx.beginPath(); ctx.moveTo(padL, padT + ch); ctx.lineTo(w - 8, padT + ch); ctx.stroke(); // X 轴
  const X = (i) => padL + (i / (n - 1)) * cw;
  const Y = (v) => padT + ch - (v / max) * ch;
  // 柱状（请求）
  ctx.fillStyle = "rgba(139,92,246,.28)";
  req.forEach((v, i) => {
    const bh = (v / max) * ch;
    ctx.fillRect(X(i) - bw / 2, padT + ch - bh, bw, bh);
  });
  // 双线
  const line = (pts, color, fill) => {
    ctx.beginPath();
    pts.forEach((v, i) => { i === 0 ? ctx.moveTo(X(i), Y(v)) : ctx.lineTo(X(i), Y(v)); });
    ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.stroke();
    if (fill) {
      const g = ctx.createLinearGradient(0, padT, 0, padT + ch);
      g.addColorStop(0, color + "30"); g.addColorStop(1, color + "00");
      ctx.lineTo(X(n - 1), padT + ch); ctx.lineTo(X(0), padT + ch); ctx.closePath();
      ctx.fillStyle = g; ctx.fill();
    }
  };
  line(req, "#8b5cf6", true);
  line(ok, "#34d399", false);
  // X 轴时间
  ctx.fillStyle = "rgba(255,255,255,.35)";
  ["-60s", "-40s", "-20s", "NOW"].forEach((t, i) => {
    ctx.fillText(t, padL + (cw / 3) * i - 8, h - 5);
  });
}

/* ================= 概览 ================= */
const Overview = {
  timer: null,
  qpsHist: [], latHist: [],
  lastCalls: 0, lastTs: 0,
  logSince: 0,

  html() {
    return `
    <div class="ov-head">
      <div class="ov-title-row"><span class="ov-eyebrow">SYSTEM PULSE</span><span class="ov-title">运行概况</span></div>
      <div class="live-pill"><span class="dot green pulse"></span>LIVE</div>
    </div>
    <div class="ov-top">
      <div class="card mcpcore">
        <div class="mcpcore-main">
          <div class="ov-eyebrow">MCP CORE <span class="pill green sm" id="ov-mcp-pill">正常</span></div>
          <div class="mcpcore-status">运行中</div>
          <div class="mcpcore-sub"><b id="ov-tools" class="mono">–</b> 个工具在线</div>
        </div>
        <div class="mcpcore-gauge">
          <svg viewBox="0 0 92 92" width="84" height="84">
            <circle cx="46" cy="46" r="38" fill="none" stroke="rgba(139,92,246,.15)" stroke-width="9"/>
            <circle id="ov-gauge-arc" cx="46" cy="46" r="38" fill="none" stroke="url(#gaugeGrad)" stroke-width="9"
              stroke-linecap="round" stroke-dasharray="238.76" stroke-dashoffset="238.76"
              transform="rotate(-90 46 46)" style="transition: stroke-dashoffset .6s ease"/>
            <defs><linearGradient id="gaugeGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#a78bfa"/>
            </linearGradient></defs>
          </svg>
          <div class="gauge-label"><b id="ov-health" class="mono">–</b><span>工具健康</span></div>
        </div>
      </div>
      <div class="card">
        <div class="ov-eyebrow">GATEWAY <span class="pill green sm" id="ov-gw-pill">已连接</span></div>
        <div class="stat-num"><span id="ov-lat">–</span><small> ms</small></div>
        <canvas class="spark" id="ov-spark" style="width:100%"></canvas>
        <div class="gw-foot"><span class="hint">支持自动故障转移</span><span class="mono hint" id="ov-lat2">– ms</span></div>
      </div>
      <div class="card">
        <div class="ov-eyebrow">BRIDGE <span class="pill green sm" id="ov-br-pill">在线</span></div>
        <div class="bridge-row">
          <span class="bridge-state" id="ov-br-state">已开启</span>
          <label class="switch"><input type="checkbox" id="ov-br-switch" checked><span class="track"></span></label>
        </div>
        <div class="br-pipes"><span class="hint" id="ov-pipe-count">– 条管道</span><div class="pipe-bars" id="ov-pipe-bars"></div></div>
      </div>
      <div class="card ch-card">
        <div class="ov-eyebrow">信道<span class="hint" style="margin-left:6px"><span id="ov-ch-count">0</span> 个</span>
          <button class="text-btn" id="ov-add-ch" style="margin-left:auto">添加</button>
        </div>
        <div class="ch-list" id="ov-ch-list"><div class="ch-empty">暂无信道</div></div>
      </div>
    </div>
    <div class="ov-main">
      <div class="card tp-card">
        <div class="ov-eyebrow">DATA THROUGHPUT STREAM</div>
        <div class="tp-head"><span class="tp-title">调用吞吐</span>
          <span class="tp-legend"><i class="lg-dot" style="background:#8b5cf6"></i>请求 <b class="mono" id="ov-req-min">–</b>/min
          <i class="lg-dot" style="background:#34d399"></i>成功 <b class="mono" id="ov-ok-min">–</b>/min</span>
        </div>
        <div class="inner-box">
          <div class="inner-title">吞吐</div>
          <canvas class="chart" id="ov-chart"></canvas>
        </div>
        <div class="tp-stats">
          <span>成功率 <b class="mono" id="ov-tp-rate">–</b></span>
          <span>p50 <b class="mono" id="ov-tp-p50">–</b></span>
          <span>峰值 <b class="mono" id="ov-tp-peak">–</b>/min</span>
        </div>
      </div>
      <div class="card rank-card">
        <div class="ov-eyebrow">TOOL ACTIVITY</div>
        <div class="tp-head"><span class="tp-title">工具调用排行</span><span class="hint mono">LIVE · TOP 8</span></div>
        <div class="inner-box">
          <div class="inner-title">排行</div>
          <div id="ov-rank"></div>
        </div>
        <div class="rank-foot"><span class="hint">按最近 60 秒调用次数排序</span><span class="follow"><span class="dot green pulse"></span>更新中</span></div>
      </div>
      <div class="card chat-card">
        <div class="chat-head">
          <div class="chat-avatar" id="chat-avatar">🤖</div>
          <div><div class="tp-title">监控助手</div><div class="chat-sub"><span class="dot green pulse"></span><span id="chat-status">在线</span></div></div>
        </div>
        <div class="inner-box">
          <div class="inner-title">对话</div>
          <div class="chat-msgs" id="chat-msgs"></div>
        </div>
        <div class="chat-chips" id="chat-chips">
          <button class="chip" data-q="现在 MCP 健康吗？">健康检查</button>
          <button class="chip" data-q="哪个工具报错最多？">错误排行</button>
          <button class="chip" data-q="最近有什么错误？">最新错误</button>
        </div>
        <div class="chat-input-row">
          <input id="chat-input" placeholder="问问 MCP 状态…" maxlength="500">
          <button class="chat-send" id="chat-send">↑</button>
        </div>
      </div>
      <div class="card log-card">
        <div class="ov-eyebrow">LIVE EVENT STREAM <span class="live-mini"><span class="dot green pulse"></span>LIVE</span></div>
        <div class="tp-title">实时日志流</div>
        <div class="log-stream slim" id="ov-logs"></div>
        <div class="log-foot"><span class="hint">自动滚动</span><span class="follow"><span class="dot green"></span>跟随中</span></div>
      </div>
      <div class="card rel-card">
        <div class="ov-eyebrow">RELIABILITY</div>
        <div class="tp-head"><span class="tp-title">调用成功率</span><span class="hint mono">60 SEC</span></div>
        <div class="inner-box">
          <div class="rel-top">
            <div class="donut-center">
              <svg viewBox="0 0 120 120" width="96" height="96">
                <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="11"/>
                <circle id="ov-donut-arc" cx="60" cy="60" r="52" fill="none" stroke="#4ade80" stroke-width="11"
                  stroke-linecap="round" stroke-dasharray="326.73" stroke-dashoffset="326.73"
                  transform="rotate(-90 60 60)" style="transition: stroke-dashoffset .6s ease, stroke .3s"/>
              </svg>
              <div class="donut-label"><b id="ov-rate">–</b><span>成功率</span></div>
            </div>
            <div class="rel-fails">
              <div class="fail-title">失败最多</div>
              <div class="fail-head"><span>工具名</span><span>成功</span><span>失败</span></div>
              <div id="ov-fails"></div>
            </div>
          </div>
          <div class="rel-div"></div>
          <div class="fail-title">调用详情</div>
          <div class="call-list" id="ov-calls"><div class="hint">暂无调用</div></div>
        </div>
      </div>
    </div>`;
  },

  init() {
    $("#page-overview").innerHTML = this.html();
    $("#ov-br-switch").addEventListener("change", async (e) => {
      try {
        const r = await api("/api/bridge", { method: "POST", body: { on: e.target.checked } });
        toast(`Bridge 已${r.enabled ? "开启" : "关闭"}`);
        this.refresh();
      } catch (err) { toast(err.message, false); e.target.checked = !e.target.checked; }
    });
    $("#ov-add-ch").addEventListener("click", () => ChannelsPage.openCreate());
    // ---- 内嵌 agent 聊天 ----
    const chatHistory = [];
    const chatMsgs = $("#chat-msgs");
    const chatInput = $("#chat-input");
    const chatStatus = $("#chat-status");
    // 根据模型供应商自动换头像（内置图标）
    const refreshAvatar = async () => {
      try {
        const ps = await api("/api/agent/providers").catch(() => []);
        const active = ps.find((p) => p.enabled) || ps[0];
        const av = $("#chat-avatar");
        if (!av || !active) return;
        const name = (active.name || "").toLowerCase();
        const url = (active.baseUrl || "").toLowerCase();
        const hay = name + " " + url;
        const map = [
          [["anthropic", "claude"], "anthropic.png"],
          [["openai", "gpt"], "openai.png"],
          [["deepseek"], "deepseek.png"],
          [["moonshot", "kimi"], "moonshot.png"],
          [["zhipu", "glm"], "zhipuai.png"],
          [["qwen", "tongyi", "aliyun"], "tongyi.png"],
          [["doubao", "volc"], "doubao.png"],
          [["longcat"], "longcat.png"],
        ];
        let icon = "";
        for (const [keys, file] of map) {
          if (keys.some((k) => hay.includes(k))) { icon = file; break; }
        }
        if (icon) {
          av.innerHTML = `<img src="vendor/providers/${icon}" alt="" onerror="this.parentElement.textContent='🤖'">`;
        }
      } catch { /* 保持默认 */ }
    };
    refreshAvatar();
    const addMsg = (role, text) => {
      const d = document.createElement("div");
      d.className = `chat-msg ${role}`;
      d.textContent = text;
      chatMsgs.appendChild(d);
      chatMsgs.scrollTop = chatMsgs.scrollHeight;
      return d;
    };
    addMsg("sys", "我是 MCP 监控助手，可以查状态、看错误、隔离故障工具、调参数。");
    const sendChat = async (preset) => {
      const text = (preset ?? chatInput.value).trim();
      if (!text) return;
      chatInput.value = "";
      addMsg("user", text);
      chatStatus.textContent = "思考中…";
      const sendBtn = $("#chat-send");
      sendBtn.disabled = true;
      const typing = document.createElement("div");
      typing.className = "chat-msg agent typing";
      typing.innerHTML = "<i></i><i></i><i></i>";
      chatMsgs.appendChild(typing);
      chatMsgs.scrollTop = chatMsgs.scrollHeight;
      try {
        const r = await api("/api/agent/chat", { method: "POST",
          body: { message: text, history: chatHistory.slice(-10) } });
        typing.remove();
        addMsg("agent", r.reply || "(无回复)");
        chatHistory.push({ role: "user", content: text }, { role: "assistant", content: r.reply || "" });
      } catch (e) {
        typing.remove();
        addMsg("sys", `出错：${e.message}`);
      }
      chatStatus.textContent = "在线";
      sendBtn.disabled = false;
      chatInput.focus();
    };
    $("#chat-send").addEventListener("click", () => sendChat());
    chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
    $$("#chat-chips .chip").forEach((c) => c.addEventListener("click", () => sendChat(c.dataset.q)));
  },

  async refresh() {
    try {
      const [ov, chs, st] = await Promise.all([
        api("/api/overview"), api("/api/channels"), api("/api/stats/tools"),
      ]);
      // ---- MCP CORE ----
      $("#ov-tools").textContent = ov.tools.count;
      $("#ov-mcp-pill").textContent = "正常";
      $("#ov-mcp-pill").className = "pill green sm";
      const health = ov.toolHealth ?? 1;
      const garc = $("#ov-gauge-arc");
      if (garc) garc.style.strokeDashoffset = String(238.76 * (1 - health));
      $("#ov-health").textContent = `${Math.round(health * 100)}%`;
      { const _u = $("#uptime"); if (_u) _u.textContent = `运行时长 ${fmtUptime(ov.uptimeSec)}`; }
      // ---- 网关延迟 ----
      const pipes = ov.bridge.pipes;
      const lat = pipes.length && pipes[0].avgLatencyMs != null ? pipes[0].avgLatencyMs
        : chs.filter((c) => c.latencyMs != null).map((c) => c.latencyMs);
      const latVal = Array.isArray(lat)
        ? (lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null) : lat;
      $("#ov-lat").textContent = latVal != null ? latVal : "–";
      $("#ov-lat2").textContent = latVal != null ? `${latVal} ms` : "– ms";
      const gwPill = $("#ov-gw-pill");
      if (!pipes.length && !chs.length) { gwPill.textContent = "未连接"; gwPill.className = "pill gray sm"; }
      else if (ov.bridge.enabled && pipes.some((p) => p.connected)) { gwPill.textContent = "已连接"; gwPill.className = "pill green sm"; }
      else { gwPill.textContent = "就绪"; gwPill.className = "pill yellow sm"; }
      const sparkEl = $("#ov-spark");
      if (latVal != null) {
        this.latHist.push(latVal); if (this.latHist.length > 30) this.latHist.shift();
        drawSpark(sparkEl, this.latHist, "#4ade80");
        sparkEl.style.opacity = "1";
      } else {
        const { ctx, w, h } = setupCanvas(sparkEl, 34);
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = "rgba(255,255,255,.12)"; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
        ctx.setLineDash([]); sparkEl.style.opacity = ".6";
      }
      // ---- Bridge ----
      const sw = $("#ov-br-switch");
      if (document.activeElement !== sw) sw.checked = ov.bridge.enabled;
      $("#ov-br-state").textContent = ov.bridge.enabled ? "已开启" : "已关闭";
      const brPill = $("#ov-br-pill");
      brPill.textContent = ov.bridge.enabled ? "在线" : "离线";
      brPill.className = `pill ${ov.bridge.enabled ? "green" : "gray"} sm`;
      $("#ov-pipe-count").textContent = pipes.length ? `${pipes.length} 条管道` : "就绪，未建管道";
      $("#ov-pipe-bars").innerHTML = pipes.length
        ? pipes.slice(0, 4).map(() => `<div class="pipe-bar"><div class="pipe-fill" style="width:${60 + Math.random() * 40}%"></div></div>`).join("")
        : "";
      // ---- 信道 ----
      $("#ov-ch-count").textContent = chs.length;
      $("#badge-channels").textContent = chs.length || "";
      $("#ov-ch-list").innerHTML = chs.length ? chs.map((c) => {
        const desc = c.ai?.name || (c.kind === "local" ? "本地直连" : c.kind === "gateway" ? "网关订阅" : c.kind);
        return `<div class="ch-row"><span class="dot ${dotFor(c)}"></span>
          <span class="ch-name">${esc(c.name)}</span>
          <span class="ch-proj">${esc(desc)}</span></div>`;
      }).join("") : `<div class="ch-empty">暂无信道，点击右上角添加</div>`;
      // ---- 吞吐 ----
      const now = Date.now(), total = st.summary.totalCalls;
      if (this.lastTs) {
        const qps = Math.max(0, (total - this.lastCalls) / ((now - this.lastTs) / 1000));
        const okRate = st.summary.successRate;
        this.qpsHist.push({ qps, ok: qps * okRate });
        if (this.qpsHist.length > 60) this.qpsHist.shift();
        const perMin = qps * 60;
        $("#ov-req-min").textContent = perMin.toFixed(0);
        $("#ov-ok-min").textContent = (perMin * okRate).toFixed(0);
        const peak = Math.max(...this.qpsHist.map((p) => p.qps)) * 60;
        $("#ov-tp-peak").textContent = peak.toFixed(0);
      }
      this.lastCalls = total; this.lastTs = now;
      if (this.qpsHist.length > 1) {
        drawThroughput($("#ov-chart"),
          this.qpsHist.map((p) => p.qps), this.qpsHist.map((p) => p.ok));
      }
      $("#ov-tp-rate").textContent = `${(st.summary.successRate * 100).toFixed(1)}%`;
      // p50：按调用量加权的平均延迟近似
      const tot = st.tools.reduce((a, t) => a + t.calls, 0);
      const p50 = tot ? Math.round(st.tools.reduce((a, t) => a + t.calls * (t.avgMs || 0), 0) / tot) : null;
      $("#ov-tp-p50").textContent = p50 != null ? `${p50}ms` : "–";
      // ---- 排行 ----
      const top = st.tools.slice(0, 8);
      const max = Math.max(1, ...top.map((t) => t.calls));
      $("#ov-rank").innerHTML = top.map((t) => `
        <div class="rank-row"><span class="rank-name">${esc(t.name)}</span>
          <div class="rank-bar"><div class="rank-fill" style="width:${(t.calls / max * 100).toFixed(1)}%"></div></div>
          <span class="rank-num">${t.calls}</span></div>`).join("") || `<div class="hint">暂无调用</div>`;
      // ---- 成功率 ----
      const rate = st.summary.successRate;
      $("#ov-rate").textContent = `${(rate * 100).toFixed(1)}%`;
      drawDonut(rate);
      const fails = [...st.tools].filter((t) => t.errors > 0).sort((a, b) => b.errors - a.errors).slice(0, 3);
      $("#ov-fails").innerHTML = fails.length ? fails.map((t) => `
        <div class="fail-row"><span class="fail-name">${esc(t.name)}</span><span class="mono">${t.calls - t.errors}</span><b class="mono">${t.errors}</b></div>`).join("")
        : `<div class="hint">暂无失败</div>`;
      // ---- 最近调用（滚动） ----
      const calls = ov.recentCalls || [];
      $("#ov-calls").innerHTML = calls.length ? calls.map((c) => `
        <div class="call-row"><span class="dot ${c.ok ? "ok" : "err"}"></span>
          <span class="call-name">${esc(c.name)}</span>
          <span class="call-ms">${c.ms}ms</span>
          <span class="call-ts">${fmtTime(c.ts)}</span></div>`).join("")
        : `<div class="hint">暂无调用</div>`;
      // ---- 错误徽章 ----
      $("#badge-errors").textContent = ov.errors.unacked || "";
      // ---- 日志（瘦：时间+级别+消息） ----
      const logs = await api(`/api/logs?limit=30&since=${this.logSince}`);
      if (logs.length) {
        this.logSince = logs[logs.length - 1].id;
        $("#ov-logs").innerHTML += logs.map((e) =>
          `<div class="log-line"><span class="log-ts">${fmtTime(e.ts)}</span><span class="log-lv ${e.level}">${e.level.toUpperCase()}</span><span class="log-msg">${esc(e.text)}</span></div>`
        ).join("");
        const el = $("#ov-logs");
        while (el.children.length > 30) el.firstChild.remove();
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      }
    } catch (e) { /* 静默，下一轮重试 */ }
  },
};

function logLine(e) {
  return `<div class="log-line"><span class="log-ts">${fmtTime(e.ts)}</span><span class="log-lv ${e.level}">${e.level.toUpperCase()}</span><span class="log-src">${esc(e.source)}</span><span class="log-msg">${esc(e.text)}</span></div>`;
}

function startLive() { stopLive(); Overview.refresh(); Overview.timer = setInterval(() => Overview.refresh(), 2000); }
function stopLive() { if (Overview.timer) { clearInterval(Overview.timer); Overview.timer = null; } }

/* ================= 信道 ================= */
const ChannelsPage = {
  dfGw: { url: localStorage.getItem("dfGwUrl") || "", token: localStorage.getItem("dfGwToken") || "" },

  html() {
    return `
    <div class="sec-head">
      <div class="sec-title">信道 <span class="hint" id="ch-total"></span></div>
      <button class="btn" id="ch-add">＋ 新建信道</button>
    </div>
    <div class="card"><table class="tbl"><thead><tr>
      <th style="width:36px"></th><th>名称</th><th>类型</th><th>状态</th><th>延迟</th><th>AI</th><th>调用</th><th style="text-align:right">操作</th>
    </tr></thead><tbody id="ch-tbody"></tbody></table></div>`;
  },

  init() {
    $("#page-channels").innerHTML = this.html();
    $("#ch-add").addEventListener("click", () => this.openCreate());
  },

  async show() {
    const chs = await api("/api/channels").catch(() => []);
    $("#ch-total").textContent = `共 ${chs.length} 条`;
    $("#ch-tbody").innerHTML = chs.map((c) => `
      <tr><td><span class="dot ${dotFor(c)}"></span></td>
        <td><b>${esc(c.name)}</b><div class="hint mono" style="font-size:10.5px">${esc(c.bindingId)}</div></td>
        <td>${c.kind === "local" ? '<span class="pill gray">本地</span>' : '<span class="pill purple">网关</span>'}</td>
        <td>${c.kind === "local" ? '<span class="pill green">运行中</span>' : (c.paired ? '<span class="pill green">已配对</span>' : '<span class="pill yellow">等待配对</span>')}</td>
        <td class="mono">${c.latencyMs != null ? c.latencyMs + " ms" : "–"}</td>
        <td>${c.ai ? esc(c.ai.name) : '<span class="hint">–</span>'}</td>
        <td class="mono">${c.stats.requestsIn}</td>
        <td><div class="row-actions">
          <button class="btn sm ghost" data-act="share" data-id="${c.bindingId}">分享</button>
          ${c.kind === "gateway" ? `<button class="btn sm ghost" data-act="recode" data-id="${c.bindingId}">换码</button>` : ""}
          <button class="btn sm danger" data-act="close" data-id="${c.bindingId}">关闭</button>
        </div></td></tr>`).join("") || `<tr><td colspan="8" class="hint" style="text-align:center;padding:24px">暂无信道</td></tr>`;
    $$("#ch-tbody [data-act]").forEach((b) => b.addEventListener("click", () => this.act(b.dataset.act, b.dataset.id)));
  },

  async act(act, id) {
    try {
      if (act === "share") {
        const r = await api(`/api/channels/${encodeURIComponent(id)}/share`);
        openModal(`<div class="modal-title">分享信道</div>
          <div class="result-box share-text">${esc(r.text)}</div>
          <div class="modal-actions"><button class="btn" id="m-copy">复制</button><button class="btn ghost" id="m-close">关闭</button></div>`);
        $("#m-copy").addEventListener("click", () => copyText(r.text));
        $("#m-close").addEventListener("click", closeModal);
      } else if (act === "recode") {
        const r = await api(`/api/channels/${encodeURIComponent(id)}/recode`, { method: "POST" });
        openModal(`<div class="modal-title">新配对码</div>
          <div class="result-box share-text">配对码：${esc(r.pairingCode)}\n\n${esc(r.hint || "")}</div>
          <div class="modal-actions"><button class="btn" id="m-copy">复制配对码</button><button class="btn ghost" id="m-close">关闭</button></div>`);
        $("#m-copy").addEventListener("click", () => copyText(r.pairingCode));
        $("#m-close").addEventListener("click", closeModal);
      } else if (act === "close") {
        await api(`/api/channels/${encodeURIComponent(id)}`, { method: "DELETE" });
        toast("信道已关闭"); this.show();
        if (currentPage === "overview") Overview.refresh();
      }
    } catch (e) { toast(e.message, false); }
  },

  openCreate() {
    const d = this.dfGw;
    openModal(`<div class="modal-title">新建信道</div>
      <div class="field"><label>信道名称</label><input id="nc-name" value="channel" maxlength="64"></div>
      <div class="field"><label>类型</label><select id="nc-kind">
        <option value="local">本地信道（局域网直连，一个 URL 搞定）</option>
        <option value="gateway">网关信道（经网关，配对码 join）</option>
      </select></div>
      <div id="nc-gw-fields" class="hidden">
        <div class="field"><label>网关地址</label><input id="nc-url" placeholder="ws://23.251.34.248:8080" value="${esc(d.url)}"></div>
        <div class="field"><label>网关 Token（64 位 hex，只存本机）</label><input id="nc-token" placeholder="64 位 hex" value="${esc(d.token)}" type="password"></div>
      </div>
      <div class="modal-actions"><button class="btn ghost" id="m-cancel">取消</button><button class="btn" id="m-ok">建立</button></div>
      <div id="nc-result"></div>`);
    const kindSel = $("#nc-kind");
    kindSel.addEventListener("change", () => $("#nc-gw-fields").classList.toggle("hidden", kindSel.value !== "gateway"));
    $("#m-cancel").addEventListener("click", closeModal);
    $("#m-ok").addEventListener("click", async () => {
      const name = $("#nc-name").value.trim() || "channel";
      const kind = kindSel.value;
      const btn = $("#m-ok"); btn.disabled = true; btn.textContent = "建立中…";
      try {
        let r;
        if (kind === "local") {
          r = await api("/api/channels", { method: "POST", body: { kind: "local", name } });
          $("#nc-result").innerHTML = `<div class="modal-title" style="margin-top:14px">建立成功</div>
            <div class="result-box ok share-text">${esc(r.url)}</div>
            <div class="modal-actions"><button class="btn" id="m-copy2">复制连接信息</button></div>`;
          $("#m-copy2").addEventListener("click", () => copyText(
            `MCP 本地信道连接信息\nURL: ${r.url}\n\n把这个 URL 发给 AI，AI 用 MCP 协议直连即可（先 initialize → notifications/initialized → tools/list）。`));
        } else {
          const gatewayUrl = $("#nc-url").value.trim(), token = $("#nc-token").value.trim();
          if (!gatewayUrl || !token) throw new Error("网关地址和 Token 必填");
          localStorage.setItem("dfGwUrl", gatewayUrl); localStorage.setItem("dfGwToken", token);
          this.dfGw = { url: gatewayUrl, token };
          r = await api("/api/channels", { method: "POST", body: { kind: "gateway", name, gatewayUrl, token } });
          const share = await api(`/api/channels/${encodeURIComponent(r.bindingId)}/share`);
          $("#nc-result").innerHTML = `<div class="modal-title" style="margin-top:14px">建立成功</div>
            <div class="result-box ok share-text">${esc(share.text)}</div>
            <div class="modal-actions"><button class="btn" id="m-copy2">复制连接信息</button></div>`;
          $("#m-copy2").addEventListener("click", () => copyText(share.text));
        }
        toast("信道建立成功"); this.show();
      } catch (e) {
        $("#nc-result").innerHTML = `<div class="result-box err" style="margin-top:14px">${esc(e.message)}</div>`;
      } finally { btn.disabled = false; btn.textContent = "建立"; }
    });
  },
};

/* ================= 网关 ================= */
/* ================= 插件 / 技能 / 连接器 ================= */
// 插件：第三方工具包 —— 突出它提供了哪些工具
function pluginCard(e) {
  return `
  <div class="ext-card card" style="background:var(--bg)">
    <div class="ext-head"><span class="ext-name">${esc(e.name)}</span>
      <span class="hint mono" style="margin-left:8px">v${esc(e.version || "")}</span>
      <span class="pill ${e.enabled ? "green" : "gray"}" style="margin-left:auto">${e.enabled ? "已启用" : "已禁用"}</span></div>
    <div class="ext-desc">${esc(e.description || "暂无描述")}</div>
    <div class="inner-box" style="margin-top:10px">
      <div class="inner-title">提供工具 · ${e.toolNames.length}</div>
      <div class="tool-tags">${e.toolNames.map((t) => `<span class="tag mono">${esc(t)}</span>`).join("") || '<span class="hint">无</span>'}</div>
    </div>
    <div class="ext-foot" style="margin-top:10px">
      <span></span>
      ${e.enabled ? `<label class="switch" title="禁用"><input type="checkbox" checked data-dis="${esc(e.name)}"><span class="track"></span></label>` : `<span class="hint">重启恢复</span>`}
    </div>
  </div>`;
}

// 技能：能力说明包 —— 突出它的用途和资源
function skillCard(e) {
  return `
  <div class="ext-card card" style="background:var(--bg)">
    <div class="ext-head"><span class="ext-name">${esc(e.name)}</span>
      <span class="hint mono" style="margin-left:8px">v${esc(e.version || "")}</span>
      <span class="pill ${e.enabled ? "green" : "gray"}" style="margin-left:auto">${e.enabled ? "已启用" : "已禁用"}</span></div>
    <div class="ext-desc">${esc(e.description || "暂无描述")}</div>
    ${e.resourceUris?.length ? `<div class="inner-box" style="margin-top:10px">
      <div class="inner-title">技能资源</div>
      <div class="mono" style="font-size:11px;color:var(--text2)">${e.resourceUris.map(esc).join("<br>")}</div>
    </div>` : ""}
    <div class="ext-foot" style="margin-top:10px">
      <span class="hint">AI 会话中按需调用</span>
      ${e.enabled ? `<label class="switch" title="禁用"><input type="checkbox" checked data-dis="${esc(e.name)}"><span class="track"></span></label>` : `<span class="hint">重启恢复</span>`}
    </div>
  </div>`;
}

// 连接器：外部服务集成 —— 突出连接状态和配置
function connectorCard(e) {
  const configured = e.name !== "github" || e.hasConfig;
  return `
  <div class="ext-card card" style="background:var(--bg)">
    <div class="ext-head"><span class="ext-name">${esc(e.name)}</span>
      <span class="dot ${e.enabled && configured ? "green" : "yellow"}" style="margin-left:8px"></span>
      <span class="hint" style="margin-left:4px">${e.enabled ? (configured ? "已连接" : "待配置") : "已禁用"}</span>
      <span class="pill ${e.enabled ? "green" : "gray"}" style="margin-left:auto">${e.enabled ? "已启用" : "已禁用"}</span></div>
    <div class="ext-desc">${esc(e.description || "暂无描述")}</div>
    ${e.toolNames?.length ? `<div class="ext-tools" style="margin-top:8px">${e.toolNames.map(esc).join(" · ")}</div>` : ""}
    <div class="ext-foot" style="margin-top:10px">
      ${e.name === "github" ? `<button class="btn sm ghost" data-cfg="${esc(e.name)}">配置 Token</button>` : `<span></span>`}
      ${e.enabled ? `<label class="switch" title="禁用"><input type="checkbox" checked data-dis="${esc(e.name)}"><span class="track"></span></label>` : `<span class="hint">重启恢复</span>`}
    </div>
  </div>`;
}

function makeExtPage(kind, title, pageId, badgeId, cardFn) {
  return {
    async show() {
      const wrap = $(`#${pageId}`);
      wrap.innerHTML = `<div class="sec-head"><div class="sec-title">${title}</div><button class="btn sm" id="${pageId}-add">＋ 添加</button></div><div id="${pageId}-wrap"></div>`;
      $(`#${pageId}-add`).addEventListener("click", () => openInstallModal(kind, title, () => this.show()));
      const exts = await api("/api/extensions").catch(() => []);
      const items = exts.filter((e) => e.kind === kind);
      const badge = $(`#${badgeId}`);
      if (badge) badge.textContent = items.length || "";
      $(`#${pageId}-wrap`).innerHTML = items.length
        ? `<div class="ext-grid">` + items.map(cardFn).join("") + `</div>`
        : `<div class="card"><div class="hint" style="padding:24px;text-align:center">暂无${title}</div></div>`;
      $$(`#${pageId}-wrap [data-dis]`).forEach((sw) => sw.addEventListener("change", async () => {
        const r = await api(`/api/extensions/${encodeURIComponent(sw.dataset.dis)}/disable`, { method: "POST" }).catch((e) => toast(e.message, false));
        if (r?.ok) { toast("已禁用，重启 dashboard 恢复"); this.show(); }
        else sw.checked = true;
      }));
      $$(`#${pageId}-wrap [data-cfg]`).forEach((b) => b.addEventListener("click", () => openExtConfig(b.dataset.cfg)));
    },
  };
}

function openExtConfig(name) {
  openModal(`<div class="modal-title">配置 ${esc(name)}</div>
    <div class="field"><label>GitHub Personal Access Token</label>
      <input id="cfg-token" type="password" placeholder="ghp_... / github_pat_...">
      <div class="hint" style="margin-top:6px">只写入本机 extensions/connectors/github/config.json，不会上传</div></div>
    <div class="modal-actions"><button class="btn ghost" id="m-cancel">取消</button><button class="btn" id="m-ok">保存</button></div>`);
  $("#m-cancel").addEventListener("click", closeModal);
  $("#m-ok").addEventListener("click", async () => {
    const token = $("#cfg-token").value.trim();
    if (!token) { toast("Token 不能为空", false); return; }
    try {
      await api(`/api/extensions/${encodeURIComponent(name)}/config`, { method: "POST", body: { token } });
      toast("Token 已保存，重启 dashboard 后生效"); closeModal();
    } catch (e) { toast(e.message, false); }
  });
}

// 安装扩展：插件/连接器传 JS 文件，技能传 SKILL.md
function openInstallModal(kind, title, onDone) {
  const isSkill = kind === "skill";
  const accept = isSkill ? ".md" : ".js";
  const fileLabel = isSkill ? "SKILL.md 文件" : "入口 JS 文件 (index.js)";
  openModal(`<div class="modal-title">添加${title}</div>
    <div class="field"><label>名称（英文、数字、-_）</label><input id="ins-name" class="mono" placeholder="my-ext"></div>
    ${isSkill ? "" : `<div class="field"><label>版本</label><input id="ins-ver" class="mono" placeholder="0.1.0"></div>
    <div class="field"><label>描述</label><input id="ins-desc" placeholder="这个扩展是做什么的"></div>`}
    <div class="field"><label>${fileLabel}</label><input id="ins-file" type="file" accept="${accept}"></div>
    <div class="hint" style="margin-bottom:12px">安装后重启 dashboard 生效</div>
    <div class="modal-actions"><button class="btn ghost" id="m-cancel">取消</button><button class="btn primary" id="m-ok">安装</button></div>`);
  $("#m-cancel").addEventListener("click", closeModal);
  $("#m-ok").addEventListener("click", async () => {
    const name = $("#ins-name").value.trim();
    const file = $("#ins-file").files[0];
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) { toast("名称不合法", false); return; }
    if (!file) { toast("请选择文件", false); return; }
    if (file.size > 5 * 1024 * 1024) { toast("文件过大（>5MB）", false); return; }
    const buf = await file.arrayBuffer();
    let b64 = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 8192) {
      b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    b64 = btoa(b64);
    const filename = isSkill ? "SKILL.md" : "index.js";
    try {
      const r = await api("/api/extensions/install", { method: "POST", body: {
        kind, name,
        version: $("#ins-ver")?.value.trim() || "0.1.0",
        description: $("#ins-desc")?.value.trim() || "",
        files: [{ filename, content: b64 }],
      }});
      if (r?.ok) { toast(`已安装，重启 dashboard 后生效`); closeModal(); onDone(); }
    } catch (e) { toast(e.message, false); }
  });
}

const PluginsPage = makeExtPage("plugin", "插件", "page-plugins", "badge-plugins", pluginCard);
const SkillsPage = makeExtPage("skill", "技能", "page-skills", "badge-skills", skillCard);
const ConnectorsPage = makeExtPage("connector", "连接器", "page-connectors", "badge-connectors", connectorCard);

/* ================= 工具 ================= */
const ToolsPage = {
  tools: [], stats: [],
  html() {
    return `<div class="sec-head"><div class="sec-title">工具 <span class="hint" id="tool-total"></span></div></div>
    <input class="tool-search" id="tool-q" placeholder="搜索工具…">
    <div class="tool-grid" id="tool-grid"></div>`;
  },
  init() {
    $("#page-tools").innerHTML = this.html();
    $("#tool-q").addEventListener("input", (e) => this.render(e.target.value));
  },
  async show() {
    const [ov, st] = await Promise.all([api("/api/overview"), api("/api/stats/tools")]).catch(() => []);
    if (!ov) return;
    this.tools = ov.tools.list; this.stats = st?.tools || [];
    $("#badge-tools").textContent = this.tools.length || "";
    $("#tool-total").textContent = `共 ${this.tools.length} 个`;
    this.render($("#tool-q").value);
  },
  render(q = "") {
    const smap = new Map(this.stats.map((s) => [s.name, s]));
    const list = this.tools.filter((t) =>
      t.name.toLowerCase().includes(q.toLowerCase()) ||
      (t.description || "").toLowerCase().includes(q.toLowerCase()));
    $("#tool-grid").innerHTML = list.map((t) => {
      const s = smap.get(t.name);
      return `<div class="card tool-card" data-name="${esc(t.name)}">
        <div class="t-name">${esc(t.name)}</div>
        <div class="t-desc">${esc(t.description || "")}</div>
        <div class="tool-meta"><span class="pill ${this.danger(t.name) ? "red" : "gray"}">${this.danger(t.name) ? "危险" : "安全"}</span>
        <span class="tool-calls">${s ? `${s.calls} 次调用` : "未调用"}</span></div></div>`;
    }).join("");
    $$("#tool-grid .tool-card").forEach((c) =>
      c.addEventListener("click", () => this.openPlayground(this.tools.find((t) => t.name === c.dataset.name))));
  },
  danger(name) {
    return /^(write_file|delete_file|move_file|exec|mouse_|key_|hotkey)/.test(name);
  },
  openPlayground(t) {
    if (!t) return;
    const danger = this.danger(t.name);
    openModal(`<div class="modal-title">试调 · <span class="mono" style="color:#c4b5fd">${esc(t.name)}</span>
      ${danger ? '<span class="pill red">危险操作</span>' : ""}</div>
      <div class="hint" style="margin-bottom:10px">${esc(t.description || "")}</div>
      <div class="field"><label>参数（JSON）</label><textarea id="pg-args">{}</textarea></div>
      ${danger ? `<div class="hint" style="margin-bottom:10px;color:var(--red)">该工具会改变本机状态，确认后再执行</div>` : ""}
      <div class="modal-actions"><button class="btn ghost" id="m-cancel">关闭</button><button class="btn" id="m-run">执行</button></div>
      <div id="pg-result" style="margin-top:12px"></div>`);
    $("#m-cancel").addEventListener("click", closeModal);
    $("#m-run").addEventListener("click", async () => {
      let args;
      try { args = JSON.parse($("#pg-args").value || "{}"); }
      catch { $("#pg-result").innerHTML = `<div class="result-box err">参数不是合法 JSON</div>`; return; }
      const btn = $("#m-run"); btn.disabled = true; btn.textContent = "执行中…";
      try {
        const r = await api("/api/tools/call", { method: "POST", body: { name: t.name, args } });
        if (r.approvalRequired) {
          btn.disabled = false; btn.textContent = "执行";
          showApprovalModal(r.approvalId, t.name, args, (res) => {
            $("#pg-result").innerHTML = res.error
              ? `<div class="result-box err">${esc(res.error)}</div>`
              : `<div class="result-box ok">${esc(JSON.stringify(res.result, null, 2))}\n\n// ${res.ms}ms</div>`;
          });
          return;
        }
        $("#pg-result").innerHTML = `<div class="result-box ok">${esc(JSON.stringify(r.result, null, 2))}\n\n// ${r.ms}ms</div>`;
      } catch (e) {
        $("#pg-result").innerHTML = `<div class="result-box err">${esc(e.message)}</div>`;
      } finally { btn.disabled = false; btn.textContent = "执行"; }
    });
  },
};

/** 审批弹窗：危险工具调用等待批准 */
function showApprovalModal(approvalId, toolName, args, onDone, onCancel) {
  openModal(`<div class="modal-title">审批请求</div>
    <div class="hint" style="margin-bottom:12px">审批模式已开启，危险工具调用需要批准后才会执行。</div>
    <div class="field"><label>工具</label><div class="mono" style="font-size:13px">${esc(toolName)} <span class="pill red sm">危险</span></div></div>
    <div class="field"><label>参数</label><pre class="result-box" style="margin:0">${esc(JSON.stringify(args, null, 2))}</pre></div>
    <div class="modal-actions"><button class="btn ghost sm" id="ap-reject">拒绝</button><button class="btn primary sm" id="ap-approve">批准执行</button></div>`);
  $("#ap-reject").addEventListener("click", async () => {
    try { await api(`/api/approvals/${approvalId}/reject`, { method: "POST" }); toast("已拒绝"); }
    catch (e) { toast(e.message, false); }
    closeModal();
    onCancel?.();
  });
  $("#ap-approve").addEventListener("click", async () => {
    const b = $("#ap-approve"); b.disabled = true; b.textContent = "执行中…";
    try {
      const r = await api(`/api/approvals/${approvalId}/approve`, { method: "POST" });
      closeModal();
      toast("已批准并执行");
      onDone?.(r);
    } catch (e) { toast(e.message, false); b.disabled = false; b.textContent = "批准执行"; }
  });
}

/* ================= 日志 ================= */
const LogsPage = {
  timer: null, since: 0, paused: false,
  html() {
    return `<div class="sec-head"><div class="sec-title">日志</div>
      <div class="log-toolbar">
        <select id="log-level"><option value="">全部级别</option><option value="info">INFO</option><option value="warn">WARN</option><option value="error">ERROR</option><option value="debug">DEBUG</option></select>
        <button class="btn sm ghost" id="log-pause">暂停</button>
        <button class="btn sm ghost" id="log-clear">清空</button>
      </div></div>
    <div class="card"><div class="log-stream" id="log-view"></div></div>`;
  },
  init() {
    $("#page-logs").innerHTML = this.html();
    $("#log-level").addEventListener("change", () => { this.since = 0; $("#log-view").innerHTML = ""; this.poll(); });
    $("#log-pause").addEventListener("click", (e) => {
      this.paused = !this.paused;
      e.target.textContent = this.paused ? "继续" : "暂停";
    });
    $("#log-clear").addEventListener("click", () => { $("#log-view").innerHTML = ""; });
  },
  start() { this.stop(); this.poll(); this.timer = setInterval(() => this.poll(), 2000); },
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } },
  async poll() {
    if (this.paused || currentPage !== "logs") return;
    const lv = $("#log-level")?.value || "";
    const logs = await api(`/api/logs?limit=200&since=${this.since}${lv ? `&level=${lv}` : ""}`).catch(() => []);
    if (!logs.length) return;
    this.since = logs[logs.length - 1].id;
    const v = $("#log-view");
    v.innerHTML += logs.map(logLine).join("");
    v.scrollTop = v.scrollHeight;
  },
};

/* ================= 错误 ================= */
const ErrorsPage = {
  timer: null,
  html() {
    return `<div class="sec-head"><div class="sec-title">错误收集</div>
      <div class="log-toolbar">
        <select id="err-src"><option value="">全部来源</option><option value="tool:">工具</option><option value="gateway">网关</option><option value="channel:">信道</option><option value="dashboard">面板</option></select>
        <select id="err-acked"><option value="">全部状态</option><option value="false">未处理</option><option value="true">已处理</option></select>
      </div></div>
    <div class="err-stats" id="err-stats"></div>
    <div class="card"><div id="err-list"></div></div>`;
  },
  init() {
    $("#page-errors").innerHTML = this.html();
    $("#err-src").addEventListener("change", () => this.show());
    $("#err-acked").addEventListener("change", () => this.show());
  },
  start() { this.stop(); this.show(); this.timer = setInterval(() => this.show(true), 5000); },
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } },
  async show(quiet) {
    const src = $("#err-src")?.value || "", acked = $("#err-acked")?.value || "";
    const d = await api(`/api/errors?limit=200${src ? `&source=${encodeURIComponent(src)}` : ""}${acked ? `&acked=${acked}` : ""}`).catch(() => null);
    if (!d) return;
    const un = d.stats.unacked;
    $("#err-stats").innerHTML = `
      <div class="card stat-card"><div class="stat-label">未处理</div><div class="stat-num" style="color:var(--red)">${un}</div></div>
      <div class="card stat-card"><div class="stat-label">今日错误</div><div class="stat-num">${d.stats.total}</div></div>
      <div class="card stat-card"><div class="stat-label">最多来源</div><div class="stat-num" style="font-size:15px;font-family:var(--font-m)">${esc(Object.entries(d.stats.bySource).sort((a, b) => b[1] - a[1])[0]?.[0] || "–")}</div></div>
      <div class="card stat-card"><div class="stat-label">处理率</div><div class="stat-num">${d.stats.total ? Math.round((d.stats.total - un) / d.stats.total * 100) : 100}<small>%</small></div></div>`;
    $("#err-list").innerHTML = d.list.map((e) => `
      <div class="err-item" data-id="${e.id}">
        <div class="err-line">
          <span class="pill red">ERROR</span>
          <span class="err-msg">${esc(e.text.slice(0, 120))}</span>
          <span class="pill ${e.acked ? "green" : "yellow"}">${e.acked ? "已处理" : "未处理"}</span>
          <span class="err-ts">${fmtTime(e.ts)}</span>
          ${e.acked ? "" : `<button class="btn sm ghost" data-ack="${e.id}">标记已处理</button>`}
        </div>
        <div class="err-detail hidden"><b>来源</b> ${esc(e.source)}\n<b>时间</b> ${new Date(e.ts).toLocaleString()}\n\n${esc(e.text)}</div>
      </div>`).join("") || `<div class="hint" style="padding:20px;text-align:center">暂无错误，干净</div>`;
    $$("#err-list .err-item").forEach((it) => it.addEventListener("click", (ev) => {
      if (ev.target.dataset.ack) return;
      it.querySelector(".err-detail").classList.toggle("hidden");
    }));
    $$("#err-list [data-ack]").forEach((b) => b.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await api(`/api/errors/${b.dataset.ack}/ack`, { method: "POST" }).catch((e) => toast(e.message, false));
      this.show();
    }));
    if (!quiet) $("#badge-errors").textContent = un || "";
  },
};

/* ================= 设置（弹窗，三栏） ================= */
const SettingsModal = {
  editing: null,
  tab: "general",
  selModel: null,
  fetchedModels: [],
  open(tab = "general") {
    openModal(`<div class="set-modal">
      <div class="set-side">
        <div class="modal-title" style="margin-bottom:12px">设置</div>
        <button class="set-tab" data-tab="general"><span>⚙</span>通用设置</button>
        <button class="set-tab" data-tab="model"><span>◫</span>模型</button>
        <button class="set-tab" data-tab="gateway"><span>⇄</span>网关</button>
      </div>
      <div class="set-main">
        <div class="set-pane" id="set-pane-general">
          <div class="set-sec-title">通用设置</div>
          <div class="set-row" style="display:block">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div><div class="set-row-t">权限</div><div class="hint">危险工具（写文件、执行命令等）调用时是否需要审批</div></div>
              <div class="seg" id="perm-seg"><button data-v="approval">需要审批</button><button data-v="direct">无需审批</button></div>
            </div>
            <div class="hint" id="perm-summary" style="margin-top:6px"></div>
            <div class="perm-list hidden" id="perm-list"></div>
          </div>
          <div class="set-row">
            <div><div class="set-row-t">语言</div><div class="hint">界面显示语言</div></div>
            <span style="font-size:12.5px;color:var(--text2)">简体中文</span>
          </div>
          <div class="set-row">
            <div><div class="set-row-t">外观</div><div class="hint">深色 / 浅色主题</div></div>
            <div class="seg" id="theme-seg"><button data-v="dark">深色</button><button data-v="light">浅色</button></div>
          </div>
          <div class="set-row">
            <div><div class="set-row-t">日志级别</div><div class="hint">低于该级别的日志不再采集，实时生效</div></div>
            <div class="cselect" id="cs-loglevel"></div>
          </div>
          <div class="set-row" style="border-bottom:none">
            <div><div class="set-row-t">当前版本</div><div class="hint">MCP-Server 控制中心</div></div>
            <span class="mono" id="app-version" style="font-size:12.5px">–</span>
          </div>
        </div>
        <div class="set-pane hidden" id="set-pane-model">
          <div class="set-sec-title">模型供应商</div>
          <div class="hint" style="margin-bottom:12px">填入各提供商的 API 密钥即可使用其模型。Key 只存服务端（~/.mcp-server/agent.json），不会发送到浏览器。</div>
          <div id="prov-list"></div>
          <button class="add-prov" id="prov-add">+ 添加模型提供商</button>
          <div class="hidden" id="prov-form-card" style="margin-top:12px;border-top:1px solid var(--border);padding-top:14px">
            <div class="set-sec-title" id="pf-title">添加模型提供商</div>
            <label class="mf-label">显示名称</label>
            <input class="mf-input" id="pf-name" placeholder="如 DeepSeek">
            <label class="mf-label">API 地址</label>
            <input class="mf-input" id="pf-base" placeholder="https://api.deepseek.com/v1（Anthropic 留空）">
            <label class="mf-label">API 协议</label>
            <div class="cselect" id="cs-pftype"></div>
            <label class="mf-label">API 密钥</label>
            <input class="mf-input" id="pf-key" type="password" placeholder="留空表示不修改">
            <div class="model-dir-head"><span class="mf-label">模型目录</span><button class="link-btn" id="pf-fetch" type="button">获取可用模型</button></div>
            <div class="model-box" id="model-box"><div class="hint">暂无模型，请获取或手动添加</div></div>
            <button class="btn sm ghost" id="pf-add-model" type="button" style="margin-top:8px">+ 添加模型</button>
            <div class="modal-actions">
              <button class="btn ghost sm" id="pf-cancel">取消</button>
              <button class="btn primary sm" id="pf-save">创建提供商</button>
            </div>
          </div>
        </div>
        <div class="set-pane hidden" id="set-pane-gateway">
          <div class="set-sec-title">网关</div>
          <div class="set-row">
            <div><div class="set-row-t">Bridge 总开关</div><div class="hint">关闭后断开所有网关管道</div></div>
            <div style="display:flex;align-items:center;gap:10px"><span class="hint" id="gw-br-state">–</span>
              <label class="switch"><input type="checkbox" id="gw-br-switch"><span class="track"></span></label></div>
          </div>
          <div class="set-sec-title" style="margin-top:16px">网关管道</div>
          <div id="gw-pipes"></div>
          <div class="set-sec-title" style="margin-top:16px">一键部署</div>
          <div class="hint" style="margin-bottom:8px">通过 SSH 在服务器上部署 / 升级网关，不经过本机 PowerShell。重复部署=升级，会沿用原来的 token，已配对的不受影响</div>
          <div class="field" style="margin-bottom:8px"><label>拉取源</label><div class="seg" id="gw-source-seg">
            <button data-v="gitee">Gitee<span class="seg-sub">国内服务器</span></button>
            <button data-v="github">GitHub<span class="seg-sub">国外服务器</span></button>
          </div></div>
          <div class="gw-deploy-grid">
            <div class="field"><label>服务器 IP</label><input id="gw-ip" class="mono" spellcheck="false" placeholder="23.251.34.248"></div>
            <div class="field"><label>SSH 端口</label><input id="gw-sshport" class="mono" inputmode="numeric" placeholder="22"></div>
            <div class="field"><label>用户名</label><input id="gw-user" class="mono" spellcheck="false" placeholder="root"></div>
            <div class="field"><label>密码</label><input id="gw-pass" type="password" placeholder="只用于本次连接，不保存"></div>
          </div>
          <details class="gw-adv"><summary>自定义部署命令（选填，会覆盖上面的字段）</summary>
            <div class="field" style="margin-top:8px"><textarea id="gw-custom-cmd" rows="2" class="mono" spellcheck="false" placeholder="空着用系统内置命令"></textarea></div>
          </details>
          <div style="margin:8px 0;display:flex;gap:8px;justify-content:flex-end">
            <button class="btn sm primary" id="gw-deploy-btn">一键部署</button>
            <button class="btn sm" id="gw-ssh-btn">SSH 终端</button>
          </div>
          <div class="hint">点一键部署会弹出 SSH 终端并自动执行，进度实时显示在终端里</div>
          <div class="set-sec-title" style="margin-top:16px">默认网关</div>
          <div class="hint" style="margin-bottom:8px">新建网关信道时自动填充，只存本机浏览器</div>
          <div class="field"><label>手动导入</label><textarea id="gw-import" rows="2" placeholder="粘贴 mcp-gw://token@host:port 连接串、部署输出，或网关地址 + Token，自动解析"></textarea></div>
          <div style="margin:2px 0 10px"><button class="btn sm" id="gw-import-btn">解析导入</button></div>
          <div class="field"><label>网关地址</label><input id="gw-url" placeholder="ws://23.251.34.248:8080"></div>
          <div class="field"><label>网关 Token</label><input id="gw-token" type="password" placeholder="64 位 hex"></div>
          <div style="margin-top:8px"><button class="btn sm" id="gw-save">保存</button></div>
        </div>
      </div>
    </div>
    <div style="margin-top:14px;display:flex;justify-content:flex-end"><button class="btn sm" id="set-close">关闭</button></div>`);
    $("#modal-box").classList.add("set-wide");
    this.bind();
    this.switchTab(tab);
  },
  switchTab(tab) {
    this.tab = tab;
    $$(".set-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    $$(".set-pane").forEach((p) => p.classList.toggle("hidden", p.id !== `set-pane-${tab}`));
    if (tab === "general") this.loadGeneral();
    if (tab === "model") this.refreshProviders();
    if (tab === "gateway") this.refreshGateway();
  },
  bind() {
    $("#set-close").addEventListener("click", closeModal);
    $$(".set-tab").forEach((b) => b.addEventListener("click", () => this.switchTab(b.dataset.tab)));
    $(".set-main")?.addEventListener("scroll", () => closeAllCSelect(), { passive: true });
    // ---- 通用 ----
    $$("#theme-seg button").forEach((b) => b.addEventListener("click", () => {
      localStorage.setItem("theme", b.dataset.v);
      applyTheme();
      $$("#theme-seg button").forEach((x) => x.classList.toggle("active", x === b));
    }));
    initCSelect("cs-loglevel", {
      value: "debug",
      options: [
        { value: "debug", label: "debug" }, { value: "info", label: "info" },
        { value: "warn", label: "warn" }, { value: "error", label: "error" },
      ],
      onChange: async (v) => {
        try {
          await api("/api/agent/loglevel", { method: "POST", body: { level: v } });
          toast("日志级别已更新，实时生效");
        } catch (err) { toast(err.message, false); }
      },
    });
    $$("#perm-seg button").forEach((b) => b.addEventListener("click", async () => {
      try {
        await api("/api/approval-mode", { method: "POST", body: { mode: b.dataset.v } });
        $$("#perm-seg button").forEach((x) => x.classList.toggle("active", x === b));
        toast(`已切换为${b.dataset.v === "approval" ? "需要审批" : "无需审批"}`);
      } catch (e) { toast(e.message, false); }
    }));
    // ---- 模型 ----
    initCSelect("cs-pftype", {
      value: "openai",
      options: [
        { value: "openai", label: "OpenAI 兼容" },
        { value: "anthropic", label: "Anthropic" },
      ],
    });
    $("#prov-add").addEventListener("click", () => this.openForm(null));
    $("#pf-cancel").addEventListener("click", () => $("#prov-form-card").classList.add("hidden"));
    $("#pf-fetch").addEventListener("click", async () => {
      const btn = $("#pf-fetch");
      btn.disabled = true; btn.textContent = "获取中…";
      try {
        const r = await api("/api/agent/providers/models", { method: "POST", body: {
          id: this.editing || undefined,
          type: $("#cs-pftype")._getVal(),
          baseUrl: $("#pf-base").value.trim() || undefined,
          apiKey: $("#pf-key").value || undefined,
        }});
        if (!r.models?.length) { toast("未获取到模型", false); return; }
        const cur = new Set(this.fetchedModels);
        r.models.forEach((m) => cur.add(m));
        this.fetchedModels = [...cur];
        if (!this.selModel) this.selModel = this.fetchedModels[0];
        this.renderModelBox();
        toast(`获取到 ${r.models.length} 个模型`);
      } catch (e) { toast(e.message, false); }
      finally { btn.disabled = false; btn.textContent = "获取可用模型"; }
    });
    $("#pf-add-model").addEventListener("click", () => {
      const m = prompt("输入模型 ID：");
      if (!m || !m.trim()) return;
      const id = m.trim();
      if (!this.fetchedModels.includes(id)) this.fetchedModels.push(id);
      this.selModel = id;
      this.renderModelBox();
    });
    $("#pf-save").addEventListener("click", async () => {
      const body = {
        id: this.editing || undefined,
        name: $("#pf-name").value.trim(),
        type: $("#cs-pftype")._getVal(),
        baseUrl: $("#pf-base").value.trim() || undefined,
        model: this.selModel || "",
        apiKey: $("#pf-key").value || undefined,
        enabled: true,
      };
      if (!body.name || !body.model) return toast("名称和模型必填（请获取或添加模型）", false);
      try {
        await api("/api/agent/providers", { method: "POST", body });
        toast("已保存");
        $("#prov-form-card").classList.add("hidden");
        this.refreshProviders();
      } catch (e) { toast(e.message, false); }
    });
    // ---- 网关 ----
    $("#gw-url").value = localStorage.getItem("dfGwUrl") || "";
    $("#gw-token").value = localStorage.getItem("dfGwToken") || "";
    try {
      const s = JSON.parse(localStorage.getItem("gwSsh") || "{}");
      $("#gw-ip").value = s.host || "";
      $("#gw-sshport").value = s.sshPort || "";
      $("#gw-user").value = s.username || "";
    } catch { /* ignore */ }
    $("#gw-deploy-btn").addEventListener("click", () => gwDeployRun());
    $("#gw-ssh-btn").addEventListener("click", () => openSshTerminal());
    // 拉取源分段选择
    const seg = $("#gw-source-seg");
    const paintSeg = () => seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.v === gwSource()));
    seg.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { localStorage.setItem("gwSource", b.dataset.v); paintSeg(); }));
    paintSeg();
    $("#gw-save").addEventListener("click", () => {
      localStorage.setItem("dfGwUrl", $("#gw-url").value.trim());
      localStorage.setItem("dfGwToken", $("#gw-token").value.trim());
      ChannelsPage.dfGw = { url: $("#gw-url").value.trim(), token: $("#gw-token").value.trim() };
      toast("默认网关已保存");
    });
    $("#gw-import-btn").addEventListener("click", () => {
      const r = parseGwImport($("#gw-import").value);
      if (!r) { toast("未能解析出网关地址和 Token", false); return; }
      $("#gw-url").value = r.url;
      $("#gw-token").value = r.token;
      localStorage.setItem("dfGwUrl", r.url);
      localStorage.setItem("dfGwToken", r.token);
      ChannelsPage.dfGw = { url: r.url, token: r.token };
      toast("网关信息已导入并设为默认");
    });
    $("#gw-br-switch").addEventListener("change", async (e) => {
      try {
        await api("/api/bridge", { method: "POST", body: { on: e.target.checked } });
        toast(`Bridge 已${e.target.checked ? "开启" : "关闭"}`);
        this.refreshGateway();
      } catch (err) { toast(err.message, false); e.target.checked = !e.target.checked; }
    });
  },
  async loadGeneral() {
    $$("#theme-seg button").forEach((x) => x.classList.toggle("active", x.dataset.v === applyTheme()));
    const [h, ov, m, apList] = await Promise.all([
      api("/api/agent/health").catch(() => null),
      api("/api/overview").catch(() => null),
      api("/api/approval-mode").catch(() => null),
      api("/api/approvals").catch(() => []),
    ]);
    if (h?.logLevel) $("#cs-loglevel")?._setVal(h.logLevel);
    $("#app-version").textContent = `v${ov?.version || "0.1.0"}`;
    $$("#perm-seg button").forEach((x) => x.classList.toggle("active", x.dataset.v === (m?.mode || "approval")));
    const pend = apList.filter((a) => a.status === "pending");
    $("#perm-summary").textContent = pend.length ? `${pend.length} 个待审批` : "暂无待审批";
    const pl = $("#perm-list");
    pl.classList.toggle("hidden", !pend.length);
    pl.innerHTML = pend.map((a) => `
      <div class="perm-row"><div><span class="mono">${esc(a.tool)}</span>
        <div class="hint mono" style="font-size:10.5px">${new Date(a.ts).toLocaleTimeString()} · ${esc(a.source)}</div></div>
        <div style="display:flex;gap:6px">
          <button class="btn sm danger" data-ap="reject" data-id="${a.id}">拒绝</button>
          <button class="btn sm primary" data-ap="approve" data-id="${a.id}">批准</button>
        </div>
      </div>`).join("");
    $$("#perm-list [data-ap]").forEach((b) => b.addEventListener("click", async () => {
      try {
        await api(`/api/approvals/${b.dataset.id}/${b.dataset.ap}`, { method: "POST" });
        toast(b.dataset.ap === "approve" ? "已批准并执行" : "已拒绝");
      } catch (e) { toast(e.message, false); }
      this.loadGeneral();
    }));
  },
  openForm(p) {
    this.editing = p?.id || null;
    this.fetchedModels = p?.model ? [p.model] : [];
    this.selModel = p?.model || null;
    $("#pf-title").textContent = p ? "编辑模型提供商" : "添加模型提供商";
    $("#pf-save").textContent = p ? "保存" : "创建提供商";
    $("#pf-name").value = p?.name || "";
    $("#cs-pftype")._setVal(p?.type || "openai");
    $("#pf-base").value = p?.baseUrl || "";
    $("#pf-key").value = "";
    this.renderModelBox();
    $("#prov-form-card").classList.remove("hidden");
  },
  renderModelBox() {
    const box = $("#model-box");
    box.innerHTML = this.fetchedModels.length ? this.fetchedModels.map((m) => `
      <span class="model-chip${m === this.selModel ? " sel" : ""}" data-m="${esc(m)}">${esc(m)}<button class="x" data-x="${esc(m)}">×</button></span>`).join("")
      : `<div class="hint">暂无模型，请获取或手动添加</div>`;
    $$("#model-box .model-chip").forEach((c) => c.addEventListener("click", (e) => {
      if (e.target.dataset.x) return;
      this.selModel = c.dataset.m;
      this.renderModelBox();
    }));
    $$("#model-box [data-x]").forEach((x) => x.addEventListener("click", (e) => {
      e.stopPropagation();
      this.fetchedModels = this.fetchedModels.filter((m) => m !== x.dataset.x);
      if (this.selModel === x.dataset.x) this.selModel = this.fetchedModels[0] || null;
      this.renderModelBox();
    }));
  },
  async refreshProviders() {
    const list = await api("/api/agent/providers").catch(() => []);
    $("#prov-list").innerHTML = list.length ? list.map((p, i) => `
      <div class="prov-card">
        <div>
          <div class="prov-name">${esc(p.name)}<span class="dot ${p.hasKey ? "green" : "gray"}"></span></div>
          <div class="prov-model">${esc(p.model)}</div>
        </div>
        <div class="prov-actions">
          ${i === 0 ? '<span class="pill green sm">使用中</span>' : `<button class="btn sm ghost" data-act="active" data-id="${p.id}">设为默认</button>`}
          <button class="btn sm" data-act="edit" data-id="${p.id}">编辑</button>
          <button class="btn sm danger" data-act="del" data-id="${p.id}">删除</button>
        </div>
      </div>`).join("") : "";
    $$("#prov-list [data-act]").forEach((b) => b.addEventListener("click", async () => {
      const id = b.dataset.id, act = b.dataset.act;
      if (act === "del" && !confirm("删除该供应商？")) return;
      if (act === "edit") { this.openForm(list.find((x) => x.id === id)); return; }
      const url = act === "active" ? `/api/agent/providers/${id}/active` : `/api/agent/providers/${id}`;
      await api(url, { method: act === "active" ? "POST" : "DELETE" }).catch((e) => toast(e.message, false));
      this.refreshProviders();
    }));
  },
  async refreshGateway() {
    const b = await api("/api/bridge").catch(() => ({ enabled: false, pipes: [] }));
    $("#gw-br-switch").checked = b.enabled;
    $("#gw-br-state").textContent = b.enabled ? "开启" : "关闭";
    $("#gw-pipes").innerHTML = b.pipes.length ? b.pipes.map((p) => `
      <div class="ch-row" style="height:44px"><span class="dot ${p.connected ? "green pulse" : "red"}"></span>
        <div><div class="mono" style="font-size:12px">${esc(p.gatewayUrl)}</div>
        <div class="hint mono" style="font-size:10.5px">${p.channelCount} 条信道 · ${p.avgLatencyMs != null ? p.avgLatencyMs + " ms" : "无延迟数据"} · ${esc(p.state)}</div></div>
      </div>`).join("") : `<div class="hint">暂无网关管道（新建网关信道后出现）</div>`;
  },
};
$("#settings-btn").addEventListener("click", () => SettingsModal.open());

/* ================= 启动 ================= */
const PAGES = {
  overview: Overview, channels: ChannelsPage,
  plugins: PluginsPage, skills: SkillsPage, connectors: ConnectorsPage,
  tools: ToolsPage, logs: LogsPage, errors: ErrorsPage,
};

(async function boot() {
  try {
    const ov = await api("/api/overview");
    { const _u = $("#uptime"); if (_u) _u.textContent = `运行时长 ${fmtUptime(ov.uptimeSec)}`; }
    buildCmdkIndex();
  } catch (e) {
    toast("连接 dashboard 后端失败", false);
  }
  setInterval(async () => {
    try {
      const ov = await api("/api/overview");
      { const _u = $("#uptime"); if (_u) _u.textContent = `运行时长 ${fmtUptime(ov.uptimeSec)}`; }
    } catch { /* ignore */ }
  }, 10000);
  navTo("overview");
})();
