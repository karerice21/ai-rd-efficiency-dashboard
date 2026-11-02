const state = {
  projects: [],
  managedProjects: [],
  overview: null,
  dashboardGranularity: "week",
  codingPlanTimer: null,
  codingPlanLoading: false,
  modelSpeedConfig: null,
  modelSpeedJobId: null,
  modelSpeedPollTimer: null,
  modelSpeedPolling: false,
  modelSpeedTargetsLoading: false,
  projectBackHash: "#/",
};

const $ = (selector) => document.querySelector(selector);
const number = new Intl.NumberFormat("zh-CN");
const businessUnits = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2, useGrouping: false });
const decimal = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const teamCollator = new Intl.Collator("zh-CN", { numeric: true });
const chartColors = [
  "#2563eb", "#8b5cf6", "#06b6d4", "#f59e0b",
  "#10b981", "#ef4444", "#64748b", "#ec4899",
  "#14b8a6", "#f97316", "#6366f1", "#84cc16",
  "#0ea5e9", "#a855f7", "#eab308", "#22c55e",
];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatNumber(value) { return number.format(Number(value || 0)); }
function formatCompact(value) { return formatBusinessInteger(value); }
function formatRatio(value) { return value === null || value === undefined ? "—" : decimal.format(Number(value)); }
function formatPercent(value) { return `${decimal.format(Math.abs(Number(value || 0)) * 100)}%`; }
function formatBusinessInteger(value) {
  if (value === null || value === undefined) return "—";
  const numeric = Number(value || 0);
  if (numeric === 0) return "0";
  if (Math.abs(numeric) >= 100000000) return `${businessUnits.format(numeric / 100000000)}亿`;
  if (Math.abs(numeric) >= 10000) return `${businessUnits.format(numeric / 10000)}万`;
  if (Math.abs(numeric) >= 1000) return `${businessUnits.format(numeric / 1000)}千`;
  return formatNumber(numeric);
}
function formatTokenCardValue(value) { return formatBusinessInteger(value); }
function localDateText(value = new Date()) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function chineseOrdinal(value) {
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === "十") return 10;
  if (value.includes("十")) {
    const [tens, ones] = value.split("十");
    return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0);
  }
  return digits[value] ?? null;
}

function teamSortKey(team) {
  const match = /^研发([一二三四五六七八九十]+)团队$/.exec(team);
  const ordinal = match ? chineseOrdinal(match[1]) : null;
  return ordinal === null ? team : `研发${String(ordinal).padStart(3, "0")}团队`;
}

function compareTeams(left, right) {
  return teamCollator.compare(teamSortKey(left), teamSortKey(right));
}

function selectedMultiValues(element) {
  return [...element.querySelectorAll("input[data-filter-value]:checked")]
    .map(input => input.value)
    .filter(Boolean);
}

function updateMultiSelectLabel(element) {
  const selected = [...element.querySelectorAll("input[data-filter-value]:checked")];
  const label = element.querySelector(".multi-select-label");
  if (!selected.length) {
    label.textContent = "全部";
  } else if (selected.length === 1) {
    label.textContent = selected[0].dataset.label || selected[0].value;
  } else {
    label.textContent = `已选 ${selected.length} 项`;
  }
}

function renderMultiSelect(element, options, selectedValues = []) {
  const validValues = new Set(options.map(option => String(option.value)));
  const selected = new Set(
    selectedValues.map(String).filter(value => validValues.has(value)),
  );
  const optionHtml = options.map(option => {
    const value = String(option.value);
    const label = String(option.label);
    return `<label class="multi-select-option" title="${escapeHtml(label)}">
      <input type="checkbox" data-filter-value data-label="${escapeHtml(label)}" value="${escapeHtml(value)}" ${selected.has(value) ? "checked" : ""} />
      <span>${escapeHtml(label)}</span>
    </label>`;
  }).join("");
  element.querySelector(".multi-select-options").innerHTML = `
    <label class="multi-select-option all-option">
      <input type="checkbox" data-select-all ${selected.size ? "" : "checked"} />
      <span>全部</span>
    </label>${optionHtml}`;
  updateMultiSelectLabel(element);
}

function handleMultiSelectChange(event) {
  const element = event.currentTarget;
  const input = event.target.closest("input[type='checkbox']");
  if (!input) return;
  const allOption = element.querySelector("input[data-select-all]");
  if (input.hasAttribute("data-select-all")) {
    if (input.checked) {
      element.querySelectorAll("input[data-filter-value]").forEach(option => { option.checked = false; });
    } else if (!selectedMultiValues(element).length) {
      input.checked = true;
    }
  } else {
    allOption.checked = selectedMultiValues(element).length === 0;
  }
  updateMultiSelectLabel(element);
  if (element.id === "teamFilter") renderProjectFilter();
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  let payload;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const detail = payload?.detail;
    const message = typeof detail === "string" ? detail : detail?.message;
    throw new Error(message || `请求失败：${response.status}`);
  }
  return payload;
}

function setLoading(visible) { $("#loading").classList.toggle("hidden", !visible); }
function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), 3600);
}

function updateSource(source) {
  const badge = $("#sourceBadge");
  badge.textContent = source.label || (source.mode === "live" ? "LiteLLM Live" : "Mock 数据");
  badge.classList.toggle("live", source.mode === "live");
  const time = source.synced_at ? new Date(source.synced_at).toLocaleString("zh-CN", { hour12: false }) : "尚未同步";
  $("#syncTime").textContent = `${source.status || "NOT_SYNCED"} · ${time}`;
}

const CODING_PLAN_WINDOW_LABELS = {
  "5h": "5 小时窗口",
  weekly: "周额度",
  monthly: "月额度",
};

function codingPlanPercentLevel(value) {
  const percent = Number(value || 0);
  if (percent >= 90) return "danger";
  if (percent >= 70) return "warn";
  return "ok";
}

function formatCodingPlanTime(value, fallback = "尚未采集") {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatCodingPlanReset(value) {
  if (!value) return "重置时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "重置时间未知";
  const remaining = date.getTime() - Date.now();
  if (remaining <= 0) return "额度窗口已到重置时间";
  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  const relative = hours ? `${hours} 小时 ${minutes} 分钟后` : `${minutes} 分钟后`;
  return `${date.toLocaleString("zh-CN", { hour12: false })}（${relative}）`;
}

function codingPlanTierHtml(tier) {
  const percent = Math.min(100, Math.max(0, Number(tier.used_percent || 0)));
  const level = codingPlanPercentLevel(percent);
  const absolute = tier.limit === null || tier.limit === undefined
    ? ""
    : `<span>已用 ${formatRatio(tier.used)} / ${formatRatio(tier.limit)}</span>`;
  return `<div class="plan-tier">
    <div class="plan-tier-head">
      <span>${escapeHtml(CODING_PLAN_WINDOW_LABELS[tier.window] || tier.window)}</span>
      <strong>${percent.toFixed(1)}% 已用</strong>
    </div>
    <div class="plan-progress"><i class="${level}" style="width:${percent}%"></i></div>
    <div class="plan-reset"><span>${escapeHtml(formatCodingPlanReset(tier.reset_at))}</span>${absolute}</div>
  </div>`;
}

function codingPlanMcpHtml(item) {
  if (!item) return "";
  return codingPlanTierHtml({
    window: "MCP 调用（月）",
    used_percent: item.used_percent,
    used: item.used,
    limit: item.limit,
    reset_at: null,
  });
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "#";
  } catch {
    return "#";
  }
}

function codingPlanCardHtml(snapshot) {
  const providerType = ["kimi", "minimax", "zhipu"].includes(snapshot.provider_type)
    ? snapshot.provider_type : "";
  const consoleUrl = safeExternalUrl(snapshot.console_url);
  if (!snapshot.configured) {
    return `<article class="plan-card ${providerType}">
      <div class="plan-card-head">
        <div><h3>${escapeHtml(snapshot.name)}</h3><p>服务端尚未配置该平台凭据</p></div>
        <span class="plan-badge off">未配置</span>
      </div>
      <div class="plan-card-body" tabindex="0">
        <div class="plan-message">在服务器 .env 中配置对应 API Key 后，重启服务即可启用采集。</div>
      </div>
      <div class="plan-card-foot"><a href="${escapeHtml(consoleUrl)}" target="_blank" rel="noopener noreferrer">打开平台控制台 ↗</a><span>未启用</span></div>
    </article>`;
  }

  const tiers = Array.isArray(snapshot.tiers) ? snapshot.tiers : [];
  const worst = Math.max(...tiers.map(tier => Number(tier.used_percent || 0)), 0);
  const level = snapshot.success ? codingPlanPercentLevel(worst) : "error";
  const label = snapshot.success
    ? (worst >= 90 ? "额度紧张" : worst >= 70 ? "需要关注" : "状态正常")
    : snapshot.credential_status === "expired" ? "Key 失效" : "查询失败";
  const stale = snapshot.stale
    ? '<div class="plan-stale">本次网络请求失败，当前显示上一次成功采集的额度。</div>' : "";
  const error = snapshot.success ? ""
    : `<div class="plan-message">${escapeHtml(snapshot.error || "暂未取得套餐额度")}</div>`;
  const levelText = snapshot.credential_message
    ? `<span class="plan-level">套餐等级：${escapeHtml(snapshot.credential_message)}</span>` : "";
  return `<article class="plan-card ${providerType}">
    <div class="plan-card-head">
      <div><h3>${escapeHtml(snapshot.name)}</h3><p>${escapeHtml(snapshot.provider_type.toUpperCase())} 套餐额度</p></div>
      <span class="plan-badge ${level}">${label}</span>
    </div>
    <div class="plan-card-body" tabindex="0" aria-label="${escapeHtml(snapshot.name)}额度详情，可上下滚动">
      ${levelText}${stale}
      ${tiers.map(codingPlanTierHtml).join("")}
      ${codingPlanMcpHtml(snapshot.mcp_monthly)}
      ${error}
    </div>
    <div class="plan-card-foot">
      <a href="${escapeHtml(consoleUrl)}" target="_blank" rel="noopener noreferrer">打开平台控制台 ↗</a>
      <span>最近成功：${escapeHtml(formatCodingPlanTime(snapshot.last_success_at, "暂无"))}</span>
    </div>
  </article>`;
}

