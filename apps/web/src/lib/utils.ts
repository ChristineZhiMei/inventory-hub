import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(value?: string | number | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function createRequestId() {
  return crypto.randomUUID();
}

export function normalizeCode(code: string) {
  return code.trim().toUpperCase();
}

export function isMobileViewport() {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
}

export const operationActionLabels: Record<string, string> = {
  CREATE: "建档",
  EDIT_PROFILE: "编辑档案",
  MOVE: "移动",
  REMOVE: "移出",
  CHECK_OUT: "出库",
  CHECK_IN: "入库",
  DISCARD: "废弃",
  RESTORE: "恢复",
  HARD_DELETE: "永久删除",
  CATEGORY_CREATE: "新建分类",
  CATEGORY_EDIT: "编辑分类",
  CATEGORY_REASSIGN: "迁移分类引用",
  CATEGORY_DELETE: "删除分类",
  TAG_CREATE: "新建标签",
  TAG_EDIT: "编辑标签",
  TAG_DELETE: "删除标签",
};

export function formatOperationSummary(action: string, summary: string) {
  const label = operationActionLabels[action];
  return label && summary.startsWith(action)
    ? `${label}${summary.slice(action.length)}`
    : summary;
}
