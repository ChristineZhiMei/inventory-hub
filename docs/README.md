# Inventory Hub 设计文档

更新日期：2026-09-05。本文档描述目标方案，不表示软件已实现或硬件已验证。

## 阅读入口

- [系统设计与需求汇总](system-design.md)：技术栈、模型、状态、接口、页面、安全、打包及验收标准。
- [架构图导航页](index.html)：本地浏览器打开，进入六份可交互图。
- [验证记录](verification.md)：图源与 HTML 摘要、校验及浏览器检查范围。

## 架构图

| 图 | 交互式 HTML | 可编辑 Archify 图源 |
|---|---|---|
| 系统架构 | [01-system.html](diagrams/01-system.html) | [JSON](diagrams/specs/01-system.architecture.json) |
| 物品状态流转 | [02-inventory.html](diagrams/02-inventory.html) | [JSON](diagrams/specs/02-inventory.lifecycle.json) |
| 前端页面结构 | [03-pages.html](diagrams/03-pages.html) | [JSON](diagrams/specs/03-pages.architecture.json) |
| 运行时架构 | [04-runtime.html](diagrams/04-runtime.html) | [JSON](diagrams/specs/04-runtime.architecture.json) |
| 连续扫码与批量移位 | [05-scan.html](diagrams/05-scan.html) | [JSON](diagrams/specs/05-scan.workflow.json) |
| 打印任务状态 | [06-print.html](diagrams/06-print.html) | [JSON](diagrams/specs/06-print.lifecycle.json) |

HTML 为 Archify 生成的自包含文档，支持主题切换、缩放、检索和导出；直接打开无需部署。GitHub 通常只展示 HTML 源码，需下载或克隆后在浏览器中查看，不依赖 GitHub Pages。

Markdown 中保留 Mermaid 模型和状态图，方便在 GitHub 上直接阅读；Archify JSON 是交互式图的编辑源，不要手工修改生成的 HTML。

## 方案状态

已确认：Electron 独立软件、Node.js 后端、React + shadcn/ui、手机局域网网页、登录、编号与容器层级、批量操作、多图、扫码和电脑打印。

设计建议：Fastify、SQLite、Drizzle、Electron Forge、废弃后永久删除、恢复时选择位置。SQLite 替代此前明确提出的 MySQL 尚需明确确认；本次按 SQLite 方案绘图，不宣称该选择已最终批准。

待硬件验证：D35 连接方式、实际电脑与手机系统版本、标签尺寸，以及 Windows/macOS 打印兼容性。跨平台目标不是已通过双平台真机验证的声明。