function renderCodingPlan(data) {
  const summary = data.summary || {};
  const definitions = [
    ["平台账号", summary.provider_account_count, "#2563eb"],
    ["已配置", summary.configured_account_count, "#8b5cf6"],
    ["查询正常", summary.healthy_account_count, "#10b981"],
    ["查询失败", summary.failed_account_count, "#ef4444"],
  ];
  $("#codingPlanMetrics").innerHTML = definitions.map(([label, value, color]) => `
    <article class="plan-status-card" style="--status-color:${color}"><span>${label}</span><strong>${formatNumber(value)}</strong></article>
  `).join("");
  const statusLabels = {
    NOT_STARTED: "等待首次采集",
    RUNNING: "正在采集",
    SUCCESS: "最近一轮采集已完成",
    ALREADY_RUNNING: "已有采集任务正在运行",
  };
  $("#codingPlanCollectionStatus").textContent = statusLabels[data.collection_status] || data.collection_status;
  $("#codingPlanUpdatedAt").textContent = `最近完成：${formatCodingPlanTime(data.last_finished_at)}`;
  $("#codingPlanAccountSummary").textContent = `已配置 ${formatNumber(summary.configured_account_count)} / ${formatNumber(summary.provider_account_count)} 个账号`;
  const snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
  $("#codingPlanGrid").innerHTML = snapshots.length
    ? snapshots.map(codingPlanCardHtml).join("")
    : '<div class="plan-empty">当前没有可展示的平台配置</div>';
}

async function loadCodingPlan({ showLoading = false } = {}) {
  if (state.codingPlanLoading) return;
  state.codingPlanLoading = true;
  if (showLoading) setLoading(true);
  try {
    renderCodingPlan(await api("/api/coding-plan/quotas"));
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.codingPlanLoading = false;
    if (showLoading) setLoading(false);
  }
}

async function refreshCodingPlan() {
  if (state.codingPlanLoading) return;
  const button = $("#codingPlanRefreshButton");
  state.codingPlanLoading = true;
  button.disabled = true;
  button.textContent = "刷新中…";
  try {
    const data = await api("/api/coding-plan/refresh", { method: "POST" });
    renderCodingPlan(data);
    toast(data.collection_status === "ALREADY_RUNNING" ? "已有套餐采集任务正在运行" : "互联网套餐用量刷新完成");
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.codingPlanLoading = false;
    button.disabled = false;
    button.textContent = "立即刷新";
  }
}

function startCodingPlanPolling() {
  clearInterval(state.codingPlanTimer);
  state.codingPlanTimer = setInterval(() => loadCodingPlan(), 30000);
}

function stopCodingPlanPolling() {
  clearInterval(state.codingPlanTimer);
  state.codingPlanTimer = null;
}

const MODEL_SPEED_TERMINAL_STATUSES = new Set(["SUCCESS", "PARTIAL_SUCCESS", "FAILED"]);
const MODEL_SPEED_FIXED_WARMUP_RUNS = 0;
const MODEL_SPEED_FIXED_RUNS = 1;
const MODEL_SPEED_FIXED_MAX_TOKENS = 100;
const MODEL_SPEED_STATUS_LABELS = {
  PENDING: "等待执行",
  RUNNING: "测速中",
  SUCCESS: "已完成",
  PARTIAL_SUCCESS: "部分完成",
  FAILED: "失败",
};

function modelSpeedStatusLabel(status) {
  return MODEL_SPEED_STATUS_LABELS[status] || status || "未知";
}

function modelSpeedMetric(value, suffix) {
  if (value === null || value === undefined || value === "") return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return `${decimal.format(numeric)} ${suffix}`;
}

function selectedModelSpeedTargetIds() {
  return [...document.querySelectorAll("#modelSpeedTargets input[data-model-speed-target]:checked")]
    .map(input => input.value)
    .filter(Boolean);
}

function updateModelSpeedCostHint() {
  const targetCount = selectedModelSpeedTargetIds().length;
  if (!targetCount) {
    $("#modelSpeedCostHint").innerHTML = "固定提示词为<strong>“你好？”</strong>，每个目标只测试 <strong>1 轮</strong>且最多输出 <strong>100 Token</strong>；选择目标后将显示本次输出 Token 理论上限。";
    return;
  }
  const requestCount = targetCount * MODEL_SPEED_FIXED_RUNS;
  const outputLimit = requestCount * MODEL_SPEED_FIXED_MAX_TOKENS;
  $("#modelSpeedCostHint").innerHTML = `
    本次使用固定提示词<strong>“你好？”</strong>，共向 <strong>${formatNumber(targetCount)}</strong> 个目标发起 <strong>${formatNumber(requestCount)}</strong> 次请求
    （每个目标 1 次正式测试，不预热），输出 Token 理论上限为
    <strong>${formatNumber(outputLimit)}</strong>。实际套餐消耗还包含输入 Token。`;
}

function setModelSpeedControlsBusy(busy) {
  const configEnabled = Boolean(state.modelSpeedConfig?.enabled);
  const hasTargets = Boolean(state.modelSpeedConfig?.targets?.length);
  document.querySelectorAll("#modelSpeedForm input").forEach(input => { input.disabled = busy; });
  const button = $("#modelSpeedStartButton");
  button.disabled = busy || !configEnabled || !hasTargets;
  button.textContent = busy ? "测速执行中…" : "开始标准测速";
}

function renderModelSpeedTargets(config) {
  const targets = Array.isArray(config.targets) ? config.targets : [];
  const container = $("#modelSpeedTargets");
  if (!config.enabled) {
    container.innerHTML = '<div class="speed-target-empty warning">服务器未启用模型测速功能，请先完成服务端环境配置。</div>';
    setModelSpeedControlsBusy(false);
    updateModelSpeedCostHint();
    return;
  }
  if (!targets.length) {
    container.innerHTML = '<div class="speed-target-empty warning">当前没有已配置的测速目标。请在服务器 .env 中配置目标后重启服务。</div>';
    setModelSpeedControlsBusy(false);
    updateModelSpeedCostHint();
    return;
  }
  const configuredLimit = Number(config.limits?.max_targets);
  const maxTargets = Number.isFinite(configuredLimit) && configuredLimit >= 0
    ? configuredLimit : targets.length;
  const defaultTargetIds = new Set(
    targets.slice(0, maxTargets).map(target => String(target.id)),
  );
  container.innerHTML = targets.map(target => `
    <label class="speed-target-option">
      <input type="checkbox" data-model-speed-target value="${escapeHtml(target.id)}" ${defaultTargetIds.has(String(target.id)) ? "checked" : ""} />
      <span class="speed-target-check" aria-hidden="true">✓</span>
      <span class="speed-target-copy">
        <strong>${escapeHtml(target.name)}</strong>
        <small>${escapeHtml(target.provider)} · ${escapeHtml(target.model)}</small>
      </span>
    </label>`).join("");
  setModelSpeedControlsBusy(false);
  updateModelSpeedCostHint();
}

function modelSpeedTargetResultHtml(target) {
  const summary = target.summary || null;
  const status = target.status || "PENDING";
  const errorMessage = typeof target.error === "string" ? target.error : target.error?.message;
  const error = errorMessage ? `<small class="speed-result-error">${escapeHtml(errorMessage)}</small>` : "";
  const countSource = summary?.completion_count_source;
  const countMethod = !summary ? "—"
    : countSource === "usage" ? "服务端 usage（精确）"
      : countSource === "estimated" ? "本地估算"
        : summary.exact_count ? "服务端 usage（精确）" : "本地估算";
  return `<tr>
    <td><strong>${escapeHtml(target.name)}</strong><small class="speed-result-meta">${escapeHtml(target.provider)} · ${escapeHtml(target.model)}</small></td>
    <td><span class="speed-status-badge ${status.toLowerCase()}">${escapeHtml(modelSpeedStatusLabel(status))}</span>${error}</td>
    <td class="number">${modelSpeedMetric(summary?.ttft_median_ms, "ms")}</td>
    <td class="number">${modelSpeedMetric(summary?.generation_tokens_per_second_median, "Token/s")}</td>
    <td class="number">${modelSpeedMetric(summary?.total_seconds_median, "s")}</td>
    <td>${escapeHtml(countMethod)}</td>
  </tr>`;
}

function renderModelSpeedJob(job) {
  if (!job) return;
  state.modelSpeedJobId = job.job_id;
  const status = job.status || "PENDING";
  const terminal = MODEL_SPEED_TERMINAL_STATUSES.has(status);
  const completed = Number(job.completed || 0);
  const total = Number(job.total || job.targets?.length || 0);
  const statusElement = $("#modelSpeedJobStatus");
  const statusClass = status === "RUNNING" || status === "PENDING"
    ? "running" : status === "SUCCESS" ? "success" : status === "PARTIAL_SUCCESS" ? "partial" : "failed";
  statusElement.className = `speed-job-status ${statusClass}`;
  statusElement.innerHTML = `
    <div>
      <strong>${escapeHtml(modelSpeedStatusLabel(status))}</strong>
      <span>${terminal ? "本轮标准测速已结束，可查看各目标结果。" : "服务器正在后台顺序执行预热和正式测速，请勿重复提交。"}</span>
    </div>
    <span class="speed-job-progress">${formatNumber(completed)} / ${formatNumber(total)} 个目标</span>`;
  $("#modelSpeedFinishedAt").textContent = job.finished_at
    ? `完成时间：${formatCodingPlanTime(job.finished_at)}`
    : `创建时间：${formatCodingPlanTime(job.requested_at)}`;
  const targets = Array.isArray(job.targets) ? job.targets : [];
  $("#modelSpeedResultTable").innerHTML = targets.length
    ? targets.map(modelSpeedTargetResultHtml).join("")
    : '<tr><td colspan="6" class="speed-result-empty">任务尚未生成目标结果</td></tr>';
  setModelSpeedControlsBusy(!terminal);
}

