"""Independent adapter for the retained frontend's HTTP contract.

Only the frontend was retained at the user's explicit request. This module
implements its data contract against this project's independent storage.
"""
import csv
import hashlib
import io
from collections import defaultdict
from datetime import date, timedelta
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from . import analytics, ingest
from .reports import export_report


class ManagedProject(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=100)
    team: str = Field(min_length=1, max_length=100)
    project_locations: list[str] = Field(min_length=1, max_length=20)


def ui_map(store):
    with store.connect() as db:
        db.executemany("INSERT OR IGNORE INTO ui_ids(project_id) VALUES (?)", [(p["id"],) for p in store.projects(include_deleted=True)])
        return {r["project_id"]: r["ui_id"] for r in db.execute("SELECT * FROM ui_ids")}


def get_project(store, ui_id):
    ids = ui_map(store)
    p = next((p for p in store.projects() if ids[p["id"]] == ui_id), None)
    if not p: raise HTTPException(404, "项目不存在")
    return p


def managed(store, p):
    ids = ui_map(store)
    with store.connect() as db:
        links = [r[0] for r in db.execute("SELECT repository FROM repository_links WHERE project_id=? ORDER BY repository", (p["id"],))]
        state = db.execute("SELECT state FROM monitoring WHERE project_id=?", (p["id"],)).fetchone()
        has_code = bool(db.execute("SELECT 1 FROM commits WHERE project_id=? LIMIT 1", (p["id"],)).fetchone())
    links = sorted(set([p["repository"], *links]))
    return {"id": ids[p["id"]], "name": p["name"], "team": p["team"],
            "monitoring_status": state[0] if state else "ACTIVE", "repository_count": len(links),
            "code_match_status": "MATCHED" if has_code else "NOT_ANALYZED",
            "repositories": [{"original_path": r, "normalized_path": urlsplit(r).path.strip('/').removesuffix('.git'), "code_match_method": "EXACT" if has_code else "NONE"} for r in links],
            "litellm_key_aliases": [{"key_alias": f"demo-{p['id']}"}], "monitor_start_date_missing": False}


def summary(row):
    return {"monitor_project_count": row.get("projects", 1), "added_lines": row["additions"],
            "prompt_tokens": row["input_tokens"], "completion_tokens": row["output_tokens"],
            "total_tokens": row["tokens"], "request_count": row["requests"], "commit_count": row["commits"],
            "tokens_per_added_line": row["tokens"] / row["additions"] if row["additions"] and not row["unknown_line_commits"] else None}


