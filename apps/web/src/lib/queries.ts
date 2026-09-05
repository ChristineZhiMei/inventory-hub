import { api } from "./api";
import type {
  Capabilities,
  Category,
  DashboardData,
  InventoryNode,
  Operation,
  PageData,
  PrintExecutor,
  PrintJob,
  RuntimeStatus,
  StorageStatus,
  Specification,
  Tag,
} from "./types";

function normalizeNode(node: InventoryNode): InventoryNode {
  return {
    ...node,
    images: node.images?.map((image) => ({
      ...image,
      url: image.url || image.mainUrl,
      thumbUrl: image.thumbUrl,
    })),
  };
}
function normalizePage(page: PageData<InventoryNode>): PageData<InventoryNode> {
  return {
    ...page,
    root: page.root ? normalizeNode(page.root) : undefined,
    items: page.items.map(normalizeNode),
  };
}

export const queries = {
  dashboard: async () => {
    const data = await api<DashboardData>("/dashboard");
    return { ...data, stagingItems: data.stagingItems.map(normalizeNode) };
  },
  search: async (q: string) => {
    const data = await api<{
      items: InventoryNode[];
      locations: InventoryNode[];
    }>(`/search?${new URLSearchParams({ q, limit: "50" })}`);
    return {
      items: data.items.map(normalizeNode),
      locations: data.locations.map(normalizeNode),
    };
  },
  capabilities: () => api<Capabilities>("/capabilities"),
  items: async (search = "") =>
    normalizePage(
      await api<PageData<InventoryNode>>(`/items${search ? `?${search}` : ""}`),
    ),
  locations: async (search = "") =>
    normalizePage(
      await api<PageData<InventoryNode>>(
        `/locations${search ? `?${search}` : ""}`,
      ),
    ),
  node: async (id: string) =>
    normalizeNode(await api<InventoryNode>(`/nodes/${id}`)),
  contents: async (id: string, recursive = true) =>
    normalizePage(
      await api<PageData<InventoryNode>>(
        `/nodes/${id}/contents?recursive=${recursive}&limit=100`,
      ),
    ),
  categories: () => api<PageData<Category> | Category[]>("/categories"),
  tags: () => api<PageData<Tag> | Tag[]>("/tags"),
  specifications: (search = "") =>
    api<PageData<Specification>>(`/specifications${search ? `?${search}` : ""}`),
  operations: (search = "") =>
    api<PageData<Operation>>(`/operations${search ? `?${search}` : ""}`),
  operation: async (id: string) => {
    const operation = await api<
      Omit<Operation, "targets"> & {
        targets?: Array<{
          nodeId: string;
          code: string;
          name?: string;
          directlyOperated: boolean;
          before?: unknown;
          after?: unknown;
          beforeSnapshot?: unknown;
          afterSnapshot?: unknown;
        }>;
      }
    >(`/operations/${id}`);
    const reversible = new Set([
      "MOVE",
      "REMOVE",
      "CHECK_OUT",
      "CHECK_IN",
      "DISCARD",
      "RESTORE",
    ]);
    return {
      ...operation,
      canReverse: operation.canReverse ?? reversible.has(operation.action),
      targets: operation.targets?.map((target) => ({
        ...target,
        before: target.before ?? target.beforeSnapshot,
        after: target.after ?? target.afterSnapshot,
      })),
    };
  },
  printJobs: () => api<PageData<PrintJob>>("/print-jobs"),
  printJob: (id: string) => api<PrintJob>(`/print-jobs/${id}`),
  printExecutors: () => api<PrintExecutor[]>("/print-executors"),
  storage: () => api<StorageStatus>("/storage/status"),
  runtime: () => api<RuntimeStatus>("/settings/runtime"),
};

export function pageItems<T>(value?: PageData<T> | T[]) {
  return Array.isArray(value) ? value : (value?.items ?? []);
}