function stopModelSpeedPolling() {
  clearTimeout(state.modelSpeedPollTimer);
  state.modelSpeedPollTimer = null;
  state.modelSpeedPolling = false;
}

async function pollModelSpeedJob(jobId) {
  if (!jobId || state.modelSpeedPolling) return;
  state.modelSpeedPolling = true;
  try {
    const job = await api(`/api/model-speed/tests/${encodeURIComponent(jobId)}`);
    if (state.modelSpeedJobId !== jobId) return;
    renderModelSpeedJob(job);
    if (MODEL_SPEED_TERMINAL_STATUSES.has(job.status)) {
      stopModelSpeedPolling();
      return;
    }
  } catch (error) {
    toast(`测速状态读取失败：${error.message}`, true);
  } finally {
    state.modelSpeedPolling = false;
  }
  if (state.modelSpeedJobId === jobId && window.location.hash === "#/coding-plan") {
    state.modelSpeedPollTimer = setTimeout(() => pollModelSpeedJob(jobId), 1500);
  }
}

function startModelSpeedPolling(jobId) {
  stopModelSpeedPolling();
  state.modelSpeedJobId = jobId;
  state.modelSpeedPollTimer = setTimeout(() => pollModelSpeedJob(jobId), 900);
}

async function loadLatestModelSpeedJob() {
  const data = await api("/api/model-speed/tests?limit=1");
  const job = Array.isArray(data.items) ? data.items[0] : null;
  if (!job) return;
  renderModelSpeedJob(job);
  if (!MODEL_SPEED_TERMINAL_STATUSES.has(job.status)) startModelSpeedPolling(job.job_id);
}

async function loadModelSpeedTargets() {
  if (state.modelSpeedTargetsLoading) return;
  state.modelSpeedTargetsLoading = true;
  try {
    const config = await api("/api/model-speed/targets");
    state.modelSpeedConfig = config;
    renderModelSpeedTargets(config);
    if (config.running_job_id) {
      state.modelSpeedJobId = config.running_job_id;
      await pollModelSpeedJob(config.running_job_id);
    } else {
      await loadLatestModelSpeedJob();
    }
  } catch (error) {
    state.modelSpeedConfig = null;
    $("#modelSpeedTargets").innerHTML = `<div class="speed-target-empty warning">测速配置读取失败：${escapeHtml(error.message)}</div>`;
    $("#modelSpeedStartButton").disabled = true;
  } finally {
    state.modelSpeedTargetsLoading = false;
  }
}

async function startModelSpeedTest(event) {
  event.preventDefault();
  const form = $("#modelSpeedForm");
  if (!form.reportValidity()) return;
  const targetIds = selectedModelSpeedTargetIds();
  if (!targetIds.length) {
    toast("请至少选择一个已配置的测速目标", true);
    return;
  }
  const maxTargets = Number(state.modelSpeedConfig?.limits?.max_targets || targetIds.length);
  if (targetIds.length > maxTargets) {
    toast(`单次最多选择 ${formatNumber(maxTargets)} 个测速目标`, true);
    return;
  }
  setModelSpeedControlsBusy(true);
  try {
    const job = await api("/api/model-speed/tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_ids: targetIds,
        warmup_runs: MODEL_SPEED_FIXED_WARMUP_RUNS,
        runs: MODEL_SPEED_FIXED_RUNS,
        max_tokens: MODEL_SPEED_FIXED_MAX_TOKENS,
      }),
    });
    renderModelSpeedJob(job);
    if (!MODEL_SPEED_TERMINAL_STATUSES.has(job.status)) startModelSpeedPolling(job.job_id);
    toast("模型标准测速任务已提交");
  } catch (error) {
    setModelSpeedControlsBusy(false);
    toast(error.message, true);
  }
}

function renderProjectFilter() {
  const selectedProjects = selectedMultiValues($("#projectFilter"));
  const selectedTeams = selectedMultiValues($("#teamFilter"));
  const projects = selectedTeams.length
    ? state.projects.filter(project => selectedTeams.includes(project.team?.trim()))
    : state.projects;
  renderMultiSelect(
    $("#projectFilter"),
    projects.map(project => ({ value: project.id, label: project.name })),
    selectedProjects,
  );
}

function metricComparisonHtml(field, comparison) {
  if (!comparison) return '<div class="metric-comparison"><span>暂无上一周期数据</span></div>';
  const periodLabels = { week: "上一周", biweek: "上一双周", month: "上月", quarter: "上一季度" };
  const change = comparison.changes?.[field];
  const previous = comparison.previous?.summary?.[field];
  const prefix = `较${periodLabels[comparison.period] || "上一周期"}`;
  if (change === null || change === undefined) {
    const text = Number(previous || 0) === 0 ? "新增，暂无环比基数" : "暂无可比数据";
    return `<div class="metric-comparison"><span>${prefix}</span><span class="change flat">${text}</span></div>`;
  }
  const direction = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const icon = change > 0 ? "↑" : change < 0 ? "↓" : "—";
  return `<div class="metric-comparison"><span>${prefix}环比</span><span class="change ${direction}">${icon} ${formatPercent(change)}</span></div>`;
}

function metricSparklineHtml(field, tokenTrend = [], codeTrend = []) {
  if (!field || field === "monitor_project_count") return "";
  const rows = ["added_lines", "tokens_per_added_line"].includes(field) ? codeTrend : tokenTrend;
  const values = (rows || [])
    .filter(row => field !== "added_lines" && field !== "tokens_per_added_line" || row.code_data_available !== false)
    .map(row => row[field])
    .filter(value => value !== null && value !== undefined && Number.isFinite(Number(value)))
    .map(Number);
  if (values.length < 2) return "";
  const width = 70, height = 38, padding = 2;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = maximum - minimum;
  const x = index => padding + index * (width - padding * 2) / (values.length - 1);
  const y = value => range === 0
    ? height / 2
    : padding + (maximum - value) / range * (height - padding * 2 - 6);
  const path = values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
  const area = `${path} L${(width-padding).toFixed(2)},${height-padding} L${padding},${height-padding} Z`;
  return `<div class="metric-sparkline" aria-label="所选时间范围内的大致变化趋势">
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">
      <path class="spark-area" d="${area}"></path>
      <path class="spark-line" d="${path}"></path>
    </svg>
  </div>`;
}

function renderMetrics(summary, detail = false, comparison = null, trends = {}) {
  const currentPeriodTokensPerLine = comparison
    ? comparison.current?.summary?.tokens_per_added_line
    : summary.tokens_per_added_line;
  const definitions = detail
    ? [
        ["累计代码量", summary.added_lines, "&lt;/&gt;", "#2563eb", "#eff6ff", null, "unit"],
        ["输入 Token 数", summary.prompt_tokens, "P", "#8b5cf6", "#f5f3ff", null, "unit"],
        ["输出 Token 数", summary.completion_tokens, "C", "#06b6d4", "#ecfeff", null, "unit"],
        ["总 Token 数", summary.total_tokens, "T", "#f59e0b", "#fffbeb", null, "unit"],
      ]
    : [
        ["监控项目数", summary.monitor_project_count, "P", "#2563eb", "#eff6ff"],
        ["新增代码总量", summary.added_lines, "&lt;/&gt;", "#10b981", "#ecfdf5", "added_lines", "unit"],
        ["输入 Token 数", summary.prompt_tokens, "P", "#8b5cf6", "#f5f3ff", "prompt_tokens", "unit"],
        ["输出 Token 数", summary.completion_tokens, "C", "#06b6d4", "#ecfeff", "completion_tokens", "unit"],
        ["总 Token 数", summary.total_tokens, "T", "#f59e0b", "#fffbeb", "total_tokens", "unit"],
        ["Token Efficiency", currentPeriodTokensPerLine, "1L", "#ef4444", "#fef2f2", "tokens_per_added_line", "unit"],
      ];
  return definitions.map(([label, value, icon, color, tint, field, format]) => {
    const exactTotal = !detail && ["added_lines", "prompt_tokens", "completion_tokens", "total_tokens"].includes(field);
    const displayValue = exactTotal ? formatNumber(value) : format === "unit"
      ? (value === null || value === undefined ? "暂无代码量" : formatBusinessInteger(value))
      : formatNumber(value);
    const exactValue = value === null || value === undefined ? "暂无代码量" : formatNumber(value);
    const sparkline = detail ? "" : metricSparklineHtml(field, trends.token, trends.code);
    return `
    <article class="metric-card ${sparkline ? "has-sparkline" : ""} ${exactTotal ? "exact-total" : ""}" style="--card-color:${color};--card-tint:${tint}">
      <div class="metric-icon">${icon}</div>
      <div class="metric-label">${label}</div>
      <div class="metric-value" title="精确值：${exactValue}">${displayValue}</div>
      ${exactTotal ? `<div class="metric-approximation">≈ ${formatBusinessInteger(value)}</div>` : ""}
      ${detail ? "" : metricComparisonHtml(field || ({ "监控项目数": "monitor_project_count", "新增代码总量": "added_lines", "输入 Token 数": "prompt_tokens", "输出 Token 数": "completion_tokens", "总 Token 数": "total_tokens" }[label]), comparison)}
      ${sparkline}
    </article>`;
  }).join("");
}

function niceMax(value) {
  if (!value) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / power) * power;
}

