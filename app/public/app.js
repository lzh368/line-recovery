/*
 * 产线恢复助手 · 前端（原生 JS，零外部请求）
 *
 * 三条不可越界的规则（见仓库 interfaces/README.md）：
 * 1. 页面上展示的“资料”全部来自后端解析结果，前端不自行推断停机原因；
 * 2. 诊断只来自嵌入式 Agent，未配置模型时如实显示不可用；
 * 3. 动作与反馈只读后端审计，工具未连接时如实显示“工具未连接”，不编造受理或反馈。
 */
const $ = (sel, root = document) => root.querySelector(sel);

/* ── 状态 ─────────────────────────────────────────────────────────────── */
const state = {
  health: null,
  tools: null,
  model: null,
  cases: [],
  caseId: null,
  summary: null,
  telemetry: null,
  events: null,
  report: null,
  reportMissing: false,
  /** 本页点“请求动作”得到的最新一次后端结果；页面刷新后由报告里的 recovery_outcome 补上。 */
  lastOutcome: null,
  audit: [],
  tab: "overview",
  analyzing: false,
  analyzeAbort: null,
  stream: { text: "", thinking: "", status: "", tools: [] },
  imageIndex: 0,
};

const STAGES = [
  { key: "requested", name: "命令受理", desc: "后端回传受理结果" },
  { key: "cooling_started", name: "风机转动", desc: "有风机运行反馈" },
  { key: "temperature_ready", name: "温度达标", desc: "后端按连续温度判定" },
  { key: "running_confirmed", name: "输送运行", desc: "实测带速恢复" },
  { key: "production_confirmed", name: "出口产出", desc: "出口计数超过动作前基准" },
];

const STATUS_LABEL = {
  not_attempted: "未尝试",
  requested: "已受理（尚未确认执行）",
  cooling_started: "风机已转动",
  temperature_ready: "温度已达要求",
  running_confirmed: "输送已运行",
  production_confirmed: "出口产出已恢复",
  rejected: "被拒绝",
  failed: "失败",
  unknown: "未确认",
};

/** Agent 工具轨迹的三种状态（见 src/diagnosis/agent.ts 的 AnalysisEvent.tool）。 */
const TOOL_STATE_LABEL = {
  start: "调用中",
  done: "已返回结果",
  deny: "被拒绝（未执行）",
};

/** 审计里的触发方（见 src/audit.ts 的 AuditActor）：谁发起的请求，页面按此如实区分。 */
const AUDIT_ACTOR_LABEL = {
  agent: "Agent 受控工具",
  backend: "页面 / 后端",
  operator: "现场人员",
};

const STATUS_INDEX = {
  requested: 0,
  cooling_started: 1,
  temperature_ready: 2,
  running_confirmed: 3,
  production_confirmed: 4,
};

/* ── DOM 小工具（全部走 textContent，上传内容不会被当作 HTML） ───────────── */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

const txt = (...children) => {
  const span = h("span");
  append(span, children);
  return span;
};

function note(kind, ...children) {
  return h("div", { class: `note ${kind}` }, ...children);
}

function hint(...children) {
  return h("p", { class: "hint" }, ...children);
}

function pills(items) {
  return h("div", { class: "row" }, items.map((i) => h("span", { class: `pill ${i.kind ?? ""}`, text: i.text })));
}

function kvList(pairs) {
  const dl = h("dl", { class: "kv" });
  for (const [label, value] of pairs) {
    if (value === undefined) continue;
    dl.append(h("dt", { text: label }), h("dd", {}, value instanceof Node ? value : document.createTextNode(fmt(value))));
  }
  return dl;
}

function table(columns, rows, options = {}) {
  const thead = h("thead", {}, h("tr", {}, columns.map((c) => h("th", { class: c.mono ? "mono" : "", text: c.title }))));
  const tbody = h(
    "tbody",
    {},
    rows.map((row) =>
      h(
        "tr",
        {},
        columns.map((c) => {
          const value = c.value(row);
          const cell = h("td", { class: c.mono ? "mono" : "" });
          append(cell, [value instanceof Node ? value : document.createTextNode(value === undefined || value === null ? "—" : String(value))]);
          return cell;
        }),
      ),
    ),
  );
  const wrapper = h("div", { class: `scroll${options.tall ? " tall" : ""}` }, h("table", {}, thead, tbody));
  return rows.length ? wrapper : (options.empty ? note("info", options.empty) : wrapper);
}

/* ── 取值与格式化 ─────────────────────────────────────────────────────── */
function fmt(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** CSV 里的 0/1 布尔按原样显示；空值表示未观测。 */
function csvCell(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}

function clock(ts) {
  const s = String(ts ?? "");
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s) ? s.slice(11, 19) : s;
}

function stamp(ts) {
  const s = String(ts ?? "");
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? `${s.slice(0, 10)} ${s.slice(11, 19)}` : s;
}

function flatten(obj, prefix = "") {
  const out = [];
  for (const [key, value] of Object.entries(obj ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) out.push(...flatten(value, path));
    else out.push([path, Array.isArray(value) ? value.join("、") : value]);
  }
  return out;
}

/* ── API ──────────────────────────────────────────────────────────────── */
async function api(path, options = {}) {
  const res = await fetch(path, options);
  const type = res.headers.get("content-type") ?? "";
  const body = type.includes("json") ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const error = new Error((body && body.message) || res.statusText || `HTTP ${res.status}`);
    error.code = body && body.error ? body.error : `HTTP_${res.status}`;
    error.detail = body ? body.detail : null;
    error.status = res.status;
    throw error;
  }
  return body;
}

