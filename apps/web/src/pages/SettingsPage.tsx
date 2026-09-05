import { useState } from "react";
import { QRCode } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleUserRound,
  Clock3,
  Copy,
  Database,
  ExternalLink,
  HardDrive,
  Info,
  Laptop,
  LockKeyhole,
  LogOut,
  Network,
  Printer,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  rememberPrintPreferences,
  type NativePrintSettings,
} from "@/lib/localPrinting";
import { queries } from "@/lib/queries";
import type { PrintPairing } from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";
import { QueryError } from "@/components/Page";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
} from "@/components/AntUi";

const pages = [
  { id: "account", label: "账号", icon: CircleUserRound },
  { id: "storage", label: "图片存储", icon: HardDrive },
  { id: "lan", label: "局域网访问", icon: Network },
  { id: "devices", label: "设备与打印", icon: Printer },
  { id: "about", label: "关于与健康", icon: Info },
] as const;

export function SettingsPage() {
  const location = useLocation();
  const section =
    pages.find((page) => location.pathname.endsWith(`/${page.id}`))?.id ||
    "about";
  return (
    <div>
      <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <nav className="surface settings-nav h-fit p-2" aria-label="设置导航">
          {pages.map(({ id, label, icon: Icon }) => (
            <Link
              key={id}
              to={`/settings/${id}`}
              className={cn(
                "flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium",
                section === id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className="size-5" />
              {label}
            </Link>
          ))}
        </nav>
        <section className="min-w-0">
          {section === "account" ? (
            <AccountSettings />
          ) : section === "storage" ? (
            <StorageSettings />
          ) : section === "lan" ? (
            <LanSettings />
          ) : section === "devices" ? (
            <DeviceSettings />
          ) : (
            <AboutSettings />
          )}
        </section>
      </div>
    </div>
  );
}

function AccountSettings() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const password = useMutation({
    mutationFn: () =>
      api("/auth/password", {
        method: "PATCH",
        idempotent: true,
        sensitive: true,
        body: { currentPassword, newPassword },
      }),
    onSuccess: async () => {
      await auth.logout();
      navigate("/login", { replace: true });
    },
  });
  const revoke = useMutation({
    mutationFn: () =>
      api("/auth/revoke-others", {
        method: "POST",
        idempotent: true,
        sensitive: true,
        body: { currentPassword },
      }),
  });
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>当前账号</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div className="grid size-12 place-items-center rounded-full bg-muted">
              <CircleUserRound className="size-7 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{auth.user?.username}</p>
              <p className="text-sm text-muted-foreground">唯一管理员账号</p>
            </div>
            <Button
              variant="outline"
              onClick={() =>
                auth.logout().then(() => navigate("/login", { replace: true }))
              }
            >
              <LogOut className="size-4" />
              退出
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LockKeyhole className="size-5" />
            修改密码
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              password.mutate();
            }}
          >
            <Field label="当前密码">
              <Input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
            </Field>
            <Field label="新密码" hint="12～128 个字符">
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
              />
            </Field>
            <Field
              label="确认新密码"
              error={
                confirm && confirm !== newPassword
                  ? "两次输入的密码不一致"
                  : undefined
              }
            >
              <Input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
            {password.error && (
              <Alert title="修改失败" tone="error">
                {errorMessage(password.error)}
              </Alert>
            )}
            <Button
              type="submit"
              loading={password.isPending}
              disabled={newPassword.length < 12 || newPassword !== confirm}
            >
              修改并重新登录
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>其他会话</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">
            撤销电脑和手机上的其他登录，不影响当前页面。
          </p>
          <Button
            variant="outline"
            loading={revoke.isPending}
            disabled={!currentPassword}
            onClick={() => revoke.mutate()}
          >
            撤销其他会话
          </Button>
          {revoke.isSuccess && (
            <Alert title="其他会话已撤销" tone="success" className="mt-4" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StorageSettings() {
  const queryClient = useQueryClient();
  const storage = useQuery({
    queryKey: ["storage-status"],
    queryFn: queries.storage,
  });
  const [selected, setSelected] = useState<{
    token: string;
    displayPath?: string;
  } | null>(null);
  const [plan, setPlan] = useState<{
    id: string;
    totalBytes: number;
    fileCount: number;
    requiredBytes: number;
    freeBytes: number;
    targetName: string;
  } | null>(null);
  const preflight = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("请先选择目录");
      return api<NonNullable<typeof plan>>("/storage/migrations/preflight", {
        method: "POST",
        body: { selectionToken: selected.token },
      });
    },
    onSuccess: setPlan,
  });
  const migrate = useMutation({
    mutationFn: async () => {
      if (!selected || !plan)
        throw new Error("迁移预检信息已失效，请重新选择目录");
      return api(`/storage/migrations/${plan.id}/start`, {
        method: "POST",
        idempotent: true,
        body: { selectionToken: selected.token },
      });
    },
    onSuccess: async () => {
      setSelected(null);
      setPlan(null);
      await queryClient.invalidateQueries({ queryKey: ["storage-status"] });
    },
  });
  async function choose() {
    const result = await window.inventoryHub?.selectMediaDirectory?.();
    if (result) {
      setSelected(result);
      setPlan(null);
      preflight.reset();
      migrate.reset();
    }
  }
  if (storage.isError)
    return (
      <QueryError error={storage.error} onRetry={() => storage.refetch()} />
    );
  const state =
    storage.data?.mediaRootAccessible === false
      ? "OFFLINE"
      : storage.data?.state || "UNCONFIGURED";
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="size-5" />
            图片存储
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-3">
            <Badge
              variant={
                state === "ONLINE"
                  ? "success"
                  : state === "MIGRATING"
                    ? "warning"
                    : "destructive"
              }
            >
              {state}
            </Badge>
            <span className="text-sm">
              {storage.data?.displayPath || "网页不会显示本机绝对路径"}
            </span>
          </div>
          {state === "OFFLINE" && (
            <Alert title="图片目录不可访问" tone="error" className="mt-4">
              新建和替换图片已停止，已有文字档案和位置操作仍可使用。
            </Alert>
          )}
          <dl className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-md bg-muted p-3">
              <dt className="text-xs text-muted-foreground">待清理任务</dt>
              <dd className="mt-1 font-semibold">
                {storage.data?.cleanupPending ?? 0}
              </dd>
            </div>
            <div className="rounded-md bg-muted p-3">
              <dt className="text-xs text-muted-foreground">可用空间</dt>
              <dd className="mt-1 font-semibold">
                {formatBytes(storage.data?.freeBytes)}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>选择或迁移目录</CardTitle>
        </CardHeader>
        <CardContent>
          {window.inventoryHub?.selectMediaDirectory ? (
            <div>
              <Button variant="outline" onClick={choose}>
                <HardDrive className="size-4" />
                选择本机目录
              </Button>
              {selected && (
                <div className="mt-4 rounded-md border bg-muted/50 p-4">
                  <p className="text-sm font-medium">
                    {selected.displayPath || "目录已授权"}
                  </p>
                  {!plan ? (
                    <Button
                      className="mt-3"
                      loading={preflight.isPending}
                      onClick={() => preflight.mutate()}
                    >
                      检查目录与空间
                    </Button>
                  ) : (
                    <div className="mt-3">
                      <dl className="grid grid-cols-2 gap-2 text-sm">
                        <InfoBox
                          label="受控文件"
                          value={`${plan.fileCount} 个`}
                        />
                        <InfoBox
                          label="需要空间"
                          value={formatBytes(plan.requiredBytes)}
                        />
                      </dl>
                      <Alert
                        title="预检通过，尚未开始迁移"
                        tone="warning"
                        className="mt-3"
                      >
                        确认后才复制并切换；完成前原目录保持权威。
                      </Alert>
                      <Button
                        className="mt-3"
                        loading={migrate.isPending}
                        onClick={() => migrate.mutate()}
                      >
                        确认开始迁移
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <Alert title="仅桌面软件可更改目录" tone="info">
              请回到电脑上的桌面设置选择路径。
            </Alert>
          )}
          {(preflight.error || migrate.error) && (
            <Alert title="目录操作失败" tone="error" className="mt-4">
              {errorMessage(preflight.error || migrate.error)}
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function LanSettings() {
  const [copied, setCopied] = useState(false);
  const capabilities = useQuery({
    queryKey: ["capabilities"],
    queryFn: queries.capabilities,
  });
  const runtime = useQuery({
    queryKey: ["runtime-status"],
    queryFn: queries.runtime,
  });
  const desktopEnvironment = useQuery({
    queryKey: ["desktop-environment"],
    queryFn: () => window.inventoryHub!.getEnvironment!(),
    enabled: !!window.inventoryHub?.getEnvironment,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (enabled: boolean) =>
      window.inventoryHub?.setLanEnabled
        ? window.inventoryHub.setLanEnabled(enabled)
        : Promise.reject(new Error("当前页面没有桌面配置权限")),
  });
  if (capabilities.isError)
    return (
      <QueryError
        error={capabilities.error}
        onRetry={() => capabilities.refetch()}
      />
    );
  const data = capabilities.data;
  const desktop = desktopEnvironment.data;
  const service = runtime.data || data?.lan || data?.service || {};
  const lanEnabled =
    desktop?.lanEnabled ?? ("enabled" in service
      ? !!service.enabled
      : "lanEnabled" in service
        ? !!service.lanEnabled
        : !!data?.lan?.enabled);
  const lanOrigin = desktop?.lanOrigin || data?.lan?.url || service.url;
  const lanUrl = lanOrigin ? new URL(lanOrigin) : null;
  const protocol = lanUrl?.protocol.replace(":", "") || service.protocol || location.protocol.replace(":", "");
  const host = lanUrl?.hostname || service.host || location.hostname;
  const port = Number(lanUrl?.port || service.port || location.port || (protocol === "https" ? 443 : 80));
  const certificateInstallUrl = desktop?.certificateInstallUrl;
  const httpsReady = lanEnabled && protocol === "https" && Boolean(lanOrigin);
  const secureDevelopmentOrigin = location.port === "14237" && host
    ? `https://${host}:14239`
    : null;
  const currentPageTrusted = window.isSecureContext;
  const copyInstallUrl = async () => {
    if (!certificateInstallUrl) return;
    try {
      await navigator.clipboard.writeText(certificateInstallUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Network className="size-5" />
            局域网服务
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <Badge variant={lanEnabled ? "success" : "secondary"}>
              {lanEnabled ? "已开启" : "未开启"}
            </Badge>
            <Badge variant={httpsReady ? "success" : "warning"}>
              {httpsReady ? "HTTPS 已配置" : "等待配置 HTTPS"}
            </Badge>
          </div>
          <dl className="grid gap-3 sm:grid-cols-2">
            <InfoBox label="协议" value={protocol.toUpperCase()} />
            <InfoBox label="主机" value={host} />
            <InfoBox label="服务端口" value={String(port)} />
            <InfoBox
              label="当前页面安全状态"
              value={currentPageTrusted ? "浏览器已认可" : "浏览器未认可"}
            />
          </dl>
          {lanOrigin && (
            <a
              href={lanOrigin}
              className="mt-4 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              {lanOrigin}
              <ExternalLink className="size-4" />
            </a>
          )}
          {!httpsReady && (
            <Alert
              title="手机实时扫码需要可信 HTTPS"
              tone="warning"
              className="mt-4"
            >
              先在桌面端生成局域网证书，再在手机上安装公开证书并核对指纹。普通
              http://192.168.x.x 无法获得相机权限。
            </Alert>
          )}
          {secureDevelopmentOrigin && (
            <Alert
              title="手机开发测试请使用 HTTPS 入口"
              tone="info"
              className="mt-4"
            >
              <p>
                当前 14237 是电脑端 HTTP 开发地址，安装证书后也不会变成安全页面。
              </p>
              <a
                href={secureDevelopmentOrigin}
                className="mt-3 inline-flex min-h-11 items-center gap-2 font-medium text-primary hover:underline"
                target="_blank"
                rel="noreferrer"
              >
                {secureDevelopmentOrigin}
                <ExternalLink className="size-4" />
              </a>
            </Alert>
          )}
        </CardContent>
      </Card>
      {lanEnabled && certificateInstallUrl && (
        <Card>
          <CardHeader>
            <CardTitle>手机安装证书</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-5 md:grid-cols-[184px_minmax(0,1fr)] md:items-start">
              <div className="w-fit rounded-xl bg-white p-3">
                <QRCode
                  value={certificateInstallUrl}
                  size={160}
                  bordered={false}
                  bgColor="#ffffff"
                  color="#000000"
                />
              </div>
              <div className="min-w-0 space-y-4">
                <p className="text-sm text-muted-foreground">
                  手机连接同一局域网后扫描二维码，或在手机浏览器输入下方网址。
                </p>
                <Field label="证书安装网址">
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                    <Input value={certificateInstallUrl} readOnly className="min-w-0 flex-1" />
                    <Button variant="outline" onClick={() => void copyInstallUrl()}>
                      <Copy className="size-4" />
                      {copied ? "已复制" : "复制"}
                    </Button>
                  </div>
                </Field>
                {desktop?.caFingerprint && (
                  <div>
                    <p className="mb-1 text-sm font-medium">SHA-256 指纹</p>
                    <code className="block rounded-md bg-muted p-3 text-xs leading-5 [overflow-wrap:anywhere]">
                      {desktop.caFingerprint}
                    </code>
                  </div>
                )}
                <Alert title="安装后仍需确认信任" tone="info">
                  iPhone 或 iPad 显示“已安装描述文件”并不等于已信任。还需在“设置 →
                  通用 → 关于本机 → 证书信任设置”中开启 Inventory Hub Local CA
                  的完全信任，随后彻底关闭并重新打开浏览器。Android 的入口因系统厂商而异。
                </Alert>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>服务控制</CardTitle>
        </CardHeader>
        <CardContent>
          {window.inventoryHub?.setLanEnabled ? (
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => mutation.mutate(true)}
                disabled={lanEnabled}
                loading={mutation.isPending}
              >
                开启局域网访问
              </Button>
              <Button
                variant="outline"
                onClick={() => mutation.mutate(false)}
                disabled={!lanEnabled || mutation.isPending}
              >
                关闭局域网访问
              </Button>
            </div>
          ) : (
            <Alert title="当前页面只能查看状态" tone="info">
              请在电脑上的桌面软件设置
              LAN。局域网开关和证书生成只能由桌面程序执行。
            </Alert>
          )}
          {mutation.error && (
            <Alert title="LAN 配置未生效" tone="error" className="mt-4">
              {errorMessage(mutation.error)}
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DeviceSettings() {
  const capabilities = useQuery({
    queryKey: ["capabilities"],
    queryFn: queries.capabilities,
  });
  if (capabilities.isLoading)
    return (
      <Card>
        <CardContent className="p-5 text-sm text-muted-foreground">
          正在读取打印能力…
        </CardContent>
      </Card>
    );
  if (capabilities.isError)
    return (
      <QueryError
        error={capabilities.error}
        onRetry={() => capabilities.refetch()}
      />
    );
  return capabilities.data?.deploymentMode === "server" ? (
    <ServerDeviceSettings />
  ) : (
    <LocalDeviceSettings />
  );
}

function ServerDeviceSettings() {
  const queryClient = useQueryClient();
  const executors = useQuery({
    queryKey: ["print-executors"],
    queryFn: queries.printExecutors,
  });
  const pairing = useMutation({
    mutationFn: () =>
      api<PrintPairing>("/print-executors/pairing", {
        method: "POST",
        body: {},
      }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/print-executors/${id}`, { method: "DELETE" }),
    onSuccess: async () =>
      queryClient.invalidateQueries({ queryKey: ["print-executors"] }),
  });
  const bridgePrinters = useQuery({
    queryKey: ["remote-bridge-printers"],
    queryFn: () => window.inventoryHubRemote!.listPrinters!(),
    enabled: !!window.inventoryHubRemote?.listPrinters,
    retry: false,
  });
  const bridgeStatus = useQuery({
    queryKey: ["remote-bridge-status"],
    queryFn: () => window.inventoryHubRemote!.getStatus!(),
    enabled: !!window.inventoryHubRemote?.getStatus,
    retry: false,
  });
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [printerId, setPrinterId] = useState("");
  const defaultPrinter =
    bridgePrinters.data?.find((printer) => printer.isDefault)?.name ||
    bridgePrinters.data?.[0]?.name ||
    "";
  const selectedPrinter = printerId || defaultPrinter;
  const pairBridge = useMutation({
    mutationFn: async () => {
      if (!window.inventoryHubRemote?.pair) throw new Error("远程打印桥不可用");
      if (!selectedPrinter) throw new Error("请选择本机打印机");
      const result = await window.inventoryHubRemote.pair({
        code,
        printerId: selectedPrinter,
        executorName: name.trim(),
      });
      if (!result.paired)
        throw new Error(result.message || "远程打印桥未完成配对");
      return result;
    },
    onSuccess: async () => {
      setCode("");
      await bridgeStatus.refetch();
      await queryClient.invalidateQueries({ queryKey: ["print-executors"] });
    },
  });
  const unpairBridge = useMutation({
    mutationFn: async () => {
      if (!window.inventoryHubRemote?.unpair) throw new Error("远程打印桥不支持取消配对");
      return window.inventoryHubRemote.unpair();
    },
    onSuccess: async () => {
      await bridgeStatus.refetch();
      await queryClient.invalidateQueries({ queryKey: ["print-executors"] });
    },
  });
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Printer className="size-5" />
            远程打印执行器
          </CardTitle>
        </CardHeader>
        <CardContent>
          {executors.isError ? (
            <QueryError
              error={executors.error}
              onRetry={() => executors.refetch()}
            />
          ) : executors.data?.length ? (
            <div className="divide-y">
              {executors.data.map((executor) => (
                <div
                  className="flex min-h-16 flex-wrap items-center gap-3 py-3"
                  key={executor.id}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-medium">{executor.name}</p>
                      <Badge
                        variant={
                          executor.state === "ONLINE" ? "success" : "secondary"
                        }
                      >
                        {executor.state}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {executorPrinterId(executor.capabilities) ||
                        "未报告打印机"}{" "}
                      · {formatDate(executor.lastSeenAt)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`撤销 ${executor.name}`}
                    loading={
                      revoke.isPending && revoke.variables === executor.id
                    }
                    onClick={() =>
                      window.confirm(`撤销“${executor.name}”的打印权限？`) &&
                      revoke.mutate(executor.id)
                    }
                  >
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              还没有已配对执行器
            </p>
          )}
          {revoke.error && (
            <Alert title="撤销失败" tone="error" className="mt-4">
              {errorMessage(revoke.error)}
            </Alert>
          )}
          <Button
            className="mt-4"
            onClick={() => pairing.mutate()}
            loading={pairing.isPending}
          >
            生成配对码
          </Button>
          {pairing.data && (
            <div className="mt-4 rounded-md border bg-muted/50 p-4">
              <p className="font-mono text-3xl font-semibold tracking-[0.25em]">
                {pairing.data.code}
              </p>
              <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                <Clock3 className="size-3" />
                {formatDate(pairing.data.expiresAt)} 过期
              </p>
            </div>
          )}
          {pairing.error && (
            <Alert title="生成失败" tone="error" className="mt-4">
              {errorMessage(pairing.error)}
            </Alert>
          )}
        </CardContent>
      </Card>
      {window.inventoryHubRemote && (
        <Card>
          <CardHeader>
            <CardTitle>本机远程打印桥</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-4 flex flex-wrap gap-2">
              <Badge
                variant={bridgeStatus.data?.paired ? "success" : "secondary"}
              >
                {bridgeStatus.data?.paired ? "已配对" : "未配对"}
              </Badge>
              {bridgeStatus.data && ["online", "printing"].includes(bridgeStatus.data.phase) && (
                <Badge variant="success">运行中</Badge>
              )}
              {bridgeStatus.data?.selectedPrinterId && (
                <Badge variant="outline">{bridgeStatus.data.selectedPrinterId}</Badge>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="配对码" required>
                <Input
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  onChange={(event) =>
                    setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                />
              </Field>
              <Field label="执行器名称" required>
                <Input
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例如：书房电脑"
                />
              </Field>
              <Field label="本机打印机" className="sm:col-span-2">
                <Select
                  value={selectedPrinter}
                  onChange={(event) => setPrinterId(event.target.value)}
                >
                  <option value="">选择打印机</option>
                  {bridgePrinters.data?.map((printer) => (
                    <option value={printer.name} key={printer.name}>
                      {printer.displayName || printer.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button
              className="mt-4"
              disabled={code.length !== 6 || !name.trim() || !selectedPrinter}
              loading={pairBridge.isPending}
              onClick={() => pairBridge.mutate()}
            >
              配对并启动
            </Button>
            {bridgeStatus.data?.paired && window.inventoryHubRemote?.unpair && (
              <Button
                variant="outline"
                className="ml-2 mt-4"
                loading={unpairBridge.isPending}
                onClick={() => unpairBridge.mutate()}
              >
                取消本机配对
              </Button>
            )}
            {(pairBridge.error ||
              unpairBridge.error ||
              bridgePrinters.error ||
              bridgeStatus.error) && (
              <Alert title="打印桥不可用" tone="error" className="mt-4">
                {errorMessage(
                  pairBridge.error ||
                    unpairBridge.error ||
                    bridgePrinters.error ||
                    bridgeStatus.error,
                )}
              </Alert>
            )}
            {bridgeStatus.data?.message && (
              <Alert
                title={
                  bridgeStatus.data.phase === "attention"
                    ? "打印桥异常"
                    : "打印桥状态"
                }
                tone={
                  bridgeStatus.data.phase === "attention" ? "warning" : "info"
                }
                className="mt-4"
              >
                {bridgeStatus.data.message}
              </Alert>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function LocalDeviceSettings() {
  const queryClient = useQueryClient();
  const [printerId, setPrinterId] = useState("");
  const [paper, setPaper] = useState<"" | "40x30" | "50x30">("");
  const [terminator, setTerminator] = useState<"" | "Enter" | "Tab">("");
  const settings = useQuery({
    queryKey: ["native-print-settings"],
    queryFn: () => api<NativePrintSettings>("/print-native/settings"),
    refetchInterval: (query) => query.state.data?.available ? false : 2_000,
    retry: false,
  });
  const defaultPrinterId =
    settings.data?.printerId ||
    settings.data?.printers.find((printer) => printer.isDefault)?.printerId ||
    settings.data?.printers[0]?.printerId ||
    "";
  const selectedPrinterId = printerId || defaultPrinterId;
  const selectedPaper = paper || settings.data?.paper || "40x30";
  const selectedTerminator = terminator || settings.data?.terminator || "Enter";
  const save = useMutation({
    mutationFn: () =>
      api<NativePrintSettings>("/print-native/settings", {
        method: "PUT",
        body: {
          printerId: selectedPrinterId,
          paper: selectedPaper,
          terminator: selectedTerminator,
        },
      }),
    onSuccess: async (result) => {
      rememberPrintPreferences({
        printerId: result.printerId || "",
        paper: result.paper,
        terminator: result.terminator,
      });
      setPrinterId(result.printerId || "");
      setPaper(result.paper);
      setTerminator(result.terminator);
      await queryClient.invalidateQueries({ queryKey: ["native-print-settings"] });
    },
  });
  return (
    <div className="space-y-6">
      <Alert title="打印由 Electron 执行" tone="info">
        此处显示的是运行后端的电脑可访问的打印机。手机和普通浏览器只负责选择设备、创建任务，不会读取当前浏览器所在设备。
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Printer className="size-5" />
            标签打印
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="打印机">
              <Select
                value={selectedPrinterId}
                onChange={(e) => setPrinterId(e.target.value)}
                disabled={!settings.data?.available || settings.isLoading}
              >
                <option value="">选择 Electron 电脑上的打印机</option>
                {settings.data?.printers.map((printer) => (
                  <option value={printer.printerId} key={printer.printerId}>
                    {printer.displayName || printer.printerId}
                    {printer.isDefault ? "（系统默认）" : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="标签纸">
              <Select
                value={selectedPaper}
                onChange={(e) => setPaper(e.target.value as "40x30" | "50x30")}
              >
                <option value="40x30">40 × 30 mm（待实机确认）</option>
                <option value="50x30">50 × 30 mm（待实机确认）</option>
              </Select>
            </Field>
            <Field label="扫码枪结束符">
              <Select
                value={selectedTerminator}
                onChange={(e) => setTerminator(e.target.value as "Enter" | "Tab")}
              >
                <option value="Enter">Enter</option>
                <option value="Tab">Tab</option>
              </Select>
            </Field>
          </div>
          <Button
            className="mt-5"
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={!settings.data?.available || !selectedPrinterId}
          >
            保存 Electron 打印配置
          </Button>
          {save.isSuccess && (
            <Alert title="打印配置已保存" tone="success" className="mt-4">
              后续从桌面端、手机或其他 Web 页面创建的本机打印任务都会使用这台设备。
            </Alert>
          )}
          {(settings.error || save.error) && (
            <Alert title="无法读取或保存打印配置" tone="error" className="mt-4">
              {errorMessage(settings.error || save.error)}
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AboutSettings() {
  const capabilities = useQuery({
    queryKey: ["capabilities"],
    queryFn: queries.capabilities,
  });
  const runtime = useQuery({
    queryKey: ["runtime-status"],
    queryFn: queries.runtime,
  });
  const ready = useQuery({
    queryKey: ["health-ready"],
    queryFn: () =>
      api<{
        status?: string;
        database?: string;
        schemaVersion?: number;
        sqliteVersion?: string;
      }>("/health/ready"),
    retry: false,
  });
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Laptop className="size-5" />
            Inventory Hub
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 sm:grid-cols-2">
            <InfoBox label="Web 版本" value="0.1.0" />
            <InfoBox
              label="部署模式"
              value={
                capabilities.data?.deploymentMode ||
                runtime.data?.appMode ||
                "检测中"
              }
            />
            <InfoBox
              label="服务名称"
              value={capabilities.data?.serviceName || "Inventory Hub Core"}
            />
            <InfoBox
              label="服务端点"
              value={
                runtime.data
                  ? `${runtime.data.protocol || "http"}://${runtime.data.host || "127.0.0.1"}:${runtime.data.port || 18473}`
                  : location.origin
              }
            />
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="size-5" />
            服务健康
          </CardTitle>
        </CardHeader>
        <CardContent>
          {ready.isError ? (
            <Alert title="服务未就绪" tone="error">
              {errorMessage(ready.error)}
            </Alert>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="success">
                <ShieldCheck className="mr-1 size-3" />
                {ready.data?.status || "READY"}
              </Badge>
              <span className="text-sm text-muted-foreground">
                SQLite{" "}
                {ready.data?.sqliteVersion ||
                  runtime.data?.sqliteVersion ||
                  "版本由服务检查"}{" "}
                · schema{" "}
                {ready.data?.schemaVersion ??
                  runtime.data?.schemaVersion ??
                  "—"}
              </span>
            </div>
          )}
          <Button
            variant="outline"
            className="mt-4"
            onClick={() =>
              Promise.all([
                ready.refetch(),
                capabilities.refetch(),
                runtime.refetch(),
              ])
            }
          >
            <RefreshCw className="size-4" />
            重新检查
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-all text-sm font-medium">{value}</dd>
    </div>
  );
}
function formatBytes(value?: number) {
  if (value === undefined) return "—";
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

function executorPrinterId(capabilities?: {
  selectedPrinterId?: string;
  printerId?: string;
  defaultPrinterId?: string;
  printerIds?: string[];
  printers?: Array<string | { printerId?: string; id?: string; name?: string }>;
}) {
  const first = capabilities?.printers?.[0];
  return (
    capabilities?.selectedPrinterId ||
    capabilities?.defaultPrinterId ||
    capabilities?.printerId ||
    capabilities?.printerIds?.[0] ||
    (typeof first === "string"
      ? first
      : first?.printerId || first?.id || first?.name) ||
    ""
  );
}
