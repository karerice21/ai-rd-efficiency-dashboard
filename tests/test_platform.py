import asyncio
import io
import json
import sqlite3
import zipfile
from datetime import date

import httpx
import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook

from app.config import Settings
from app.demo import PROJECTS
from app.gitee import fetch_commits
from app.ingest import FIELDS, ledger, template
from app.main import create_app


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(Settings(database_path=tmp_path / "test.sqlite3"))) as c:
        yield c


def usage(**overrides):
    return {"request_id": "test-request-1", "project_id": "P001", "startTime": "2026-10-15T08:00:00Z", "model": "fictional-model", "prompt_tokens": 100, "completion_tokens": 25, "total_tokens": 125, "spend": 0.01, **overrides}


def upload(client, kind, data, filename=None):
    name = filename or ("ledger.xlsx" if kind == "ledger" else "usage.json")
    return client.post(f"/api/import/{kind}", files={"file": (name, data)})


def dashboard(client, **params):
    return client.get("/api/dashboard", params={"start": "2026-10-01", "end": "2026-10-30", **params})


def test_offline_start_and_static(client):
    assert client.get("/api/health").json()["status"] == "ok"
    response = client.get("/")
    assert response.status_code == 200
    assert response.headers["content-security-policy"].startswith("default-src 'self'")
    assert client.get("/static/app.js").status_code == 200
    assert len(client.get("/api/projects").json()) == 6
    assert client.get("/api/meta").json()["gitee_enabled"] is False


def test_seed_idempotent(tmp_path):
    settings = Settings(database_path=tmp_path / "repeat.sqlite3")
    with TestClient(create_app(settings)) as c: first = dashboard(c).json()
    with TestClient(create_app(settings)) as c: second = dashboard(c).json()
    assert first == second


def test_metrics_match_database(client):
    result = dashboard(client).json()
    k = result["kpis"]
    with client.app.state.store.connect() as db:
        u = db.execute("SELECT SUM(input_tokens), SUM(output_tokens), COUNT(*), SUM(cost) FROM usage WHERE day BETWEEN '2026-10-01' AND '2026-10-30'").fetchone()
        c = db.execute("SELECT SUM(additions), COUNT(*) FROM commits WHERE day BETWEEN '2026-10-01' AND '2026-10-30'").fetchone()
    assert (k["input_tokens"], k["output_tokens"], k["requests"]) == tuple(u[:3])
    assert k["tokens"] == u[0] + u[1]
    assert k["cost"] == pytest.approx(u[3], abs=0.000001)
    assert (k["additions"], k["commits"]) == tuple(c)
    assert sum(t["tokens"] for t in result["trend"]) == k["tokens"]
    assert sum(t["tokens"] for t in result["models"]) == k["tokens"]


def test_filter_and_zero_filling(client):
    data = dashboard(client, team="星云研发一部").json()
    assert data["kpis"]["projects"] == 2
    assert all(p["team"] == "星云研发一部" for p in data["projects"])
    assert dashboard(client, project_id="P001").json()["kpis"]["projects"] == 1
    empty = dashboard(client, project_id="missing", grain="day").json()
    assert empty["kpis"]["tokens"] == 0
    assert len(empty["trend"]) == 30
    assert empty["kpis"]["lines_per_million_tokens"] is None


def test_commit_team_filter_before_limit(client):
    rows = client.get("/api/commits", params={"start":"2026-09-01", "end":"2026-10-30", "team":"星云研发一部"}).json()
    assert rows and all(r["project_id"] in {"P001", "P002"} for r in rows)
    assert len(rows) == dashboard(client, start="2026-09-01", team="星云研发一部").json()["kpis"]["commits"]


@pytest.mark.parametrize("params", [{"start": "2026-11-01"}, {"start": "2020-01-01"}, {"grain": "invalid"}, {"start": "invalid"}])
def test_invalid_filters(client, params):
    assert dashboard(client, **params).status_code == 422


def test_usage_import_dedup_and_discard_private_fields(client):
    before = dashboard(client).json()["kpis"]["tokens"]
    data = json.dumps([usage(api_key="unpersisted-value", messages=["unpersisted-prompt"], metadata={"email": "discard@example.com"})]).encode()
    assert upload(client, "litellm", data).json() == {"imported": 1, "duplicates": 0}
    assert upload(client, "litellm", data).json() == {"imported": 0, "duplicates": 1}
    assert dashboard(client).json()["kpis"]["tokens"] == before + 125
    with client.app.state.store.connect() as db:
        dump = "\n".join(db.iterdump())
    assert "unpersisted" not in dump
    assert "discard@example.com" not in dump


@pytest.mark.parametrize("overrides", [{"prompt_tokens": -1}, {"total_tokens": 99}, {"startTime": "2026-10-01T00:00:00"}, {"project_id": "unknown"}, {"spend": float("nan")}, {"model": "=FORMULA()"}, {"completion_tokens": True}, {"metadata": []}, {"project_id": []}])
def test_invalid_usage_atomic(client, overrides):
    body = json.dumps([usage(), usage(request_id="test-request-2", **overrides)]).encode()
    before = dashboard(client).json()["kpis"]
    assert upload(client, "litellm", body).status_code == 422
    assert dashboard(client).json()["kpis"] == before


def test_duplicate_batch_ids_and_timezone(client):
    assert upload(client, "litellm", json.dumps([usage(), usage()]).encode()).status_code == 422
    result = upload(client, "litellm", json.dumps([usage(startTime="2026-10-01T00:30:00+09:00")]).encode())
    assert result.status_code == 200
    with client.app.state.store.connect() as db:
        assert db.execute("SELECT day FROM usage WHERE id='test-request-1'").fetchone()[0] == "2026-09-30"


