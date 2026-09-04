# 架构图验证记录

日期：2026-09-05。工具：Archify 2.17。范围仅为文档与图形产物，不包括业务软件、手机摄像头或 D35 真机验收。

## 1. 最终交付结果

六份图均通过 `deliver --quality showcase`：9/9 项产物检查、0 个错误、0 个警告。六份最终 HTML 均通过 `visual-check`，并核对浏览器回执中的 SHA-256 与实际文件相同。

| 图 | diagram_type | validation | browser_evidence | visual_review | correction_rounds |
|---|---|---|---|---|---|
| [01-system](diagrams/01-system.html) | architecture | 9/9 showcase | passed | passed | 0 |
| [02-inventory](diagrams/02-inventory.html) | lifecycle | 9/9 showcase | passed | passed | 1 |
| [03-pages](diagrams/03-pages.html) | architecture | 9/9 showcase | passed | passed | 0 |
| [04-runtime](diagrams/04-runtime.html) | architecture | 9/9 showcase | passed | passed | 0 |
| [05-scan](diagrams/05-scan.html) | workflow | 9/9 showcase | passed | passed | 1 |
| [06-print](diagrams/06-print.html) | lifecycle | 9/9 showcase | passed | passed | 0 |

`correction_rounds` 记录首次浏览器检查后的视觉修正轮次，不是图源初始布局校验次数。物品状态图修正了首屏溢出；扫码图将工具默认图例改为业务语义。修正后均重新校验、交付并采集最终截图。

## 2. 可复核文件摘要

每个 HTML 都是独立文档；图源与产物大小单位为字节。

### 01-system

- output：`diagrams/01-system.html`
- specification：`diagrams/specs/01-system.architecture.json`
- specification_sha256：`0e8765ff5e040a6beffe09d5957ba06567d5101fa3ed7624125d8e1f756928cf`
- specification_bytes：2238
- artifact_sha256：`3c5022211c3461eb8e4e6aa0f1902476da597561bb0114e13ff2670d021b5220`
- artifact_bytes：710057
- [自动浏览器回执](diagrams/01-system.visual-check.json)
- [四张截图联系页](diagrams/01-system.visual-check.html)

### 02-inventory

- output：`diagrams/02-inventory.html`
- specification：`diagrams/specs/02-inventory.lifecycle.json`
- specification_sha256：`6c3416f529acc82415084bf73a30e1298ccec30a57c06e34d75f0c5ac941b405`
- specification_bytes：1962
- artifact_sha256：`fa292c91cff3ffab430d5a3617ee84a1673e677f31add231a7e16110be03d726`
- artifact_bytes：707402
- [自动浏览器回执](diagrams/02-inventory.visual-check.json)
- [四张截图联系页](diagrams/02-inventory.visual-check.html)

### 03-pages

- output：`diagrams/03-pages.html`
- specification：`diagrams/specs/03-pages.architecture.json`
- specification_sha256：`008648815644cc3c2c8dfc060a5ad37a8010fe13126b0bc2ab7ad0713b7739a7`
- specification_bytes：1976
- artifact_sha256：`751926908f1d94b82a26b8795b6c9e93b2d3148d54a43ad11f0f810148ecd3c1`
- artifact_bytes：705773
- [自动浏览器回执](diagrams/03-pages.visual-check.json)
- [四张截图联系页](diagrams/03-pages.visual-check.html)

### 04-runtime

- output：`diagrams/04-runtime.html`
- specification：`diagrams/specs/04-runtime.architecture.json`
- specification_sha256：`e8fdc15479ab34a00ed5b600662dc76ee28b74a55267fa27e1b67600d5f80954`
- specification_bytes：2066
- artifact_sha256：`5549eac9e43565dfa0757c5abf32c9190d6fc0a8cb701508bda9bd46284d1049`
- artifact_bytes：707601
- [自动浏览器回执](diagrams/04-runtime.visual-check.json)
- [四张截图联系页](diagrams/04-runtime.visual-check.html)

### 05-scan

- output：`diagrams/05-scan.html`
- specification：`diagrams/specs/05-scan.workflow.json`
- specification_sha256：`1c071327108c14320b7d53f69940ce79aff8019c4554f84c7903b44b49c93a39`
- specification_bytes：2889
- artifact_sha256：`cb145ff644ba52c9e8a126608b3f7a165d9ed1f65d8d004e6b66f7da3c9344e2`
- artifact_bytes：713412
- [自动浏览器回执](diagrams/05-scan.visual-check.json)
- [四张截图联系页](diagrams/05-scan.visual-check.html)