function lineChart(element, rows, series, axisLabels = {}) {
  if (!rows?.length) {
    element.innerHTML = '<div class="chart-empty">当前筛选范围暂无趋势数据</div>';
    return;
  }
  const hasRightAxis = series.some(item => item.axis === "right");
  const width = 900, height = 290, left = 74, right = hasRightAxis ? 84 : 20, top = 20, bottom = 42;
  const plotW = width - left - right, plotH = height - top - bottom;
  const axisMax = (axis) => niceMax(Math.max(
    ...rows.flatMap(row => series
      .filter(item => (item.axis || "left") === axis)
      .map(item => Number(row[item.key] || 0))),
    0,
  ));
  const leftMax = axisMax("left");
  const rightMax = hasRightAxis ? axisMax("right") : leftMax;
  const x = (index) => left + (rows.length === 1 ? plotW / 2 : index * plotW / (rows.length - 1));
  const y = (value, item) => {
    const max = item.axis === "right" ? rightMax : leftMax;
    return top + plotH - Number(value || 0) / max * plotH;
  };
  const displaySeriesValue = (item, value) => item.format === "unit" ? formatBusinessInteger(value) : item.format === "ratio" ? formatRatio(value) : formatNumber(value);
  const grid = Array.from({ length: 5 }, (_, index) => {
    const gy = top + plotH * index / 4;
    const label = formatCompact(leftMax * (4 - index) / 4);
    return `<line x1="${left}" y1="${gy}" x2="${width-right}" y2="${gy}" stroke="#e8eef6" stroke-width="1"/><text x="${left-10}" y="${gy+4}" text-anchor="end" fill="#8a98ad" font-size="10">${label}</text>`;
  }).join("");
  const rightLabels = hasRightAxis ? Array.from({ length: 5 }, (_, index) => {
    const gy = top + plotH * index / 4;
    const label = formatCompact(rightMax * (4 - index) / 4);
    return `<text x="${width-right+10}" y="${gy+4}" text-anchor="start" fill="#8a98ad" font-size="10">${label}</text>`;
  }).join("") : "";
  const axisTitles = `
    ${axisLabels.left ? `<text class="axis-title" x="18" y="${top + 8}" writing-mode="vertical-rl" text-orientation="upright" fill="#64748b" font-size="10" font-weight="650">${escapeHtml(axisLabels.left)}</text>` : ""}
    ${hasRightAxis && axisLabels.right ? `<text class="axis-title" x="${width - 18}" y="${top + 8}" writing-mode="vertical-rl" text-orientation="upright" fill="#64748b" font-size="10" font-weight="650">${escapeHtml(axisLabels.right)}</text>` : ""}`;
  const paths = series.map(item => {
    const d = rows.map((row, index) => `${index ? "L" : "M"}${x(index)},${y(row[item.key], item)}`).join(" ");
    const points = rows.length <= 45 ? rows.map((row, index) => `<circle cx="${x(index)}" cy="${y(row[item.key], item)}" r="2.5" fill="white" stroke="${item.color}" stroke-width="2"><title>${escapeHtml(row.stat_date)} · ${item.label}: ${displaySeriesValue(item, row[item.key])}</title></circle>`).join("") : "";
    return `<path d="${d}" fill="none" stroke="${item.color}" stroke-width="2.3" stroke-linejoin="round" stroke-linecap="round"/>${points}`;
  }).join("");
  const tickCount = Math.min(6, rows.length);
  const labels = Array.from({ length: tickCount }, (_, index) => {
    const rowIndex = Math.round(index * (rows.length - 1) / Math.max(1, tickCount - 1));
    return `<text x="${x(rowIndex)}" y="${height-13}" text-anchor="middle" fill="#8a98ad" font-size="10">${escapeHtml(rows[rowIndex].stat_date.slice(5))}</text>`;
  }).join("");
  const step = rows.length > 1 ? plotW / (rows.length - 1) : plotW;
  const hoverZones = rows.map((row, index) => {
    const zoneLeft = rows.length === 1 ? left : Math.max(left, x(index) - step / 2);
    const zoneRight = rows.length === 1 ? width - right : Math.min(width - right, x(index) + step / 2);
    return `<rect class="hover-zone" data-index="${index}" data-date="${escapeHtml(row.stat_date)}" x="${zoneLeft}" y="${top}" width="${Math.max(1, zoneRight-zoneLeft)}" height="${plotH}" fill="transparent" pointer-events="all"/>`;
  }).join("");
  element.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="按日趋势图">
      ${grid}${rightLabels}${axisTitles}${paths}${labels}
      <line class="hover-guide" x1="0" y1="${top}" x2="0" y2="${top+plotH}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 4" visibility="hidden"/>
      <g class="hover-points"></g>
      ${hoverZones}
    </svg>
    <div class="chart-tooltip hidden" role="status"></div>`;

  const guide = element.querySelector(".hover-guide");
  const markerGroup = element.querySelector(".hover-points");
  const tooltip = element.querySelector(".chart-tooltip");
  const showPoint = (index) => {
    const row = rows[index];
    const pointX = x(index);
    const pointY = Math.min(...series.map(item => y(row[item.key], item)));
    guide.setAttribute("x1", pointX);
    guide.setAttribute("x2", pointX);
    guide.setAttribute("visibility", "visible");
    markerGroup.innerHTML = series.map(item => `
      <circle cx="${pointX}" cy="${y(row[item.key], item)}" r="4" fill="white" stroke="${item.color}" stroke-width="2.5" pointer-events="none"/>
    `).join("");
    tooltip.innerHTML = `
      <strong>${escapeHtml(row.stat_date)}</strong>
      ${series.map(item => `<span><i style="background:${item.color}"></i>${escapeHtml(item.label)}<b title="精确值：${formatNumber(row[item.key])}">${displaySeriesValue(item, row[item.key])}</b></span>`).join("")}`;
    tooltip.style.left = `${Math.min(89, Math.max(11, pointX / width * 100))}%`;
    tooltip.style.top = `${pointY / height * 100}%`;
    tooltip.classList.remove("hidden");
  };
  element.querySelectorAll(".hover-zone").forEach(zone => {
    const show = () => showPoint(Number(zone.dataset.index));
    zone.addEventListener("pointerenter", show);
    zone.addEventListener("pointermove", show);
  });
  element.addEventListener("pointerleave", () => {
    guide.setAttribute("visibility", "hidden");
    markerGroup.innerHTML = "";
    tooltip.classList.add("hidden");
  });
}

function periodTickIndexes(rows, period) {
  const maximumLabels = 12;
  if (rows.length <= maximumLabels) return rows.map((_, index) => index);
  const indexes = new Set([0, rows.length - 1]);
  for (let index = 0; index < maximumLabels; index += 1) {
    indexes.add(Math.round(index * (rows.length - 1) / (maximumLabels - 1)));
  }
  return [...indexes].sort((left, right) => left - right);
}

function selectedPeriodBounds(row) {
  const selectedStart = $("#startDate")?.value;
  const selectedEnd = $("#endDate")?.value;
  return {
    start: selectedStart && selectedStart > row.period_start ? selectedStart : row.period_start,
    end: selectedEnd && selectedEnd < row.period_end ? selectedEnd : row.period_end,
  };
}

function periodDisplayLabel(row) {
  const { start, end } = selectedPeriodBounds(row);
  return start === end ? start : `${start} 至 ${end}`;
}

function periodAxisLabel(row, period) {
  const { start, end } = selectedPeriodBounds(row);
  if (period === "month") return [start.slice(0, 7)];
  if (period === "quarter") return [periodDisplayLabel(row)];
  return [start.slice(5), end.slice(5)];
}

function periodAxisLabelSvg(row, period, x, y) {
  const lines = periodAxisLabel(row, period);
  return `<text x="${x}" y="${y}" text-anchor="middle" fill="#8a98ad" font-size="9">${lines.map((line, index) => `<tspan x="${x}" dy="${index ? 11 : 0}">${escapeHtml(line)}</tspan>`).join("")}</text>`;
}

function tokenConsumptionComboChart(element, rows, period) {
  const periodLabel = { week: "周", biweek: "双周", month: "月", quarter: "季度" }[period] || "周期";
  if (!rows?.length) {
    element.innerHTML = '<div class="chart-empty">当前筛选范围暂无 Token 趋势数据</div>';
    return;
  }
  const width = 900, height = 290, left = 74, right = 24, top = 20, bottom = 42;
  const plotW = width - left - right, plotH = height - top - bottom;
  const maximum = niceMax(Math.max(...rows.map(row => Number(row.total_tokens || 0)), 0));
  const average = rows.reduce((sum, row) => sum + Number(row.total_tokens || 0), 0) / rows.length;
  const slotWidth = plotW / rows.length;
  const barWidth = Math.min(38, Math.max(5, slotWidth * .58));
  const x = index => left + slotWidth * (index + .5);
  const y = value => top + plotH - Number(value || 0) / maximum * plotH;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const gy = top + plotH * index / 4;
    return `<line x1="${left}" y1="${gy}" x2="${width-right}" y2="${gy}" stroke="#e8eef6" stroke-width="1"/>
      <text x="${left-10}" y="${gy+4}" text-anchor="end" fill="#8a98ad" font-size="10">${formatCompact(maximum * (4-index) / 4)}</text>`;
  }).join("");
  const bars = rows.map((row, index) => {
    const totalY = y(row.total_tokens);
    return `<rect x="${x(index)-barWidth/2}" y="${totalY}" width="${barWidth}" height="${Math.max(0, top+plotH-totalY)}" rx="3" fill="#fbbf24" fill-opacity=".42" pointer-events="none"/>`;
  }).join("");
  const totalPath = rows.map((row, index) => `${index ? "L" : "M"}${x(index)},${y(row.total_tokens)}`).join(" ");
  const labels = periodTickIndexes(rows, period).map(rowIndex => periodAxisLabelSvg(rows[rowIndex], period, x(rowIndex), height - 22)).join("");
  const hoverZones = rows.map((row, index) => `<rect class="hover-zone" data-index="${index}" x="${left+slotWidth*index}" y="${top}" width="${slotWidth}" height="${plotH}" fill="transparent" pointer-events="all"/>`).join("");
  const averageY = y(average);
  element.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="按${periodLabel}统计的 Token 消耗柱线趋势图">
      ${grid}
      <text class="axis-title" x="18" y="${top + 8}" writing-mode="vertical-rl" text-orientation="upright" fill="#64748b" font-size="10" font-weight="650">Token 数（个）</text>
      <line x1="${left}" y1="${averageY}" x2="${width-right}" y2="${averageY}" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4 4"/>
      <text x="${width-right-3}" y="${Math.max(top + 10, averageY - 6)}" text-anchor="end" fill="#64748b" font-size="10">平均值：${formatBusinessInteger(average)}</text>
      ${bars}
      <path d="${totalPath}" fill="none" stroke="#f59e0b" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
      ${rows.map((row, index) => `<circle cx="${x(index)}" cy="${y(row.total_tokens)}" r="3" fill="white" stroke="#f59e0b" stroke-width="2" pointer-events="none"/>`).join("")}
      ${labels}
      <line class="hover-guide" x1="0" y1="${top}" x2="0" y2="${top+plotH}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 4" visibility="hidden"/>
      ${hoverZones}
    </svg>
    <div class="chart-tooltip hidden" role="status"></div>`;
  const guide = element.querySelector(".hover-guide");
  const tooltip = element.querySelector(".chart-tooltip");
  const showPoint = index => {
    const row = rows[index];
    const pointX = x(index);
    guide.setAttribute("x1", pointX);
    guide.setAttribute("x2", pointX);
    guide.setAttribute("visibility", "visible");
    tooltip.innerHTML = `
      <strong>${escapeHtml(periodDisplayLabel(row))}</strong>
      <span><i style="background:#f59e0b"></i>总 Token 数<b title="精确值：${formatNumber(row.total_tokens)}">${formatBusinessInteger(row.total_tokens)}</b></span>
      <span><i style="background:#94a3b8"></i>平均值<b title="精确值：${formatNumber(average)}">${formatBusinessInteger(average)}</b></span>`;
    tooltip.style.left = `${Math.min(89, Math.max(11, pointX / width * 100))}%`;
    tooltip.style.top = `${y(row.total_tokens) / height * 100}%`;
    tooltip.classList.remove("hidden");
  };
  element.querySelectorAll(".hover-zone").forEach(zone => {
    const show = () => showPoint(Number(zone.dataset.index));
    zone.addEventListener("pointerenter", show);
    zone.addEventListener("pointermove", show);
  });
  element.addEventListener("pointerleave", () => {
    guide.setAttribute("visibility", "hidden");
    tooltip.classList.add("hidden");
  });
}

