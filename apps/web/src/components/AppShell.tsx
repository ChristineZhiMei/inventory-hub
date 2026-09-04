import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import gsap from "gsap";
import {
  Archive,
  Boxes,
  ChevronRight,
  CircleUserRound,
  CloudOff,
  History,
  House,
  Menu,
  PackagePlus,
  Printer,
  ScanLine,
  Search,
  Settings,
  Shapes,
  Warehouse,
  X,
} from "lucide-react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { api, resolvePendingRequest, unresolvedRequests } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { Badge, Button, Input } from "./ui";

const primary = [
  { to: "/", label: "概览", icon: House, end: true },
  { to: "/items", label: "物品", icon: Archive },
  { to: "/locations", label: "位置", icon: Warehouse },
  { to: "/intake", label: "连续录入", icon: PackagePlus },
  { to: "/scan", label: "扫码", icon: ScanLine },
];
const management = [
  { to: "/operations", label: "操作记录", icon: History },
  { to: "/print-jobs", label: "打印队列", icon: Printer },
  { to: "/taxonomy", label: "分类与标签", icon: Shapes },
  { to: "/settings", label: "设置", icon: Settings },
];

function NavItem({
  item,
  onClick,
}: {
  item: (typeof primary)[number];
  onClick?: () => void;
}) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onClick}
      className={({ isActive }) =>
        cn(
          "flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors",
          isActive
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )
      }
    >
      <Icon className="size-5" />
      <span>{item.label}</span>
    </NavLink>
  );
}

export function AppShell() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [drawer, setDrawer] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [search, setSearch] = useState("");
  const [revision, setRevision] = useState(0);
  const drawerRef = useRef<HTMLElement>(null);
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
          if (error.status && ![404, 503].includes(error.status))
            resolvePendingRequest(pending.requestId);
        });
    }
  }, [online, queryClient]);
  useLayoutEffect(() => {
    const panel = drawerRef.current;
    if (
      !drawer ||
      !panel ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const tween = gsap.fromTo(
      panel,
      { xPercent: -100 },
      {
        xPercent: 0,
        duration: 0.22,
        ease: "power2.out",
        clearProps: "transform",
      },
    );
    return () => {
      tween.kill();
    };
  }, [drawer]);
  useQuery({
    queryKey: ["changes", revision],
    queryFn: async () => {
      const data = await api<{ changed: boolean; dataRevision: number }>(
        `/changes?sinceRevision=${revision}`,
      );
      if (data.changed && revision > 0)
        await queryClient.invalidateQueries({
          predicate: (q) =>
            q.queryKey[0] !== "changes" && q.queryKey[0] !== "auth",
        });
      setRevision(data.dataRevision);
      return data;
    },
    enabled: online && document.visibilityState === "visible",
    refetchInterval: 3000,
    retry: false,
  });
  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const q = search.trim();
    if (q) navigate(`/search?q=${encodeURIComponent(q)}`);
  };
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[256px_minmax(0,1fr)]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r bg-card lg:flex lg:flex-col">
        <Link to="/" className="flex h-20 items-center gap-3 border-b px-5">
          <div className="grid size-10 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Boxes className="size-6" />
          </div>
          <div>
            <p className="font-semibold leading-tight">Inventory Hub</p>
            <p className="text-xs text-muted-foreground">物品与位置管理</p>
          </div>
        </Link>
        <nav
          className="scrollbar-thin flex-1 overflow-y-auto p-3"
          aria-label="主导航"
        >
          <p className="px-3 pb-2 pt-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            工作区
          </p>
          {primary.map((item) => (
            <NavItem key={item.to} item={item} />
          ))}
          <p className="px-3 pb-2 pt-5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            管理
          </p>
          {management.map((item) => (
            <NavItem key={item.to} item={item} />
          ))}
        </nav>
        <div className="border-t p-3">
          <div className="flex items-center gap-3 rounded-md px-3 py-2">
            <CircleUserRound className="size-8 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {auth.user?.username}
              </p>
              <p className="text-xs text-muted-foreground">本地管理员</p>
            </div>
          </div>
        </div>
      </aside>
      <div className="min-w-0 lg:col-start-2">
        {!online && (
          <div className="sticky top-0 z-40 flex min-h-11 items-center justify-center gap-2 bg-amber-500 px-4 text-sm font-medium text-amber-950">
            <CloudOff className="size-4" />
            网络已断开，当前仅可查看已加载内容
          </div>
        )}
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b bg-background/90 px-4 backdrop-blur lg:px-8">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setDrawer(true)}
            aria-label="打开菜单"
          >
            <Menu className="size-5" />
          </Button>
          <form onSubmit={submitSearch} className="relative max-w-xl flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="global-search"
              name="global-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
              placeholder="搜索名称、编号或标签"
              aria-label="全局搜索"
              autoComplete="off"
            />
          </form>
          <Badge
            variant={online ? "success" : "warning"}
            className="hidden sm:inline-flex"
          >
            {online ? "服务在线" : "离线"}
          </Badge>
        </header>
        <main className="mx-auto w-full max-w-[1500px] p-4 pb-28 lg:p-8 lg:pb-8">
          <Outlet />
        </main>
      </div>
      <nav
        className="safe-bottom fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t bg-card/95 px-1 pt-1 backdrop-blur lg:hidden"
        aria-label="移动端主导航"
      >
        {primary.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              to={item.to}
              end={item.end}
              key={item.to}
              className={({ isActive }) =>
                cn(
                  "flex min-h-14 flex-col items-center justify-center gap-1 rounded-md text-[11px]",
                  isActive ? "text-primary" : "text-muted-foreground",
                )
              }
            >
              <Icon className="size-5" />
              <span>{item.label === "连续录入" ? "录入" : item.label}</span>
            </NavLink>
          );
        })}
      </nav>
      {drawer && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/45 lg:hidden"
          onMouseDown={(e) => e.currentTarget === e.target && setDrawer(false)}
        >
          <aside
            ref={drawerRef}
            className="h-full w-[min(340px,88vw)] overflow-y-auto border-r bg-card p-4 shadow-raised"
          >
            <div className="mb-5 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="grid size-10 place-items-center rounded-lg bg-primary text-primary-foreground">
                  <Boxes className="size-6" />
                </div>
                <strong>Inventory Hub</strong>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setDrawer(false)}
                aria-label="关闭菜单"
              >
                <X className="size-5" />
              </Button>
            </div>
            <nav aria-label="所有页面">
              {[...primary, ...management].map((item) => (
                <NavItem
                  key={item.to}
                  item={item}
                  onClick={() => setDrawer(false)}
                />
              ))}
            </nav>
            <Button
              variant="outline"
              className="mt-6 w-full justify-between"
              onClick={() => navigate("/settings/account")}
            >
              <span>{auth.user?.username}</span>
              <ChevronRight className="size-4" />
            </Button>
          </aside>
        </div>
      )}
    </div>
  );
}
