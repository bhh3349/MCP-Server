/* MCP-Server 控制中心前端 */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------- 基础 ---------- */
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
function copyText(t) {
  navigator.clipboard.writeText(t).then(() => toast("已复制"), () => toast("复制失败", false));
}
function openModal(html) {
  $("#modal-box").innerHTML = html;
  $("#modal-overlay").classList.remove("hidden");
}
function closeModal() { $("#modal-overlay").classList.add("hidden"); }
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
  if (ch.paired) return "green";
  return "yellow";
}

/* ---------- 路由 ---------- */
const PAGE_TITLES = { overview: "概览", channels: "信道", gateway: "网关", extensions: "扩展", tools: "工具", logs: "日志", errors: "错误" };
let currentPage = "overview";
const pageInited = {};
function navTo(page) {
  currentPage = page;
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${page}`));
  $("#crumb").textContent = PAGE_TITLES[page];
  if (!pageInited[page]) { pageInited[page] = true; PAGES[page].init?.(); }
  PAGES[page].show?.();
  stopLive();
  LogsPage.stop(); ErrorsPage.stop();
  if (page === "overview") startLive();
  if (page === "logs") LogsPage.start();
  if (page === "errors") ErrorsPage.start();
}
$$(".nav-item").forEach((b) => b.addEventListener("click", () => navTo(b.dataset.page)));
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
function drawDonut(cv, rate) {
  const { ctx, w, h } = setupCanvas(cv, 96);
  const cx = 48, cy = 48, r = 38, lw = 11;
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = lw; ctx.lineCap = "round";
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,.07)"; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * rate);
  ctx.strokeStyle = rate > 0.95 ? "#4ade80" : rate > 0.8 ? "#facc15" : "#f87171";
  ctx.stroke();
}

/* ================= 概览 ================= */
const Overview = {
  timer: null,
  qpsHist: [], latHist: [],
  lastCalls: 0, lastTs: 0,
  logSince: 0,

  html() {
    return `
    <div class="ov-top">
      <div class="card stat-card hero">
        <div class="stat-label"><span class="dot green pulse"></span>MCP 状态</div>
        <div class="stat-num" id="ov-tools">–</div>
        <div class="stat-sub" id="ov-uptime">运行中 · --</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label"><span class="dot green pulse" id="ov-gw-dot"></span>网关延迟</div>
        <div class="stat-num" id="ov-lat">–<small> ms</small></div>
        <canvas class="spark" id="ov-spark" style="width:100%"></canvas>
      </div>
      <div class="card stat-card">
        <div class="stat-label"><span class="dot green" id="ov-br-dot"></span>BRIDGE</div>
        <div class="bridge-row">
          <span class="bridge-state" id="ov-br-state">开启</span>
          <label class="switch"><input type="checkbox" id="ov-br-switch" checked><span class="track"></span></label>
        </div>
        <div class="stat-sub" id="ov-br-sub">通道正常</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">信道 <span class="pill purple" id="ov-ch-count">0</span>
          <button class="btn sm ghost" id="ov-add-ch" style="margin-left:auto">＋ 添加</button>
        </div>
        <div class="ch-list" id="ov-ch-list"><div class="ch-empty">暂无信道</div></div>
      </div>
    </div>
    <div class="ov-mid">
      <div class="card">
        <div class="card-title">调用吞吐 <span class="hint mono" id="ov-qps">– req/s</span></div>
        <canvas class="chart" id="ov-chart"></canvas>
        <div style="display:flex;gap:14px;margin-top:6px;font-size:11px;color:var(--text3)">
          <span><span style="color:#8b5cf6">—</span> 调用/秒</span>
          <span><span style="color:#34d399">—</span> 成功/秒</span>
        </div>
      </div>
      <div class="card">
        <div class="card-title">工具调用排行</div>
        <div id="ov-rank"></div>
      </div>
      <div class="card">
        <div class="card-title">调用成功率</div>
        <div class="donut-wrap">
          <div class="donut-center"><canvas id="ov-donut" style="width:96px"></canvas>
            <div class="donut-label"><b id="ov-rate">–</b><span>成功率</span></div>
          </div>
          <div class="donut-legend" id="ov-legend"></div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">实时日志 <span class="hint">最近 30 条</span></div>
      <div class="log-stream" id="ov-logs"></div>
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
  },

  async refresh() {
    try {
      const [ov, chs, st] = await Promise.all([
        api("/api/overview"), api("/api/channels"), api("/api/stats/tools"),
      ]);
      // MCP
      $("#ov-tools").innerHTML = `${ov.tools.count}<small> 工具</small>`;
      $("#ov-uptime").textContent = `运行中 · ${fmtUptime(ov.uptimeSec)}`;
      $("#uptime").textContent = `运行时长 ${fmtUptime(ov.uptimeSec)}`;
      // 网关延迟：取各管道平均
      const pipes = ov.bridge.pipes;
      const lat = pipes.length && pipes[0].avgLatencyMs != null ? pipes[0].avgLatencyMs
        : chs.filter((c) => c.latencyMs != null).map((c) => c.latencyMs);
      const latVal = Array.isArray(lat)
        ? (lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null) : lat;
      $("#ov-lat").innerHTML = latVal != null ? `${latVal}<small> ms</small>` : `–<small> ms</small>`;
      const gwOk = ov.bridge.enabled && pipes.some((p) => p.connected);
      $("#ov-gw-dot").className = `dot ${pipes.length === 0 ? "gray" : gwOk ? "green pulse" : "red"}`;
      if (latVal != null) {
        this.latHist.push(latVal); if (this.latHist.length > 30) this.latHist.shift();
        drawSpark($("#ov-spark"), this.latHist, "#4ade80");
      }
      // Bridge
      const sw = $("#ov-br-switch");
      if (document.activeElement !== sw) sw.checked = ov.bridge.enabled;
      $("#ov-br-state").textContent = ov.bridge.enabled ? "开启" : "关闭";
      $("#ov-br-dot").className = `dot ${ov.bridge.enabled ? "green" : "gray"}`;
      $("#ov-br-sub").textContent = ov.bridge.enabled
        ? (pipes.length ? `${pipes.length} 条网关管道` : "就绪，未建管道") : "通道已关闭";
      // 信道列表
      $("#ov-ch-count").textContent = chs.length;
      $("#badge-channels").textContent = chs.length || "";
      $("#ov-ch-list").innerHTML = chs.length ? chs.map((c) => `
        <div class="ch-row"><span class="dot ${dotFor(c)}"></span>
          <span class="ch-name">${esc(c.name)}</span>
          <span class="ch-proj">${esc(c.ai?.name ? `${c.ai.name} · ${c.stats.requestsIn}调用` : c.paired ? "已配对" : "等待配对")}</span>
        </div>`).join("") : `<div class="ch-empty">暂无信道，点击添加</div>`;
      // 吞吐：用总调用数差分
      const now = Date.now(), total = st.summary.totalCalls;
      if (this.lastTs) {
        const qps = (total - this.lastCalls) / ((now - this.lastTs) / 1000);
        const okRate = st.summary.successRate;
        this.qpsHist.push({ qps: Math.max(0, qps), ok: Math.max(0, qps * okRate) });
        if (this.qpsHist.length > 30) this.qpsHist.shift();
        $("#ov-qps").textContent = `${qps.toFixed(1)} req/s`;
      }
      this.lastCalls = total; this.lastTs = now;
      if (this.qpsHist.length > 1) {
        drawLineChart($("#ov-chart"),
          [this.qpsHist.map((p) => p.qps), this.qpsHist.map((p) => p.ok)],
          ["#8b5cf6", "#34d399"]);
      }
      // 排行
      const top = st.tools.slice(0, 8);
      const max = Math.max(1, ...top.map((t) => t.calls));
      $("#ov-rank").innerHTML = top.map((t) => `
        <div class="rank-row"><span class="rank-name">${esc(t.name)}</span>
          <div class="rank-bar"><div class="rank-fill" style="width:${(t.calls / max * 100).toFixed(1)}%"></div></div>
          <span class="rank-num">${t.calls}</span></div>`).join("") || `<div class="hint">暂无调用</div>`;
      // 成功率
      const rate = st.summary.successRate;
      $("#ov-rate").textContent = `${(rate * 100).toFixed(1)}%`;
      drawDonut($("#ov-donut"), rate);
      $("#ov-legend").innerHTML = `
        <div><span class="dot green"></span> 成功 ${st.summary.totalCalls - st.summary.totalErrors}</div>
        <div><span class="dot red"></span> 失败 ${st.summary.totalErrors}</div>
        <div class="hint mono">共 ${st.summary.totalCalls} 次调用</div>`;
      // 错误徽章
      $("#badge-errors").textContent = ov.errors.unacked || "";
      // 日志
      const logs = await api(`/api/logs?limit=30&since=${this.logSince}`);
      if (logs.length) {
        this.logSince = logs[logs.length - 1].id;
        $("#ov-logs").innerHTML += logs.map(logLine).join("");
        const el = $("#ov-logs");
        while (el.children.length > 30) el.firstChild.remove();
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
        <td>${c.paired ? '<span class="pill green">已配对</span>' : '<span class="pill yellow">等待配对</span>'}</td>
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
const GatewayPage = {
  html() {
    return `
    <div class="sec-head"><div class="sec-title">网关</div></div>
    <div class="card" style="margin-bottom:12px">
      <div class="card-title">BRIDGE 总开关 <span class="hint">关闭后断开所有网关管道</span></div>
      <div class="bridge-row" style="margin-top:0">
        <span class="bridge-state" id="gw-br-state">–</span>
        <label class="switch"><input type="checkbox" id="gw-br-switch"><span class="track"></span></label>
      </div>
    </div>
    <div class="card" style="margin-bottom:12px">
      <div class="card-title">网关管道</div>
      <div id="gw-pipes"></div>
    </div>
    <div class="card">
      <div class="card-title">默认网关 <span class="hint">新建网关信道时自动填充，只存本机浏览器</span></div>
      <div class="field"><label>网关地址</label><input id="gw-url" placeholder="ws://23.251.34.248:8080"></div>
      <div class="field"><label>网关 Token</label><input id="gw-token" type="password" placeholder="64 位 hex"></div>
      <div class="modal-actions" style="margin-top:4px"><button class="btn sm" id="gw-save">保存</button></div>
    </div>`;
  },
  init() {
    $("#page-gateway").innerHTML = this.html();
    $("#gw-url").value = localStorage.getItem("dfGwUrl") || "";
    $("#gw-token").value = localStorage.getItem("dfGwToken") || "";
    $("#gw-save").addEventListener("click", () => {
      localStorage.setItem("dfGwUrl", $("#gw-url").value.trim());
      localStorage.setItem("dfGwToken", $("#gw-token").value.trim());
      ChannelsPage.dfGw = { url: $("#gw-url").value.trim(), token: $("#gw-token").value.trim() };
      toast("默认网关已保存");
    });
    $("#gw-br-switch").addEventListener("change", async (e) => {
      try {
        await api("/api/bridge", { method: "POST", body: { on: e.target.checked } });
        toast(`Bridge 已${e.target.checked ? "开启" : "关闭"}`);
        this.show();
      } catch (err) { toast(err.message, false); e.target.checked = !e.target.checked; }
    });
  },
  async show() {
    const b = await api("/api/bridge").catch(() => ({ enabled: false, pipes: [] }));
    $("#gw-br-switch").checked = b.enabled;
    $("#gw-br-state").innerHTML = b.enabled
      ? `<span class="dot green"></span> 开启` : `<span class="dot gray"></span> 关闭`;
    $("#gw-pipes").innerHTML = b.pipes.length ? b.pipes.map((p) => `
      <div class="ch-row" style="height:44px"><span class="dot ${p.connected ? "green pulse" : "red"}"></span>
        <div><div class="mono" style="font-size:12px">${esc(p.gatewayUrl)}</div>
        <div class="hint mono" style="font-size:10.5px">${p.channelCount} 条信道 · ${p.avgLatencyMs != null ? p.avgLatencyMs + " ms" : "无延迟数据"} · ${esc(p.state)}</div></div>
      </div>`).join("") : `<div class="hint">暂无网关管道（新建网关信道后出现）</div>`;
  },
};

/* ================= 扩展 ================= */
const ExtensionsPage = {
  html() { return `<div class="sec-head"><div class="sec-title">扩展</div></div><div id="ext-wrap"></div>`; },
  init() { $("#page-extensions").innerHTML = this.html(); },
  async show() {
    const exts = await api("/api/extensions").catch(() => []);
    $("#badge-ext").textContent = exts.length || "";
    const groups = { plugin: "插件 Plugins", skill: "技能 Skills", connector: "连接器 Connectors" };
    $("#ext-wrap").innerHTML = Object.entries(groups).map(([kind, title]) => {
      const items = exts.filter((e) => e.kind === kind);
      return `<div class="card" style="margin-bottom:12px"><div class="card-title">${title} <span class="hint">${items.length}</span></div>
        ${items.length ? `<div class="ext-grid">` + items.map((e) => `
          <div class="ext-card card" style="background:var(--bg)">
            <div class="ext-head"><span class="ext-name">${esc(e.name)}</span>
              <span class="pill ${e.enabled ? "green" : "gray"}" style="margin-left:auto">${e.enabled ? "已启用" : "已禁用"}</span></div>
            <div class="ext-desc">${esc(e.description || "暂无描述")}</div>
            <div class="ext-tools">${e.toolNames.map(esc).join(" · ") || e.version || ""}</div>
            <div class="ext-foot">
              ${e.name === "github" ? `<button class="btn sm ghost" data-cfg="${esc(e.name)}">配置 Token</button>` : `<span></span>`}
              ${e.enabled ? `<label class="switch" title="禁用"><input type="checkbox" checked data-dis="${esc(e.name)}"><span class="track"></span></label>` : `<span class="hint">重启恢复</span>`}
            </div>
          </div>`).join("") + `</div>`
        : `<div class="hint">暂无${title}</div>`}</div>`;
    }).join("");
    $$("#ext-wrap [data-dis]").forEach((sw) => sw.addEventListener("change", async () => {
      const r = await api(`/api/extensions/${encodeURIComponent(sw.dataset.dis)}/disable`, { method: "POST" }).catch((e) => toast(e.message, false));
      if (r?.ok) { toast("已禁用，重启 dashboard 恢复"); this.show(); }
      else sw.checked = true;
    }));
    $$("#ext-wrap [data-cfg]").forEach((b) => b.addEventListener("click", () => this.openConfig(b.dataset.cfg)));
  },
  openConfig(name) {
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
  },
};

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
        $("#pg-result").innerHTML = `<div class="result-box ok">${esc(JSON.stringify(r.result, null, 2))}\n\n// ${r.ms}ms</div>`;
      } catch (e) {
        $("#pg-result").innerHTML = `<div class="result-box err">${esc(e.message)}</div>`;
      } finally { btn.disabled = false; btn.textContent = "执行"; }
    });
  },
};

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

/* ================= 启动 ================= */
const PAGES = {
  overview: Overview, channels: ChannelsPage, gateway: GatewayPage,
  extensions: ExtensionsPage, tools: ToolsPage, logs: LogsPage, errors: ErrorsPage,
};

(async function boot() {
  try {
    const ov = await api("/api/overview");
    $("#uptime").textContent = `运行时长 ${fmtUptime(ov.uptimeSec)}`;
    buildCmdkIndex();
  } catch (e) {
    toast("连接 dashboard 后端失败", false);
  }
  setInterval(async () => {
    try {
      const ov = await api("/api/overview");
      $("#uptime").textContent = `运行时长 ${fmtUptime(ov.uptimeSec)}`;
    } catch { /* ignore */ }
  }, 10000);
  navTo("overview");
})();