function efficiencyComboChart(element, rows, period) {
  const periodLabel = { week: "周", biweek: "双周", month: "月", quarter: "季度" }[period] || "周期";
  if (!rows?.length) {
    element.innerHTML = `<div class="chart-empty">当前筛选范围暂无${periodLabel}效率数据</div>`;
    return;
  }
  const width = 900, height = 290, left = 74, right = 84, top = 20, bottom = 42;
  const plotW = width - left - right, plotH = height - top - bottom;
  const codeMax = niceMax(Math.max(...rows.map(row => Number(row.added_lines || 0)), 0));
  const ratioValues = rows
    .map(row => row.tokens_per_added_line)
    .filter(value => value !== null && value !== undefined)
    .map(Number);
  const ratioAverage = rows.reduce((totals, row) => {
    totals.addedLines += Number(row.added_lines || 0);
    totals.totalTokens += Number(row.total_tokens || 0);
    return totals;
  }, { addedLines: 0, totalTokens: 0 });
  const averageTokensPerLine = ratioAverage.addedLines > 0
    ? ratioAverage.totalTokens / ratioAverage.addedLines
    : null;
  const ratioMax = niceMax(Math.max(...ratioValues, Number(averageTokensPerLine || 0), 0));
  const slotWidth = plotW / rows.length;
  const barWidth = Math.min(42, Math.max(5, slotWidth * .56));
  const x = (index) => left + slotWidth * (index + .5);
  const codeY = (value) => top + plotH - Number(value || 0) / codeMax * plotH;
  const ratioY = (value) => top + plotH - Number(value || 0) / ratioMax * plotH;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const gy = top + plotH * index / 4;
    return `<line x1="${left}" y1="${gy}" x2="${width-right}" y2="${gy}" stroke="#e8eef6" stroke-width="1"/>
      <text x="${left-10}" y="${gy+4}" text-anchor="end" fill="#8a98ad" font-size="10">${formatCompact(codeMax * (4-index) / 4)}</text>
      <text x="${width-right+10}" y="${gy+4}" text-anchor="start" fill="#8a98ad" font-size="10">${formatCompact(ratioMax * (4-index) / 4)}</text>`;
  }).join("");
  const axisTitles = `
    <text class="axis-title" x="18" y="${top + 8}" writing-mode="vertical-rl" text-orientation="upright" fill="#64748b" font-size="10" font-weight="650">新增代码行数（行）</text>
    <text class="axis-title" x="${width - 18}" y="${top + 8}" writing-mode="vertical-rl" text-orientation="upright" fill="#64748b" font-size="10" font-weight="650">Token Efficiency（Token/行）</text>`;
  const averageLine = averageTokensPerLine === null ? "" : `
    <line x1="${left}" y1="${ratioY(averageTokensPerLine)}" x2="${width-right}" y2="${ratioY(averageTokensPerLine)}" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4 4"/>
    <text x="${width-right-4}" y="${Math.max(top + 10, ratioY(averageTokensPerLine) - 6)}" text-anchor="end" fill="#64748b" font-size="10">平均值：${formatBusinessInteger(averageTokensPerLine)}</text>`;
  const bars = rows.map((row, index) => {
    const y = codeY(row.added_lines);
    return `<rect class="combo-bar" x="${x(index)-barWidth/2}" y="${y}" width="${barWidth}" height="${Math.max(0, top+plotH-y)}" rx="3" fill="#93c5fd"><title>${escapeHtml(periodDisplayLabel(row))} · 周期新增代码行：${formatBusinessInteger(row.added_lines)}</title></rect>`;
  }).join("");
  let drawingLine = false;
  const ratioPath = rows.map((row, index) => {
    if (row.tokens_per_added_line === null || row.tokens_per_added_line === undefined) {
      drawingLine = false;
      return "";
    }
    const command = drawingLine ? "L" : "M";
    drawingLine = true;
    return `${command}${x(index)},${ratioY(row.tokens_per_added_line)}`;
  }).join(" ");
  const ratioPoints = rows.map((row, index) => row.tokens_per_added_line === null || row.tokens_per_added_line === undefined ? "" : `
    <circle cx="${x(index)}" cy="${ratioY(row.tokens_per_added_line)}" r="3" fill="white" stroke="#8b5cf6" stroke-width="2"><title>${escapeHtml(periodDisplayLabel(row))} · Token Efficiency：${formatBusinessInteger(row.tokens_per_added_line)}</title></circle>`).join("");
  const labels = periodTickIndexes(rows, period).map(rowIndex => periodAxisLabelSvg(rows[rowIndex], period, x(rowIndex), height - 22)).join("");
  const hoverZones = rows.map((row, index) => `<rect class="hover-zone" data-index="${index}" x="${left+slotWidth*index}" y="${top}" width="${slotWidth}" height="${plotH}" fill="transparent" pointer-events="all"/>`).join("");
  element.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="按${periodLabel}统计的 Token Efficiency 组合图">
      ${grid}${axisTitles}${averageLine}${bars}
      <path d="${ratioPath}" fill="none" stroke="#8b5cf6" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${ratioPoints}${labels}
      <line class="hover-guide" x1="0" y1="${top}" x2="0" y2="${top+plotH}" stroke="#64748b" stroke-width="1" stroke-dasharray="4 4" visibility="hidden"/>
      ${hoverZones}
    </svg>
    <div class="chart-tooltip hidden" role="status"></div>`;

  const guide = element.querySelector(".hover-guide");
  const tooltip = element.querySelector(".chart-tooltip");
  const showPeriod = (index) => {
    const row = rows[index];
    const pointX = x(index);
    guide.setAttribute("x1", pointX);
    guide.setAttribute("x2", pointX);
    guide.setAttribute("visibility", "visible");
    tooltip.innerHTML = `
      <strong>${escapeHtml(periodDisplayLabel(row))}</strong>
      <span><i style="background:#93c5fd"></i>周期新增代码行<b title="精确值：${formatNumber(row.added_lines)}">${formatBusinessInteger(row.added_lines)}</b></span>
      <span><i style="background:#f59e0b"></i>周期总 Token 数<b title="精确值：${formatNumber(row.total_tokens)}">${formatBusinessInteger(row.total_tokens)}</b></span>
      <span><i style="background:#8b5cf6"></i>Token Efficiency<b title="精确值：${formatNumber(row.tokens_per_added_line)}">${row.tokens_per_added_line === null || row.tokens_per_added_line === undefined ? "暂无代码量" : formatBusinessInteger(row.tokens_per_added_line)}</b></span>
      <span><i style="background:#94a3b8"></i>平均值<b title="精确值：${formatNumber(averageTokensPerLine)}">${averageTokensPerLine === null ? "暂无代码量" : formatBusinessInteger(averageTokensPerLine)}</b></span>`;
    tooltip.style.left = `${Math.min(89, Math.max(11, pointX / width * 100))}%`;
    const tooltipY = row.tokens_per_added_line === null || row.tokens_per_added_line === undefined ? codeY(row.added_lines) : Math.min(codeY(row.added_lines), ratioY(row.tokens_per_added_line));
    tooltip.style.top = `${tooltipY / height * 100}%`;
    tooltip.classList.remove("hidden");
  };
  element.querySelectorAll(".hover-zone").forEach(zone => {
    const show = () => showPeriod(Number(zone.dataset.index));
    zone.addEventListener("pointerenter", show);
    zone.addEventListener("pointermove", show);
  });
  element.addEventListener("pointerleave", () => {
    guide.setAttribute("visibility", "hidden");
    tooltip.classList.add("hidden");
  });
}

function renderTokenEfficiency() {
  const rows = state.overview?.period_efficiency_trend || [];
  efficiencyComboChart($("#tokenTrend"), rows, state.dashboardGranularity);
}

function rankingChart(element, rows, color) {
  const values = (rows || []).filter(item => Number(item.value) > 0).slice(0, 8);
  if (!values.length) {
    element.innerHTML = '<div class="ranking-empty">当前筛选范围暂无排行数据</div>';
    return;
  }
  const max = Math.max(...values.map(item => Number(item.value)));
  element.innerHTML = values.map((item, index) => `
    <div class="ranking-row" data-project-id="${item.project_id}">
      <div class="ranking-meta">
        <span class="ranking-name">${index + 1}. ${escapeHtml(item.project_name)}</span>
        <span class="ranking-value">${formatCompact(item.value)}</span>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, item.value/max*100)}%;background:${color}"></div></div>
    </div>`).join("");
  element.querySelectorAll(".ranking-row").forEach(row => row.addEventListener("click", () => navigateProject(row.dataset.projectId)));
}

function renderEfficiencyInsights(insights, codeAnalysisPeriod) {
  const values = Array.isArray(insights) ? insights : [];
  const allowedTones = new Set(["danger", "success", "warning", "info"]);
  const sections = ["总体趋势", "项目表现"];
  $("#efficiencyInsights").innerHTML = values.length ? sections.map(section => {
    const items = values.filter(item => (item.section || "总体趋势") === section);
    if (!items.length) return "";
    return `<section class="insight-section">
      <h4 class="insight-section-title">${escapeHtml(section)}</h4>
      <div class="insight-section-items">${items.map(item => {
        const tone = allowedTones.has(item.tone) ? item.tone : "info";
        return `<div class="insight-item ${tone}">
          <span class="insight-icon" aria-hidden="true">${escapeHtml(item.icon || "i")}</span>
          <p>${escapeHtml(item.message)}</p>
        </div>`;
      }).join("")}</div>
    </section>`;
  }).join("") : '<div class="chart-empty">当前筛选范围暂无可生成的效能洞察</div>';
  const codePeriodText = codeAnalysisPeriod === "biweek" && state.dashboardGranularity === "week"
    ? "代码指标按两周有效导入周期分析；Token 指标按周分析。"
    : "代码与 Token 指标按当前所选粒度分析。";
  $("#insightMethodNote").textContent = `基于当前筛选范围与统计规则自动生成，数据不出内网。${codePeriodText}`;
}

function efficiencyRankingChart(element, rows) {
  const values = (rows || []).slice(0, 8);
  if (!values.length) {
    element.innerHTML = '<div class="ranking-empty">当前筛选范围缺少同时具有代码量和 Token 的项目</div>';
    return;
  }
  const maximum = Math.max(...values.map(item => Number(item.code_lines_per_million_tokens || 0)), 1);
  element.innerHTML = values.map((item, index) => {
    const efficiency = Number(item.code_lines_per_million_tokens || 0);
    return `<div class="ranking-row efficiency-ranking-row" data-project-id="${item.project_id}">
      <div class="ranking-meta">
        <span class="ranking-name">${index + 1}. ${escapeHtml(item.project_name)}</span>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, efficiency / maximum * 100)}%;background:#3b82f6"></div></div>
      <div class="efficiency-ranking-meta">新增 ${formatBusinessInteger(item.added_lines)} · 每百万 Token 产出 ${formatNumber(Math.round(efficiency))} 行${item.sample_status === "SMALL" ? " · 样本较小" : ""}</div>
    </div>`;
  }).join("");
  element.querySelectorAll(".ranking-row").forEach(row => row.addEventListener("click", () => navigateProject(row.dataset.projectId)));
}

function renderTeamEfficiencyComparison(rows) {
  const values = Array.isArray(rows) ? rows : [];
  const element = $("#teamEfficiencyComparison");
  if (!values.length) {
    element.innerHTML = '<div class="team-efficiency-empty">当前筛选范围暂无团队投入产出数据</div>';
    return;
  }
  const shareText = value => value === null || value === undefined
    ? "—"
    : `${(Number(value) * 100).toFixed(1)}%`;
  const shareWidth = value => Math.max(0, Math.min(100, Number(value || 0) * 100));
  const resultMeaning = multiplier => multiplier === null || multiplier === undefined
    ? "待核验"
    : Number(multiplier) >= 1.2 ? "产出占优" : Number(multiplier) >= 0.8 ? "投入匹配" : "投入偏高";
  element.innerHTML = `
    <div class="team-efficiency-head"><span>团队</span><span>代码占比</span><span>Token 占比</span><span>结果</span></div>
    ${values.map(item => {
      const multiplier = item.output_input_multiplier;
      const multiplierClass = multiplier !== null && Number(multiplier) >= 1 ? "good" : "warn";
      return `<div class="team-efficiency-row">
        <span class="team-efficiency-name" title="${escapeHtml(item.team)}">${escapeHtml(item.team)}</span>
        <span class="share-meter"><i class="share-meter-track"><b class="share-meter-fill" style="width:${shareWidth(item.code_share)}%;background:#3b82f6"></b></i><span>${shareText(item.code_share)}</span></span>
        <span class="share-meter"><i class="share-meter-track"><b class="share-meter-fill" style="width:${shareWidth(item.token_share)}%;background:#8b5cf6"></b></i><span>${shareText(item.token_share)}</span></span>
        <span class="team-efficiency-result"><strong class="team-efficiency-multiplier ${multiplierClass}">${multiplier === null || multiplier === undefined ? "—" : formatRatio(multiplier)}</strong><small class="team-efficiency-meaning">${resultMeaning(multiplier)}</small></span>
      </div>`;
    }).join("")}`;
}

function polarPoint(cx, cy, radius, angle) {
  const radians = (angle - 90) * Math.PI / 180;
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
}

function donutPath(startAngle, endAngle) {
  const cx = 110, cy = 110, outer = 78, inner = 48;
  const safeEnd = endAngle - startAngle >= 360 ? startAngle + 359.999 : endAngle;
  const outerStart = polarPoint(cx, cy, outer, startAngle);
  const outerEnd = polarPoint(cx, cy, outer, safeEnd);
  const innerEnd = polarPoint(cx, cy, inner, safeEnd);
  const innerStart = polarPoint(cx, cy, inner, startAngle);
  const largeArc = safeEnd - startAngle > 180 ? 1 : 0;
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outer} ${outer} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${inner} ${inner} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
}

function projectColor(item, fallbackIndex) {
  const projectIndex = state.projects.findIndex(project => Number(project.id) === Number(item.project_id));
  const colorIndex = projectIndex >= 0 ? projectIndex : fallbackIndex;
  if (colorIndex < chartColors.length) return chartColors[colorIndex];
  return `hsl(${Math.round((colorIndex * 137.508 + 216) % 360)} 68% 52%)`;
}

function pieChart(element, rows, dimension = "PROJECT") {
  const values = (rows || [])
    .map((item, index) => ({ ...item, color: projectColor(item, index) }))
    .filter(item => Number(item.value) > 0)
    .sort((left, right) => Number(right.value) - Number(left.value)
      || teamCollator.compare(String(left.name), String(right.name)));
  if (!values.length) {
    element.innerHTML = '<div class="chart-empty">当前筛选范围暂无占比数据</div>';
    return;
  }
  const total = values.reduce((sum, item) => sum + Number(item.value), 0);
  let angle = 0;
  const segments = values.map((item, index) => {
    const start = angle;
    const share = Number(item.value) / total;
    angle += share * 360;
    const interactionAttributes = dimension === "TEAM"
      ? `class="pie-segment" data-index="${index}" tabindex="0" role="button" aria-label="${escapeHtml(item.name)}详细信息"`
      : "";
    return `<path ${interactionAttributes} d="${donutPath(start, angle)}" fill="${item.color}" stroke="white" stroke-width="2"><title>${escapeHtml(item.name)}：${formatNumber(item.value)}（${(share * 100).toFixed(1)}%）</title></path>`;
  }).join("");
  const legend = values.map((item, index) => {
    const share = Number(item.value) / total * 100;
    const interactionAttributes = dimension === "TEAM" ? `class="interactive" data-index="${index}" tabindex="0"` : "";
    return `<li ${interactionAttributes}><i style="background:${item.color}"></i><span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><b>${share.toFixed(1)}%</b></li>`;
  }).join("");
  const detail = dimension === "TEAM"
    ? '<div class="pie-detail"><strong>团队详情</strong><span>悬停扇区或图例查看</span></div>'
    : "";
  element.innerHTML = `
    <div class="pie-visual">
      <svg viewBox="0 0 220 220" role="img" aria-label="占比图">${segments}<text x="110" y="104" text-anchor="middle" fill="#70809c" font-size="11">合计</text><text x="110" y="125" text-anchor="middle" fill="#172033" font-size="16" font-weight="750">${formatCompact(total)}</text></svg>
    </div>
    <div class="pie-side">${detail}<ul class="pie-legend">${legend}</ul></div>`;

  if (dimension === "TEAM") {
    const segmentElements = [...element.querySelectorAll(".pie-segment")];
    const legendElements = [...element.querySelectorAll(".pie-legend li.interactive")];
    const detailElement = element.querySelector(".pie-detail");
    const activate = (index) => {
      segmentElements.forEach((segment, itemIndex) => segment.classList.toggle("active", itemIndex === index));
      legendElements.forEach((legendItem, itemIndex) => legendItem.classList.toggle("active", itemIndex === index));
      const item = values[index];
      const share = Number(item.value) / total * 100;
      const team = (state.overview?.team_totals || []).find(row => row.team === item.name) || {};
      detailElement.innerHTML = `
        <strong>${escapeHtml(item.name)}</strong>
        <span>项目数<b>${formatNumber(team.project_count)}</b></span>
        <span>新增代码<b>${formatNumber(team.added_lines)} 行</b></span>
        <span>总 Token<b>${formatNumber(team.total_tokens)}</b></span>
        <span>当前占比<b>${share.toFixed(1)}%</b></span>`;
    };
    [...segmentElements, ...legendElements].forEach(target => {
      target.addEventListener("pointerenter", () => activate(Number(target.dataset.index)));
      target.addEventListener("focus", () => activate(Number(target.dataset.index)));
    });
    element.addEventListener("pointerleave", () => {
      segmentElements.forEach(segment => segment.classList.remove("active"));
      legendElements.forEach(legendItem => legendItem.classList.remove("active"));
      detailElement.innerHTML = '<strong>团队详情</strong><span>悬停扇区或图例查看</span>';
    });
  }
}


function renderOverview(data) {
  state.overview = data;
  updateSource(data.data_source);
  document.querySelectorAll("[data-dashboard-granularity]").forEach(button => {
    const active = button.dataset.dashboardGranularity === state.dashboardGranularity;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("#metricCards").innerHTML = renderMetrics(data.summary, false, data.comparison, {
    token: data.period_token_trend,
    code: data.code_analysis_trend,
  });
  renderEfficiencyInsights(data.insights, data.code_analysis_period);
  tokenConsumptionComboChart($("#codeTrend"), data.period_token_trend, state.dashboardGranularity);
  renderTokenEfficiency();
  rankingChart($("#codeRanking"), data.project_code_ranking, "#3b82f6");
  rankingChart($("#tokenRanking"), data.project_token_ranking, "#8b5cf6");
  efficiencyRankingChart($("#efficiencyRanking"), data.project_efficiency_ranking);
  const pieLabel = data.pie_dimension === "PROJECT" ? "项目" : "团队";
  $("#codePieTitle").textContent = `${pieLabel}代码量占比`;
  $("#tokenPieTitle").textContent = `${pieLabel} Token 占比`;
  pieChart($("#codePie"), data.code_pie, data.pie_dimension);
  pieChart($("#tokenPie"), data.token_pie, data.pie_dimension);
  renderTeamEfficiencyComparison(data.team_efficiency_comparison);
}

function queryString() {
  const params = new URLSearchParams();
  selectedMultiValues($("#teamFilter")).forEach(team => params.append("teams", team));
  selectedMultiValues($("#projectFilter")).forEach(projectId => params.append("project_ids", projectId));
  if ($("#startDate").value) params.set("start", $("#startDate").value);
  if ($("#endDate").value) params.set("end", $("#endDate").value);
  params.set("granularity", state.dashboardGranularity);
  return params.toString();
}

async function loadOverview() {
  setLoading(true);
  try {
    const data = await api(`/api/dashboard/overview?${queryString()}`);
    renderOverview(data);
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

async function downloadReport() {
  const button = $("#reportButton");
  const formatSelect = $("#reportFormat");
  const format = formatSelect.value;
  const params = new URLSearchParams(queryString());
  params.set("format", format);
  button.disabled = formatSelect.disabled = true;
  button.textContent = "生成中…";
  try {
    const response = await fetch(`/api/dashboard/report?${params}`);
    if (response.status === 401) { window.location.assign("/login"); return; }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(typeof payload?.detail === "string" ? payload.detail : `报告生成失败：${response.status}`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const filename = response.headers.get("Content-Disposition")?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    anchor.download = filename ? decodeURIComponent(filename) : `AI研发效能报告.${format}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast("报告已生成，内容按当前筛选时间和统计粒度汇总");
  } catch (error) { toast(error.message, true); }
  finally {
    button.disabled = formatSelect.disabled = false;
    button.textContent = "生成报告";
  }
}

