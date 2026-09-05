import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import {
  CreateNodeSchema,
  DeleteNodeSchema,
  OperationInputSchema,
  PatchProfileSchema,
  PrintCreateSchema,
  RequestIdSchema,
  UploadInitSchema,
} from "@inventory-hub/contracts";
import { loadConfig, type InventoryConfigInput } from "../config.js";
import { InventoryDatabase } from "../db/database.js";
import { SCHEMA_VERSION } from "../db/schema.js";
import { AppError } from "../errors.js";
import { AuthService } from "../services/auth.js";
import { IdempotencyService, type RequestIdentity } from "../services/idempotency.js";
import { InventoryService } from "../services/inventory.js";
import { MediaService } from "../services/media.js";
import { NodeService } from "../services/nodes.js";
import { PrintService } from "../services/print.js";
import { TaxonomyService } from "../services/taxonomy.js";

interface RequestAuth { userId: string; username: string; sessionId: string; csrfToken: string; expiresAt: string; rawToken: string }

export interface InventoryServer extends FastifyInstance {
  inventory: {
    database: InventoryDatabase;
    config: ReturnType<typeof loadConfig>;
  };
}

const publicRoutes = new Set([
  "/api/v1/health/live",
  "/api/v1/health/ready",
  "/api/v1/setup/status",
  "/api/v1/setup",
  "/api/v1/auth/login",
  "/api/v1/print-executors/claim-pairing",
]);