### 06-print

- output：`diagrams/06-print.html`
- specification：`diagrams/specs/06-print.lifecycle.json`
- specification_sha256：`731086f93b387995d4d1a941ad6dbd0251ed33750ef4a5eca604a46d84e371f1`
- specification_bytes：2138
- artifact_sha256：`2e2b4b65feb90287f88403b2ecceabe647f3d454d7e9271f7b1287bfcf2de549`
- artifact_bytes：709010
- [自动浏览器回执](diagrams/06-print.visual-check.json)
- [四张截图联系页](diagrams/06-print.visual-check.html)

## 3. 浏览器证据与视觉复核

自动浏览器：本机 Google Chrome，由 Archify 的原生 `visual-check` 命令启动隔离的检查会话。

- 对每份 HTML 测量 1440×900、1600×1000、1920×1080、2048×1320 四种视口。
- 检查横纵向溢出、图例与浮动工具栏间距、节点文字可读性。
- 在 1440×900 和 2048×1320 分别采集浅色、深色主题，共 24 张截图。
- 最终结果均为 `scrollWidth <= innerWidth`、`scrollHeight <= innerHeight`。
- 图像复核检查节点文字、关系方向、标签遮挡、两种主题和大屏整体布局；这与自动回执中的 `visualReview: pending` 分开记录，不篡改自动回执。
- 查看器的检索、焦点、导出等完整交互未逐项验收，不把截图检查宣称为查看器全功能测试。

### 浏览器操作链路（OPERATION_TIMELINE）

目标：只读验证本次生成的架构文档。计划优先复用 Chrome 会话；不操作外部业务页面，不进行网页持久化提交。未命中适用的业务 workflow 或 flow。

| step_id | owner_skill | segment_type | planned_action | actual_action | status | mcp_verification | evidence | next_action_or_stop_reason |
|---|---|---|---|---|---|---|---|---|
| 01 | chrome-devtools-workflow-operator | verify | 列出并选择目标标签页 | list_pages 等待 300 秒超时 | BLOCKED | 未取得页面列表 | MCP 超时结果 | 不修改浏览器配置，使用用户允许的替代检查 |
| 02 | archify | verify | 检查最终 HTML 多尺寸布局 | visual-check 在隔离 Chrome 检查 | PASS | 不适用，非 MCP 证据 | 每图 visual-check.json | 对失败画布修正后重跑 |
| 03 | archify | verify | 复核浅深主题与大屏 | 图像工具查看最终截图 | PASS | 不适用，图像复核 | 每图 PNG 与联系页 | 完成最终文件摘要校验 |

`requests_table`：无业务网络请求需要取证。`selected_page`：未取得；`focus_status`：BLOCKED。`unexecuted_actions`：用户 Chrome 标签页复用及完整查看器交互验证。`final_state`：替代浏览器检查通过；未更改用户浏览器配置。`settlement_candidates`：本轮为生成器自带检查流程，不创建或更新通用浏览器技能。

## 4. 文档与提交检查

- 六份图源 JSON 解析与 Archify 类型校验通过。
- 对六份完整生成 HTML 中共 12 段 JavaScript 执行 Node.js `vm.Script` 语法解析；不执行应用业务逻辑。
- 校验 Markdown 与导航页的本地文件链接、图源/产物 SHA-256 和浏览器回执绑定。
- 提交前执行 `git diff --check` 和暂存区检查，仅包含 `docs/` 文档、图源、生成 HTML 和图片证据；不新增或提交测试代码。
- 仓库尚无业务应用构建命令。本轮为纯文档交付，不宣称 Electron 软件已编译或已完成双平台验收。

## 5. 重新生成

在已安装的 Archify 技能目录运行；将下列路径替换成实际仓库绝对路径。依次对其他五份图执行对应类型的同样命令。

```sh
node bin/archify.mjs validate architecture /path/to/inventory-hub/docs/diagrams/specs/01-system.architecture.json --quality showcase --json
node bin/archify.mjs deliver architecture /path/to/inventory-hub/docs/diagrams/specs/01-system.architecture.json /path/to/inventory-hub/docs/diagrams/01-system.html --quality showcase --json
node bin/archify.mjs visual-check /path/to/inventory-hub/docs/diagrams/01-system.html --json
```

只有 `deliver` 成功后才检查目标 HTML，避免误验旧文件。任何图源修改都需要重新生成、更新摘要并检查视觉效果。