async function refreshData() {
  const button = $("#refreshButton");
  button.disabled = true;
  setLoading(true);
  try {
    const params = new URLSearchParams();
    if ($("#startDate").value) params.set("start", $("#startDate").value);
    if ($("#endDate").value) params.set("end", $("#endDate").value);
    const result = await api(`/api/litellm/sync?${params}`, { method: "POST" });
    await loadOverview();
    toast(`Token 刷新完成：更新 ${formatNumber(result.upserted_row_count)} 条项目日数据`);
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; setLoading(false); }
}

async function uploadCodeStatistics(file) {
  if (!file) return;
  const button = $("#codeUploadButton");
  const input = $("#codeUploadInput");
  const lowerName = file.name.toLowerCase();
  if (!lowerName.endsWith(".csv") && !lowerName.endsWith(".xlsx")) {
    toast("请选择 codeStatisticDetail-日期.csv 或 .xlsx 文件", true);
    input.value = "";
    return;
  }

  button.disabled = true;
  input.disabled = true;
  setLoading(true);
  try {
    const form = new FormData();
    form.append("file", file, file.name);
    const result = await api("/api/code-stat/import", {
      method: "POST",
      body: form,
    });
    await loadOverview();
    if (result.status === "DUPLICATE_FILE") {
      toast("该代码统计文件已完整导入过，本次未重复写入数据");
      return;
    }
    const ambiguity = result.ambiguous_source_repository_count
      ? `，歧义 ${formatNumber(result.ambiguous_source_repository_count)} 个`
      : "";
    toast(
      `代码统计导入完成：新增 ${formatNumber(result.inserted_daily_count)} 条，` +
      `修正 ${formatNumber(result.updated_daily_count)} 条，` +
      `跳过相同数据 ${formatNumber(result.unchanged_daily_count)} 条，` +
      `匹配 ${formatNumber(result.matched_source_repository_count)} 个台账仓库，` +
      `保留非监控仓库 ${formatNumber(result.ignored_out_of_scope_repository_count)} 个${ambiguity}`,
    );
  } catch (error) {
    toast(error.message, true);
  } finally {
    input.value = "";
    input.disabled = false;
    button.disabled = false;
    setLoading(false);
  }
}