export const createInventoryServer = (configInput: InventoryConfigInput = {}): InventoryServer => {
  const config = loadConfig(configInput);
  const database = new InventoryDatabase(config);
  const auth = new AuthService(database, config);
  const idempotency = new IdempotencyService(database);
  const media = new MediaService(database);
  const nodes = new NodeService(database, idempotency, media);
  const inventory = new InventoryService(database, idempotency);
  const taxonomy = new TaxonomyService(database, idempotency);
  const printing = new PrintService(database, idempotency, config.simulatePrinting, config.appMode);
  const https = config.tlsCertPath && config.tlsKeyPath ? { cert: readFileSync(config.tlsCertPath), key: readFileSync(config.tlsKeyPath) } : undefined;
  const publicHttps = config.protocol === "https" || config.appOrigins.some((origin) => origin.startsWith("https://"));
  const secureContext = publicHttps || config.host === "127.0.0.1" || config.host === "localhost";
  const app = Fastify({ logger: config.logLevel === "silent" ? false : { level: config.logLevel }, bodyLimit: 30 * 1024 * 1024, trustProxy: config.trustedProxy ? 1 : false, ...(https ? { https } : {}) }) as unknown as InventoryServer;
  app.inventory = { database, config };
  const cleanupTimer = setInterval(() => void media.processCleanupJobs().catch((error) => app.log.error({ err: error }, "media cleanup failed")), 5_000);
  cleanupTimer.unref();

  app.addContentTypeParser(["application/octet-stream", "image/jpeg", "image/png", "image/webp"], { parseAs: "buffer", bodyLimit: 25 * 1024 * 1024 }, (_request, body, done) => done(null, body));

  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?")[0] ?? request.url;
    if (!path.startsWith("/api/v1") || publicRoutes.has(path)) return;
    if (isDeviceRoute(path)) return;
    const rawToken = auth.parseCookie(request.headers.cookie);
    const context = auth.authenticate(rawToken);
    (request as any).auth = { ...context, rawToken: rawToken! } satisfies RequestAuth;
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      auth.assertCsrf(rawToken, firstHeader(request.headers["x-csrf-token"]));
      const origin = request.headers.origin;
      if (origin && config.appOrigins.length && !config.appOrigins.includes(origin)) throw new AppError("CSRF_INVALID", "请求来源不在允许列表");
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const requestId = firstHeader(request.headers["idempotency-key"]) ?? request.id;
    if (error instanceof ZodError) {
      const fields: Record<string, string[]> = {};
      for (const issue of error.issues) {
        const key = issue.path.join(".") || "body";
        (fields[key] ??= []).push(issue.message);
      }
      return reply.status(422).send(failure("VALIDATION_ERROR", "请求内容校验失败", requestId, false, undefined, fields));
    }
    if (error instanceof AppError) return reply.status(error.statusCode).send(failure(error.code, error.message, requestId, error.retryable, error.details, error.fields));
    const sqliteCode = (error as any)?.code as string | undefined;
    if (sqliteCode?.startsWith("SQLITE_CONSTRAINT")) return reply.status(409).send(failure("REFERENCE_CONFLICT", "数据约束冲突", requestId, false));
    request.log.error({ err: error }, "request failed");
    return reply.status(500).send(failure("INTERNAL_ERROR", "服务处理失败", requestId, false));
  });

  app.get("/api/v1/health/live", async (request) => success({ status: "live" }, request.id));
  app.get("/api/v1/health/ready", async (request, reply) => {
    try {
      const quickCheck = database.quickCheck();
      if (quickCheck !== "ok") return reply.status(503).send(failure("DB_UNAVAILABLE", "数据库完整性检查未通过", request.id, true));
      return success({ status: "ready", schemaVersion: SCHEMA_VERSION, sqliteVersion: database.sqliteVersion, dataRevision: database.dataRevision }, request.id);
    } catch { return reply.status(503).send(failure("DB_UNAVAILABLE", "数据库尚未就绪", request.id, true)); }
  });
  app.get("/api/v1/setup/status", async (request) => success({
    initialized: auth.initialized,
    localSetupAllowed: config.appMode !== "server",
    setupTokenRequired: config.appMode !== "server" && Boolean(config.setupToken),
    reason: config.appMode === "server" && !auth.initialized ? "服务器模式请先运行本机管理员初始化命令" : undefined,
  }, request.id));
  app.post("/api/v1/setup", async (request) => {
    const body = z.object({
      username: z.string().trim().min(3).max(32),
      password: z.string().min(12).max(128),
      setupToken: z.string().optional(),
      mediaDirectoryToken: z.string().min(1).optional(),
    }).parse(request.body);
    if (config.appMode === "server") {
      throw new AppError("DESKTOP_ONLY", "服务器模式必须通过本机管理命令完成首次设置");
    } else if (config.setupToken) {
      if (body.setupToken !== config.setupToken) throw new AppError("DESKTOP_ONLY", "首次设置凭证无效");
    } else if (!isLoopbackAddress(request.ip)) {
      throw new AppError("DESKTOP_ONLY", "首次设置只能在本机完成");
    }
    if (auth.initialized) throw new AppError("INVALID_STATE", "系统已经完成初始化");
    const migrationPlan = body.mediaDirectoryToken ? await media.preflightMigration(body.mediaDirectoryToken) : null;
    const user = auth.setup(body.username, body.password);
    let storageMigration: unknown = null;
    if (migrationPlan && body.mediaDirectoryToken) {
      try { storageMigration = await media.startMigration(body.mediaDirectoryToken, migrationPlan.id); }
      catch (error) {
        storageMigration = {
          id: migrationPlan.id,
          state: "FAILED",
          errorCode: error instanceof AppError ? error.code : "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : "图片目录迁移失败",
        };
      }
    }
    return success({ ...user, storageMigration }, request.id);
  });
  app.post("/api/v1/auth/login", async (request, reply) => {
    const body = z.object({ username: z.string(), password: z.string() }).parse(request.body);
    const result = auth.login(body.username, body.password, `${request.ip}:${body.username.trim().toLocaleLowerCase()}`);
    reply.header("Set-Cookie", auth.cookieHeader(result.token));
    return success({ user: result.user, csrfToken: result.csrfToken, expiresAt: result.expiresAt }, request.id);
  });
  app.post("/api/v1/auth/logout", async (request, reply) => {
    const context = requestAuth(request);
    auth.logout(context.rawToken);
    reply.header("Set-Cookie", auth.cookieHeader("", true)).status(204).send();
  });
  app.get("/api/v1/auth/me", async (request) => {
    const context = requestAuth(request);
    return success({ user: { id: context.userId, username: context.username }, csrfToken: context.csrfToken, expiresAt: context.expiresAt }, request.id);
  });
  app.patch("/api/v1/auth/password", async (request, reply) => {
    const body = z.object({ currentPassword: z.string(), newPassword: z.string() }).parse(request.body);
    auth.changePassword(requestAuth(request).userId, body.currentPassword, body.newPassword);
    reply.header("Set-Cookie", auth.cookieHeader("", true));
    return success({ changed: true, reauthenticationRequired: true }, request.id);
  });
  app.post("/api/v1/auth/revoke-others", async (request) => {
    const body = z.object({ currentPassword: z.string() }).parse(request.body);
    const context = requestAuth(request);
    auth.revokeOthers(context.userId, context.sessionId, body.currentPassword);
    return success({ revoked: true }, request.id);
  });

  app.get("/api/v1/capabilities", async (request) => success({
    appMode: config.appMode,
    deploymentMode: config.appMode === "development" ? "web" : config.appMode,
    desktopBridge: config.appMode === "desktop",
    camera: secureContext,
    printing: true,
    simulatedPrinting: config.simulatePrinting,
    supportedUploadFormats: ["image/jpeg", "image/png", "image/webp"],
    uploadMaxBytes: 25 * 1024 * 1024,
    serviceName: "Inventory Hub",
    actions: ["MOVE", "REMOVE", "CHECK_OUT", "CHECK_IN", "DISCARD", "RESTORE"],
    upload: { maxFiles: 5, maxBytes: 25 * 1024 * 1024, supportedFormats: ["image/jpeg", "image/png", "image/webp"] },
    printCapabilities: { simulator: config.simulatePrinting, nativeAvailable: !config.simulatePrinting },
    protocol: publicHttps ? "https" : config.protocol,
    serviceProtocol: config.protocol,
    secureContext,
    mobileCameraRequiresTrustedHttps: true,
    lan: config.lanOrigin ? {
      enabled: true,
      protocol: "https",
      host: new URL(config.lanOrigin).hostname,
      port: Number(new URL(config.lanOrigin).port || 443),
      url: config.lanOrigin,
    } : { enabled: false },
  }, request.id));
  app.get("/api/v1/changes", async (request) => {
    const sinceRevision = z.coerce.number().int().min(0).default(0).parse((request.query as any).sinceRevision);
    return success({ changed: database.dataRevision > sinceRevision, dataRevision: database.dataRevision }, request.id);
  });
  app.get("/api/v1/dashboard", async (request) => success(nodes.dashboard(), request.id));
  app.get("/api/v1/items", async (request) => {
    const result = nodes.listItems(request.query as any);
    return success(result, request.id, result.nextCursor);
  });
  app.get("/api/v1/search", async (request) => {
    const query = request.query as any;
    const items = nodes.listItems({ ...query, limit: query.limit ?? 20 });
    const locations = nodes.listLocations({ ...query, limit: query.limit ?? 20 });
    return success({ items: items.items, locations: locations.items }, request.id);
  });
  app.post("/api/v1/nodes", async (request) => {
    const body = CreateNodeSchema.parse(request.body);
    return success(await runWrite(request, idempotency, body, (identity) => nodes.create(identity, body)), writeRequestId(request));
  });
  app.get<{ Params: { id: string } }>("/api/v1/nodes/:id", async (request) => success(nodes.detail(request.params.id), request.id));
  app.patch<{ Params: { id: string } }>("/api/v1/nodes/:id", async (request) => {
    const body = PatchProfileSchema.parse(request.body);
    return success(await runWrite(request, idempotency, body, (identity) => nodes.patch(identity, request.params.id, body)), writeRequestId(request));
  });
  app.delete<{ Params: { id: string } }>("/api/v1/nodes/:id", async (request) => {
    const body = DeleteNodeSchema.parse(request.body);
    return success(await runWrite(request, idempotency, body, (identity) => nodes.delete(identity, request.params.id, body)), writeRequestId(request));
  });
  app.put<{ Params: { id: string } }>("/api/v1/nodes/:id/images", async (request) => {
    const body = z.object({ expectedVersion: z.number().int().positive(), entries: z.array(z.union([z.object({ imageId: z.string().uuid() }), z.object({ uploadId: z.string().uuid() })])).max(5) }).parse(request.body);
    const patch = PatchProfileSchema.parse({ expectedVersion: body.expectedVersion, images: body.entries });
    return success(await runWrite(request, idempotency, body, (identity) => nodes.patch(identity, request.params.id, patch)), writeRequestId(request));
  });
  app.get("/api/v1/locations", async (request) => {
    const result = nodes.listLocations(request.query as any);
    return success(result, request.id, result.nextCursor);
  });
  app.get<{ Params: { id: string } }>("/api/v1/nodes/:id/contents", async (request) => {
    const query = request.query as any;
    const result = nodes.contents(request.params.id, query.recursive !== "false", Math.min(Number(query.limit) || 100, 100), query.cursor, query.treeToken);
    return success(result, request.id, result.nextCursor);
  });
  app.get<{ Params: { code: string } }>("/api/v1/codes/:code", async (request) => success(nodes.byCode(request.params.code), request.id));
  app.get<{ Params: { code: string } }>("/api/v1/codes/:code/barcode", async (request, reply) => {
    const node = nodes.byCode(request.params.code);
    reply.type("image/png").header("Cache-Control", "private, no-store").header("X-Content-Type-Options", "nosniff");
    return printing.barcodePng(node.code, false);
  });

  app.post("/api/v1/inventory/preview", async (request) => success(inventory.preview(OperationInputSchema.parse(request.body)), request.id));
  app.post("/api/v1/inventory/operations", async (request) => {
    const body = OperationInputSchema.parse(request.body);
    return success(await runWrite(request, idempotency, body, (identity) => inventory.commit(identity, body)), writeRequestId(request));
  });
  app.get("/api/v1/operations", async (request) => {
    const result = nodes.operations(request.query as any);
    return success(result, request.id, result.nextCursor);
  });
  app.get<{ Params: { id: string } }>("/api/v1/operations/:id", async (request) => success(nodes.operationDetail(request.params.id), request.id));
  app.get<{ Params: { requestId: string } }>("/api/v1/requests/:requestId", async (request) => {
    const result = idempotency.get(requestAuth(request).userId, RequestIdSchema.parse(request.params.requestId));
    if (!result) throw new AppError("NOT_FOUND", "请求尚未登记");
    return success(result, request.id);
  });

  app.post("/api/v1/uploads", async (request) => success(media.init(requestAuth(request).userId, UploadInitSchema.parse(request.body)), request.id));
  app.put<{ Params: { id: string } }>("/api/v1/uploads/:id/content", async (request, reply) => {
    const result = await media.acceptContent(requestAuth(request).userId, request.params.id, request.body as Buffer);
    return reply.status(202).send(success(result, request.id));
  });
  app.get<{ Params: { id: string } }>("/api/v1/uploads/:id", async (request) => success(media.get(requestAuth(request).userId, request.params.id), request.id));
  app.delete<{ Params: { id: string } }>("/api/v1/uploads/:id", async (request, reply) => { media.cancel(requestAuth(request).userId, request.params.id); reply.status(204).send(); });
  app.get<{ Params: { id: string } }>("/api/v1/images/:id", async (request, reply) => {
    const variant = z.enum(["main", "thumb"]).default("main").parse((request.query as any).variant);
    const bytes = await media.readImage(request.params.id, variant);
    reply.type("image/webp").header("X-Content-Type-Options", "nosniff").header("Cache-Control", "private, no-store");
    return bytes;
  });
  app.get<{ Params: { id: string } }>("/api/v1/images/:id/download", async (request, reply) => {
    const bytes = await media.readImage(request.params.id, "main");
    reply.type("image/webp").header("Content-Disposition", `attachment; filename="image-${request.params.id}.webp"`).header("Cache-Control", "private, no-store");
    return bytes;
  });

  app.get("/api/v1/categories", async (request) => success(taxonomy.categories(), request.id));
  app.post("/api/v1/categories", async (request) => {
    const body = z.object({ name: z.string().trim().min(1).max(3), parentId: z.string().uuid().optional() }).parse(request.body);
    return success(await runWrite(request, idempotency, body, (identity) => taxonomy.createCategory(identity, body)), writeRequestId(request));
  });
  app.patch<{ Params: { id: string } }>("/api/v1/categories/:id", async (request) => {
    const body = z.object({ expectedVersion: z.number().int().positive(), name: z.string().trim().min(1).max(3).optional(), parentId: z.string().uuid().nullable().optional() }).parse(request.body);
    return success(await runWrite(request, idempotency, body, (identity) => taxonomy.patchCategory(identity, request.params.id, body)), writeRequestId(request));
  });
  app.delete<{ Params: { id: string } }>("/api/v1/categories/:id", async (request) => {
    const body = z.object({ expectedVersion: z.number().int().positive() }).parse(request.body);
    return success(await runWrite(request, idempotency, body, (identity) => taxonomy.deleteCategory(identity, request.params.id, body.expectedVersion)), writeRequestId(request));
  });
  app.post<{ Params: { id: string } }>("/api/v1/categories/:id/reassign", async (request) => {
    const body = z.object({ targetCategoryId: z.string().uuid(), expectedVersion: z.number().int().positive(), previewCount: z.number().int().min(0), referenceToken: z.string() }).parse(request.body);
    return success(await runWrite(request, idempotency, body, (identity) => taxonomy.reassignCategory(identity, request.params.id, body)), writeRequestId(request));
  });
  app.get("/api/v1/tags", async (request) => success(taxonomy.tags(), request.id));
  app.post("/api/v1/tags", async (request) => {
    const body = z.object({ name: z.string().trim().min(1).max(120) }).parse(request.body);
    return success(await runWrite(request, idempotency, body, (identity) => taxonomy.createTag(identity, body.name)), writeRequestId(request));
  });
  app.patch<{ Params: { id: string } }>("/api/v1/tags/:id", async (request) => {
    const body = z.object({ name: z.string().trim().min(1).max(120), expectedVersion: z.number().int().positive() }).parse(request.body);
    return success(await runWrite(request, idempotency, body, (identity) => taxonomy.patchTag(identity, request.params.id, body)), writeRequestId(request));
  });
  app.delete<{ Params: { id: string } }>("/api/v1/tags/:id", async (request) => {
    const body = z.object({ expectedVersion: z.number().int().positive(), confirmName: z.string(), referenceToken: z.string() }).parse(request.body);
    return success(await runWrite(request, idempotency, body, (identity) => taxonomy.deleteTag(identity, request.params.id, body)), writeRequestId(request));
  });
  app.get("/api/v1/specifications", async (request) => success(taxonomy.specifications(request.query as Record<string, unknown>), request.id));
  app.post("/api/v1/specifications", async (request) => {
    const body = z.object({ name: z.string().trim().min(1).max(120) }).parse(request.body);
    return success(await runWrite(request, idempotency, body, (identity) => taxonomy.createSpecification(identity, body.name)), writeRequestId(request));
  });
  app.patch<{ Params: { id: string } }>("/api/v1/specifications/:id", async (request) => {
    const body = z.object({ name: z.string().trim().min(1).max(120), expectedVersion: z.number().int().positive() }).parse(request.body);
    return success(await runWrite(request, idempotency, body, (identity) => taxonomy.patchSpecification(identity, request.params.id, body)), writeRequestId(request));
  });
  app.delete<{ Params: { id: string } }>("/api/v1/specifications/:id", async (request) => {
    const body = z.object({ expectedVersion: z.number().int().positive(), confirmName: z.string(), referenceToken: z.string() }).parse(request.body);
    return success(await runWrite(request, idempotency, body, (identity) => taxonomy.deleteSpecification(identity, request.params.id, body)), writeRequestId(request));
  });

  app.get("/api/v1/print-jobs", async (request) => success(printing.list(request.query as any), request.id));
  app.post("/api/v1/print-jobs", async (request) => {
    const body = PrintCreateSchema.parse(request.body);
    return success(await runWrite(request, idempotency, body, (identity) => printing.create(identity, body)), writeRequestId(request));
  });
  app.get<{ Params: { id: string } }>("/api/v1/print-jobs/:id", async (request) => success(printing.detail(request.params.id), request.id));
  app.post<{ Params: { id: string } }>("/api/v1/print-jobs/:id/cancel-pending", async (request) => {
    const body = request.body ?? {};
    return success(await runWrite(request, idempotency, body, (identity) => printing.cancelPending(identity, request.params.id)), writeRequestId(request));
  });
  app.post<{ Params: { id: string } }>("/api/v1/print-jobs/:id/resume", async (request) => {
    const body = request.body ?? {};
    return success(await runWrite(request, idempotency, body, (identity) => printing.resume(identity, request.params.id)), writeRequestId(request));
  });
  app.post<{ Params: { id: string } }>("/api/v1/print-jobs/:id/simulate", async (request) => {
    const body = z.object({ failOrdinal: z.number().int().positive().optional(), unknownOrdinal: z.number().int().positive().optional() }).default({}).parse(request.body ?? {});
    return success(await runWrite(request, idempotency, body, (identity) => printing.simulate(identity, request.params.id, body.failOrdinal, body.unknownOrdinal)), writeRequestId(request));
  });
  app.post<{ Params: { id: string } }>("/api/v1/print-items/:id/retry", async (request) => {
    const body = z.object({ expectedState: z.literal("FAILED").optional() }).default({}).parse(request.body ?? {});
    return success(await runWrite(request, idempotency, body, (identity) => printing.retry(identity, request.params.id)), writeRequestId(request));
  });
  app.post<{ Params: { id: string } }>("/api/v1/print-items/:id/resolve", async (request) => {
    const body = z.object({ conclusion: z.enum(["ACCEPTED", "NOT_ACCEPTED"]), evidence: z.string().max(1000), acknowledgedByUser: z.literal(true) }).parse(request.body);
    return success(await runWrite(request, idempotency, body, (identity) => printing.resolveUnknown(identity, request.params.id, body)), writeRequestId(request));
  });
  app.post<{ Params: { id: string } }>("/api/v1/print-jobs/:id/reprint", async (request) => {
    const body = z.object({ itemIds: z.array(z.string().uuid()).min(1).max(100), acknowledgeDuplicateRisk: z.literal(true) }).parse(request.body);
    return success(await runWrite(request, idempotency, body, (identity) => printing.reprint(identity, request.params.id, body.itemIds, body.acknowledgeDuplicateRisk)), writeRequestId(request));
  });
  app.get("/api/v1/print-executors", async (request) => success(printing.listExecutors(), request.id));
  app.post("/api/v1/print-executors/pairing", async (request) => success(printing.createPairing(requestAuth(request).userId), request.id));
  app.post("/api/v1/print-executors/claim-pairing", async (request) => {
    const body = z.object({ code: z.string().regex(/^\d{6}$/), deviceId: z.string().min(1).max(120), name: z.string().min(1).max(120), capabilities: z.record(z.unknown()).default({}) }).parse(request.body);
    return success(printing.claimPairing(body, request.ip), request.id);
  });
  app.post("/api/v1/print-executors/heartbeat", async (request) => {
    const body = z.object({ capabilities: z.record(z.unknown()).optional() }).default({}).parse(request.body ?? {});
    return success(printing.heartbeat(bearerToken(request), body.capabilities), request.id);
  });
  app.post("/api/v1/print-executors/claim", async (request) => success(printing.claimNext(bearerToken(request)), request.id));
  app.post<{ Params: { id: string } }>("/api/v1/print-executors/items/:id/report", async (request) => {
    const body = z.object({ attemptNo: z.number().int().positive(), claimToken: z.string().uuid(), state: z.enum(["SUBMITTED", "FAILED", "UNKNOWN"]), evidence: z.string().max(1000).optional(), osJobId: z.string().max(200).optional() }).parse(request.body);
    return success(printing.report(bearerToken(request), request.params.id, body), request.id);
  });
  app.post("/api/v1/print-native/claim", async (request) => {
    if (config.appMode !== "desktop") throw new AppError("DESKTOP_ONLY", "本机打印领取接口只能由桌面应用使用");
    const body = z.object({}).parse(request.body ?? {});
    return success(await runWrite(request, idempotency, body, (identity) => printing.claimLocalNative(identity)), writeRequestId(request));
  });
  app.post<{ Params: { id: string } }>("/api/v1/print-native/items/:id/report", async (request) => {
    if (config.appMode !== "desktop") throw new AppError("DESKTOP_ONLY", "本机打印回报接口只能由桌面应用使用");
    const body = z.object({ attemptNo: z.number().int().positive(), claimToken: z.string().uuid(), state: z.enum(["SUBMITTED", "FAILED", "UNKNOWN"]), evidence: z.string().max(1000).optional(), osJobId: z.string().max(200).optional() }).parse(request.body);
    return success(await runWrite(request, idempotency, body, (identity) => printing.reportLocalNative(identity, request.params.id, body)), writeRequestId(request));
  });
  app.post<{ Params: { id: string } }>("/api/v1/print-jobs/:id/local/claim", async (request) => {
    if (config.appMode !== "desktop") throw new AppError("DESKTOP_ONLY", "本机打印领取接口只能由桌面应用使用");
    const body = z.object({ executorId: z.literal("local-native") }).parse(request.body);
    const claimed = await runWrite(request, idempotency, body, (identity) => printing.claimLocalNativeForJob(identity, request.params.id));
    if (!claimed.item) return success({ item: null }, writeRequestId(request));
    const payload = claimed.item.payload;
    return success({
      item: {
        id: claimed.item.id,
        code: payload.node.code,
        name: payload.node.name,
        type: payload.node.type,
        copyIndex: payload.copyIndex - 1,
        ordinal: claimed.item.ordinal,
        attemptNo: claimed.item.attemptNo,
        paper: payload.paper,
      },
      leaseToken: claimed.item.claimToken,
    }, writeRequestId(request));
  });
  app.post<{ Params: { id: string } }>("/api/v1/print-items/:id/local/report", async (request) => {
    if (config.appMode !== "desktop") throw new AppError("DESKTOP_ONLY", "本机打印回报接口只能由桌面应用使用");
    const body = z.object({
      executorId: z.literal("local-native"),
      leaseToken: z.string().uuid(),
      outcome: z.enum(["SUBMITTED", "FAILED", "UNKNOWN"]),
      message: z.string().max(1000).optional(),
      osJobId: z.string().max(200).optional(),
    }).parse(request.body);
    return success(await runWrite(request, idempotency, body, (identity) => printing.reportLocalNativeByLease(identity, request.params.id, body)), writeRequestId(request));
  });
  app.delete<{ Params: { id: string } }>("/api/v1/print-executors/:id", async (request) => success(printing.revokeExecutor(request.params.id), request.id));

  app.get("/api/v1/storage/status", async (request) => {
    const root = database.activeRoot;
    const pending = (database.db.prepare("SELECT count(*) count FROM cleanup_jobs WHERE state<>'REMOVED'").get() as any).count;
    return success({ state: root.state, configured: true, cleanupPending: pending, mediaRootAccessible: existsSync(root.absolutePath) }, request.id);
  });
  app.post("/api/v1/storage/migrations/preflight", async (request) => {
    if (config.appMode !== "desktop" && config.appMode !== "development") throw new AppError("DESKTOP_ONLY", "图片目录只能在本机桌面端选择");
    const body = z.object({ selectionToken: z.string().min(1) }).parse(request.body);
    return success(await media.preflightMigration(body.selectionToken), request.id);
  });
  app.post<{ Params: { id: string } }>("/api/v1/storage/migrations/:id/start", async (request) => {
    if (config.appMode !== "desktop" && config.appMode !== "development") throw new AppError("DESKTOP_ONLY", "图片目录只能在本机桌面端迁移");
    const body = z.object({ selectionToken: z.string().min(1) }).parse(request.body);
    return success(await media.startMigration(body.selectionToken, request.params.id), request.id);
  });
  app.get<{ Params: { id: string } }>("/api/v1/storage/migrations/:id", async (request) => success(media.migrationStatus(request.params.id), request.id));
  app.post<{ Params: { id: string } }>("/api/v1/storage/migrations/:id/cancel", async (request) => success(media.cancelMigration(request.params.id), request.id));
  app.post<{ Params: { id: string } }>("/api/v1/storage/migrations/:id/cleanup-old-copy", async (request) => {
    const body = z.object({ confirmation: z.literal("DELETE_OLD_COPY") }).parse(request.body);
    return success(await media.cleanupOldCopy(request.params.id, body.confirmation), request.id);
  });
  app.get("/api/v1/cleanup-jobs", async (request) => success({ items: database.db.prepare(`SELECT id,kind,state,attempts,next_attempt_at nextAttemptAt,last_error lastError,created_at createdAt,updated_at updatedAt
    FROM cleanup_jobs ORDER BY created_at DESC LIMIT 100`).all().map((row: any) => ({ ...row, nextAttemptAt: new Date(row.nextAttemptAt).toISOString(), createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() })) }, request.id));
  app.post("/api/v1/cleanup-jobs/run", async (request) => success({ processed: await media.processCleanupJobs() }, request.id));
  app.get("/api/v1/settings/runtime", async (request) => success({ appMode: config.appMode, host: config.host, port: config.port, protocol: publicHttps ? "https" : config.protocol, serviceProtocol: config.protocol, secureContext, sqliteVersion: database.sqliteVersion, schemaVersion: SCHEMA_VERSION, dataRevision: database.dataRevision, lanEnabled: Boolean(config.lanOrigin), url: config.lanOrigin }, request.id));

  if (config.staticRoot) registerStaticSpa(app, config.staticRoot);
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.status(404).send(failure("NOT_FOUND", "接口不存在", request.id, false));
    return reply.status(404).send("Not found");
  });
  app.addHook("onClose", async () => {
    clearInterval(cleanupTimer);
    database.close();
  });
  return app;
};

