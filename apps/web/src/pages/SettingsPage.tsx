import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleUserRound,
  Clock3,
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
  const queryClient = useQueryClient();
  const capabilities = useQuery({
    queryKey: ["capabilities"],
    queryFn: queries.capabilities,
  });
  const runtime = useQuery({
    queryKey: ["runtime-status"],
    queryFn: queries.runtime,
  });
  const desktopStatus = useQuery({
    queryKey: ["desktop-service-status"],
    queryFn: () => window.inventoryHub!.getServiceStatus!(),
    enabled: !!window.inventoryHub?.getServiceStatus,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (enabled: boolean) =>
      window.inventoryHub?.setLanEnabled
        ? window.inventoryHub.setLanEnabled(enabled)
        : Promise.reject(new Error("当前页面没有桌面配置权限")),
    onSuccess: async () =>
      queryClient.invalidateQueries({ queryKey: ["capabilities"] }),
  });
  if (capabilities.isError)
    return (
      <QueryError
        error={capabilities.error}
        onRetry={() => capabilities.refetch()}
      />
    );
  const data = capabilities.data;
  const service =
    desktopStatus.data || runtime.data || data?.lan || data?.service || {};
  const protocol = service.protocol || location.protocol.replace(":", "");
  const host = service.host || location.hostname;
  const port =
    service.port || Number(location.port || (protocol === "https" ? 443 : 80));
  const lanEnabled =
    "enabled" in service
      ? !!service.enabled
      : "lanEnabled" in service
        ? !!service.lanEnabled
        : !!data?.lan?.enabled;
  const trusted =
    window.isSecureContext &&
    protocol === "https" &&
    (data?.lan?.certificateTrusted ?? true);
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
            <Badge variant={trusted ? "success" : "warning"}>
              {trusted ? "可信 HTTPS" : "非可信上下文"}
            </Badge>
          </div>
          <dl className="grid gap-3 sm:grid-cols-2">
            <InfoBox label="协议" value={protocol.toUpperCase()} />
            <InfoBox label="主机" value={host} />
            <InfoBox label="服务端口" value={String(port)} />
            <InfoBox
              label="相机安全上下文"
              value={window.isSecureContext ? "可申请权限" : "不可用"}
            />
          </dl>
          {service.url && (
            <a
              href={service.url}
              className="mt-4 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              {service.url}
              <ExternalLink className="size-4" />
            </a>
          )}
          {!trusted && (
            <Alert
              title="手机实时扫码需要可信 HTTPS"
              tone="warning"
              className="mt-4"
            >
              先在桌面端生成局域网证书，再在手机上安装公开证书并核对指纹。普通
              http://192.168.x.x 无法获得相机权限。
            </Alert>
          )}
        </CardContent>
      </Card>
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
                开启 LAN
              </Button>
              <Button
                variant="outline"
                onClick={() => mutation.mutate(false)}
                disabled={!lanEnabled || mutation.isPending}
              >
                关闭 LAN
              </Button>
            </div>
          ) : (
            <Alert title="当前页面只能查看状态" tone="info">
              请在电脑上的桌面软件设置
              LAN。更改监听地址、证书或端口后可能需要重启内置服务；本页不会伪装开关已经生效。
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
  const initial = (() => {
    try {
      return JSON.parse(
        localStorage.getItem("inventory-hub:device-preferences") || "{}",
      );
    } catch {
      return {};
    }
  })() as { printerId?: string; paper?: string; terminator?: string };
  const [printerId, setPrinterId] = useState(
    initial.printerId || "HPRT-D35-SIMULATOR",
  );
  const [paper, setPaper] = useState(initial.paper || "40x30");
  const [terminator, setTerminator] = useState(initial.terminator || "Enter");
  const [saved, setSaved] = useState(false);
  const printers = useQuery({
    queryKey: ["native-printers"],
    queryFn: () => window.inventoryHub!.listPrinters!(),
    enabled: !!window.inventoryHub?.listPrinters,
    retry: false,
  });
  const nativePrinters = (printers.data || []) as Array<{
    name?: string;
    displayName?: string;
  }>;
  function save() {
    localStorage.setItem(
      "inventory-hub:device-preferences",
      JSON.stringify({ printerId, paper, terminator }),
    );
    setSaved(true);
  }
  return (
    <div className="space-y-6">
      <Alert title="当前使用打印模拟器" tone="warning">
        HPRT D35 尚未完成实机验证；队列成功不代表实际出纸。
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
                value={printerId}
                onChange={(e) => setPrinterId(e.target.value)}
              >
                <option value="HPRT-D35-SIMULATOR">HPRT D35 模拟器</option>
                {nativePrinters.map((printer, index) => {
                  const name =
                    printer.name || printer.displayName || `printer-${index}`;
                  return (
                    <option value={name} key={name}>
                      {printer.displayName || name}
                    </option>
                  );
                })}
              </Select>
            </Field>
            <Field label="标签纸">
              <Select value={paper} onChange={(e) => setPaper(e.target.value)}>
                <option value="40x30">40 × 30 mm（待实机确认）</option>
                <option value="50x30">50 × 30 mm（待实机确认）</option>
              </Select>
            </Field>
            <Field label="扫码枪结束符">
              <Select
                value={terminator}
                onChange={(e) => setTerminator(e.target.value)}
              >
                <option value="Enter">Enter</option>
                <option value="Tab">Tab</option>
              </Select>
            </Field>
          </div>
          <Button className="mt-5" onClick={save}>
            保存当前客户端偏好
          </Button>
          {saved && (
            <Alert title="偏好已保存" tone="success" className="mt-4">
              这不会把尚未验证的打印机标记为可用。
            </Alert>
          )}
          {printers.error && (
            <Alert title="无法读取系统打印机" tone="error" className="mt-4">
              {errorMessage(printers.error)}
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