def test_ledger_template_and_update(client):
    response = client.get("/api/template/ledger.xlsx")
    assert len(ledger(response.content, 1000)) == 6
    result = upload(client, "ledger", response.content)
    assert result.json()["imported"] == 6
    rows = [dict(PROJECTS[0], budget=5000)]
    assert upload(client, "ledger", template(rows)).status_code == 200
    assert len(client.get("/api/projects").json()) == 6
    assert client.get("/api/projects").json()[0]["budget"] == 5000


def test_ledger_validation_and_conflict_rollback(client):
    bad = dict(PROJECTS[1], name="=HYPERLINK()")
    assert upload(client, "ledger", template([PROJECTS[0], bad])).status_code == 422
    conflict = dict(PROJECTS[1], repository=PROJECTS[2]["repository"])
    before = client.get("/api/projects").json()
    assert upload(client, "ledger", template([dict(PROJECTS[0], name="暂存测试"), conflict])).status_code == 409
    assert client.get("/api/projects").json() == before


@pytest.mark.parametrize("change", [{"budget": -1}, {"id": "../escape"}, {"repository": "https://localhost/owner/repo"}, {"repository": "https://demo@example.com/owner/repo"}, {"repository": "https://gitee.com:443/owner/repo"}, {"repository": "https://gitee.com/../repo"}, {"repository": "https://gitee.com/owner/repo?token=placeholder"}, {"status": "unknown"}])
def test_project_validation(client, change):
    assert client.post("/api/projects", json={**PROJECTS[0], **change}).status_code == 422


def test_corrupt_and_oversized_upload(client):
    assert upload(client, "ledger", b"not an xlsx").status_code == 422
    assert upload(client, "litellm", b"not json").status_code == 422
    assert upload(client, "litellm", b"[]", "usage.txt").status_code == 422
    assert upload(client, "litellm", b"x" * 2_200_000).status_code == 413
    wb = Workbook(); wb.active.title = "projects"; wb.active.append(["invalid"])
    out = io.BytesIO(); wb.save(out)
    assert upload(client, "ledger", out.getvalue()).status_code == 422


def test_ledger_row_limit_and_zip_bomb():
    with pytest.raises(ValueError, match="最多"):
        ledger(template([PROJECTS[0], PROJECTS[1]]), 1)
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z: z.writestr("large.xml", b"0" * 10_000_001)
    with pytest.raises(ValueError, match="解压"):
        ledger(out.getvalue(), 1000)


def test_security_origin_host_and_disabled_sync(client):
    assert client.post("/api/projects", json=PROJECTS[0], headers={"Origin": "https://untrusted.example"}).status_code == 403
    assert client.post("/api/projects", json=PROJECTS[0], headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert client.get("/api/health", headers={"Host": "untrusted.example"}).status_code == 400
    assert client.post("/api/sync/gitee", json={"project_id": "P001", "start": "2026-10-01", "end": "2026-10-30"}).status_code == 403


def test_gitee_pagination_minimization_and_dedup(client):
    calls = []
    def handler(request):
        calls.append(request)
        assert request.url.host == "gitee.com"
        assert request.headers["Authorization"] == "Bearer test-only-credential"
        if not request.url.path.endswith("/commits"):
            return httpx.Response(200, json={"private": False})
        page = request.url.params["page"]
        assert "access_token" not in str(request.url)
        item = {"sha": "a" * 40, "commit": {"author": {"date": "2026-10-15T08:00:00Z", "name": "discard-name", "email": "discard@example.com"}, "message": "discard-message"}}
        return httpx.Response(200, json=[item] * 100 if page == "1" else [item])
    rows = asyncio.run(fetch_commits("https://gitee.com/orbit-demo/test.git", "P001", date(2026,10,1), date(2026,10,30), "test-only-credential", httpx.MockTransport(handler)))
    assert len(calls) == 3
    assert all(r["additions"] is None and r["author"] == "公开 API 提交者" for r in rows)
    assert client.app.state.store.insert_commits(rows) == 1
    assert dashboard(client).json()["kpis"]["lines_per_million_tokens"] is None


def test_gitee_limits_and_errors():
    item = {"sha": "a" * 40, "commit": {"author": {"date": "2026-10-15T08:00:00Z"}}}
    with pytest.raises(ValueError, match="分页上限"):
        asyncio.run(fetch_commits("https://gitee.com/orbit-demo/test", "P001", date(2026,10,1), date(2026,10,30), transport=httpx.MockTransport(lambda r: httpx.Response(200, json=[item] * 100 if r.url.path.endswith('/commits') else {"private": False}))))
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(fetch_commits("https://gitee.com/orbit-demo/test", "P001", date(2026,10,1), date(2026,10,30), transport=httpx.MockTransport(lambda r: httpx.Response(429))))
    with pytest.raises(ValueError):
        asyncio.run(fetch_commits("https://untrusted.example/owner/repo", "P001", date(2026,10,1), date(2026,10,30)))


def test_gitee_rejects_private_repo():
    with pytest.raises(ValueError, match="公开"):
        asyncio.run(fetch_commits("https://gitee.com/orbit-demo/test", "P001", date(2026,10,1), date(2026,10,30), transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"private": True})) ))


def test_clean_start_without_demo(tmp_path):
    with TestClient(create_app(Settings(database_path=tmp_path / "clean.sqlite3", seed_demo=False))) as c:
        assert c.get("/api/projects").json() == []
        assert dashboard(c).json()["kpis"]["tokens"] == 0


def test_configuration_does_not_expose_credentials(tmp_path):
    with TestClient(create_app(Settings(database_path=tmp_path / "secret.sqlite3", gitee_token="test-only-credential"))) as c:
        assert "test-only-credential" not in c.get("/api/meta").text
        assert "test-only-credential" not in c.get("/openapi.json").text
