"""Deterministic synthetic fixtures. No external files or services are read."""
from datetime import date, timedelta
from hashlib import sha256
from random import Random

PROJECTS = [
    {"id": "P001", "name": "星轨知识助手", "team": "星云研发一部", "owner": "虚构成员甲", "repository": "https://example.com/orbit-demo/knowledge.git", "budget": 1800, "planned_days": 40, "actual_days": 34, "status": "进行中"},
    {"id": "P002", "name": "月湾协作空间", "team": "星云研发一部", "owner": "虚构成员乙", "repository": "https://example.com/orbit-demo/workspace.git", "budget": 2400, "planned_days": 55, "actual_days": 51, "status": "进行中"},
    {"id": "P003", "name": "极光文档工坊", "team": "远航平台二部", "owner": "虚构成员丙", "repository": "https://example.com/orbit-demo/docs.git", "budget": 1200, "planned_days": 30, "actual_days": 25, "status": "已完成"},
    {"id": "P004", "name": "云帆测试工具", "team": "远航平台二部", "owner": "虚构成员丁", "repository": "https://example.com/orbit-demo/testing.git", "budget": 1600, "planned_days": 38, "actual_days": 42, "status": "进行中"},
    {"id": "P005", "name": "晨星数据沙盒", "team": "晨光体验三部", "owner": "虚构成员戊", "repository": "https://example.com/orbit-demo/sandbox.git", "budget": 2100, "planned_days": 50, "actual_days": 44, "status": "进行中"},
    {"id": "P006", "name": "微光界面实验室", "team": "晨光体验三部", "owner": "虚构成员己", "repository": "https://example.com/orbit-demo/interface.git", "budget": 900, "planned_days": 24, "actual_days": 21, "status": "已完成"},
]


def seed(store):
    with store.connect() as db:
        if db.execute("SELECT 1 FROM meta WHERE key='demo_seeded'").fetchone():
            return
        # All inserts and the marker share one transaction, safe across startup retries.
        if db.execute("SELECT 1 FROM projects LIMIT 1").fetchone():
            return
        rng = Random(8421)
        for p in PROJECTS:
            db.execute("INSERT INTO projects VALUES (:id,:name,:team,:owner,:repository,"
                       ":budget,:planned_days,:actual_days,:status)", p)
            for offset in range(60):
                day = (date(2026, 9, 1) + timedelta(days=offset)).isoformat()
                for k in range(rng.randint(2, 5)):
                    input_tokens = rng.randint(12000, 68000)
                    output_tokens = rng.randint(3000, 16000)
                    db.execute("INSERT INTO usage VALUES (?,?,?,?,?,?,?,?)", (
                        f"demo-{p['id']}-{offset}-{k}", p["id"], day,
                        ["demo-coder", "demo-reasoner", "demo-assistant"][k % 3],
                        input_tokens, output_tokens,
                        round((input_tokens * 0.8 + output_tokens * 2.4) / 1_000_000, 6), "demo"))
                for k in range(rng.randint(1, 4)):
                    sha = sha256(f"fictional-{p['id']}-{offset}-{k}".encode()).hexdigest()[:40]
                    db.execute("INSERT INTO commits VALUES (?,?,?,?,?,?)", (
                        p["id"], sha, day, p["owner"], rng.randint(20, 360), "demo"))
        db.execute("INSERT INTO meta VALUES ('demo_seeded','true')")
