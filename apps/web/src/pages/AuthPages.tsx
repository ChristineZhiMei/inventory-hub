import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Boxes, FolderOpen, RefreshCw, ShieldCheck } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
} from "@/components/ui";

function AuthFrame({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <main className="grid min-h-screen place-items-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-7 flex items-center justify-center gap-3">
          <div className="grid size-11 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Boxes className="size-6" />
          </div>
          <div>
            <p className="text-lg font-semibold">Inventory Hub</p>
            <p className="text-xs text-muted-foreground">物品与位置管理</p>
          </div>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">{title}</CardTitle>
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
      </div>
    </main>
  );
}

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await auth.login({ username, password });
      const requested = (location.state as { from?: string } | null)?.from;
      navigate(
        requested?.startsWith("/") && !requested.startsWith("//")
          ? requested
          : "/",
        { replace: true },
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame
      title="登录"
      description="登录后可以在电脑和局域网手机上访问同一套档案。"
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="用户名" htmlFor="username" required>
          <Input
            id="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            minLength={3}
            maxLength={32}
            required
            autoFocus
          />
        </Field>
        <Field label="密码" htmlFor="password" required>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={12}
            maxLength={128}
            required
          />
        </Field>
        {error && (
          <Alert title="无法登录" tone="error">
            {error}
          </Alert>
        )}
        <Button type="submit" loading={busy} className="w-full">
          登录
        </Button>
      </form>
    </AuthFrame>
  );
}

export function SetupPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [directoryToken, setDirectoryToken] = useState("");
  const [directoryLabel, setDirectoryLabel] = useState("");
  const mutation = useMutation({
    mutationFn: (body: unknown) =>
      api("/setup", {
        method: "POST",
        body,
        idempotent: true,
        sensitive: true,
      }),
  });
  async function chooseDirectory() {
    const bridge = window.inventoryHub;
    if (!bridge?.selectMediaDirectory) return;
    const result = await bridge.selectMediaDirectory();
    if (result) {
      setDirectoryToken(result.token);
      setDirectoryLabel(result.displayPath || "已选择图片目录");
    }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirm) return;
    await mutation.mutateAsync({
      username,
      password,
      setupToken: auth.setup?.setupTokenRequired ? setupToken : undefined,
      mediaDirectoryToken: directoryToken || undefined,
    });
    await queryClient.invalidateQueries({ queryKey: ["setup-status"] });
    navigate("/login", { replace: true });
  }
  if (auth.setup && !auth.setup.localSetupAllowed) {
    return (
      <AuthFrame title="需要服务器初始化">
        <Alert title="请在服务器终端运行 init-admin" tone="warning">
          {auth.setup.reason || "完成管理员初始化后刷新此页面。"}
        </Alert>
        <Button className="mt-4 w-full" onClick={() => auth.refetch()}>
          <RefreshCw className="size-4" />
          重新检查
        </Button>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title="首次设置" description="创建唯一管理员账号。">
      <form onSubmit={submit} className="space-y-4">
        <Alert
          title={
            auth.setup?.setupTokenRequired ? "需要初始化凭证" : "仅限本机初始化"
          }
          tone="info"
        >
          {auth.setup?.setupTokenRequired
            ? "请输入启动时配置的 setup token。"
            : "公开网络不会提供注册入口。"}
        </Alert>
        {auth.setup?.setupTokenRequired && (
          <Field label="Setup token" htmlFor="setup-token" required>
            <Input
              id="setup-token"
              type="password"
              value={setupToken}
              onChange={(event) => setSetupToken(event.target.value)}
              autoComplete="off"
              required
            />
          </Field>
        )}
        <Field
          label="用户名"
          htmlFor="setup-username"
          hint="3～32 个字符"
          required
        >
          <Input
            id="setup-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            minLength={3}
            maxLength={32}
            autoComplete="username"
            required
          />
        </Field>
        <Field
          label="密码"
          htmlFor="setup-password"
          hint="12～128 个字符，允许使用密码管理器粘贴"
          required
        >
          <Input
            id="setup-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            required
          />
        </Field>
        <Field
          label="确认密码"
          htmlFor="setup-confirm"
          error={
            confirm && password !== confirm ? "两次输入的密码不一致" : undefined
          }
          required
        >
          <Input
            id="setup-confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            required
          />
        </Field>
        {window.inventoryHub?.selectMediaDirectory && (
          <div>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={chooseDirectory}
            >
              <FolderOpen className="size-4" />
              {directoryLabel || "选择图片存储目录"}
            </Button>
            <p className="mt-1.5 text-xs text-muted-foreground">
              可以稍后在桌面设置中选择。
            </p>
          </div>
        )}
        {mutation.error && (
          <Alert title="初始化失败" tone="error">
            {errorMessage(mutation.error)}
          </Alert>
        )}
        <Button
          type="submit"
          loading={mutation.isPending}
          disabled={
            password !== confirm ||
            password.length < 12 ||
            (!!auth.setup?.setupTokenRequired && !setupToken)
          }
          className="w-full"
        >
          <ShieldCheck className="size-4" />
          完成设置
        </Button>
      </form>
    </AuthFrame>
  );
}

export function DiagnosticPage({ error }: { error: unknown }) {
  const auth = useAuth();
  return (
    <AuthFrame
      title="服务暂不可用"
      description="页面无法完成启动检查，数据没有被重置。"
    >
      <div className="space-y-4">
        <Alert title="启动诊断" tone="error">
          {errorMessage(error)}
        </Alert>
        <p className="text-sm text-muted-foreground">
          请确认桌面服务正在运行且 18473
          端口未被占用。如果数据库被其他实例占用，请先关闭另一个 Inventory Hub。
        </p>
        <Button className="w-full" onClick={() => auth.refetch()}>
          <RefreshCw className="size-4" />
          重试连接
        </Button>
      </div>
    </AuthFrame>
  );
}
