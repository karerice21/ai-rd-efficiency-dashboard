import sqlite3
import base64
import hashlib
import re
from contextlib import asynccontextmanager
from datetime import date
from xml.etree.ElementTree import ParseError

import httpx
from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import analytics, demo, gitee, ingest
from .config import ROOT, Settings
from .store import Store
from .frontend_api import router as frontend_router


class Project(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str
    name: str
    team: str
    owner: str
    repository: str
    budget: float
    planned_days: float
    actual_days: float
    status: str


class Sync(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: str
    start: date
    end: date


def create_app(settings=None):
    settings = settings or Settings.from_env()
    @asynccontextmanager
    async def lifespan(app):
        app.state.store = Store(settings.database_path)
        if settings.seed_demo: demo.seed(app.state.store)
        yield
    app = FastAPI(title="AI R&D Efficiency Dashboard", version="1.0.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None)
    app.state.settings = settings
    login_script = re.search(r"<script>(.*?)</script>", (ROOT / "static/login.html").read_text(), re.S).group(1)
    login_hash = base64.b64encode(hashlib.sha256(login_script.encode()).digest()).decode()
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "testserver"])

    @app.middleware("http")
    async def security(request: Request, call_next):
        # Loopback-only demo. Cross-site writes are blocked; there is no public auth layer.
        origin = request.headers.get("origin")
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            if request.headers.get("sec-fetch-site") == "cross-site" or (origin and origin != str(request.base_url).rstrip("/")):
                return JSONResponse({"detail": "不允许跨来源写入"}, status_code=403)
        length = request.headers.get("content-length", "0")
        if not length.isdigit() or int(length) > settings.max_upload_bytes + 65536:
            return JSONResponse({"detail": "请求体积超限"}, status_code=413)
        received = 0
        receive = request._receive
        async def limited_receive():
            nonlocal received
            message = await receive()
            received += len(message.get("body", b""))
            if received > settings.max_upload_bytes + 65536:
                raise HTTPException(413, "请求体积超限")
            return message
        request._receive = limited_receive
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        response.headers["Content-Security-Policy"] = f"default-src 'self'; script-src 'self' 'sha256-{login_hash}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        return response

    @app.exception_handler(ValueError)
    async def invalid(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=422)

    @app.exception_handler(sqlite3.IntegrityError)
    async def conflict(request, exc):
        return JSONResponse({"detail": "项目 id 或仓库冲突，整个批次已回滚"}, status_code=409)

    @app.get("/", include_in_schema=False)
    def index(): return FileResponse(ROOT / "static/index.html")

    @app.get("/workspace", include_in_schema=False)
    def workspace(): return FileResponse(ROOT / "static/workspace/index.html")

    @app.get("/login", include_in_schema=False)
    def login(): return FileResponse(ROOT / "static/login.html")

    def asset_endpoint(name):
        def serve(): return FileResponse(ROOT / "static" / name)
        return serve
    for name in ["app.js", "styles.css", "favicon.svg", "login.css"]:
        app.add_api_route("/"+name, asset_endpoint(name), include_in_schema=False)

    @app.get("/api/health")
    def health(): return {"status": "ok", "version": "1.0.0"}

    @app.get("/api/meta")
    def meta():
        with app.state.store.connect() as db:
            period = db.execute("SELECT MIN(day), MAX(day) FROM (SELECT day FROM usage UNION ALL SELECT day FROM commits)").fetchone()
        return {"company": "星屿科技（虚构）", "gitee_enabled": settings.gitee_enabled,
                "default_start": period[1][:7] + "-01" if period[1] else "2026-10-01",
                "default_end": period[1] or "2026-10-30", "timezone": "UTC",
                "demo_notice": "个人作品演示 · 内置数据全部虚构"}

    @app.get("/api/projects")
    def projects(): return app.state.store.projects()

    @app.post("/api/projects")
    def save_project(payload: Project):
        row = ingest.project(payload.model_dump())
        app.state.store.upsert_projects([row])
        return row

    @app.get("/api/dashboard")
    def dashboard(start: date = date(2026, 10, 1), end: date = date(2026, 10, 30),
                  team: str | None = None, project_id: str | None = None,
                  grain: str = Query("week", pattern="^(day|week|month)$")):
        return analytics.dashboard(app.state.store, start, end, team, project_id, grain)

    @app.get("/api/commits")
    def commits(start: date, end: date, project_id: str | None = None, team: str | None = None):
        if start > end or (end - start).days > 366: raise ValueError("日期范围无效")
        with app.state.store.connect() as db:
            rows = db.execute("""SELECT c.* FROM commits c JOIN projects p ON p.id=c.project_id
                WHERE c.day BETWEEN ? AND ? AND (? IS NULL OR c.project_id=?)
                AND (? IS NULL OR p.team=?) ORDER BY c.day DESC,c.sha LIMIT 500""",
                (str(start), str(end), project_id, project_id, team, team))
            return [dict(r) for r in rows]

    async def read_upload(file, suffix):
        try:
            if not (file.filename or "").lower().endswith(suffix):
                raise ValueError(f"仅接受 {suffix} 文件")
            content = await file.read(settings.max_upload_bytes + 1)
            if len(content) > settings.max_upload_bytes: raise HTTPException(413, "文件过大")
            return content
        finally:
            await file.close()

    @app.post("/api/import/ledger")
    async def import_ledger(file: UploadFile = File(...)):
        content = await read_upload(file, ".xlsx")
        try:
            rows = ingest.ledger(content, settings.max_rows)
        except (ParseError, EOFError):
            raise ValueError("工作簿损坏") from None
        app.state.store.upsert_projects(rows)
        return {"imported": len(rows), "message": "台账已导入，按 id 更新，未列出的项目保留"}

    @app.post("/api/import/litellm")
    async def import_litellm(file: UploadFile = File(...)):
        rows = ingest.litellm(await read_upload(file, ".json"), {p["id"] for p in app.state.store.projects()}, settings.max_rows)
        inserted = app.state.store.insert_usage(rows)
        return {"imported": inserted, "duplicates": len(rows) - inserted}

    @app.get("/api/template/ledger.xlsx")
    def ledger_template():
        return Response(ingest.template(demo.PROJECTS), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={"Content-Disposition": 'attachment; filename="fictional-project-ledger.xlsx"'})

    @app.get("/api/template/litellm.json")
    def usage_template():
        return [{"request_id": "sample-request-001", "project_id": "P001", "startTime": "2026-10-15T08:00:00Z", "model": "demo-coder", "prompt_tokens": 12000, "completion_tokens": 3000, "total_tokens": 15000, "spend": 0.0168}]

    @app.post("/api/sync/gitee")
    async def sync(payload: Sync):
        if not settings.gitee_enabled: raise HTTPException(403, "公开 API 采集未启用，演示提交已内置")
        if payload.start > payload.end or (payload.end - payload.start).days > 90:
            raise ValueError("Gitee 采集日期范围为 1–91 天")
        p = next((p for p in app.state.store.projects() if p["id"] == payload.project_id), None)
        if not p: raise HTTPException(404, "项目不存在")
        with app.state.store.connect() as db:
            monitoring = db.execute("SELECT state FROM monitoring WHERE project_id=?", (p["id"],)).fetchone()
        if monitoring and monitoring[0] != "ACTIVE": raise HTTPException(403, "项目已停止监控，请先恢复")
        try:
            rows = await gitee.fetch_commits(p["repository"], p["id"], payload.start, payload.end, settings.gitee_token)
        except httpx.HTTPStatusError as exc:
            raise HTTPException(502, f"公开 API 返回状态 {exc.response.status_code}，请检查仓库可见性或限流") from None
        except (httpx.HTTPError, KeyError, TypeError):
            raise HTTPException(502, "公开 API 请求失败或响应格式无效") from None
        inserted = app.state.store.insert_commits(rows)
        return {"imported": inserted, "duplicates": len(rows) - inserted, "message": "已采集提交次数；API 未提供新增行数，未采集作者身份"}

    app.include_router(frontend_router(app))
    app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
    return app


app = create_app()
