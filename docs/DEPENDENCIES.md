# 依赖许可证与漏洞审查

审查日期：2026-11-02。安装来源为公开 PyPI，依赖在本项目虚拟环境中安装，没有使用参考项目的 wheels 或环境。`requirements.txt` 固定运行时依赖的完整闭包。

## 运行时许可证

共 22 个包，机器可读清单见 [dependency-licenses.json](dependency-licenses.json)，包含名称、精确版本、许可证与上游地址。

| 范围 | 许可证 | 分发时注意 |
| --- | --- | --- |
| FastAPI、Pydantic、openpyxl、AnyIO 等 | MIT | 保留版权与许可声明 |
| Uvicorn、Starlette、HTTPX、Click 等 | BSD 系列 | 保留上游版权、条款及免责声明 |
| python-multipart、OpenTelemetry API | Apache-2.0 | 保留许可与适用的 NOTICE；修改时保留相关说明 |
| typing_extensions、defusedxml | PSF 系列 | 保留其许可与版权声明 |
| certifi | MPL-2.0 | 文件级弱 copyleft；分发或修改受覆盖文件时遵守源代码与通知义务 |

本次未发现运行时依赖使用 GPL / AGPL，未发现缺失许可证元数据的运行时包。此结论来自安装包元数据，不是法律意见；若制作包含依赖的镜像或二进制包，需另行保留完整许可文件与 NOTICE，并复核 MPL 义务。当前 Git 仓库只分发本项目源码和依赖清单，没有复制第三方库或字体。

## 漏洞

使用 `pip-audit -r requirements.txt --no-deps --disable-pip` 查询公开漏洞源；本次结果见 [dependency-vulnerabilities.json](dependency-vulnerabilities.json)。结果仅代表审查时点已知漏洞，不表示不存在未知风险。GitHub 工作流提供后续重新检查能力。

## 前端与开发工具

前端没有 npm 依赖、CDN、外部字体、图片或监控 SDK；主界面 6 个前端文件按用户要求保留，其分发权限需人工确认，见 NOTICE.md；数据工作区 CSS、JavaScript 与 Canvas 为本次独立实现。开发工具的 29 个额外包许可证清单另列于 `dependency-licenses-dev.json`，包括审计工具自身及其表格输出依赖。浏览器自动化工具未作为应用依赖分发。

复查方式：

```bash
python -m pip install -r requirements-dev.txt
pip-licenses --format=json --with-urls
pip-audit -r requirements.txt --no-deps --disable-pip
```
