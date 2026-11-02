# 实现与范围

浏览器通过同源 JSON API 与 FastAPI 交互。SQLite 保存规范化项目、逐请求用量和逐提交记录；聚合服务对日期、团队和项目应用统一筛选。前端仅展示聚合与白名单明细。

```text
固定种子虚构数据 ─┐
Excel 台账上传 ───┼→ 校验与明确项目关联 → SQLite → 聚合 API → HTML / Canvas / 表格
LiteLLM JSON ─────┤
Gitee 公开 API ───┘
```

- `store.py`：参数化 SQL、外键约束、事务、索引；不继承任何既有数据库结构或迁移。
- `demo.py`：固定种子直接构造虚构数据；只初始化空数据库。
- `ingest.py`：先完整校验再持久化；拒绝公式、宏、异常数值、未登记项目、重复记录和非允许仓库地址。
- `analytics.py`：日/周/月 UTC 聚合、空周期补零、缺失行数计数、费用与当前台账比较。
- `gitee.py`：固定官方主机、公开性校验、有限分页、超时；不保存作者身份或消息，不根据请求目标读取任意 URL。
- `main.py`：同源写入限制、Host 校验、上传体积限制、安全响应头；静态页面不依赖 CDN；为保留原界面的动态样式允许行内 CSS，登录页仅允许哈希匹配的行内脚本。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /api/health | 健康检查 |
| GET | /api/meta | 默认日期、演示提示、采集开关 |
| GET / POST | /api/projects | 项目列表 / 校验保存 |
| GET | /api/dashboard | 日期、团队、项目、粒度聚合 |
| GET | /api/commits | 提交明细，最多 500 条 |
| POST | /api/import/ledger | multipart Excel 台账 |
| POST | /api/import/litellm | multipart LiteLLM JSON |
| GET | /api/template/ledger.xlsx | 虚构台账模板 |
| GET | /api/template/litellm.json | 虚构日志示例 |
| POST | /api/sync/gitee | 按需公开采集 |
| GET | /openapi.json | 机器可读 API 契约 |

## 明确限制

此版本面向单用户本机作品演示。没有真实登录认证、角色权限、组织隔离、生产调度、并发采集任务或实时 LiteLLM 连接。工期数据来自台账快照，无法代表真实节省工时。公开 API 集成通过模拟响应验证，实际可用性与限流由上游决定。

根据用户最终要求，保留 6 个前端文件并逐字节校验；`frontend_api.py` 独立适配原 HTTP 契约，不复制原后端。没有运行原服务，没有导入其配置、数据库、文档、后端源码、打包文件、依赖缓存或 Git 元数据。原目录只读，所有新增文件均放在新目录。前端权属与分发许可见 NOTICE.md。原项目匹配说明仍显示原文字；此演示以后端登记的明确仓库归属为准，不实现模糊后缀匹配。
