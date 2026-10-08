# Inventory Hub

本地优先的物品档案与收纳位置管理软件。支持物品、袋子、箱子和仓库的唯一编号、条码、图片、分类标签、嵌套收纳、出入库、移动、废弃、操作历史与打印任务。

同一套 React 页面运行于 Electron 桌面端和手机浏览器；桌面端自带 Node.js 核心服务与 SQLite，无需另装数据库。服务器部署提供 Docker Compose、Nginx 和 HTTPS 入口。

## 开发运行

要求 Node.js 22+、pnpm 9.9。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

- Web 开发地址：`http://127.0.0.1:14237`
- Core API：`http://127.0.0.1:18473/api/v1`
- Electron 开发：保持 Web 开发服务运行后执行 `pnpm dev:desktop`

首次打开会进入管理员初始化。物品需要名称和分类，图片选填（最多 5 张）；未指定实际收纳位置的档案进入系统暂存区。

## 搭配

侧栏或手机菜单 → 搭配，创建分组并添加列表项。支持分类、标签和规格多选，包含 / 符合 / 存在三种规则，单项及全局随机、历史回退和锁定；分组自动保存。详见 [搭配说明](docs/matching.md)。

## AI 识别

设置 → AI 识别中填写智谱 API Key，默认模型为 `glm-4.6v-flash`。创建或编辑物品时可根据图片填写名称、分类、规格和标签；选择说明在分类与标签菜单配置。详见 [AI 识别说明](docs/ai-recognition.md)。

## 校验与打包

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm package:mac:arm64
pnpm package:mac:x64
pnpm package:win:x64
```

构建制品输出到 `apps/desktop/release/`。当前制品未签名；macOS 公证和 Windows 代码签名需要各平台的发行证书。

## 服务器部署

复制 `deploy/.env.example` 为 `deploy/.env`，设置公开访问地址、会话密钥和 HTTPS 证书；首次管理员账号按 [服务器部署说明](deploy/README.md) 在服务器终端创建，然后执行：

```bash
docker compose --env-file deploy/.env -f deploy/compose.yml up -d --build
```

默认 HTTPS 入口为 `https://localhost:19473`。手机摄像头扫码必须通过可信 HTTPS 访问；普通局域网 HTTP 仍可手动输入编号。

## 文档

[完整开发文档](docs/development.md) 包含业务规则、数据模型、接口契约、Mermaid 架构与状态图、部署方式及验收场景。
