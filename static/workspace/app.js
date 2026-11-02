"use strict";
const $ = (selector) => document.querySelector(selector);
const state = { projects: [], data: null, meta: null, commits: [] };
const fmt = (value) => Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const compact = (value) => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : fmt(value);
const money = (v) => `$${Number(v || 0).toFixed(2)}`;
const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "输入格式错误，请检查必填项与字段类型");
  return result;
}
let noticeTimer;
function notice(message, error = false) {
  const n = $("#notice"); n.textContent = message; n.hidden = false; n.className = `notice${error ? " error" : ""}`;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { n.hidden = true; }, error ? 12000 : 6000);
}
function table(target, headers, rows) {
  const wrap = $(target); wrap.replaceChildren();
  if (!rows.length) { wrap.append(node("p", "当前范围暂无数据", "empty")); return; }
  const t = node("table"), head = node("thead"), tr = node("tr"), body = node("tbody");
  headers.forEach((h) => tr.append(node("th", h))); head.append(tr); t.append(head);
  rows.forEach((r) => { const row = node("tr"); r.forEach((c) => { const cell = node("td"); cell.append(c instanceof Node ? c : document.createTextNode(String(c ?? "—"))); row.append(cell); }); body.append(row); });
  t.append(body); wrap.append(t);
}
function badge(text) { return node("span", text, `badge${text === "已暂停" ? " warn" : ""}`); }
function option(value, label) { const o = node("option", label); o.value = value; return o; }
function options() {
  const team = $("#team").value;
  const selected = $("#project").value;
  $("#project").replaceChildren(option("", "全部"));
  state.projects.filter((p) => !team || p.team === team).forEach((p) => $("#project").append(option(p.id, p.name)));
  if ([...$("#project").options].some((o) => o.value === selected)) $("#project").value = selected;
}
async function loadProjects() {
  state.projects = await api("/api/projects");
  const selected = $("#team").value;
  $("#team").replaceChildren(option("", "全部"));
  [...new Set(state.projects.map((p) => p.team))].forEach((t) => $("#team").append(option(t, t)));
  if ([...$("#team").options].some((o) => o.value === selected)) $("#team").value = selected;
  options();
  $("#sync-project").replaceChildren();
  state.projects.forEach((p) => $("#sync-project").append(option(p.id, p.name)));
  $("#project-count").textContent = `共 ${state.projects.length} 个项目 · 仓库按项目 ID 明确关联`;
  table("#project-table", ["项目名称", "团队", "负责人", "监控状态", "仓库地址", "操作"], state.projects.map((p) => {
    const edit = node("button", "编辑"); edit.addEventListener("click", () => editProject(p));
    return [p.name, p.team, p.owner, badge(p.status), p.repository, edit];
  }));
}
function query() {
  const q = new URLSearchParams({ start: $("#start").value, end: $("#end").value, grain: $("#grain").value });
  if ($("#team").value) q.set("team", $("#team").value);
  if ($("#project").value) q.set("project_id", $("#project").value);
  return q;
}
async function refresh() {
  $("#filters").classList.add("loading");
  try {
    state.data = await api(`/api/dashboard?${query()}`);
    render(); if (location.hash === "#commits") await loadCommits();
  } catch (e) { notice(e.message, true); } finally { $("#filters").classList.remove("loading"); }
}
function render() {
  const d = state.data, k = d.kpis;
  $("#kpis").replaceChildren();
  [["P", "监控项目数", k.projects], ["</>", "新增代码总量（已知行数）", k.additions], ["P", "输入 Token 数", k.input_tokens], ["C", "输出 Token 数", k.output_tokens], ["T", "总 Token 数", k.tokens], ["API", "API 请求数", k.requests]].forEach(([icon, label, value]) => {
    const card = node("article", null, "kpi"); card.append(node("span", icon, "icon"), node("small", label), node("strong", fmt(value))); $("#kpis").append(card);
  });
  $("#insights").replaceChildren(...d.insights.map((i) => node("li", i)));
  table("#team-table", ["团队", "新增代码行", "Token 总量", "提交次数"], d.teams.map((t) => [t.label, fmt(t.additions), fmt(t.tokens), fmt(t.commits)]));
  table("#budget-table", ["项目", "AI 费用 / 预算", "预算使用率", "实际 / 计划人天"], d.projects.map((p) => [detailLink(p), `${money(p.cost)} / ${money(p.budget)}`, p.budget_utilization_pct == null ? "—" : `${fmt(p.budget_utilization_pct)}%`, `${fmt(p.actual_days)} / ${fmt(p.planned_days)}`]));
  table("#period-table", ["周期起始日", "输入 Token", "输出 Token", "提交次数", "新增代码行", "缺失行数的提交", "费用 USD"], d.trend.map((t) => [t.label, fmt(t.input_tokens), fmt(t.output_tokens), fmt(t.commits), fmt(t.additions), fmt(t.unknown_line_commits), money(t.cost)]));
  table("#model-table", ["模型", "请求数", "输入 Token", "输出 Token", "费用 USD"], d.models.map((m) => [m.label, fmt(m.requests), fmt(m.input_tokens), fmt(m.output_tokens), money(m.cost)]));
  const sources = { demo: "虚构数据", litellm: "LiteLLM 导入", gitee: "Gitee 公开 API" };
  $("#data-source").textContent = `数据来源：${d.sources.map((s) => sources[s] || s).join(" / ") || "暂无数据"} · UTC`;
  drawCharts();
}
function detailLink(p) {
  const a = node("a", p.name); a.href = "#dashboard";
  a.addEventListener("click", () => { $("#team").value = ""; options(); $("#project").value = p.id; refresh(); }); return a;
}
function context(id) {
  const canvas = $(id); if (!canvas || !canvas.clientWidth) return null;
  const ratio = window.devicePixelRatio || 1, width = canvas.clientWidth, height = 240;
  canvas.width = width * ratio; canvas.height = height * ratio;
  const c = canvas.getContext("2d"); c.scale(ratio, ratio); c.font = "11px sans-serif";
  return { c, width, height };
}
function barChart(id, values, color = "#4c85f4") {
  const ctx = context(id); if (!ctx) return;
  const { c, width } = ctx; const rows = values.filter((v) => v.value != null).sort((a, b) => b.value - a.value).slice(0, 6);
  if (!rows.length) { c.fillStyle = "#8c98ac"; c.fillText("当前范围暂无完整数据", 20, 100); return; }
  const max = Math.max(...rows.map((v) => v.value), 1), left = Math.min(135, width * .36), right = 65, unit = 34;
  rows.forEach((r, i) => {
    const y = 15 + i * unit; c.fillStyle = "#75829a"; c.textAlign = "right";
    const label = r.label.length > 11 ? `${r.label.slice(0, 10)}…` : r.label;
    c.fillText(label, left - 12, y + 13); c.fillStyle = "#f2f5fb"; c.fillRect(left, y, Math.max(1, width - left - right), 18);
    c.fillStyle = color; c.fillRect(left, y, Math.max(0, (width - left - right) * r.value / max), 18);
    c.fillStyle = "#52617a"; c.textAlign = "left"; c.fillText(compact(r.value), width - right + 8, y + 13);
  });
}
function lineChart() {
  const ctx = context("#trend"); if (!ctx) return;
  const { c, width, height } = ctx; const rows = state.data.trend, left = 55, right = 22, top = 20, bottom = 32;
  const max = Math.max(...rows.map((r) => Math.max(r.input_tokens, r.output_tokens)), 1) * 1.15;
  c.textAlign = "right";
  for (let i = 0; i <= 4; i++) { const y = top + (height - top - bottom) * i / 4; c.strokeStyle = "#edf1f7"; c.beginPath(); c.moveTo(left, y); c.lineTo(width - right, y); c.stroke(); c.fillStyle = "#97a3b6"; c.fillText(compact(max * (4 - i) / 4), left - 9, y + 4); }
  for (const [field, color] of [["input_tokens", "#4c85f4"], ["output_tokens", "#28bac4"]]) {
    c.beginPath(); c.strokeStyle = color; c.lineWidth = 2.5;
    rows.forEach((r, i) => { const x = left + (width - left - right) * i / Math.max(rows.length - 1, 1); const y = height - bottom - (height - top - bottom) * r[field] / max; if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); }); c.stroke();
    rows.forEach((r, i) => { const x = left + (width - left - right) * i / Math.max(rows.length - 1, 1); const y = height - bottom - (height - top - bottom) * r[field] / max; c.beginPath(); c.fillStyle = color; c.arc(x, y, 3, 0, Math.PI * 2); c.fill(); });
  }
  c.fillStyle = "#97a3b6"; c.textAlign = "center";
  const every = Math.max(1, Math.ceil(rows.length / 6));
  rows.forEach((r, i) => { if (i % every === 0) c.fillText(r.label.slice(5), left + (width - left - right) * i / Math.max(rows.length - 1, 1), height - 9); });
}
function drawCharts() {
  if (!state.data) return;
  const d = state.data; lineChart();
  barChart("#efficiency", d.projects.map((p) => ({ label: p.name, value: p.lines_per_million_tokens })), "#9070d5");
  barChart("#code-ranking", d.projects.map((p) => ({ label: p.name, value: p.additions })), "#37b69c");
  barChart("#token-ranking", d.projects.map((p) => ({ label: p.name, value: p.tokens })));
  barChart("#models", d.models.map((m) => ({ label: m.label, value: m.tokens })), "#8b74cf");
}
async function loadCommits() {
  const q = new URLSearchParams({ start: $("#start").value, end: $("#end").value });
  if ($("#team").value) q.set("team", $("#team").value);
  if ($("#project").value) q.set("project_id", $("#project").value);
  state.commits = await api(`/api/commits?${q}`);
  const visible = state.commits.filter((c) => !$("#team").value || state.projects.find((p) => p.id === c.project_id)?.team === $("#team").value);
  table("#commit-table", ["日期 UTC", "项目", "提交标识", "提交者", "新增行数", "来源"], visible.map((c) => [c.day, state.projects.find((p) => p.id === c.project_id)?.name || c.project_id, c.sha.slice(0, 10), c.author, c.additions == null ? "缺失" : fmt(c.additions), c.source === "demo" ? "虚构提交" : "公开 API"]));
}
function route() {
  const id = ["dashboard", "tokens", "commits", "projects", "import"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "dashboard";
  document.querySelectorAll(".view").forEach((v) => { v.hidden = v.id !== id; });
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.hash === `#${id}`));
  requestAnimationFrame(drawCharts);
  if (id === "commits" && state.data) loadCommits().catch((e) => notice(e.message, true));
}
function editProject(p = null) {
  const form = $("#project-form"); form.reset(); $("#dialog-error").textContent = "";
  $("#dialog-title").textContent = p ? "编辑项目" : "新增项目";
  form.elements.id.readOnly = !!p;
  if (p) Object.entries(p).forEach(([k, v]) => { if (form.elements[k]) form.elements[k].value = v; });
  $("#project-dialog").showModal();
}
$("#filters").addEventListener("submit", (e) => { e.preventDefault(); refresh(); });
$("#refresh").addEventListener("click", refresh);
$("#team").addEventListener("change", options);
$("#add-project").addEventListener("click", () => editProject());
for (const id of ["#cancel-dialog", "#close-dialog"]) $(id).addEventListener("click", () => $("#project-dialog").close());
$("#project-form").addEventListener("submit", async (e) => {
  e.preventDefault(); const button = e.submitter; button.disabled = true;
  const payload = Object.fromEntries(new FormData(e.target));
  ["budget", "planned_days", "actual_days"].forEach((k) => { payload[k] = Number(payload[k]); });
  try { await api("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); await loadProjects(); await refresh(); $("#project-dialog").close(); notice("项目已保存"); }
  catch (err) { $("#dialog-error").textContent = err.message; } finally { button.disabled = false; }
});
document.querySelectorAll(".upload-form").forEach((form) => form.addEventListener("submit", async (e) => {
  e.preventDefault(); const file = form.querySelector("input").files[0]; if (!file) return;
  if (file.size > 2097152) { notice("文件不得超过 2 MiB", true); return; }
  const body = new FormData(); body.append("file", file); const button = form.querySelector("button"); button.disabled = true;
  try { const result = await api(`/api/import/${form.dataset.kind}`, { method: "POST", body }); await loadProjects(); await refresh(); notice(`导入成功：${result.imported} 条${result.duplicates != null ? `，重复跳过 ${result.duplicates} 条` : ""}`); form.reset(); }
  catch (err) { notice(err.message, true); } finally { button.disabled = false; }
}));
$("#sync-form").addEventListener("submit", async (e) => {
  e.preventDefault(); const button = $("#sync-button"); button.disabled = true;
  try { const result = await api("/api/sync/gitee", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: $("#sync-project").value, start: $("#start").value, end: $("#end").value }) }); await refresh(); notice(`新增 ${result.imported} 次提交；${result.message}`); }
  catch (err) { notice(err.message, true); } finally { button.disabled = false; }
});
window.addEventListener("hashchange", route);
window.addEventListener("resize", drawCharts);
async function init() {
  try {
    state.meta = await api("/api/meta"); $("#start").value = state.meta.default_start; $("#end").value = state.meta.default_end;
    $("#sync-state").textContent = state.meta.gitee_enabled ? "已启用公开 API，需先在项目管理中登记 Gitee 公开仓库。" : "当前为离线演示模式。如需公开 API 采集，请设置 GITEE_ENABLED=true 并重启服务。";
    await loadProjects(); route(); await refresh();
  } catch (e) { notice(`加载失败：${e.message}`, true); }
}
init();