/* ── 主题 ─────────────────────────────────────────────────────────────── */
function initTheme() {
  const stored = localStorage.getItem("lr-theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  setTheme(stored ? stored : prefersDark ? "dark" : "light");
  $("#theme-toggle").addEventListener("click", () => {
    setTheme(document.documentElement.classList.contains("dark") ? "light" : "dark");
  });
}

function setTheme(mode) {
  const dark = mode === "dark";
  document.documentElement.classList.toggle("dark", dark);
  localStorage.setItem("lr-theme", mode);
  const button = $("#theme-toggle");
  button.textContent = dark ? "浅色模式" : "深色模式";
  button.setAttribute("aria-pressed", String(dark));
}

/* ── 顶部状态与侧栏 ───────────────────────────────────────────────────── */
async function loadHealth() {
  try {
    state.health = await api("/api/health");
  } catch (error) {
    state.health = null;
    $("#runtime-info").replaceChildren(note("bad", `无法读取运行信息：${error.message}`));
    return;
  }
  $("#runtime-info").replaceChildren(
    kvList([
      ["版本", state.health.version],
      ["执行模式", state.health.execution_mode === "live" ? "live（真实执行）" : "dry_run（演示模式）"],
      ["契约目录", state.health.contracts_dir],
      ["接口目录", state.health.interfaces_dir],
      ["接口配置", state.health.interfaces_config],
      ["运行目录", state.health.runtime_dir],
      ["示例目录", state.health.example_dir],
    ]),
  );
  const mode = $("#pill-mode");
  mode.textContent = state.health.execution_mode === "live" ? "执行模式 live" : "执行模式 dry_run（演示）";
  mode.className = `pill ${state.health.execution_mode === "live" ? "bad" : "tint"}`;
}

async function loadTools() {
  try {
    state.tools = await api("/api/tools");
  } catch (error) {
    $("#tools-panel").replaceChildren(note("bad", `无法读取工具状态：${error.message}`));
    return;
  }
  renderTools();
}

function renderTools() {
  const data = state.tools;
  if (!data) return;
  const panel = $("#tools-panel");
  const interfaces = data.interfaces ?? [];
  panel.replaceChildren(
    ...interfaces.map((item) => {
      const connected = item.connection === "connected";
      // idle（配了服务但还没试过连接）按“未连接”提示，不能写成“连接失败”；只有真的试过并失败才用 bad。
      const kind = connected ? "ok" : item.connection === "error" ? "bad" : "warn";
      return h(
        "div",
        { class: "stack" },
        h(
          "div",
          { class: "row between" },
          h("strong", { text: item.title }),
          h("span", { class: `pill ${kind}`, text: item.connectionLabel }),
        ),
        kvList([
          ["查询工具", item.statusTool],
          ["写工具", item.writeTool],
          ["服务命令", item.serviceConfigured ? item.serviceCommand : "未配置（所以是“工具未连接”）"],
          ["命令存在", item.serviceConfigured ? (item.serviceExists ? "是" : "否") : "—"],
          ["已声明工具", item.declaredTools.map((t) => t.name).join("、") || "—"],
          ["契约文件", item.toolsJsonPath],
        ]),
        item.note ? hint(item.note) : null,
        item.error ? note("bad", `连接错误：${item.error}`) : null,
        h(
          "div",
          { class: "row" },
          h("button", {
            type: "button",
            text: "连接",
            disabled: !item.serviceConfigured || connected,
            onclick: (event) => connectTool(item.id, event.target),
          }),
          h("button", {
            type: "button",
            text: "断开",
            disabled: !connected,
            onclick: (event) => disconnectTool(item.id, event.target),
          }),
        ),
      );
    }),
  );
  updatePills();
}

async function connectTool(id, button) {
  button.disabled = true;
  button.textContent = "连接中…";
  try {
    await api(`/api/tools/${id}/connect`, { method: "POST" });
  } catch (error) {
    button.textContent = `连接失败：${error.message}`;
  }
  await loadTools();
}

async function disconnectTool(id, button) {
  button.disabled = true;
  button.textContent = "断开中…";
  try {
    await api(`/api/tools/${id}/disconnect`, { method: "POST" });
  } catch (error) {
    button.textContent = `断开失败：${error.message}`;
  }
  await loadTools();
}

async function loadModel() {
  const panel = $("#model-panel");
  panel.replaceChildren(h("div", { class: "faint" }, h("span", { class: "spinner" }, h("i"), h("i"), h("i")), " 正在检查模型…"));
  try {
    state.model = await api("/api/model");
  } catch (error) {
    state.model = { configured: false, error: error.message, note: "无法读取模型状态" };
  }
  renderModel();
}

function renderModel() {
  const model = state.model ?? {};
  const panel = $("#model-panel");
  const env = model.model_env ?? {};
  const fromEnv = Boolean(env.provider_set || env.model_id_set);
  const modelLine = [
    `模型 ${model.pinned_provider ?? "—"} / ${model.pinned_model_id ?? "—"}`,
    env.provider_key
      ? `变量 ${env.provider_key} / ${env.model_id_key}（${fromEnv ? `来自 ${model.env_file ?? "app/.env"}` : "未写，用默认值"}）`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const keyLine = [
    `端点 ${model.base_url ?? "—"}`,
    `密钥变量 ${model.provider_env_key ?? "—"}`,
    model.api_key_present ? "已读到" : "未读到",
    `填写位置 ${model.env_file ?? "app/.env"}${model.env_file_exists ? "（存在）" : "（未创建）"}`,
  ].join(" · ");
  if (model.configured) {
    panel.replaceChildren(
      kvList([
        ["状态", "已就绪"],
        ["提供方", model.provider ?? model.pinned_provider],
        ["模型", model.modelId ?? model.pinned_model_id],
        ["Agent 数据根", model.data_root],
      ]),
      hint(model.note ?? ""),
      hint(modelLine),
      hint(keyLine),
    );
  } else {
    panel.replaceChildren(
      note(
        "warn",
        h("strong", { text: "诊断暂不可用" }),
        h("div", { text: model.note ?? "未配置模型。" }),
        model.error ? h("div", { class: "faint", text: `原因：${model.error}` }) : null,
        h("div", { class: "faint", text: "浏览资料、工具状态、审计与动作边界不受影响；诊断需要为本应用配置模型 API Key。" }),
        h("div", { class: "faint", text: modelLine }),
        h("div", { class: "faint", text: keyLine }),
      ),
    );
  }
  updatePills();
}

function updatePills() {
  const tools = $("#pill-tools");
  const toolText = $("#pill-tools-text");
  const interfaces = (state.tools && state.tools.interfaces) || [];
  const connected = interfaces.filter((i) => i.connection === "connected").length;
  const configured = interfaces.filter((i) => i.serviceConfigured).length;
  if (!interfaces.length) {
    tools.className = "pill warn";
    toolText.textContent = "工具状态未知";
  } else if (connected === interfaces.length) {
    tools.className = "pill ok";
    toolText.textContent = `工具已连接（${connected}/${interfaces.length}）`;
  } else if (configured === 0) {
    tools.className = "pill warn";
    toolText.textContent = `工具未连接（${interfaces.length} 个接口均无服务）`;
  } else {
    tools.className = "pill bad";
    toolText.textContent = `工具部分可用（${connected}/${interfaces.length}）`;
  }

  const model = $("#pill-model");
  const modelText = $("#pill-model-text");
  if (!state.model) {
    model.className = "pill";
    modelText.textContent = "模型检查中…";
  } else if (state.model.configured) {
    model.className = "pill ok";
    modelText.textContent = `模型 ${state.model.modelId ?? "已就绪"}`;
  } else {
    model.className = "pill warn";
    modelText.textContent = "模型未配置";
  }
}

/* ── 案例 ─────────────────────────────────────────────────────────────── */
async function refreshCases() {
  try {
    const data = await api("/api/cases");
    state.cases = data.cases ?? [];
  } catch (error) {
    $("#case-list-msg").textContent = `读取案例失败：${error.message}`;
    return;
  }
  renderCases();
}

function renderCases() {
  const list = $("#case-list");
  const empty = $("#case-list-empty");
  list.replaceChildren(
    ...state.cases.map((meta) =>
      h(
        "button",
        {
          type: "button",
          class: "case-item",
          "aria-current": String(meta.caseId === state.caseId),
          onclick: () => selectCase(meta.caseId),
        },
        h("strong", { text: meta.label || meta.caseId }),
        h("span", { class: "faint", text: `${meta.caseId} · ${meta.deviceId} · ${meta.origin === "example" ? "example" : "上传"}` }),
      ),
    ),
  );
  empty.hidden = state.cases.length > 0;
}

async function selectCase(caseId) {
  if (state.analyzeAbort) state.analyzeAbort.abort();
  state.caseId = caseId;
  state.summary = null;
  state.telemetry = null;
  state.events = null;
  state.report = null;
  state.reportMissing = false;
  state.lastOutcome = null;
  state.audit = [];
  state.stream = { text: "", thinking: "", status: "", tools: [] };
  state.imageIndex = 0;
  $("#empty-state").hidden = true;
  $("#workspace").hidden = false;
  $("#case-title").textContent = caseId;
  $("#case-badges").replaceChildren(h("span", { class: "pill", text: "加载中…" }));
  renderCases();
  setTab("overview");

  try {
    state.summary = await api(`/api/cases/${encodeURIComponent(caseId)}`);
  } catch (error) {
    $("#case-badges").replaceChildren(h("span", { class: "pill bad", text: `加载失败：${error.message}` }));
    return;
  }
  renderCaseHeader();
  renderAll();
  await loadCaseAux();
}

async function loadCaseAux() {
  const id = encodeURIComponent(state.caseId);
  const [telemetry, events, report, audit] = await Promise.all([
    api(`/api/cases/${id}/telemetry?limit=500`).catch(() => null),
    api(`/api/cases/${id}/events`).catch(() => null),
    api(`/api/cases/${id}/report`)
      .then((value) => value)
      .catch((error) => {
        if (error.code === "REPORT_NOT_FOUND") {
          state.reportMissing = true;
          return null;
        }
        return null;
      }),
    api(`/api/cases/${id}/audit`).catch(() => ({ audit: [] })),
  ]);
  state.telemetry = telemetry;
  state.events = events;
  state.report = report;
  state.audit = (audit && audit.audit) || [];
  renderAll();
}

function renderAll() {
  renderOverview();
  renderTelemetry();
  renderEvents();
  renderImages();
  renderDiagnosis();
  renderActions();
}

function renderCaseHeader() {
  const { meta, counts, manifestCheck, parseProblems } = state.summary;
  const badges = [
    h("span", { class: "pill tint", text: meta.origin === "example" ? "example（只读联调资料）" : "上传资料包" }),
    h("span", { class: "pill", text: meta.deviceId }),
    h("span", { class: "pill", text: `${counts.telemetryRows} 行时序` }),
    h("span", { class: "pill", text: `${counts.events} 条日志` }),
    h("span", { class: "pill", text: `${counts.images} 张图片` }),
  ];
  if (manifestCheck.problems.length) badges.push(h("span", { class: "pill warn", text: `manifest 疑点 ${manifestCheck.problems.length}` }));
  else badges.push(h("span", { class: "pill ok", text: "manifest 核对通过" }));
  if (parseProblems.length) badges.push(h("span", { class: "pill warn", text: `解析提示 ${parseProblems.length}` }));
  $("#case-badges").replaceChildren(...badges);
  $("#case-title").textContent = `${meta.caseId} · ${meta.label || ""}`.trim();
  $("#delete-case").hidden = meta.origin !== "upload";
}

/* ── 资料总览 ─────────────────────────────────────────────────────────── */
function renderOverview() {
  const panel = $("#tab-overview");
  if (!state.summary) {
    panel.replaceChildren(h("div", { class: "card faint", text: "正在读取资料…" }));
    return;
  }
  const { request, device, snapshot, facts, readme, operatingGuide, files, manifestCheck, parseProblems, counts, validations, meta } = state.summary;

  panel.replaceChildren(
    h(
      "section",
      { class: "card" },
      h("h3", { text: "操作人员提出的问题" }),
      hint("README.md 是业务问题原文，不是答案，也不是执行授权。"),
      h("pre", { class: "json prose", text: readme || "（资料包里没有 README.md）" }),
      h("div", { style: "margin-top:12px" }),
      hint("requested_task（request.json）"),
      h("pre", { class: "json prose", text: request.requested_task || "—" }),
    ),

    h(
      "section",
      { class: "card" },
      h("h3", { text: "案例与采集窗口" }),
      kvList([
        ["案例", meta.caseId],
        ["设备", meta.deviceId],
        ["来源", meta.origin === "example" ? `example（${meta.sourceDir}）` : "上传 ZIP"],
        ["载入时间", stamp(meta.loadedAt)],
        ["dataset_version", request.dataset_version],
        ["采集窗口", `${stamp(request.window_start)} ~ ${stamp(request.window_end)}`],
        ["采样间隔", `${request.sample_interval_s ?? "—"} s`],
        ["时序行数", `${facts.window.rows} 行（按窗口与间隔预期 ${facts.window.expectedRows ?? "—"} 行）`],
        ["时序缺口", facts.window.gaps.length ? facts.window.gaps.map((g) => `${clock(g.after)}→${clock(g.before)} 缺 ${g.missingSamples} 点`).join("；") : "无"],
        ["资料自述完整性", `telemetry_complete=${fmt(request.collection && request.collection.telemetry_complete)}，events_complete=${fmt(request.collection && request.collection.events_complete)}`],
        ["上传快照时效性", `uploaded_state_is_live_authority=${fmt(request.collection && request.collection.uploaded_state_is_live_authority)}`],
        ["synthetic", fmt(request.synthetic)],
      ]),
    ),

    h(
      "section",
      { class: "card" },
      h("h3", { text: "窗口内的事实核对" }),
      hint("这里只列出资料记录了什么的客观结果，不给出停机原因；原因判断在“诊断与证据”里由 Agent 给出。"),
      kvList([
        ["供电丢失", facts.power.lostAt ? stamp(facts.power.lostAt) : "窗口内无记录"],
        ["供电恢复", facts.power.restoredAt ? stamp(facts.power.restoredAt) : "窗口内无记录"],
        ["丢失期间最低驱动电压", facts.power.voltageMin === null ? "—" : `${facts.power.voltageMin} V`],
        ["驱动就绪失效", facts.power.driveReadyLostAt ? stamp(facts.power.driveReadyLostAt) : "无记录"],
        ["驱动就绪恢复", facts.power.driveReadyBackAt ? stamp(facts.power.driveReadyBackAt) : "无记录"],
        ["末态上游电源可用", fmt(facts.power.endUpstreamAvailable)],
        ["末态驱动支路使能", fmt(facts.power.endDrivePowerEnabled)],
        ["最后运动时刻", facts.motion.lastMovingAt ? stamp(facts.motion.lastMovingAt) : "无记录"],
        ["停稳时刻", facts.motion.stoppedAt ? stamp(facts.motion.stoppedAt) : "无记录"],
        ["末态带速", facts.motion.endSpeed === null ? "—" : `${facts.motion.endSpeed} m/s`],
        ["末态电机电流", facts.motion.endMotorCurrent === null ? "—" : `${facts.motion.endMotorCurrent} A`],
        ["运行请求变化", facts.runCommand.transitions.length ? facts.runCommand.transitions.map((t) => `${clock(t.at)} ${fmt(t.from)}→${fmt(t.to)}`).join("；") : "窗口内无变化"],
        ["末态运行请求", fmt(facts.runCommand.endValue)],
        ["入口计数", `${fmt(facts.counters.infeed.first)} → ${fmt(facts.counters.infeed.last)}（增量 ${fmt(facts.counters.infeed.delta)}）`],
        ["出口计数", `${fmt(facts.counters.outfeed.first)} → ${fmt(facts.counters.outfeed.last)}（增量 ${fmt(facts.counters.outfeed.delta)}）`],
        ["人工移出计数", `${fmt(facts.counters.manualRemoved.first)} → ${fmt(facts.counters.manualRemoved.last)}（增量 ${fmt(facts.counters.manualRemoved.delta)}）`],
        ["在制箱数（入口−出口−人工移出）", fmt(facts.counters.workInProgress)],
        ["柜温", `min ${fmt(facts.temperature.min)} / max ${fmt(facts.temperature.max)} / 末值 ${fmt(facts.temperature.last)} °C`],
        ["达到预警温度的采样数", `${facts.temperature.samplesAtOrAboveWarning}（预警 ${fmt(device.cooling && device.cooling.warning_temperature_c)} °C）`],
        ["达到暂停温度的采样数", `${facts.temperature.samplesAtOrAbovePause}（暂停 ${fmt(device.cooling && device.cooling.pause_temperature_c)} °C）`],
      ]),
      facts.missing.length
        ? note("warn", `缺失字段（空值=未观测，不等于 0/false）：${facts.missing.map((m) => `${m.field}×${m.count}`).join("、")}`)
        : note("ok", "所有 CSV 字段都有观测值。"),
    ),

    h(
      "section",
      { class: "card" },
      h("h3", { text: "上传快照与 CSV 末行核对" }),
      note("info", "device_state.json 的 source 是 uploaded_snapshot：它只描述上传当时，不是执行授权；执行前必须由后端工具重新查询。"),
      h("div", { style: "margin-top:12px" }),
      kvList([
        ["快照 source", facts.snapshot.source],
        ["快照采集时间", stamp(facts.snapshot.capturedAt)],
        ["快照有效期", stamp(facts.snapshot.expiresAt)],
        ["快照 revision", facts.snapshot.revision],
      ]),
      h("div", { style: "margin-top:12px" }),
      facts.snapshotVsCsvEnd.length
        ? table(
            [
              { title: "字段", mono: true, value: (r) => r.field },
              { title: "CSV 末行", value: (r) => fmt(r.csv) },
              { title: "上传快照", value: (r) => fmt(r.snapshot) },
            ],
            facts.snapshotVsCsvEnd,
          )
        : note("ok", "快照与 CSV 末行在可对照字段上一致。"),
      h("div", { style: "margin-top:12px" }),
      h("h4", { text: "快照中不由资料授予的字段" }),
      table(
        [
          { title: "字段", mono: true, value: (r) => r.field },
          { title: "快照值", value: (r) => fmt(r.value) },
          { title: "说明", value: (r) => r.note },
        ],
        facts.snapshotOnlyFields,
        { empty: "该快照里没有这类字段。" },
      ),
      h("div", { style: "margin-top:12px" }),
      h("details", { class: "thinking" }, h("summary", { text: "查看上传快照原始字段" }), h("pre", { class: "json", text: JSON.stringify(snapshot, null, 2) })),
    ),

    h(
      "section",
      { class: "card" },
      h("h3", { text: "输入完整性与契约校验" }),
      kvList([
        ["文件数", `${counts.files} 个（含 images/ ${counts.images} 张）`],
        ["manifest 已核对条目", manifestCheck.checked],
        ["manifest 疑点", manifestCheck.problems.length ? `${manifestCheck.problems.length} 条` : "无"],
        ["manifest 未列出的多余文件", manifestCheck.extraFiles.length ? manifestCheck.extraFiles.join("、") : "无"],
        ["request.json 契约", validations.request.valid ? "通过" : "不通过"],
        ["device_state.json 契约", validations.deviceState.valid ? "通过" : "不通过"],
      ]),
      manifestCheck.problems.length
        ? h(
            "div",
            { style: "margin-top:12px" },
            table(
              [
                { title: "文件", mono: true, value: (r) => r.path },
                { title: "状态", value: (r) => r.status },
                { title: "细节", mono: true, value: (r) => (r.status === "size_mismatch" ? `期望 ${r.expectedBytes} 字节，实际 ${r.actualBytes}` : r.status === "sha256_mismatch" ? `期望 ${String(r.expectedSha256).slice(0, 12)}…，实际 ${String(r.actualSha256).slice(0, 12)}…` : "—") },
              ],
              manifestCheck.problems,
            ),
          )
        : null,
      validations.request.valid ? null : note("bad", `request.json：${validations.request.issues.map((i) => `${i.path} ${i.message}`).join("；")}`),
      validations.deviceState.valid ? null : note("bad", `device_state.json：${validations.deviceState.issues.map((i) => `${i.path} ${i.message}`).join("；")}`),
      parseProblems.length ? h("div", { style: "margin-top:12px" }, note("warn", `解析提示：${parseProblems.join("；")}`)) : null,
      h("div", { style: "margin-top:12px" }),
      h("details", { class: "thinking" }, h("summary", { text: "查看资料文件清单（路径 / 字节 / sha256）" }),
        table(
          [
            { title: "路径", mono: true, value: (r) => r.path },
            { title: "字节", mono: true, value: (r) => r.bytes },
            { title: "sha256", mono: true, value: (r) => `${r.sha256.slice(0, 16)}…` },
          ],
          files,
          { tall: true },
        ),
      ),
    ),

    h(
      "section",
      { class: "card" },
      h("h3", { text: "设备资料（device.json）" }),
      kvList(flatten(device)),
    ),

    operatingGuide
      ? h("section", { class: "card" }, h("h3", { text: "公开操作参考（operating_guide.md）" }), h("pre", { class: "json prose", text: operatingGuide }))
      : null,
  );
}

/* ── 时序数据 ─────────────────────────────────────────────────────────── */
function miniChart(title, field, values, unit, options = {}) {
  const width = 240;
  const height = 56;
  const pad = 4;
  const nums = values.filter((v) => typeof v === "number");
  const min = options.min !== undefined ? options.min : nums.length ? Math.min(...nums) : 0;
  const max = options.max !== undefined ? options.max : nums.length ? Math.max(...nums) : 1;
  const span = max - min || 1;
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const yOf = (v) => height - pad - ((v - min) / span) * (height - pad * 2);
  let path = "";
  let open = false;
  values.forEach((value, index) => {
    if (typeof value !== "number") {
      open = false;
      return;
    }
    const x = pad + index * step;
    path += `${open ? "L" : "M"} ${x.toFixed(1)} ${yOf(value).toFixed(1)} `;
    open = true;
  });
  const last = nums.length ? nums[nums.length - 1] : null;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${title} 的窗口内折线`);
  const grid = document.createElementNS("http://www.w3.org/2000/svg", "line");
  grid.setAttribute("x1", "0");
  grid.setAttribute("x2", String(width));
  grid.setAttribute("y1", String(yOf(min)));
  grid.setAttribute("y2", String(yOf(min)));
  grid.setAttribute("stroke", "currentColor");
  grid.setAttribute("stroke-width", "0.5");
  grid.setAttribute("opacity", "0.25");
  const poly = document.createElementNS("http://www.w3.org/2000/svg", "path");
  poly.setAttribute("d", path.trim());
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke", "var(--brand-600)");
  poly.setAttribute("stroke-width", "1.5");
  poly.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(grid, poly);
  const unitText = unit === "01" ? "" : ` ${unit}`;
  return h(
    "div",
    { class: "chart" },
    h(
      "div",
      { class: "label" },
      h("span", { text: title }),
      h("span", { class: "mono", text: last === null ? "—" : `${unit === "01" ? (last ? "1" : "0") : last}${unitText}` }),
    ),
    svg,
    h("div", { class: "faint", text: `${field} · min ${min} / max ${max}${unitText}` }),
  );
}

function renderTelemetry() {
  const panel = $("#tab-telemetry");
  if (!state.telemetry) {
    panel.replaceChildren(h("div", { class: "card faint", text: state.summary ? "正在读取时序数据…" : "正在读取资料…" }));
    return;
  }
  const { header, rows, total } = state.telemetry;
  const pick = (field, transform) => rows.map((r) => (transform ? transform(r.values[field]) : typeof r.values[field] === "number" ? r.values[field] : null));
  const asNumber = (v) => (typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" ? v : null);

  panel.replaceChildren(
    h(
      "section",
      { class: "card" },
      h("h3", { text: "关键量折线" }),
      hint(`共 ${total} 行，1 Hz 采样；折线只画到本页读取的 ${rows.length} 行。缺测点会断开。`),
      h(
        "div",
        { class: "charts" },
        miniChart("驱动供电电压", "drive_supply_voltage_v", pick("drive_supply_voltage_v"), "V"),
        miniChart("带速", "belt_speed_m_s", pick("belt_speed_m_s"), "m/s"),
        miniChart("柜温", "cabinet_temperature_c", pick("cabinet_temperature_c"), "°C"),
        miniChart("上游电源可用", "upstream_power_available", pick("upstream_power_available", asNumber), "01", { min: 0, max: 1 }),
      ),
    ),
    h(
      "section",
      { class: "card" },
      h("h3", { text: "时序明细" }),
      hint("CSV 里 0/1 是布尔量；空值表示未观测，不等于 0 或 false。ts 为控制器时标。"),
      table(
        header.map((field) => ({
          title: field,
          mono: true,
          value: (row) => (field === "timestamp" ? clock(row.timestamp) : csvCell(row.values[field])),
        })),
        rows,
        { tall: true },
      ),
    ),
  );
}

/* ── 控制器日志 ───────────────────────────────────────────────────────── */
function renderEvents() {
  const panel = $("#tab-events");
  if (!state.events) {
    panel.replaceChildren(h("div", { class: "card faint", text: "正在读取日志…" }));
    return;
  }
  const events = state.events.events ?? [];
  if (!events.length) {
    panel.replaceChildren(h("section", { class: "card" }, h("h3", { text: "控制器日志" }), note("info", "events.jsonl 为空。")));
    return;
  }
  panel.replaceChildren(
    h(
      "section",
      { class: "card" },
      h("h3", { text: `控制器日志（${events.length} 条）` }),
      hint("events.jsonl 原文事件流，按文件顺序展示；事件是控制器记录，不是结论。"),
      h(
        "div",
        { class: "timeline" },
        events.map((e) =>
          h(
            "div",
            { class: `ev ${e.level === "error" ? "error" : e.level === "warn" || e.level === "warning" ? "warn" : ""}` },
            h("div", { class: "meta", text: `${e.event_id} · ${stamp(e.timestamp)} · ${e.source}/${e.level} · ${e.code}` }),
            h("div", { text: e.message }),
          ),
        ),
      ),
    ),
  );
}

/* ── 工位图片 ─────────────────────────────────────────────────────────── */
function renderImages() {
  const panel = $("#tab-images");
  if (!state.summary) {
    panel.replaceChildren(h("div", { class: "card faint", text: "正在读取资料…" }));
    return;
  }
  const frames = state.summary.images ?? [];
  if (!frames.length) {
    panel.replaceChildren(h("section", { class: "card" }, h("h3", { text: "工位图片" }), note("info", "这份资料里没有工位图片。")));
    return;
  }
  const index = Math.min(state.imageIndex, frames.length - 1);
  const frame = frames[index];
  const src = `/api/cases/${encodeURIComponent(state.caseId)}/file?path=${encodeURIComponent(String(frame.file))}`;

  panel.replaceChildren(
    h(
      "section",
      { class: "card" },
      h("h3", { text: "工位图片" }),
      note("info", `有限用途：${frame.observation_scope || "仅可见物料分布，不用于测量速度、供电或安全许可"}`),
      h("div", { style: "margin-top:12px" }),
      h("img", { class: "frame", src, alt: `${frame.file} 于 ${frame.timestamp} 的工位画面` }),
      h("div", { style: "margin-top:12px" }),
      kvList([
        ["时间", stamp(frame.timestamp)],
        ["相机", frame.camera_id],
        ["视角", frame.view],
        ["文件", frame.file],
        ["synthetic", fmt(frame.synthetic)],
      ]),
      frames.length > 1
        ? h(
            "div",
            { class: "row", style: "margin-top:12px" },
            h("button", { type: "button", text: "上一张", disabled: index === 0, onclick: () => { state.imageIndex = index - 1; renderImages(); } }),
            h("button", { type: "button", text: "下一张", disabled: index === frames.length - 1, onclick: () => { state.imageIndex = index + 1; renderImages(); } }),
            txt(h("span", { class: "faint", text: `${index + 1} / ${frames.length}` })),
          )
        : null,
      h("div", { style: "margin-top:12px" }),
      note("warn", "图片只能说明该时点可见的物料分布，不能证明运动状态、供电情况或安全条件；背景货架物品不计入在制箱数，在制箱数以计数差为准。"),
    ),
    h(
      "section",
      { class: "card" },
      h("h3", { text: "图片清单" }),
      table(
        [
          { title: "文件", mono: true, value: (r) => r.file },
          { title: "时间", mono: true, value: (r) => stamp(r.timestamp) },
          { title: "相机", value: (r) => r.camera_id },
          { title: "观察范围", value: (r) => r.observation_scope },
        ],
        frames,
      ),
    ),
  );
}

/* ── 诊断与证据 ───────────────────────────────────────────────────────── */
function renderDiagnosis() {
  const panel = $("#tab-diagnosis");
  const model = state.model ?? {};
  const nodes = [];

  nodes.push(
    h(
      "section",
      { class: "card" },
      h("h3", { text: "历史异常判断（只描述上传时间窗）" }),
      hint("诊断由嵌入式 Agent 读取工作目录里的资料产生。它可以调用四个受控设备工具（查询状态 / 请求恢复输送 / 请求散热）取得真实状态，但不能指定设备、版本、请求号或速度；每次调用都会记进后端审计。"),
      model.configured
        ? kvList([
            ["模型", `${model.provider} · ${model.modelId}`],
            ["密钥", `${model.provider_env_key}（${model.api_key_present ? "已读到" : "未读到"}）`],
            ["Agent 数据根", model.data_root],
          ])
        : note(
            "bad",
            h("strong", { text: "诊断暂不可用：未配置模型" }),
            h("div", { text: model.error ?? "" }),
            h("div", { class: "faint", text: `模型 ${model.pinned_provider ?? "—"} / ${model.pinned_model_id ?? "—"}（在 ${model.env_file ?? "app/.env"} 里由 LR_MODEL_PROVIDER / LR_MODEL_ID 指定）。` }),
            h("div", { class: "faint", text: `在同一文件里写一行 ${model.provider_env_key ?? "DEEPSEEK_API_KEY"}=<官方 API Key>，然后重启服务；此状态下页面其余部分仍按真实资料工作。` }),
          ),
      h(
        "div",
        { class: "row", style: "margin-top:12px" },
        h("button", {
          class: "primary",
          type: "button",
          id: "analyze-button",
          text: state.analyzing ? "诊断进行中…" : state.report ? "重新诊断" : "开始诊断",
          disabled: state.analyzing || !model.configured || !state.summary,
          onclick: runAnalyze,
        }),
        state.analyzing
          ? h("button", { type: "button", text: "中止", onclick: () => state.analyzeAbort && state.analyzeAbort.abort() })
          : null,
        h("span", { class: "faint", text: "诊断只读资料，不会产生任何设备动作。" }),
      ),
      state.stream.status || state.analyzing || state.stream.text || state.stream.thinking
        ? h(
            "div",
            { class: "stack", style: "margin-top:12px" },
            h("div", { class: "faint" }, h("span", { class: "spinner", hidden: !state.analyzing }, h("i"), h("i"), h("i")), ` ${state.stream.status || "等待模型输出…"}`),
            state.stream.tools.length
              ? h(
                  "div",
                  { class: "stack" },
                  h("div", { class: "faint", text: `受控工具轨迹（${state.stream.tools.length} 条）：` }),
                  h(
                    "ul",
                    {},
                    state.stream.tools.map((t) =>
                      h(
                        "li",
                        {},
                        h("span", { class: "mono", text: t.name }),
                        " — ",
                        h("span", { text: TOOL_STATE_LABEL[t.state] ?? t.state }),
                        t.detail ? h("span", { class: "faint", text: `：${t.detail}` }) : null,
                      ),
                    ),
                  ),
                )
              : null,
            state.stream.thinking
              ? h("details", { class: "thinking", open: state.analyzing }, h("summary", { text: `思考过程（${state.stream.thinking.length} 字）` }), h("pre", { text: state.stream.thinking }))
              : null,
            state.stream.text
              ? h("details", { class: "thinking" }, h("summary", { text: `模型原始输出（${state.stream.text.length} 字）` }), h("pre", { text: state.stream.text }))
              : null,
          )
        : null,
    ),
  );

  if (state.reportMissing && !state.report) {
    nodes.push(h("section", { class: "card" }, note("info", "这个案例还没有报告。执行一次诊断后，报告会按 contracts/report.schema.json 生成并保存。")));
  }

  if (state.report) {
    const { report, valid, issues, model: usedModel, session_id, created_at, updated_at, raw_model_output } = state.report;
    const diagnosis = report.diagnosis ?? {};
    const recovery = report.recovery ?? {};
    const windowKind = diagnosis.window_status === "abnormal" ? "bad" : diagnosis.window_status === "normal" ? "ok" : "warn";
    nodes.push(
      h(
        "section",
        { class: "card" },
        h("div", { class: "row between" }, h("h3", { text: "诊断结论" }), h("span", { class: `pill ${windowKind}`, text: `窗口状态：${diagnosis.window_status ?? "—"}` })),
        h("div", { style: "margin-top:8px" }),
        h(
          "div",
          { class: "row" },
          (diagnosis.fault_types ?? []).length
            ? (diagnosis.fault_types ?? []).map((t) => h("span", { class: "pill warn", text: t }))
            : h("span", { class: "pill", text: "未给出故障类型" }),
          h("span", { class: "pill", text: `窗口末态：${diagnosis.observed_end_state ?? "—"}` }),
        ),
        h("div", { style: "margin-top:12px" }),
        h("p", { text: diagnosis.summary ?? "" }),
        h("div", { style: "margin-top:12px" }),
        h("h4", { text: `证据（${(diagnosis.evidence ?? []).length} 条）` }),
        ...(diagnosis.evidence ?? []).map((e) =>
          h(
            "div",
            { class: "evidence" },
            h("div", { class: "loc", text: `${e.file} · ${e.locator}` }),
            h("div", { text: e.observation }),
          ),
        ),
        h("div", { style: "margin-top:12px" }),
        h("h4", { text: "下一步建议" }),
        h("ul", {}, (diagnosis.recommendations ?? []).map((r) => h("li", { text: r }))),
      ),

      h(
        "section",
        { class: "card" },
        h("h3", { text: "报告分层与校验" }),
        kvList([
          ["契约校验", valid ? "通过 contracts/report.schema.json" : "不通过"],
          ["生成时间", stamp(created_at)],
          ["更新时间", stamp(updated_at)],
          ["模型", usedModel ? `${usedModel.provider} · ${usedModel.modelId}` : "—"],
          ["会话", session_id ?? "—"],
          ["recovery.decision", recovery.decision ?? "—"],
          ["recovery.status", `${recovery.status ?? "—"}（${STATUS_LABEL[recovery.status] ?? "—"}）`],
        ]),
        valid ? null : note("bad", `校验问题：${(issues ?? []).map((i) => `${i.path} ${i.message}`).join("；")}`),
        note("info", "报告里的 diagnosis 只描述上传时间窗；recovery.operations 与 recovery.latest_state 只能来自后端工具轨迹，未执行时为空。"),
        h("div", { style: "margin-top:12px" }),
        h("details", { class: "thinking" }, h("summary", { text: "查看报告 JSON" }), h("pre", { class: "json", text: JSON.stringify(report, null, 2) })),
        raw_model_output
          ? h("details", { class: "thinking", style: "margin-top:8px" }, h("summary", { text: "查看模型原始输出" }), h("pre", { class: "json", text: raw_model_output }))
          : null,
      ),
    );
  }

  panel.replaceChildren(...nodes);
}

async function runAnalyze() {
  if (!state.caseId || state.analyzing) return;
  state.analyzing = true;
  state.stream = { text: "", thinking: "", status: "正在创建会话…", tools: [] };
  state.reportMissing = false;
  renderDiagnosis();

  const controller = new AbortController();
  state.analyzeAbort = controller;
  let failed = null;
  try {
    const res = await fetch(`/api/cases/${encodeURIComponent(state.caseId)}/analyze`, { method: "POST", signal: controller.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw Object.assign(new Error(body.message || res.statusText), { code: body.error, detail: body.detail });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf("\n\n");
      while (cut >= 0) {
        const chunk = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            handleAnalyzeEvent(JSON.parse(line.slice(5).trim()));
          } catch {
            /* 忽略无法解析的流片段 */
          }
        }
        cut = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (error.name !== "AbortError") failed = error;
  } finally {
    state.analyzing = false;
    state.analyzeAbort = null;
  }

  if (failed) {
    state.stream.status = `诊断未完成：${failed.code ?? "ERROR"}`;
    $("#tab-diagnosis").prepend(
      note("bad", h("strong", { text: `诊断失败（${failed.code ?? "ERROR"}）` }), h("div", { text: failed.message }), failed.detail ? h("pre", { class: "json", text: JSON.stringify(failed.detail, null, 2) }) : null),
    );
  } else if (!state.report) {
    state.stream.status = state.stream.status || "会话结束但没有报告";
  }
  // 诊断期间 Agent 可能真的调用过受控工具：审计、报告与工具连接状态都要重新读一遍，
  // 页面显示的阶段就来自这些真实记录，而不是模型自己写的计划。
  await Promise.all([refreshAudit(), refreshReport(), loadTools()]);
  renderDiagnosis();
  renderActions();
}

function handleAnalyzeEvent(payload) {
  if (payload.type === "status") state.stream.status = payload.message;
  else if (payload.type === "thinking") state.stream.thinking += payload.delta;
  else if (payload.type === "text") state.stream.text += payload.delta;
  else if (payload.type === "tool") {
    state.stream.tools.push({ name: payload.name, state: payload.state, detail: payload.detail });
    state.stream.status =
      payload.state === "deny"
        ? `受控工具被拒绝，未执行：${payload.name}`
        : `受控工具：${payload.name}（${TOOL_STATE_LABEL[payload.state] ?? payload.state}）`;
  } else if (payload.type === "report") {
    state.report = {
      case_id: state.caseId,
      report: payload.report,
      valid: payload.valid,
      issues: payload.issues,
      model: payload.model,
      session_id: payload.sessionId,
      recovery_plan: payload.recovery_plan,
      created_at: null,
      updated_at: null,
    };
    state.reportMissing = false;
    state.stream.status = "诊断完成，报告已生成";
  } else if (payload.type === "error") {
    state.stream.status = `诊断失败：${payload.code}`;
    $("#tab-diagnosis").prepend(note("bad", h("strong", { text: `诊断失败（${payload.code}）` }), h("div", { text: payload.message })));
  }
  renderDiagnosis();
}

/* ── 动作与反馈 ───────────────────────────────────────────────────────── */
function stageBar(outcome) {
  const status = outcome ? outcome.status : "not_attempted";
  const reached = STATUS_INDEX[status];
  return h(
    "div",
    { class: "stages" },
    STAGES.map((stage, index) => {
      const done = reached !== undefined && index <= reached;
      return h(
        "div",
        { class: `stage ${done ? "done" : "pending"}` },
        h("div", { class: "name", text: `${index + 1}. ${stage.name}` }),
        h("div", { class: "state", text: done ? "已达成" : reached === undefined && index === 0 && status !== "not_attempted" ? "未达成" : "未开始" }),
        h("div", { class: "faint", text: stage.desc }),
      );
    }),
  );
}

function statePanel(label, value) {
  if (!value || typeof value !== "object") return null;
  const scalars = Object.entries(value).filter(([, v]) => v === null || typeof v !== "object");
  const nested = Object.entries(value).filter(([, v]) => v !== null && typeof v === "object");
  return h(
    "div",
    {},
    h("h4", { text: label }),
    kvList(scalars.map(([k, v]) => [k, fmt(v)])),
    nested.length
      ? h("details", { class: "thinking", style: "margin-top:8px" }, h("summary", { text: "嵌套字段" }), h("pre", { class: "json", text: JSON.stringify(Object.fromEntries(nested), null, 2) }))
      : null,
  );
}

function renderActions() {
  const panel = $("#tab-actions");
  if (!state.summary) {
    panel.replaceChildren(h("div", { class: "card faint", text: "正在读取资料…" }));
    return;
  }
  // 阶段只反映真实工具轨迹的结果：本页刚发起的动作优先，其次是报告里保存的那次执行结果。
  const outcome = state.lastOutcome ?? (state.report && state.report.recovery_outcome) ?? null;
  const recovery = outcome ?? ((state.report && state.report.report && state.report.report.recovery) || null);
  const stageSource = state.lastOutcome
    ? "本页“请求动作”的后端结果（见下方审计）"
    : state.report && state.report.recovery_outcome
      ? "报告保存的那次工具执行结果（见下方审计）"
      : "尚未执行任何工具动作";
  const interfaces = (state.tools && state.tools.interfaces) || [];
  const connected = interfaces.filter((i) => i.connection === "connected");
  const mode = (state.tools && state.tools.execution_mode) || "dry_run";

  const nodes = [];

  nodes.push(
    h(
      "section",
      { class: "card" },
      h("div", { class: "row between" }, h("h3", { text: "阶段" }), h("span", { class: `pill ${statusKind(recovery && recovery.status)}`, text: `当前：${STATUS_LABEL[(recovery && recovery.status) || "not_attempted"]}` })),
      hint("“命令受理”“设备动作”“产出恢复”是不同阶段；受理不等于执行完成，更不等于产出恢复。"),
      stageBar(recovery ? { status: recovery.status } : null),
      h("div", { style: "margin-top:12px" }),
      kvList([
        ["动作决策", recovery ? recovery.decision : "—"],
        ["阶段状态", recovery ? `${recovery.status}（${STATUS_LABEL[recovery.status] ?? "—"}）` : "—"],
        ["说明", recovery ? recovery.summary : "—"],
        ["来源", stageSource],
      ]),
    ),

    h(
      "section",
      { class: "card" },
      h("h3", { text: "请求动作" }),
      note("info", mode === "live" ? "当前执行模式：live（真实执行）。" : "当前执行模式：dry_run（演示模式，服务由部署方另行交付并配置）。"),
      h("div", { class: "faint", style: "margin-top:8px", text: "上传快照里的许可只是记录，不授予执行权限；后端会在执行点前重新查询最新可信状态并核对前置条件。" }),
      h(
        "div",
        { class: "row", style: "margin-top:12px" },
        h("button", { class: "primary", type: "button", text: "请求恢复输送（resume_conveyor）", onclick: (e) => runRecovery("resume_conveyor", e.target) }),
        h("button", { type: "button", text: "请求散热（start_cooling）", onclick: (e) => runRecovery("start_cooling", e.target) }),
      ),
      connected.length
        ? h("div", { class: "faint", style: "margin-top:8px", text: `已连接：${connected.map((i) => i.title).join("、")}` })
        : note("warn", "两个设备接口当前都是“工具未连接”：点击请求只会得到一条表示未执行的审计记录，不会产生任何设备动作。"),
      state.report && state.report.pending_plan
        ? note("info", `诊断提出的计划（尚未执行）：${state.report.pending_plan.preferred_action ?? "无动作"} —— ${state.report.pending_plan.reason}`)
        : null,
    ),
  );

  if (outcome) {
    nodes.push(
      h(
        "section",
        { class: "card" },
        h("h3", { text: "本次执行详情" }),
        kvList([
          ["是否尝试执行", outcome.attempted ? "是" : "否（后端在请求动作前就挡住了，没有发出写）"],
          ["是否幂等重放", outcome.replayed ? "是（同一请求号的重试，本次没有第二次执行动作）" : "否"],
          ["reason_code", outcome.reason_code],
          ["结论", outcome.summary],
          ["执行模式", mode],
        ]),
        outcome.readback
          ? h(
              "div",
              { style: "margin-top:12px" },
              h("h4", { text: "限时状态读回" }),
              kvList([
                ["预算", `${outcome.readback.budget_ms} ms（每 ${outcome.readback.interval_ms} ms 查一次，最多 ${outcome.readback.polls_limit} 次）`],
                ["实际查询", `${outcome.readback.polls} 次，用时 ${outcome.readback.duration_ms} ms`],
                ["预算内到达最终阶段", outcome.readback.timed_out ? "否（如实保留当时的阶段，未宣称完成）" : "是"],
              ]),
            )
          : null,
        outcome.preconditions && outcome.preconditions.length
          ? h(
              "div",
              { style: "margin-top:12px" },
              h("h4", { text: `执行点前核对（${outcome.preconditions.filter((c) => c.ok).length}/${outcome.preconditions.length} 项满足）` }),
              table(
                [
                  { title: "字段", mono: true, value: (r) => r.field },
                  { title: "含义", value: (r) => r.label },
                  { title: "要求", mono: true, value: (r) => r.required },
                  { title: "实际", mono: true, value: (r) => fmt(r.actual) },
                  { title: "结果", value: (r) => (r.ok ? "通过" : "不满足") },
                ],
                outcome.preconditions,
              ),
            )
          : null,
        outcome.latest_state ? h("div", { style: "margin-top:12px" }, statePanel("最新工具状态（来自后端查询，不是上传快照）", outcome.latest_state)) : null,
        outcome.operations && outcome.operations.length
          ? h("div", { style: "margin-top:12px" }, h("h4", { text: "写工具返回" }), h("pre", { class: "json", text: JSON.stringify(outcome.operations, null, 2) }))
          : null,
      ),
    );
  }

  nodes.push(
    h(
      "section",
      { class: "card" },
      h("div", { class: "row between" }, h("h3", { text: "后端审计（唯一的执行记录）" }), h("button", { class: "link", type: "button", text: "刷新", onclick: refreshAudit })),
      hint("前端只展示这里记录过的动作；模型写在报告里的计划不会被当作已执行的动作。"),
      state.audit.length
        ? h(
            "div",
            { class: "scroll" },
            table(
              [
                { title: "时间", mono: true, value: (r) => stamp(r.at) },
                { title: "触发方", value: (r) => AUDIT_ACTOR_LABEL[r.actor] ?? r.actor ?? "—" },
                { title: "阶段", value: (r) => r.phase },
                { title: "接口", value: (r) => r.interface_id ?? "—" },
                { title: "工具", mono: true, value: (r) => r.tool ?? "—" },
                { title: "结果", mono: true, value: (r) => r.outcome },
                { title: "原因码", mono: true, value: (r) => r.reason_code },
                { title: "模式", value: (r) => r.execution_mode },
                { title: "request_id", mono: true, value: (r) => r.request_id ?? "—" },
                { title: "expected_revision", mono: true, value: (r) => (r.expected_revision === null || r.expected_revision === undefined ? "—" : r.expected_revision) },
                { title: "说明", value: (r) => r.message },
              ],
              state.audit,
            ),
          )
        : note("info", "该案例还没有审计记录（尚未请求过任何动作）。"),
      state.audit.some((r) => r.post_state)
        ? h(
            "div",
            { style: "margin-top:12px" },
            h("details", { class: "thinking" }, h("summary", { text: "查看审计里的工具状态快照" }), h("pre", { class: "json", text: JSON.stringify(state.audit.filter((r) => r.post_state).map((r) => ({ at: r.at, phase: r.phase, post_state: r.post_state })), null, 2) })),
          )
        : null,
    ),

    h(
      "section",
      { class: "card" },
      h("h3", { text: "未确定事项" }),
      state.report && (state.report.report.limitations ?? []).length
        ? h("ul", {}, state.report.report.limitations.map((l) => h("li", { text: l })))
        : note("info", "还没有报告；执行诊断后会在这里列出资料限制与未核实事项。"),
      state.report && state.report.recovery_plan
        ? h("div", { style: "margin-top:12px" }, h("h4", { text: "诊断给出的恢复计划（未执行）" }), kvList([["decision", state.report.recovery_plan.decision], ["preferred_action", state.report.recovery_plan.preferred_action ?? "—"], ["理由", state.report.recovery_plan.reason]]))
        : null,
    ),
  );

  panel.replaceChildren(...nodes);
}

function statusKind(status) {
  if (status === "production_confirmed" || status === "running_confirmed" || status === "temperature_ready") return "ok";
  if (status === "cooling_started" || status === "requested") return "tint";
  if (status === "rejected" || status === "failed") return "bad";
  return "warn";
}

async function runRecovery(action, button) {
  if (!state.caseId) return;
  const original = button.textContent;
  button.disabled = true;
  try {
    const result = await api(`/api/cases/${encodeURIComponent(state.caseId)}/recovery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (state.report && result.report) {
      state.report = { ...state.report, report: result.report, valid: result.valid, issues: result.issues, recovery_outcome: result.outcome };
    } else if (!state.report) {
      state.reportMissing = true;
    }
    if (result.outcome) state.lastOutcome = result.outcome;
  } catch (error) {
    $("#tab-actions").prepend(note("bad", h("strong", { text: "请求失败" }), h("div", { text: error.message })));
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
  // 执行走的是真实工具：审计与工具连接状态都重新读一遍再渲染。
  await Promise.all([refreshAudit(), loadTools()]);
  renderActions();
  renderDiagnosis();
}

async function refreshAudit() {
  if (!state.caseId) return;
  try {
    const data = await api(`/api/cases/${encodeURIComponent(state.caseId)}/audit`);
    state.audit = data.audit ?? [];
  } catch {
    /* 读取失败时保留旧内容 */
  }
}

/** 重新读取服务端保存的报告（诊断结束后用它把 recovery_outcome 拿回来，而不是自己拼）。 */
async function refreshReport() {
  if (!state.caseId) return;
  try {
    state.report = await api(`/api/cases/${encodeURIComponent(state.caseId)}/report`);
    state.reportMissing = false;
  } catch (error) {
    if (error.code === "REPORT_NOT_FOUND") {
      state.report = null;
      state.reportMissing = true;
    }
    /* 其他读取失败时保留已有内容 */
  }
}

/* ── 侧栏交互 ─────────────────────────────────────────────────────────── */
function bindSidebar() {
  $("#load-example").addEventListener("click", async () => {
    const msg = $("#case-list-msg");
    msg.textContent = "正在载入 example…";
    try {
      const data = await api("/api/cases/load-example", { method: "POST" });
      msg.textContent = `已载入 example：${data.case.caseId}`;
      await refreshCases();
      await selectCase(data.case.caseId);
    } catch (error) {
      msg.textContent = `载入 example 失败：${error.message}`;
    }
  });

  $("#refresh-cases").addEventListener("click", refreshCases);

  const fileInput = $("#zip-input");
  const uploadButton = $("#upload");
  fileInput.addEventListener("change", () => {
    uploadButton.disabled = !fileInput.files || !fileInput.files.length;
    $("#upload-msg").textContent = "";
  });

  uploadButton.addEventListener("click", uploadZip);
  $("#case-label").addEventListener("keydown", (event) => {
    // IME 组合输入期间的回车不触发上传
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!$("#upload").disabled) uploadZip();
  });

  $("#delete-case").addEventListener("click", async () => {
    if (!state.caseId) return;
    try {
      await api(`/api/cases/${encodeURIComponent(state.caseId)}`, { method: "DELETE" });
      state.caseId = null;
      state.summary = null;
      $("#workspace").hidden = true;
      $("#empty-state").hidden = false;
      await refreshCases();
    } catch (error) {
      $("#case-badges").append(h("span", { class: "pill bad", text: `删除失败：${error.message}` }));
    }
  });

  $("#tabs").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-tab]");
    if (button) setTab(button.dataset.tab);
  });

  document.querySelectorAll("[data-demo]").forEach((button) => {
    button.addEventListener("click", () => {
      const kind = button.dataset.demo;
      if (kind === "example") $("#load-example").click();
      else if (kind === "upload") fileInput.click();
      else if (kind === "tools") $("#tools-panel").scrollIntoView({ behavior: "smooth", block: "center" });
      else if (kind === "model") $("#model-panel").scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

async function uploadZip() {
  const fileInput = $("#zip-input");
  const msg = $("#upload-msg");
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  msg.textContent = `正在上传 ${file.name}（${file.size} 字节）…`;
  const label = $("#case-label").value.trim();
  try {
    const data = await api("/api/cases/upload", {
      method: "POST",
      // HTTP 头只能是 ASCII，案例名编码后传输，后端会解码
      headers: label ? { "x-case-label": encodeURIComponent(label) } : {},
      body: file,
    });
    msg.textContent = `已载入：${data.case.caseId}`;
    fileInput.value = "";
    $("#upload").disabled = true;
    await refreshCases();
    await selectCase(data.case.caseId);
  } catch (error) {
    msg.textContent = `上传失败（${error.code ?? "ERROR"}）：${error.message}`;
    if (error.detail) {
      msg.append(h("div", { class: "faint", text: JSON.stringify(error.detail) }));
    }
  }
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll("#tabs button[data-tab]").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.tab === tab));
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tab;
  });
}

/* ── 启动 ─────────────────────────────────────────────────────────────── */
async function boot() {
  initTheme();
  bindSidebar();
  await Promise.all([loadHealth(), loadTools(), loadModel()]);
  await refreshCases();
  if (state.cases.length === 1) await selectCase(state.cases[0].caseId);
}

boot();
