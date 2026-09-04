# Inventory Hub 服务器部署

服务器模式只运行一个 Node/SQLite 写入实例，Nginx 在自定义 HTTPS 端口 `19473` 提供同源 Web 与 `/api/` 代理。SQLite 整个目录和图片目录使用独立持久卷；不要把数据库目录放到 NFS/SMB，也不要横向扩容 app 服务。

## 启动

1. 将可信证书和私钥分别放到 `deploy/certs/fullchain.pem`、`deploy/certs/privkey.pem`。
2. 复制 `deploy/.env.example` 为 `deploy/.env`，设置实际的 HTTPS Origin 和至少 32 字符的随机会话密钥。
3. 先构建镜像，再通过只在服务器终端运行的交互命令创建首个管理员。服务器模式不会开放公网注册或网页 setup：

   ```bash
   docker compose --env-file deploy/.env -f deploy/compose.yml build app web
   docker compose --env-file deploy/.env -f deploy/compose.yml run --rm --no-deps app node packages/core/dist/init-admin.js
   ```

   管理员密码只在交互提示中输入，不要写入 `deploy/.env` 或 Shell 历史。初始化命令与服务不能同时打开 SQLite，因此请在首次 `up` 之前执行。

4. 启动服务：

   ```bash
   docker compose --env-file deploy/.env -f deploy/compose.yml up -d
   ```

5. 检查 `https://主机名:19473/healthz` 和 `https://主机名:19473/api/v1/health/ready`，然后使用刚创建的管理员登录。

Compose 更新策略为 `stop-first`，避免两个进程同时打开同一 SQLite 目录。Nginx 不挂载媒体卷，图片只能通过鉴权 API 读取。证书文件、数据库、媒体和实际 `.env` 均不得提交到 Git。

桌面包命令位于 `apps/desktop/package.json`：macOS arm64/x64 分别生成 DMG 与 ZIP，Windows x64 生成 NSIS 安装器与 ZIP。正式分发前仍需 Windows 代码签名以及 macOS 签名、公证；当前配置不会把未签名产物表述为已完成发布验收。

## 桌面 LAN HTTPS 开发配置

手机实时摄像头需要可信 HTTPS。开发阶段可用 `mkcert` 为实际局域网 IP 生成证书，示例中的 IP 必须替换为电脑当前私网地址：

```bash
mkcert -install
mkcert -cert-file inventory-hub.pem -key-file inventory-hub-key.pem localhost 127.0.0.1 192.168.1.20
```

启动桌面端前设置：

```bash
IH_LAN_ENABLED=true \
IH_HOST=0.0.0.0 \
IH_LAN_ORIGIN=https://192.168.1.20:18473 \
IH_TLS_CERT_PATH=/absolute/path/inventory-hub.pem \
IH_TLS_KEY_PATH=/absolute/path/inventory-hub-key.pem \
pnpm dev:desktop
```

`0.0.0.0` 只用于明确开启 LAN 后的监听，应用默认仍只监听 `127.0.0.1`。将 `mkcert -CAROOT` 中的**公开根证书**安装到手机并核对后再访问；绝不能把 CA 私钥或标签服务器私钥复制到手机、项目或 Git。手机证书信任、相机授权和真实网络访问必须分别做真机验收。