async function refreshDashboardProjects() {
  const selectedTeams = selectedMultiValues($("#teamFilter"));
  state.projects = await api("/api/dashboard/projects");
  const teams = [...new Set(state.projects.map(project => project.team?.trim()).filter(Boolean))].sort(compareTeams);
  renderMultiSelect(
    $("#teamFilter"),
    teams.map(team => ({ value: team, label: team })),
    selectedTeams,
  );
  renderProjectFilter();
}

function managementStatusBadge(status) {
  const labels = {
    ACTIVE: "监控中",
    STOPPED: "已停止",
    MATCHED: "已匹配",
    PARTIAL: "部分匹配",
    AMBIGUOUS_LEDGER: "存在歧义",
    UNMATCHED_LEDGER: "未匹配",
    NOT_ANALYZED: "待分析",
    NO_REPOSITORY: "无仓库",
  };
  const className = status === "ACTIVE" ? "active"
    : status === "STOPPED" ? "stopped"
      : status === "MATCHED" ? "matched"
        : status === "AMBIGUOUS_LEDGER" || status === "PARTIAL" ? "ambiguous"
          : "unmatched";
  return `<span class="status-badge ${className}">${escapeHtml(labels[status] || status)}</span>`;
}

function renderManagedProjects() {
  const activeCount = state.managedProjects.filter(project => project.monitoring_status === "ACTIVE").length;
  $("#managementCount").textContent = `共 ${formatNumber(state.managedProjects.length)} 个项目，监控中 ${formatNumber(activeCount)} 个`;
  $("#managementTable").innerHTML = state.managedProjects.length
    ? state.managedProjects.map(project => {
        const normalizedPaths = project.repositories.length
          ? `<ul class="path-list">${project.repositories.map(item => `<li>${escapeHtml(item.normalized_path)}</li>`).join("")}</ul>`
          : "—";
        const methods = [...new Set(project.repositories.map(item => item.code_match_method).filter(item => item && item !== "NONE"))];
        const statusAction = project.monitoring_status === "ACTIVE"
          ? `<button class="text-button danger" data-action="stop" data-project-id="${project.id}">停止监控</button>`
          : `<button class="text-button success" data-action="resume" data-project-id="${project.id}">恢复监控</button>`;
        return `<tr>
          <td><strong>${escapeHtml(project.name)}</strong></td>
          <td>${escapeHtml(project.team)}</td>
          <td>${managementStatusBadge(project.monitoring_status)}</td>
          <td>${formatNumber(project.repository_count)} 个</td>
          <td>${normalizedPaths}</td>
          <td>${managementStatusBadge(project.code_match_status)}</td>
          <td>${methods.length ? methods.map(escapeHtml).join("、") : "—"}</td>
          <td><div class="management-actions">
            <button class="text-button" data-action="edit" data-project-id="${project.id}">编辑</button>
            <button class="text-button" data-action="rematch" data-project-id="${project.id}" ${project.monitoring_status === "STOPPED" ? "disabled" : ""}>重新匹配</button>
            ${statusAction}
            <button class="text-button danger" data-action="delete" data-project-id="${project.id}">删除项目</button>
          </div></td>
        </tr>`;
      }).join("")
    : '<tr><td colspan="8" class="chart-empty">暂无项目</td></tr>';
}