export const startInventoryServer = async (configInput: InventoryConfigInput = {}) => {
  const app = createInventoryServer(configInput);
  const address = await app.listen({ host: app.inventory.config.host, port: app.inventory.config.port });
  return { app, address, close: () => app.close() };
};

const requestAuth = (request: FastifyRequest): RequestAuth => {
  const context = (request as any).auth as RequestAuth | undefined;
  if (!context) throw new AppError("UNAUTHENTICATED", "请先登录");
  return context;
};

const writeRequestId = (request: FastifyRequest): string => RequestIdSchema.parse(firstHeader(request.headers["idempotency-key"]));
const writeIdentity = (request: FastifyRequest, payload: unknown): RequestIdentity => ({
  userId: requestAuth(request).userId,
  requestId: writeRequestId(request),
  method: request.method,
  route: request.url.split("?")[0] ?? request.url,
  payload,
});
const runWrite = async <T>(request: FastifyRequest, service: IdempotencyService, payload: unknown, callback: (identity: RequestIdentity) => T | Promise<T>): Promise<T> => {
  const identity = writeIdentity(request, payload);
  const existing = service.lookup(identity);
  if (existing !== undefined) return existing as T;
  service.begin(identity);
  try { return await callback(identity); }
  catch (error) {
    if (error instanceof AppError) service.persistRejected(identity, error);
    throw error;
  }
  finally { service.finish(identity); }
};

