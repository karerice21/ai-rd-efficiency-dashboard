from collections import defaultdict
from datetime import date, timedelta


def dashboard(store, start, end, team=None, project_id=None, grain="week"):
    if start > end or (end - start).days > 366:
        raise ValueError("开始日期不得晚于结束日期，范围最多 367 天")
    if grain not in {"day", "week", "month"}:
        raise ValueError("统计粒度无效")
    projects = [p for p in store.projects() if (not team or p["team"] == team)
                and (not project_id or p["id"] == project_id)]
    ids = {p["id"] for p in projects}
    with store.connect() as db:
        usages = [dict(r) for r in db.execute("SELECT * FROM usage WHERE day BETWEEN ? AND ?", (start.isoformat(), end.isoformat())) if r["project_id"] in ids]
        commits = [dict(r) for r in db.execute("SELECT * FROM commits WHERE day BETWEEN ? AND ?", (start.isoformat(), end.isoformat())) if r["project_id"] in ids]
    def bucket(day):
        d = date.fromisoformat(day)
        if grain == "week": d -= timedelta(days=d.weekday())
        if grain == "month": d = d.replace(day=1)
        return d.isoformat()
    def empty(label):
        return {"label": label, "input_tokens": 0, "output_tokens": 0, "tokens": 0, "cost": 0, "requests": 0, "commits": 0, "additions": 0, "unknown_line_commits": 0}
    timeline, by_project, models = {}, {}, {}
    d = start
    while d <= end:
        label = bucket(d.isoformat())
        timeline[label] = empty(label)
        d += timedelta(days=1)
    for p in projects:
        by_project[p["id"]] = {**p, **empty(p["name"])}
    for u in usages:
        model = models.setdefault(u["model"], empty(u["model"]))
        for target in [timeline[bucket(u["day"])], by_project[u["project_id"]], model]:
            target["input_tokens"] += u["input_tokens"]
            target["output_tokens"] += u["output_tokens"]
            target["tokens"] += u["input_tokens"] + u["output_tokens"]
            target["cost"] += u["cost"]
            target["requests"] += 1
    for c in commits:
        for target in [timeline[bucket(c["day"])], by_project[c["project_id"]]]:
            target["commits"] += 1
            target["additions"] += c["additions"] or 0
            target["unknown_line_commits"] += int(c["additions"] is None)
    total = empty("total")
    teams = {}
    for p in by_project.values():
        group = teams.setdefault(p["team"], empty(p["team"]))
        for key in total.keys() - {"label"}:
            total[key] += p[key]
            group[key] += p[key]
        p["lines_per_million_tokens"] = round(p["additions"] * 1e6 / p["tokens"], 2) if p["tokens"] and p["commits"] and not p["unknown_line_commits"] else None
        p["schedule_variance_days"] = p["actual_days"] - p["planned_days"]
        p["budget_utilization_pct"] = round(p["cost"] * 100 / p["budget"], 2) if p["budget"] else None
    total.update(projects=len(projects), teams=len(teams), cost=round(total["cost"], 6))
    total["lines_per_million_tokens"] = round(total["additions"] * 1e6 / total["tokens"], 2) if total["tokens"] and total["commits"] and not total["unknown_line_commits"] else None
    return {
        "range": {"start": start.isoformat(), "end": end.isoformat(), "grain": grain},
        "kpis": total, "trend": list(timeline.values()),
        "projects": list(by_project.values()), "teams": list(teams.values()),
        "models": list(models.values()), "sources": sorted({r["source"] for r in usages + commits}),
        "insights": [
            f"当前范围覆盖 {len(projects)} 个项目，共 {total['commits']} 次提交、{total['requests']} 次模型请求。",
            f"有 {total['unknown_line_commits']} 次提交未提供新增行数；存在缺失时不计算综合投入产出比。",
            "统计关系不能证明 AI 带来因果提升；代码行数与 Token 比值不作为人员绩效评价。",
        ],
    }
