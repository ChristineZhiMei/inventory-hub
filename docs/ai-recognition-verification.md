# AI 识别与移动端验证记录

日期：2026-10-08。代码分支：master。没有提交代码或保存浏览器内的测试表单。

- goal：验证 AI 配置、识别回填、说明限制和手机布局与多选交互。
- tab_strategy：后续全部复用 page 18，结束回到 `http://127.0.0.1:14237/taxonomy`，不操作用户的 page 15。
- commit_policy：NO_COMMIT（浏览器不保存业务数据）。
- matched_workflows：frontend-bug-fix-loop。
- matched_flows：无站点专用 flow。
- target_tab / selected_page：page 18；focus_status：FOCUSED。

## OPERATION_TIMELINE

| step_id | owner_skill | segment_type | planned_action | actual_action | status | mcp_verification / evidence | requests_table | next_action_or_stop_reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | MAIN_SKILL | verify | 复用目标页 | list_pages、select_page 选择 page 18 | 通过 | 页面 URL 与本地应用一致 | 无 | 检查手机布局 |
| 2 | frontend-bug-fix-loop | verify | 检查工具栏与说明 | 手机视口检查 taxonomy；切换规格记录 | 通过 | 320px 视口，页面 scrollWidth=320；工具栏宽288、右边界304；搜索框右边界292；说明 maxLength=300 | 见下表 | 检查多选输入 |
| 3 | frontend-bug-fix-loop | verify | 首次展开不输入，第二次可输入 | 手机视口打开规格多选，再次点击，关闭 | 通过（Chrome 模拟） | 首次 readOnly=true/expanded=true；第二次 readOnly=false/expanded=true；关闭后恢复只读 | 无 | 检查回填与撤销 |
| 4 | frontend-bug-fix-loop | guarded | 验证选中字段回填 | 页面内临时拦截识别 fetch，仅勾选名称并确认；撤销 | 通过（模拟响应） | 拦截调用1次，fields=[name]；名称更新；分类、规格、标签不变；撤销恢复原名称 | 模拟响应，未发送识别网络请求 | 返回分类页清除拦截 |
| 5 | MAIN_SKILL | verify | 清理并检查控制台 | 整页导航回 taxonomy，检查 DOM、网络与控制台 | 通过 | 临时拦截标记不存在；无 error/warn；数据 GET 均200 | 见下表 | 完成；Safari 双击问题按用户要求搁置 |

规格切换时直接操作隐藏 radio 的 MCP 点击超时，改点可见的“规格记录”文字后成功；这不是 Safari 真机复现证据。

### requests_table

| 请求 | 结果 | 证据 |
| --- | --- | --- |
| GET /api/v1/ai/selection-rules | 200 | reqid 963 |
| GET /api/v1/categories | 200 | reqid 964 |
| GET /api/v1/tags | 200 | reqid 965 |
| GET /api/v1/specifications?limit=50 | 200 | reqid 966 |
| POST /api/v1/ai/recognize | 页面内模拟，无真实请求 | 仅验证前端回填/撤销，不代表真实模型成功 |

## 代码与隔离验证

- `pnpm typecheck`、`pnpm build` 通过；最终移动端调整后重新执行 `pnpm typecheck`、`pnpm build:web`、`git diff --check` 通过。构建有既有大包提示。
- 使用临时数据库和模拟上游验证 Key 加密与版本冲突、完整候选表读取、非法 ID 过滤/去重/前三项、字段选择、清空/保留规则、10次轮换、选项变更失效、识别期间变更拒绝、异常响应处理。
- 迁移验证覆盖既有选项补空说明、重复启动、50字规则升级300字保留内容与版本、300字接受/301字拒绝；数据库 quick_check 正常。
- 未新增测试代码文件。

## 结束状态与未验证项

- final_state：原标签页停留 taxonomy 的规格记录，320px 手机模拟；模拟回填已撤销，没有保存业务数据。
- unexecuted_actions：真实模型调用、Safari 真机输入法和按钮触摸验证、代码提交/推送。
- Safari 偶发两次点击问题按用户要求停止排查，不声称修复。
- 上下文使用稳定前缀和本地轮换；并非供应商托管对话，每次仍须发送前置数据。缓存命中未实测。
- settlement_candidates：手机布局、多选输入与 AI 模拟回填可整理为浏览器操作路径 flow；本次未修改或新建技能。
