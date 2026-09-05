import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { useAuth } from "@/lib/auth";
import { DiagnosticPage, LoginPage, SetupPage } from "@/pages/AuthPages";

const DashboardPage = lazy(() => import("@/pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const IntakePage = lazy(() => import("@/pages/IntakePage").then((module) => ({ default: module.IntakePage })));
const ItemsPage = lazy(() => import("@/pages/ItemsPage").then((module) => ({ default: module.ItemsPage })));
const LocationsPage = lazy(() => import("@/pages/LocationsPage").then((module) => ({ default: module.LocationsPage })));
const NodeDetailPage = lazy(() => import("@/pages/NodeDetailPage").then((module) => ({ default: module.NodeDetailPage })));
const NodeEditorPage = lazy(() => import("@/pages/NodeEditorPage").then((module) => ({ default: module.NodeEditorPage })));
const OperationsPage = lazy(() => import("@/pages/OperationsPage").then((module) => ({ default: module.OperationsPage })));
const OperationDetailPage = lazy(() => import("@/pages/OperationsPage").then((module) => ({ default: module.OperationDetailPage })));
const PrintJobsPage = lazy(() => import("@/pages/PrintPages").then((module) => ({ default: module.PrintJobsPage })));
const PrintJobDetailPage = lazy(() => import("@/pages/PrintPages").then((module) => ({ default: module.PrintJobDetailPage })));
const ScanPage = lazy(() => import("@/pages/ScanPage").then((module) => ({ default: module.ScanPage })));
const SearchPage = lazy(() => import("@/pages/SearchPage").then((module) => ({ default: module.SearchPage })));
const SettingsPage = lazy(() => import("@/pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const TaxonomyPage = lazy(() => import("@/pages/TaxonomyPage").then((module) => ({ default: module.TaxonomyPage })));

function ProtectedApp() {
  const auth = useAuth();
  const location = useLocation();
  if (auth.booting) return <div className="grid min-h-screen place-items-center"><div className="text-center"><div className="mx-auto size-9 animate-spin rounded-full border-4 border-primary border-t-transparent" /><p className="mt-4 text-sm text-muted-foreground">正在连接 Inventory Hub…</p></div></div>;
  if (auth.bootError) return <DiagnosticPage error={auth.bootError} />;
  if (!auth.setup?.initialized) return location.pathname === "/setup" ? <SetupPage /> : <Navigate to="/setup" replace />;
  if (!auth.user) return location.pathname === "/login" ? <LoginPage /> : <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;
  if (location.pathname === "/login" || location.pathname === "/setup") return <Navigate to="/" replace />;
  return <Suspense fallback={<div className="grid min-h-72 place-items-center text-sm text-muted-foreground">正在加载页面…</div>}><Routes><Route element={<AppShell />}><Route index element={<DashboardPage />} /><Route path="search" element={<SearchPage />} /><Route path="items" element={<ItemsPage />} /><Route path="items/new" element={<NodeEditorPage mode="create" forcedType="ITEM" />} /><Route path="items/:id" element={<NodeDetailPage />} /><Route path="items/:id/edit" element={<NodeEditorPage mode="edit" />} /><Route path="locations" element={<LocationsPage />} /><Route path="locations/new" element={<NodeEditorPage mode="create" />} /><Route path="locations/:id" element={<NodeDetailPage />} /><Route path="locations/:id/edit" element={<NodeEditorPage mode="edit" />} /><Route path="intake" element={<IntakePage />} /><Route path="scan" element={<ScanPage />} /><Route path="operations" element={<OperationsPage />} /><Route path="operations/:id" element={<OperationDetailPage />} /><Route path="print-jobs" element={<PrintJobsPage />} /><Route path="print-jobs/:id" element={<PrintJobDetailPage />} /><Route path="taxonomy" element={<TaxonomyPage />} /><Route path="settings" element={<SettingsPage />} /><Route path="settings/:section" element={<SettingsPage />} /><Route path="*" element={<NotFound />} /></Route></Routes></Suspense>;
}

function NotFound() { return <div className="surface grid min-h-80 place-items-center p-8 text-center"><div><p className="text-5xl font-semibold text-muted-foreground/40">404</p><h1 className="mt-3 text-xl font-semibold">页面不存在</h1><p className="mt-2 text-sm text-muted-foreground">这个入口可能已经移动，返回概览继续操作。</p><a href="/" className="mt-5 inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">返回概览</a></div></div>; }

export default function App() {
  return <Routes><Route path="*" element={<ProtectedApp />} /></Routes>;
}
