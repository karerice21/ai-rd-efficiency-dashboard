import io
import json
import math
import re
import zipfile
from datetime import date, datetime, timezone
from urllib.parse import urlsplit

from openpyxl import Workbook, load_workbook

FIELDS = ["id", "name", "team", "owner", "repository", "budget", "planned_days", "actual_days", "status"]
STATUSES = {"进行中", "已完成", "已暂停"}


def text(value, label, limit=100):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
        raise ValueError(f"{label} 必须是 1–{limit} 字符的文本")
    value = value.strip()
    if value[0] in "=+-@" or any(ord(c) < 32 for c in value):
        raise ValueError(f"{label} 含不允许的控制字符或公式前缀")
    return value


def number(value, label, integer=False):
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        raise ValueError(f"{label} 必须是非负数")
    if not math.isfinite(value) or value < 0 or value > 1e12 or (integer and value != int(value)):
        raise ValueError(f"{label} 超出范围或格式不正确")
    return int(value) if integer else float(value)


def repository(value):
    value = text(value, "repository", 250)
    u = urlsplit(value)
    if (u.scheme != "https" or u.hostname not in {"example.com", "gitee.com"}
            or u.netloc != u.hostname or u.query or u.fragment
            or not re.fullmatch(r"/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+(?:\.git)?", u.path)
            or any(part in {".", ".."} for part in u.path.split("/"))):
        raise ValueError("仓库需为 https://example.com 或 https://gitee.com 下的 owner/repo 地址")
    return value


def project(row):
    if set(row) != set(FIELDS):
        raise ValueError("项目字段必须与台账模板一致")
    result = {k: text(row[k], k) for k in ["id", "name", "team", "owner", "status"]}
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", result["id"]):
        raise ValueError("id 仅允许字母、数字、下划线和短横线")
    if result["status"] not in STATUSES:
        raise ValueError("status 必须为进行中、已完成或已暂停")
    result["repository"] = repository(row["repository"])
    for k in ["budget", "planned_days", "actual_days"]:
        result[k] = number(row[k], k)
    return result


def ledger(content, max_rows):
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as z:
            if len(z.infolist()) > 100 or sum(i.file_size for i in z.infolist()) > 10_000_000:
                raise ValueError("工作簿解压体积过大")
            if any("vbaProject" in i.filename for i in z.infolist()):
                raise ValueError("不支持包含宏的工作簿")
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=False, keep_links=False)
        try:
            if wb.sheetnames != ["projects"]:
                raise ValueError("工作簿必须仅包含 projects 工作表")
            sheet = wb["projects"]
            sheet.reset_dimensions()
            rows = sheet.iter_rows(values_only=True)
            header = next(rows, ())
            if list(header) != FIELDS:
                raise ValueError("表头必须与下载的模板完全一致")
            result = []
            ids, repos = set(), set()
            for index, row in enumerate(rows, 2):
                if index > max_rows + 1:
                    raise ValueError(f"台账最多 {max_rows} 行")
                if all(v is None for v in row):
                    continue
                if len(row) != len(FIELDS):
                    raise ValueError(f"第 {index} 行列数不正确")
                try:
                    item = project(dict(zip(FIELDS, row)))
                except ValueError as exc:
                    raise ValueError(f"第 {index} 行：{exc}") from None
                if item["id"] in ids or item["repository"] in repos:
                    raise ValueError(f"第 {index} 行项目 id 或仓库重复")
                ids.add(item["id"]); repos.add(item["repository"])
                result.append(item)
            if not result:
                raise ValueError("台账没有有效项目")
            return result
        finally:
            wb.close()
    except (zipfile.BadZipFile, KeyError, TypeError, OSError) as exc:
        raise ValueError("文件不是有效的台账工作簿") from exc


def template(projects):
    wb = Workbook()
    ws = wb.active
    ws.title = "projects"
    ws.append(FIELDS)
    for p in projects:
        ws.append([p[k] for k in FIELDS])
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    for col in ws.columns:
        ws.column_dimensions[col[0].column_letter].width = 24
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def utc_day(value):
    if not isinstance(value, str):
        raise ValueError("时间需为 ISO 日期或带时区时间戳")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return date.fromisoformat(value).isoformat()
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("时间戳必须带时区")
    return dt.astimezone(timezone.utc).date().isoformat()


def litellm(content, project_ids, max_rows):
    try:
        data = json.loads(content)
    except (ValueError, UnicodeDecodeError):
        raise ValueError("无效 JSON") from None
    if not isinstance(data, list) or not 1 <= len(data) <= max_rows:
        raise ValueError(f"JSON 顶层须为 1–{max_rows} 条日志的数组")
    rows = []
    ids = set()
    for index, item in enumerate(data, 1):
        try:
            if not isinstance(item, dict):
                raise ValueError("日志条目必须为对象")
            metadata = item.get("metadata", {})
            if not isinstance(metadata, dict):
                raise ValueError("metadata 必须为对象")
            project_id = item.get("project_id", metadata.get("project_id"))
            if project_id not in project_ids:
                raise ValueError("project_id 未在项目台账中登记")
            row = {
                "id": text(item.get("request_id"), "request_id", 120),
                "project_id": project_id,
                "day": utc_day(item.get("startTime")),
                "model": text(item.get("model"), "model", 100),
                "input_tokens": number(item.get("prompt_tokens"), "prompt_tokens", True),
                "output_tokens": number(item.get("completion_tokens"), "completion_tokens", True),
                "cost": number(item.get("spend", 0), "spend"), "source": "litellm",
            }
            if "total_tokens" in item and number(item["total_tokens"], "total_tokens", True) != row["input_tokens"] + row["output_tokens"]:
                raise ValueError("total_tokens 与输入、输出之和不一致")
            if row["id"] in ids:
                raise ValueError("批次包含重复 request_id")
            ids.add(row["id"])
            # Deliberately discard keys, prompts, IPs, email and all other metadata.
            rows.append(row)
        except (ValueError, TypeError, OverflowError):
            raise ValueError(f"第 {index} 条日志格式错误：检查项目、时间、计数及重复 ID") from None
    return rows