async function loadManagedProjects() {
  setLoading(true);
  try {
    state.managedProjects = await api("/api/project-management/projects");
    renderManagedProjects();
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

function openProjectEditor(project = null) {
  $("#projectEditorTitle").textContent = project ? "编辑项目" : "新增项目";
  $("#editingProjectId").value = project?.id || "";
  $("#projectNameInput").value = project?.name || "";
  $("#projectTeamInput").value = project?.team || "";
  $("#projectLocationsInput").value = project
    ? project.repositories.map(item => item.original_path).join("\n")
    : "";
  $("#projectEditor").showModal();
  $("#projectNameInput").focus();
}

function closeProjectEditor() {
  $("#projectEditor").close();
}

async function saveManagedProject(event) {
  event.preventDefault();
  const projectId = $("#editingProjectId").value;
  const projectLocations = $("#projectLocationsInput").value
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean);
  const payload = {
    name: $("#projectNameInput").value.trim(),
    team: $("#projectTeamInput").value.trim(),
    project_locations: projectLocations,
  };
  if (!payload.name || !payload.team || !projectLocations.length) {
    toast("请填写项目名称、团队和至少一个项目位置", true);
    return;
  }
  const button = $("#saveProjectButton");
  button.disabled = true;
  setLoading(true);
  try {
    await api(
      projectId ? `/api/project-management/projects/${projectId}` : "/api/project-management/projects",
      {
        method: projectId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    closeProjectEditor();
    await Promise.all([loadManagedProjects(), refreshDashboardProjects()]);
    toast(projectId ? "项目已更新并重新匹配" : "项目已新增并完成匹配分析");
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; setLoading(false); }
}

async function performProjectAction(action, projectId) {
  const project = state.managedProjects.find(item => String(item.id) === String(projectId));
  if (!project) return;
  if (action === "edit") {
    openProjectEditor(project);
    return;
  }
  if (action === "stop" && !window.confirm(`确定停止监控“${project.name}”吗？历史代码和 Token 会继续保留。`)) return;
  if (action === "delete" && !window.confirm(`确定删除项目“${project.name}”吗？项目会从监控清单中移除，历史代码和 Token 仍会保留。`)) return;
  setLoading(true);
  try {
    const path = action === "delete"
      ? `/api/project-management/projects/${projectId}`
      : `/api/project-management/projects/${projectId}/${action}`;
    await api(path, { method: action === "delete" ? "DELETE" : "POST" });
    await Promise.all([loadManagedProjects(), refreshDashboardProjects()]);
    const messages = { stop: "项目已停止监控", resume: "项目已恢复监控并重新匹配", rematch: "仓库重新匹配完成", delete: "项目已删除，历史统计已保留" };
    toast(messages[action] || "操作完成");
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

function navigateProject(projectId) {
  state.projectBackHash = "#/";
  window.location.hash = `#/projects/${projectId}`;
}

async function renderProject(projectId) {
  setLoading(true);
  try {
    const data = await api(`/api/dashboard/projects/${projectId}`);
    updateSource(data.data_source);
    const project = data.project;
    const repositories = project.repositories.length
      ? project.repositories.map(item => `<li>${escapeHtml(item.normalized_path)}</li>`).join("")
      : "<li>台账未登记仓库地址</li>";
    const aliases = project.litellm_key_aliases.length
      ? project.litellm_key_aliases.map(item => `<li>${escapeHtml(item.key_alias)}</li>`).join("")
      : "<li>尚未匹配到 Key Alias</li>";
    $("#projectContent").innerHTML = `
      <section class="project-hero">
        <div>
          <span class="eyebrow">PROJECT INTELLIGENCE</span>
          <h2>${escapeHtml(project.name)}</h2>
          <p>${escapeHtml(project.team || "未填写所属团队")}</p>
          ${project.monitor_start_date_missing ? '<p class="warning-note">台账缺少项目开始日期，当前展示可用历史数据</p>' : ""}
        </div>
        <div class="project-meta">
          <div class="meta-block"><span>仓库地址</span><ul class="meta-list">${repositories}</ul></div>
          <div class="meta-block"><span>LITELLM KEY ALIAS</span><ul class="meta-list">${aliases}</ul></div>
        </div>
      </section>
      <section class="metric-grid detail-metrics">${renderMetrics(data.summary, true)}</section>
      <section class="chart-grid detail-chart-grid">
        <article class="panel chart-card"><div class="panel-heading"><div><span class="eyebrow">DAILY OUTPUT</span><h3>每日代码新增行数趋势</h3></div></div><div id="projectCodeTrend" class="chart"></div></article>
        <article class="panel chart-card"><div class="panel-heading"><div><span class="eyebrow">DAILY TOKEN</span><h3>每日 Token 消耗趋势</h3></div></div><div id="projectTokenTrend" class="chart"></div></article>
      </section>`;
    lineChart($("#projectCodeTrend"), data.code_trend, [{ key: "added_lines", label: "新增代码行", color: "#3b82f6", format: "unit" }]);
    lineChart($("#projectTokenTrend"), data.token_trend, [
      { key: "prompt_tokens", label: "输入 Token 数", color: "#8b5cf6", format: "unit" },
      { key: "completion_tokens", label: "输出 Token 数", color: "#06b6d4", format: "unit" },
      { key: "total_tokens", label: "总 Token 数", color: "#f59e0b", format: "unit" },
    ]);
  } catch (error) { toast(error.message, true); window.location.hash = "#/"; }
  finally { setLoading(false); }
}

function setActiveTopNavigation(activeId) {
  document.querySelectorAll(".top-nav-link").forEach(link => {
    const active = link.id === activeId;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function route() {
  const match = window.location.hash.match(/^#\/projects\/(\d+)$/);
  const management = window.location.hash === "#/management";
  const codingPlan = window.location.hash === "#/coding-plan";
  $("#dashboardView").classList.toggle("hidden", Boolean(match) || management || codingPlan);
  $("#projectView").classList.toggle("hidden", !match);
  $("#projectManagementView").classList.toggle("hidden", !management);
  $("#codingPlanView").classList.toggle("hidden", !codingPlan);
  if (management) setActiveTopNavigation("manageProjectsButton");
  else if (codingPlan) setActiveTopNavigation("codingPlanButton");
  else setActiveTopNavigation("dashboardNavButton");
  if (match) renderProject(match[1]);
  if (management) loadManagedProjects();
  if (codingPlan) {
    loadCodingPlan({ showLoading: true });
    loadModelSpeedTargets();
    startCodingPlanPolling();
  } else {
    stopCodingPlanPolling();
    stopModelSpeedPolling();
  }
}

async function initialize() {
  setLoading(true);
  try {
    if (!$("#endDate").value) $("#endDate").value = localDateText();
    await refreshDashboardProjects();
    await loadOverview();
    route();
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

$("#queryButton").addEventListener("click", loadOverview);
$("#reportButton").addEventListener("click", downloadReport);
$("#refreshButton").addEventListener("click", refreshData);
$("#codeUploadButton").addEventListener("click", () => {
  const input = $("#codeUploadInput");
  input.value = "";
  input.click();
});
$("#codeUploadInput").addEventListener("change", event => {
  uploadCodeStatistics(event.target.files?.[0]);
});
$("#manageProjectsButton").addEventListener("click", () => { window.location.hash = "#/management"; });
$("#codingPlanButton").addEventListener("click", () => { window.location.hash = "#/coding-plan"; });
$("#logoutButton").addEventListener("click", async () => {
  try { await fetch("/api/auth/logout", { method: "POST" }); }
  finally { window.location.replace("/login"); }
});
$("#codingPlanBackButton").addEventListener("click", () => { window.location.hash = "#/"; });
$("#codingPlanRefreshButton").addEventListener("click", refreshCodingPlan);
$("#modelSpeedForm").addEventListener("submit", startModelSpeedTest);
$("#modelSpeedTargets").addEventListener("change", event => {
  if (!event.target.matches("input[data-model-speed-target]")) return;
  const maxTargets = Number(state.modelSpeedConfig?.limits?.max_targets || Number.POSITIVE_INFINITY);
  if (selectedModelSpeedTargetIds().length > maxTargets) {
    event.target.checked = false;
    toast(`单次最多选择 ${formatNumber(maxTargets)} 个测速目标`, true);
  }
  updateModelSpeedCostHint();
});
$("#managementBackButton").addEventListener("click", () => { window.location.hash = "#/"; });
$("#addProjectButton").addEventListener("click", () => openProjectEditor());
$("#closeProjectEditorButton").addEventListener("click", closeProjectEditor);
$("#cancelProjectEditorButton").addEventListener("click", closeProjectEditor);
$("#projectEditorForm").addEventListener("submit", saveManagedProject);
$("#managementTable").addEventListener("click", event => {
  const button = event.target.closest("button[data-action]");
  if (button) performProjectAction(button.dataset.action, button.dataset.projectId);
});
$("#teamFilter").addEventListener("change", handleMultiSelectChange);
$("#projectFilter").addEventListener("change", handleMultiSelectChange);
document.querySelectorAll(".multi-select").forEach(element => {
  element.addEventListener("toggle", () => {
    if (!element.open) return;
    document.querySelectorAll(".multi-select[open]").forEach(other => {
      if (other !== element) other.removeAttribute("open");
    });
  });
});
document.addEventListener("pointerdown", event => {
  if (event.target.closest(".multi-select")) return;
  document.querySelectorAll(".multi-select[open]").forEach(element => element.removeAttribute("open"));
});
document.querySelectorAll("[data-dashboard-granularity]").forEach(button => button.addEventListener("click", () => {
  state.dashboardGranularity = button.dataset.dashboardGranularity;
  loadOverview();
}));
$("#backButton").addEventListener("click", () => { window.location.hash = state.projectBackHash; });
window.addEventListener("hashchange", route);
window.addEventListener("DOMContentLoaded", initialize);
