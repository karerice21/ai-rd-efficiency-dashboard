import re
from urllib.parse import urlsplit

import httpx

from .ingest import utc_day

API = "https://gitee.com/api/v5"


async def fetch_commits(repository, project_id, start, end, token="", transport=None):
    u = urlsplit(repository)
    if u.scheme != "https" or u.netloc != "gitee.com" or u.query or u.fragment:
        raise ValueError("请先登记 Gitee 公开仓库地址")
    path = u.path.removesuffix(".git")
    if not re.fullmatch(r"/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+", path):
        raise ValueError("仓库路径无效")
    headers = {"Accept": "application/json"}
    if token: headers["Authorization"] = f"Bearer {token}"
    rows = []
    async with httpx.AsyncClient(timeout=15, follow_redirects=False, headers=headers, transport=transport, trust_env=False) as client:
        info = await client.get(f"{API}/repos{path}")
        info.raise_for_status()
        if len(info.content) > 2_000_000:
            raise ValueError("Gitee 响应体积过大")
        info_data = info.json()
        if not isinstance(info_data, dict) or info_data.get("private") is not False:
            raise ValueError("仅允许采集明确标记为公开的仓库")
        for page in range(1, 11):
            response = await client.get(f"{API}/repos{path}/commits", params={
                "page": page, "per_page": 100, "since": f"{start}T00:00:00Z", "until": f"{end}T23:59:59Z"})
            response.raise_for_status()
            if len(response.content) > 2_000_000:
                raise ValueError("Gitee 响应体积过大")
            data = response.json()
            if not isinstance(data, list) or len(data) > 100: raise ValueError("Gitee 响应格式无效")
            for item in data:
                sha = item["sha"]
                if not re.fullmatch(r"[a-fA-F0-9]{7,64}", sha): raise ValueError("提交标识无效")
                day = utc_day(item["commit"]["author"]["date"])
                if str(start) <= day <= str(end):
                    rows.append({"project_id": project_id, "sha": sha, "day": day,
                                 "author": "公开 API 提交者", "additions": None, "source": "gitee"})
            if len(data) < 100: return rows
    # Refuse incomplete snapshots; the caller persists only a complete batch.
    raise ValueError("超过 1000 条分页上限，请缩短日期范围后重试")