const success = <T>(data: T, requestId: string, nextCursor?: string | null) => ({
  data,
  meta: { requestId, serverTime: new Date().toISOString(), ...(nextCursor !== undefined ? { nextCursor } : {}) },
});
const failure = (code: any, message: string, requestId: string, retryable: boolean, details?: unknown, fields?: Record<string, string[]>) => ({
  error: { code, message, ...(fields ? { fields } : {}), ...(details !== undefined ? { details } : {}), retryable }, meta: { requestId },
});
const firstHeader = (value: string | string[] | undefined): string | undefined => Array.isArray(value) ? value[0] : value;
const isLoopbackAddress = (value: string): boolean => value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
const isDeviceRoute = (path: string): boolean => path === "/api/v1/print-executors/heartbeat" || path === "/api/v1/print-executors/claim" || /^\/api\/v1\/print-executors\/items\/[^/]+\/report$/.test(path);
const bearerToken = (request: FastifyRequest): string => {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) throw new AppError("UNAUTHENTICATED", "缺少打印执行器令牌");
  return authorization.slice(7);
};

const registerStaticSpa = (app: FastifyInstance, staticRoot: string): void => {
  const root = resolve(staticRoot);
  app.get("/*", async (request, reply) => {
    if (request.url.startsWith("/api/")) throw new AppError("NOT_FOUND", "接口不存在");
    const pathname = decodeURIComponent(request.url.split("?")[0] ?? request.url);
    const candidate = resolve(root, `.${pathname}`);
    if (!(candidate === root || candidate.startsWith(`${root}${sep}`))) throw new AppError("NOT_FOUND", "静态资源不存在");
    const path = existsSync(candidate) && extname(candidate) ? candidate : resolve(root, "index.html");
    if (!existsSync(path)) throw new AppError("NOT_FOUND", "静态页面尚未构建");
    reply.type(mimeType(path)).header("Cache-Control", extname(path) === ".html" ? "no-cache" : "public,max-age=31536000,immutable");
    return readFile(path);
  });
};

const mimeType = (path: string): string => ({
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".json": "application/json",
} as Record<string, string>)[extname(path)] ?? "application/octet-stream";
