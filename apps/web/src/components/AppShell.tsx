import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AppstoreOutlined,
  CloudOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  InboxOutlined,
  MenuOutlined,
  MoonOutlined,
  PlusSquareOutlined,
  PrinterOutlined,
  ScanOutlined,
  SearchOutlined,
  SettingOutlined,
  SunOutlined,
  TagsOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Menu, Switch } from "antd";
import { Popup, TabBar } from "antd-mobile";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { api, resolvePendingRequest, unresolvedRequests } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { consumeLocalNativeQueue } from "@/lib/localPrinting";
import { useBodyScrollLock } from "@/lib/scrollLock";
import { useTheme } from "@/lib/theme";
import { Badge, Button, Input } from "./AntUi";

const primary = [
  { to: "/", label: "概览", icon: <AppstoreOutlined /> },
  { to: "/archives", label: "档案", icon: <FolderOpenOutlined /> },
  { to: "/staging", label: "待整理", icon: <InboxOutlined /> },
  { to: "/intake", label: "连续录入", mobileLabel: "录入", icon: <PlusSquareOutlined /> },
  { to: "/scan", label: "扫码", icon: <ScanOutlined /> },
];

const management = [
  { to: "/operations", label: "操作记录", icon: <HistoryOutlined /> },
  { to: "/print-jobs", label: "打印队列", icon: <PrinterOutlined /> },
  { to: "/taxonomy", label: "分类与标签", icon: <TagsOutlined /> },
  { to: "/settings", label: "设置", icon: <SettingOutlined /> },
];

const allNavigation = [...primary, ...management];

function currentRoute(pathname: string) {
  return (
    [...allNavigation]
      .sort((left, right) => right.to.length - left.to.length)
      .find((item) =>
        item.to === "/"
          ? pathname === "/"
          : pathname === item.to || pathname.startsWith(`${item.to}/`),
      )?.to ?? "/"
  );
}

export function AppShell() {
  const auth = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [drawer, setDrawer] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [search, setSearch] = useState("");
  const [revision, setRevision] = useState(0);
  useBodyScrollLock(drawer);
  const selectedRoute = useMemo(
    () => currentRoute(location.pathname),
    [location.pathname],
  );

  useEffect(() => setDrawer(false), [location.pathname]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => {
    if (!online) return;
    for (const pending of unresolvedRequests()) {
      void api<{ state?: string }>(`/requests/${pending.requestId}`)
        .then((result) => {
          if (result.state && result.state !== "RUNNING") {
            resolvePendingRequest(pending.requestId);
            void queryClient.invalidateQueries();
          }
        })
        .catch((error: { status?: number }) => {
          if (error.status && ![404, 503].includes(error.status)) {
            resolvePendingRequest(pending.requestId);
          }
        });
    }
  }, [online, queryClient]);
  useEffect(() => {
    if (!online || !window.inventoryHub?.printLabel) return;
    const consume = () => {
      void consumeLocalNativeQueue().catch(() => undefined);
    };
    consume();
    const interval = window.setInterval(consume, 2_000);
    return () => window.clearInterval(interval);
  }, [online]);

  useQuery({
    queryKey: ["changes", revision],
    queryFn: async () => {
      const data = await api<{ changed: boolean; dataRevision: number }>(
        `/changes?sinceRevision=${revision}`,
      );
      if (data.changed && revision > 0) {
        await queryClient.invalidateQueries({
          predicate: (query) =>
            query.queryKey[0] !== "changes" && query.queryKey[0] !== "auth",
        });
      }
      setRevision(data.dataRevision);
      return data;
    },
    enabled: online && document.visibilityState === "visible",
    refetchInterval: 3000,
    retry: false,
  });

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const query = search.trim();
    if (query) navigate(`/search?q=${encodeURIComponent(query)}`);
  };

  const menuItems = allNavigation.map((item) => ({
    key: item.to,
    icon: item.icon,
    label: item.label,
  }));

  return (
    <div className="app-shell">
      <aside className="desktop-sidebar">
        <Link to="/" className="brand-link">
          <span className="brand-mark"><CloudOutlined /></span>
          <span className="brand-copy">
            <strong>Inventory Hub</strong>
            <small>物品与位置管理</small>
          </span>
        </Link>
        <Menu
          mode="inline"
          selectedKeys={[selectedRoute]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          className="sidebar-menu"
        />
        <div className="sidebar-account">
          <UserOutlined />
          <span>
            <strong>{auth.user?.username}</strong>
            <small>本地管理员</small>
          </span>
        </div>
      </aside>

      <section className="app-workspace">
        {!online && (
          <div className="offline-banner">
            网络已断开，当前仅可查看已加载内容
          </div>
        )}
        <header className="app-header">
          <Button
            variant="ghost"
            size="icon"
            className="mobile-menu-trigger"
            onClick={() => setDrawer(true)}
            aria-label="打开菜单"
          >
            <MenuOutlined />
          </Button>
          <form onSubmit={submitSearch} className="global-search">
            <Input
              id="global-search"
              name="global-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              prefix={<SearchOutlined />}
              placeholder="搜索名称、编号或标签"
              aria-label="全局搜索"
              autoComplete="off"
            />
          </form>
          <Badge variant={online ? "success" : "warning"} className="online-state">
            {online ? "服务在线" : "离线"}
          </Badge>
          <Switch
            checked={theme === "dark"}
            checkedChildren={<MoonOutlined />}
            unCheckedChildren={<SunOutlined />}
            onChange={toggleTheme}
            aria-label={theme === "dark" ? "切换到明亮主题" : "切换到暗色主题"}
          />
        </header>
        <main className="app-content">
          <Outlet />
        </main>
      </section>

      <TabBar
        className="mobile-tabbar"
        activeKey={selectedRoute}
        onChange={(key) => navigate(key)}
        safeArea
      >
        {primary.map((item) => (
          <TabBar.Item
            key={item.to}
            icon={item.icon}
            title={item.mobileLabel ?? item.label}
          />
        ))}
      </TabBar>

      <Popup
        visible={drawer}
        position="left"
        onMaskClick={() => setDrawer(false)}
        onClose={() => setDrawer(false)}
        bodyClassName="mobile-navigation"
        bodyStyle={{ width: "min(340px, 88vw)", height: "100dvh" }}
      >
        <div className="mobile-navigation__header">
          <span className="brand-mark"><CloudOutlined /></span>
          <strong>Inventory Hub</strong>
          <Switch
            checked={theme === "dark"}
            checkedChildren={<MoonOutlined />}
            unCheckedChildren={<SunOutlined />}
            onChange={toggleTheme}
            aria-label="切换主题"
          />
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selectedRoute]}
          items={menuItems}
          onClick={({ key }) => {
            navigate(key);
            setDrawer(false);
          }}
          className="mobile-navigation__menu"
        />
        <Button
          variant="outline"
          className="mobile-navigation__account"
          onClick={() => navigate("/settings/account")}
        >
          <UserOutlined />
          <span>{auth.user?.username}</span>
        </Button>
      </Popup>
    </div>
  );
}
