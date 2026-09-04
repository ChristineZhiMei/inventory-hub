import type { ApiErrorBody } from "./types";
import { createRequestId } from "./utils";

const API_PREFIX = import.meta.env.VITE_API_PREFIX || "/api/v1";

type Envelope<T> = { data: T; meta?: { requestId?: string; serverTime?: string; nextCursor?: string | null } };
type ErrorEnvelope = { error: ApiErrorBody; meta?: { requestId?: string } };

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: Record<string, string> = {},
    public details: Record<string, unknown> = {},
    public retryable = false,
    public requestId?: string,
  ) { super(message); this.name = "ApiError"; }
}

let csrfToken = "";
export function setCsrfToken(token?: string | null) { csrfToken = token || ""; }

export interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  idempotent?: boolean;
  idempotencyKey?: string;
  sensitive?: boolean;
  raw?: boolean;
}

type PendingRequest = { requestId: string; method: string; path: string; payload: string; createdAt: number };
const pendingStorageKey = "inventory-hub:unresolved-requests";
function readPending(): PendingRequest[] { try { return JSON.parse(localStorage.getItem(pendingStorageKey) || "[]") as PendingRequest[]; } catch { return []; } }
function writePending(items: PendingRequest[]) { localStorage.setItem(pendingStorageKey, JSON.stringify(items.slice(-20))); }
export function unresolvedRequests() { return readPending(); }
export function resolvePendingRequest(requestId: string) { writePending(readPending().filter((item) => item.requestId !== requestId)); }

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const isForm = options.body instanceof FormData || options.body instanceof Blob || options.body instanceof ArrayBuffer;
  if (options.body !== undefined && !isForm) headers.set("Content-Type", "application/json");
  if (csrfToken && options.method && !["GET", "HEAD", "OPTIONS"].includes(options.method)) headers.set("X-CSRF-Token", csrfToken);
  let requestIdentity: PendingRequest | undefined;
  if (options.idempotent) {
    const method = options.method || "POST";
    const payloadText = options.body === undefined ? "" : JSON.stringify(options.body);
    requestIdentity = options.sensitive ? undefined : readPending().find((item) => item.method === method && item.path === path && item.payload === payloadText);
    if (!requestIdentity) {
      requestIdentity = { requestId: options.idempotencyKey || createRequestId(), method, path, payload: payloadText, createdAt: Date.now() };
      if (!options.sensitive) writePending([...readPending(), requestIdentity]);
    }
    headers.set("Idempotency-Key", requestIdentity.requestId);
  }

  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, {
      ...options,
      headers,
      credentials: "include",
      body: options.body === undefined ? undefined : isForm ? options.body as BodyInit : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "无法连接 Inventory Hub 服务，请检查网络后重试", {}, {}, true, requestIdentity?.requestId);
  }

  if (options.raw && response.ok) return response as T;
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("json") ? await response.json() as Envelope<T> | ErrorEnvelope : undefined;
  if (!response.ok) {
    const failure = payload && "error" in payload ? payload.error : { code: `HTTP_${response.status}`, message: "请求处理失败" };
    if (requestIdentity && response.status < 500 && failure.code !== "DATABASE_BUSY" && failure.code !== "REQUEST_RUNNING") resolvePendingRequest(requestIdentity.requestId);
    const normalizedFields = Object.fromEntries(Object.entries(failure.fields || {}).map(([key, value]) => [key, Array.isArray(value) ? value.join("；") : value]));
    throw new ApiError(response.status, failure.code, failure.message, normalizedFields, failure.details, failure.retryable, payload?.meta?.requestId || requestIdentity?.requestId);
  }
  if (requestIdentity) resolvePendingRequest(requestIdentity.requestId);
  if (response.status === 204) return undefined as T;
  if (payload && "data" in payload) {
    const data = payload.data;
    if (data && typeof data === "object" && payload.meta?.nextCursor && !("nextCursor" in data)) {
      Object.assign(data, { nextCursor: payload.meta.nextCursor });
    }
    return data;
  }
  return payload as T;
}

export function errorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "发生未知错误";
}

export function imageUrl(id: string, variant: "main" | "thumb" = "thumb") {
  return `${API_PREFIX}/images/${encodeURIComponent(id)}?variant=${variant}`;
}