def bucket(d, grain):
    if grain == "week": return d - timedelta(days=d.weekday())
    if grain == "biweek": return date(2020, 1, 6) + timedelta(days=((d - date(2020, 1, 6)).days // 14) * 14)
    if grain == "month": return d.replace(day=1)
    return date(d.year, ((d.month - 1) // 3) * 3 + 1, 1)


def period_end(d, grain):
    if grain in {"week", "biweek"}: return d + timedelta(days=6 if grain == "week" else 13)
    months = 1 if grain == "month" else 3
    month = d.month - 1 + months
    return date(d.year + month // 12, month % 12 + 1, 1) - timedelta(days=1)


def build_overview(store, start=None, end=None, teams=(), project_ids=(), granularity="week"):
    if granularity not in {"week", "biweek", "month", "quarter"}: raise ValueError("统计粒度无效")
    ids = ui_map(store)
    with store.connect() as db:
        first = db.execute("SELECT MIN(day) FROM (SELECT day FROM usage UNION ALL SELECT day FROM commits)").fetchone()[0]
    end = end or date(2026, 10, 30)
    start = start or date.fromisoformat(first or "2026-10-01")
    data = analytics.dashboard(store, start, end, grain="day")
    selected = [p for p in data["projects"] if (not teams or p["team"] in teams) and (not project_ids or ids[p["id"]] in project_ids)]
    wanted = {p["id"] for p in selected}
    # Reaggregate selected projects directly; multi-select semantics are intersections.
    daily = defaultdict(lambda: {"input_tokens":0,"output_tokens":0,"tokens":0,"requests":0,"commits":0,"additions":0,"unknown_line_commits":0,"cost":0})
    d = start
    while d <= end: daily[d.isoformat()]; d += timedelta(days=1)
    with store.connect() as db:
        for r in db.execute("SELECT * FROM usage WHERE day BETWEEN ? AND ?",(str(start),str(end))):
            if r["project_id"] not in wanted: continue
            row=daily[r["day"]]
            row["input_tokens"]+=r["input_tokens"]; row["output_tokens"]+=r["output_tokens"]
            row["tokens"]+=r["input_tokens"]+r["output_tokens"]; row["requests"]+=1; row["cost"]+=r["cost"]
        for r in db.execute("SELECT * FROM commits WHERE day BETWEEN ? AND ?",(str(start),str(end))):
            if r["project_id"] not in wanted: continue
            row=daily[r["day"]]; row["commits"]+=1; row["additions"]+=r["additions"] or 0
            row["unknown_line_commits"]+=int(r["additions"] is None)
    totals={k:sum(r[k] for r in daily.values()) for k in next(iter(daily.values()))}
    totals["projects"]=len(selected)
    periods={}
    for day,r in daily.items():
        b=bucket(date.fromisoformat(day),granularity)
        target=periods.setdefault(b,{k:0 for k in r})
        for k,v in r.items(): target[k]+=v
    trend=[{**summary(r),"stat_date":str(b),"period_start":str(b),"period_end":str(period_end(b,granularity)),"code_data_available":not r["unknown_line_commits"]} for b,r in sorted(periods.items())]
    team_rows=[]
    for team in sorted({p["team"] for p in selected}):
        rows=[p for p in selected if p["team"]==team]
        added=sum(p["additions"] for p in rows); tokens=sum(p["tokens"] for p in rows)
        cs=added/totals["additions"] if totals["additions"] else None
        ts=tokens/totals["tokens"] if totals["tokens"] else None
        team_rows.append({"team":team,"project_count":len(rows),"added_lines":added,"total_tokens":tokens,
                          "code_share":cs,"token_share":ts,"output_input_multiplier":cs/ts if cs is not None and ts else None})
    def ranking(key):
        return [{"project_id":ids[p["id"]],"project_name":p["name"],"value":p[key]} for p in sorted(selected,key=lambda p:p[key],reverse=True)]
    efficiencies=[{"project_id":ids[p["id"]],"project_name":p["name"],"added_lines":p["additions"],"code_lines_per_million_tokens":p["lines_per_million_tokens"],"sample_status":"NORMAL"} for p in selected if p["lines_per_million_tokens"] is not None]
    efficiencies.sort(key=lambda p:p["code_lines_per_million_tokens"],reverse=True)
    # Last displayed period vs the preceding equal calendar bucket, restricted to selection.
    current_start=max(start,bucket(end,granularity)); previous_end=bucket(end,granularity)-timedelta(days=1)
    previous_start=bucket(previous_end,granularity)
    cur={k:sum(r[k] for day,r in daily.items() if day>=str(current_start)) for k in next(iter(daily.values()))}
    prev={k:sum(r[k] for day,r in daily.items() if str(previous_start)<=day<=str(previous_end)) for k in next(iter(daily.values()))}
    current_summary=summary({**cur,"projects":len(selected)}); previous_summary=summary({**prev,"projects":len(selected)})
    changes={k:(current_summary[k]-v)/v if isinstance(v,(int,float)) and v and current_summary[k] is not None else None for k,v in previous_summary.items()}
    source={"mode":"mock","label":"虚构演示 · 本地数据","status":"DEMO","synced_at":None}
    return {"summary":summary(totals),"data_source":source,"comparison":{"period":granularity,"current":{"summary":current_summary},"previous":{"summary":previous_summary},"changes":changes},
            "period_token_trend":trend,"period_efficiency_trend":trend if not totals["unknown_line_commits"] else [],"code_analysis_trend":trend,"code_analysis_period":granularity,
            "project_code_ranking":ranking("additions"),"project_token_ranking":ranking("tokens"),"project_efficiency_ranking":efficiencies,
            "pie_dimension":"TEAM","code_pie":[{"name":t["team"],"value":t["added_lines"]} for t in team_rows],
            "token_pie":[{"name":t["team"],"value":t["total_tokens"]} for t in team_rows],"team_totals":team_rows,"team_efficiency_comparison":team_rows,
            "insights":[{"section":"总体趋势","tone":"info","message":f"虚构演示：{len(selected)} 个项目，{totals['commits']} 次提交，{totals['requests']} 次模型请求。"},
                        {"section":"总体趋势","tone":"warning","message":f"{totals['unknown_line_commits']} 次提交缺少新增行数；统计不代表 AI 的因果提升。"},
                        {"section":"项目表现","tone":"info","message":"数据来自本地台账、用量与提交。Token/行与每百万 Token 产出行数仅用于资源观察。"}],
            "range":{"start":str(start),"end":str(end)},"daily":[{"stat_date":day,**summary(r)} for day,r in sorted(daily.items())]}


def router(app):
    routes=APIRouter()
    def store(): return app.state.store

    @routes.get("/api/dashboard/projects")
    def projects():
        ids=ui_map(store())
        return [{"id":ids[p["id"]],"name":p["name"],"team":p["team"]} for p in store().projects()]

    @routes.get("/api/dashboard/overview")
    def overview(start:date|None=None,end:date|None=None,teams:list[str]=Query([]),project_ids:list[int]=Query([]),granularity:str="week"):
        return build_overview(store(),start,end,teams,project_ids,granularity)

    @routes.get("/api/dashboard/report")
    def report(start:date|None=None,end:date|None=None,teams:list[str]=Query([]),project_ids:list[int]=Query([]),granularity:str="week",format:str="pdf"):
        data=build_overview(store(),start,end,teams,project_ids,granularity)
        content=export_report(data,format)
        mime="application/pdf" if format=="pdf" else "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        return Response(content,media_type=mime,headers={"Content-Disposition":f"attachment; filename*=UTF-8''fictional-rd-report.{format}"})

    @routes.get("/api/dashboard/projects/{ui_id}")
    def detail(ui_id:int):
        p=get_project(store(),ui_id)
        result=build_overview(store(),project_ids=[ui_id])
        return {"project":managed(store(),p),"summary":result["summary"],"data_source":result["data_source"],"code_trend":result["daily"],"token_trend":result["daily"]}

    @routes.get("/api/project-management/projects")
    def managed_projects(): return [managed(store(),p) for p in store().projects()]

    def save(payload,ui_id=None):
        repos=[ingest.repository(r) for r in payload.project_locations]
        if len(set(repos))!=len(repos): raise ValueError("项目位置重复")
        existing=get_project(store(),ui_id) if ui_id else None
        pid=existing["id"] if existing else "DEMO-"+uuid4().hex[:12]
        row=existing or {"id":pid,"owner":"虚构成员","budget":0.0,"planned_days":0.0,"actual_days":0.0,"status":"进行中"}
        row={**row,"name":ingest.text(payload.name,"name"),"team":ingest.text(payload.team,"team"),"repository":repos[0]}
        with store().connect() as db:
            for r in repos:
                conflict=db.execute("SELECT id FROM projects WHERE repository=? AND id!=?",(r,pid)).fetchone()
                link=db.execute("SELECT project_id FROM repository_links WHERE repository=? AND project_id!=?",(r,pid)).fetchone()
                if conflict or link: raise ValueError("仓库已登记在其他项目")
            db.execute("""INSERT INTO projects VALUES (:id,:name,:team,:owner,:repository,:budget,:planned_days,:actual_days,:status)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name,team=excluded.team,repository=excluded.repository""",row)
            db.execute("DELETE FROM repository_links WHERE project_id=?",(pid,))
            db.executemany("INSERT INTO repository_links VALUES (?,?)",[(pid,r) for r in repos[1:]])
        return managed(store(),row)

    @routes.post("/api/project-management/projects")
    def create(payload:ManagedProject): return save(payload)

    @routes.put("/api/project-management/projects/{ui_id}")
    def update(ui_id:int,payload:ManagedProject): return save(payload,ui_id)

    @routes.post("/api/project-management/projects/{ui_id}/{action}")
    def action(ui_id:int,action:str):
        p=get_project(store(),ui_id)
        if action not in {"stop","resume","rematch"}: raise HTTPException(404,"操作不存在")
        if action!="rematch":
            with store().connect() as db:
                db.execute("INSERT INTO monitoring VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET state=excluded.state",(p["id"],"STOPPED" if action=="stop" else "ACTIVE"))
        return managed(store(),p)

    @routes.delete("/api/project-management/projects/{ui_id}")
    def remove(ui_id:int):
        p=get_project(store(),ui_id)
        with store().connect() as db:
            db.execute("INSERT INTO monitoring VALUES (?,'DELETED') ON CONFLICT(project_id) DO UPDATE SET state='DELETED'",(p["id"],))
        return {"deleted":True,"historical_data_retained":True}

    @routes.post("/api/litellm/sync")
    def refresh_demo(): return {"upserted_row_count":0,"mode":"demo","message":"本地快照已重新读取，无外部调用；新日志从 /workspace 导入"}

    @routes.get("/api/coding-plan/quotas")
    @routes.post("/api/coding-plan/refresh")
    def quotas():
        return {"collection_status":"虚构额度快照（不访问外部服务）","last_finished_at":"2026-10-30T08:00:00Z",
                "summary":{"provider_account_count":3,"configured_account_count":3,"healthy_account_count":3,"failed_account_count":0},
                "snapshots":[{"name":name+"（虚构演示）","provider_type":provider,"configured":True,"success":True,"console_url":"https://example.com/demo-console",
                    "credential_message":"虚构套餐，不配置真实账号","last_success_at":"2026-10-30T08:00:00Z","tiers":[{"window":"monthly","used":used,"limit":1000,"used_percent":used/10,"reset_at":None}]} for name,provider,used in [("演示平台一","kimi",260),("演示平台二","minimax",480),("演示平台三","zhipu",710)]]}

    @routes.get("/api/model-speed/targets")
    def speed_config(): return {"enabled":False,"targets":[],"limits":{"max_targets":0},"demo_notice":"本作品不执行付费模型测速"}

    @routes.get("/api/model-speed/tests")
    def speed_history(): return {"items":[]}

    @routes.post("/api/auth/logout")
    def logout(): return {"demo":True}

    @routes.post("/api/auth/login")
    async def login(request:Request):
        # Visual demonstration only. No credentials are stored or authenticated.
        data=await request.json()
        if not isinstance(data,dict) or not data.get("username") or not data.get("password"):
            raise ValueError("本地演示入口需填写非空占位值；不要输入真实账号密码")
        return {"demo":True,"authenticated":False}

    @routes.post("/api/code-stat/import")
    async def code_import(file:UploadFile=File(...)):
        try:
            content=await file.read(app.state.settings.max_upload_bytes+1)
            if len(content)>app.state.settings.max_upload_bytes: raise HTTPException(413,"文件过大")
            if (file.filename or "").lower().endswith(".xlsx"):
                # A project ledger can be imported through the retained upload action.
                rows=ingest.ledger(content,app.state.settings.max_rows)
                store().upsert_projects(rows)
                return {"status":"IMPORTED","inserted_daily_count":0,"updated_daily_count":len(rows),"unchanged_daily_count":0,"matched_source_repository_count":len(rows),"ignored_out_of_scope_repository_count":0}
            if not (file.filename or "").lower().endswith(".csv"): raise ValueError("仅接受虚构提交 CSV 或项目台账 XLSX")
            reader=csv.DictReader(io.StringIO(content.decode("utf-8-sig")))
            if reader.fieldnames!=["project_id","sha","day","additions","author"]: raise ValueError("CSV 表头需为 project_id,sha,day,additions,author；模板见 /workspace 说明")
            ids={p["id"] for p in store().projects()}; rows=[]
            for item in reader:
                if len(rows)>=app.state.settings.max_rows: raise ValueError("最多 1000 条提交")
                if item["project_id"] not in ids: raise ValueError("项目未登记")
                try: added=int(item["additions"])
                except (ValueError,TypeError): raise ValueError("additions 需为非负整数") from None
                rows.append({"project_id":item["project_id"],"sha":ingest.text(item["sha"],"sha",120),"day":ingest.utc_day(item["day"]),
                    "additions":ingest.number(added,"additions",True),"author":ingest.text(item["author"],"author"),"source":"import"})
            if not rows: raise ValueError("CSV 没有数据")
            inserted=store().insert_commits(rows)
            return {"status":"IMPORTED" if inserted else "DUPLICATE_FILE","inserted_daily_count":inserted,"updated_daily_count":0,"unchanged_daily_count":len(rows)-inserted,"matched_source_repository_count":len({r['project_id'] for r in rows}),"ignored_out_of_scope_repository_count":0}
        except UnicodeDecodeError: raise ValueError("CSV 需使用 UTF-8 编码") from None
        finally: await file.close()

    return routes
