import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import bwipjs from "bwip-js";
import type { PrintCreateInput } from "@inventory-hub/contracts";
import { labelBarcodeOptions, labelPaper } from "@inventory-hub/contracts";
import type { InventoryDatabase } from "../db/database.js";
import type { AppMode } from "../config.js";
import { getNode } from "../domain/model.js";
import { AppError, invariant } from "../errors.js";
import type { IdempotencyService, RequestIdentity } from "./idempotency.js";

const EXECUTOR_ONLINE_WINDOW_MS = 90_000;
const PAIRING_RATE_WINDOW_MS = 10 * 60_000;
const PRINT_CREATE_DEBOUNCE_MS = 2_000;

export class PrintService {
  private readonly pairingCreateAttempts = new Map<string, number[]>();
  private readonly pairingClaimAttempts = new Map<string, number[]>();
  private readonly recentPrintCreates = new Map<string, { jobId: string; expiresAt: number }>();

  constructor(
    private readonly database: InventoryDatabase,
    private readonly idempotency: IdempotencyService,
    private readonly simulator: boolean,
    private readonly appMode: AppMode,
  ) {}

  async barcodePng(code: string, includeText = true): Promise<Buffer> {
    return bwipjs.toBuffer({ ...labelBarcodeOptions, text: code, includetext: includeText, textxalign: "center" });
  }

  create(identity: RequestIdentity, input: PrintCreateInput): any {
    const replay = this.idempotency.lookup(identity);
    if (replay) return replay;
    const debounceKey = printCreateDebounceKey(identity.userId, input);
    const recent = this.recentPrintCreates.get(debounceKey);
    if (recent && recent.expiresAt > Date.now()) {
      return this.database.transaction(() => {
        const repeated = this.idempotency.lookup(identity);
        if (repeated) return repeated;
        const value = this.detail(recent.jobId, false);
        this.idempotency.persistSuccess(identity, value);
        return value;
      });
    }
    if (recent) this.recentPrintCreates.delete(debounceKey);
    const value = this.database.transaction(() => {
      const repeated = this.idempotency.lookup(identity);
      if (repeated) return repeated;
      if (input.executorId === "local-simulator") invariant(this.simulator, "EXECUTOR_OFFLINE", "当前未启用本机打印模拟器");
      else if (input.executorId === "local-native") invariant(this.appMode === "desktop", "DESKTOP_ONLY", "真实本机打印只能由桌面应用执行");
      else {
        const executor = this.database.db.prepare("SELECT state,last_seen_at lastSeenAt FROM print_executors WHERE id=?").get(input.executorId) as { state: string; lastSeenAt: number } | undefined;
        invariant(Boolean(executor && executor.state !== "REVOKED"), "EXECUTOR_OFFLINE", "打印执行器不存在或已撤销");
        invariant(executor!.state === "ONLINE" && executor!.lastSeenAt >= Date.now() - EXECUTOR_ONLINE_WINDOW_MS, "EXECUTOR_OFFLINE", "打印执行器已离线，请先恢复执行器心跳");
      }
      const nodes = input.nodeIds.map((id) => {
        const node = getNode(this.database.db, id);
        const categories = this.database.db.prepare(`SELECT c.id,c.name FROM categories c
          JOIN node_categories nc ON nc.category_id=c.id WHERE nc.node_id=?
          ORDER BY nc.sort_order,c.name,c.id`).all(id);
        const specifications = this.database.db.prepare(`SELECT s.id,s.name FROM specifications s
          JOIN node_specifications ns ON ns.specification_id=s.id WHERE ns.node_id=?
          ORDER BY ns.sort_order,s.name,s.id`).all(id);
        return { ...node, categories, specifications };
      });
      invariant(nodes.length * input.copies <= 2000, "VALIDATION_ERROR", "打印子任务不能超过 2000 张");
      const id = randomUUID();
      const now = Date.now();
      this.database.db.prepare(`INSERT INTO print_jobs(id,request_id,executor_id,printer_id,template_version,paused,created_at,updated_at)
        VALUES(?,?,?,?,1,0,?,?)`).run(id, identity.requestId, input.executorId, input.printerId, now, now);
      const insert = this.database.db.prepare(`INSERT INTO print_items(id,job_id,ordinal,node_id_snapshot,copy_index,payload_snapshot,state,attempt_count,acknowledged_unknown,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'QUEUED',0,0,?,?)`);
      let ordinal = 0;
      for (const node of nodes) {
        for (let copyIndex = 1; copyIndex <= input.copies; copyIndex += 1) {
          ordinal += 1;
          insert.run(randomUUID(), id, ordinal, node.id, copyIndex, JSON.stringify({
            node: {
              id: node.id,
              code: node.code,
              name: node.name,
              type: node.type,
              categories: node.categories,
              specifications: node.specifications,
            },
            copyIndex,
            templateId: input.templateId,
            templateVersion: 1,
            paper: { ...labelPaper(input.templateId), orientation: "landscape" },
            printerId: input.printerId,
            executorId: input.executorId,
            renderVersion: 1,
          }), now, now);
        }
      }
      if (this.simulator && input.executorId === "local-simulator") this.simulateAllSuccessful(id);
      this.database.bumpRevision();
      const value = this.detail(id, false);
      this.idempotency.persistSuccess(identity, value);
      return value;
    });
    this.rememberPrintCreate(debounceKey, value.id);
    return value;
  }

  list(query: Record<string, unknown>): any {
    this.recoverStaleClaims();
    const rows = this.database.db.prepare(`SELECT id,request_id requestId,executor_id executorId,printer_id printerId,paused,pause_reason pauseReason,created_at createdAt,updated_at updatedAt
      FROM print_jobs ORDER BY created_at DESC LIMIT 100`).all() as any[];
    return { items: rows.map((row) => ({ ...row, paused: Boolean(row.paused), status: this.aggregateStatus(row.id), counts: this.counts(row.id), createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() })), nextCursor: null };
  }

  detail(jobId: string, recover = true): any {
    if (recover) this.recoverStaleClaims();
    const job = this.database.db.prepare(`SELECT id,request_id requestId,executor_id executorId,printer_id printerId,paused,pause_reason pauseReason,related_job_id relatedJobId,
      created_at createdAt,updated_at updatedAt FROM print_jobs WHERE id=?`).get(jobId) as any;
    if (!job) throw new AppError("NOT_FOUND", "打印任务不存在");
    const items = this.database.db.prepare(`SELECT id,ordinal,node_id_snapshot nodeId,copy_index copyIndex,payload_snapshot payloadSnapshot,state,
      attempt_count attemptCount,related_item_id relatedItemId,acknowledged_unknown acknowledgedUnknown,created_at createdAt,updated_at updatedAt
      FROM print_items WHERE job_id=? ORDER BY ordinal`).all(jobId) as any[];
    return {
      ...job,
      paused: Boolean(job.paused),
      status: this.aggregateStatus(jobId),
      counts: this.counts(jobId),
      createdAt: new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
      items: items.map((item) => {
        const payload = JSON.parse(item.payloadSnapshot);
        const latestAttempt = this.database.db.prepare("SELECT error FROM print_attempts WHERE item_id=? ORDER BY attempt_no DESC LIMIT 1").get(item.id) as { error: string | null } | undefined;
        return { ...item, ordinal: item.ordinal - 1, copyIndex: item.copyIndex - 1, code: payload.node.code, name: payload.node.name, error: latestAttempt?.error ?? undefined, payloadSnapshot: payload, acknowledgedUnknown: Boolean(item.acknowledgedUnknown), createdAt: new Date(item.createdAt).toISOString(), updatedAt: new Date(item.updatedAt).toISOString() };
      }),
    };
  }

  cancelPending(identity: RequestIdentity, jobId: string): any {
    this.recoverStaleClaims();
    return this.write(identity, () => {
      this.detail(jobId, false);
      const cancellable = this.database.db.prepare("SELECT id FROM print_items WHERE job_id=? AND state IN ('QUEUED','FAILED')").all(jobId).map((row: any) => row.id);
      const changed = this.database.db.prepare("UPDATE print_items SET state='CANCELLED',updated_at=? WHERE job_id=? AND state IN ('QUEUED','FAILED')").run(Date.now(), jobId).changes;
      if (changed) this.database.bumpRevision();
      const remaining = this.database.db.prepare("SELECT id FROM print_items WHERE job_id=? AND state NOT IN ('CANCELLED','SUBMITTED')").all(jobId).map((row: any) => row.id);
      return { cancelledIds: cancellable, notCancelledIds: remaining, job: this.detail(jobId, false) };
    });
  }

  retry(identity: RequestIdentity, itemId: string): any {
    return this.write(identity, () => {
      const item = this.getItem(itemId);
      invariant(item.state === "FAILED", "INVALID_STATE", "只有明确失败的标签可以重试");
      this.database.db.prepare("UPDATE print_items SET state='QUEUED',updated_at=? WHERE id=?").run(Date.now(), itemId);
      this.database.bumpRevision();
      return this.getItem(itemId);
    });
  }

  resolveUnknown(identity: RequestIdentity, itemId: string, input: { conclusion: "ACCEPTED" | "NOT_ACCEPTED"; evidence: string; acknowledgedByUser: boolean }): any {
    return this.write(identity, () => {
      const item = this.getItem(itemId);
      invariant(item.state === "UNKNOWN" && input.acknowledgedByUser, "INVALID_STATE", "只有人工确认后才能核对未知结果");
      const state = input.conclusion === "ACCEPTED" ? "SUBMITTED" : "FAILED";
      this.database.db.prepare("UPDATE print_items SET state=?,acknowledged_unknown=1,updated_at=? WHERE id=?").run(state, Date.now(), itemId);
      this.database.db.prepare("UPDATE print_attempts SET state=?,finished_at=?,error=COALESCE(error,?) WHERE item_id=? AND attempt_no=?")
        .run(state, Date.now(), input.evidence, itemId, item.attemptCount);
      this.database.bumpRevision();
      return this.getItem(itemId);
    });
  }

  resume(identity: RequestIdentity, jobId: string): any {
    this.recoverStaleClaims();
    return this.write(identity, () => {
      const blockers = (this.database.db.prepare("SELECT count(*) count FROM print_items WHERE job_id=? AND ((state='UNKNOWN' AND acknowledged_unknown=0) OR state='FAILED')").get(jobId) as any).count;
      invariant(blockers === 0, "INVALID_STATE", "仍有失败或结果未知的标签未处理");
      const changed = this.database.db.prepare("UPDATE print_jobs SET paused=0,pause_reason=NULL,updated_at=? WHERE id=? AND (paused<>0 OR pause_reason IS NOT NULL)").run(Date.now(), jobId).changes;
      if (changed) this.database.bumpRevision();
      return this.detail(jobId, false);
    });
  }

  simulate(identity: RequestIdentity, jobId: string, failOrdinal?: number, unknownOrdinal?: number): any {
    invariant(this.simulator, "EXECUTOR_OFFLINE", "当前未启用打印模拟器");
    this.recoverStaleClaims();
    return this.write(identity, () => {
      const job = this.detail(jobId, false);
      invariant(!job.paused, "INVALID_STATE", "打印批次已暂停");
      const queued = this.database.db.prepare("SELECT id,ordinal,attempt_count attemptCount FROM print_items WHERE job_id=? AND state='QUEUED' ORDER BY ordinal").all(jobId) as any[];
      let changed = false;
      for (const item of queued) {
        const attemptNo = item.attemptCount + 1;
        const token = randomUUID();
        const now = Date.now();
        this.database.db.prepare("UPDATE print_items SET state='SENDING',attempt_count=?,claim_token=?,claimed_at=?,updated_at=? WHERE id=? AND state='QUEUED'")
          .run(attemptNo, token, now, now, item.id);
        this.database.db.prepare(`INSERT INTO print_attempts(id,item_id,attempt_no,state,claim_token,started_at) VALUES(?,?,?,'SENDING',?,?)`)
          .run(randomUUID(), item.id, attemptNo, token, now);
        const finalState = item.ordinal === unknownOrdinal ? "UNKNOWN" : item.ordinal === failOrdinal ? "FAILED" : "SUBMITTED";
        this.database.db.prepare("UPDATE print_items SET state=?,updated_at=? WHERE id=? AND claim_token=?").run(finalState, Date.now(), item.id, token);
        this.database.db.prepare("UPDATE print_attempts SET state=?,finished_at=?,os_job_id=?,error=? WHERE item_id=? AND attempt_no=? AND claim_token=?")
          .run(finalState, Date.now(), finalState === "SUBMITTED" ? `sim-${randomUUID()}` : null, finalState === "FAILED" ? "模拟器明确拒绝" : finalState === "UNKNOWN" ? "模拟回报丢失" : null, item.id, attemptNo, token);
        changed = true;
        if (finalState === "FAILED" || finalState === "UNKNOWN") {
          this.database.db.prepare("UPDATE print_jobs SET paused=1,pause_reason=?,updated_at=? WHERE id=?").run(finalState, Date.now(), jobId);
          break;
        }
      }
      if (changed) this.database.bumpRevision();
      return this.detail(jobId, false);
    });
  }

  reprint(identity: RequestIdentity, sourceJobId: string, itemIds: string[], acknowledgeDuplicateRisk: boolean): any {
    return this.write(identity, () => {
      invariant(acknowledgeDuplicateRisk, "VALIDATION_ERROR", "补打前必须确认重复出纸风险");
      const sourceJob = this.database.db.prepare("SELECT executor_id executorId,printer_id printerId,template_version templateVersion FROM print_jobs WHERE id=?").get(sourceJobId) as any;
      if (!sourceJob) throw new AppError("NOT_FOUND", "原打印批次不存在");
      invariant(itemIds.length > 0 && new Set(itemIds).size === itemIds.length, "VALIDATION_ERROR", "请选择不重复的标签子任务");
      const placeholders = itemIds.map(() => "?").join(",");
      const originals = this.database.db.prepare(`SELECT id,payload_snapshot payloadSnapshot,state FROM print_items WHERE job_id=? AND id IN (${placeholders}) ORDER BY ordinal`).all(sourceJobId, ...itemIds) as any[];
      invariant(originals.length === itemIds.length && originals.every((item) => item.state === "SUBMITTED" || item.state === "UNKNOWN"), "INVALID_STATE", "只有已接受或结果未知的标签可以补打");
      const id = randomUUID();
      const now = Date.now();
      this.database.db.prepare(`INSERT INTO print_jobs(id,request_id,executor_id,printer_id,template_version,paused,related_job_id,created_at,updated_at)
        VALUES(?,?,?,?,?,0,?,?,?)`).run(id, identity.requestId, sourceJob.executorId, sourceJob.printerId, sourceJob.templateVersion, sourceJobId, now, now);
      const insert = this.database.db.prepare(`INSERT INTO print_items(id,job_id,ordinal,node_id_snapshot,copy_index,payload_snapshot,state,attempt_count,related_item_id,acknowledged_unknown,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'QUEUED',0,?,0,?,?)`);
      originals.forEach((item, index) => {
        const payload = JSON.parse(item.payloadSnapshot);
        insert.run(randomUUID(), id, index + 1, payload.node.id, payload.copyIndex, item.payloadSnapshot, item.id, now, now);
        if (item.state === "UNKNOWN") this.database.db.prepare("UPDATE print_items SET acknowledged_unknown=1,updated_at=? WHERE id=?").run(now, item.id);
      });
      this.database.bumpRevision();
      return this.detail(id, false);
    });
  }

  createPairing(userId: string): any {
    this.assertRateLimit(this.pairingCreateAttempts, userId, 3, PAIRING_RATE_WINDOW_MS, "配对码申请过于频繁，请稍后再试");
    return this.database.transaction(() => {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const id = randomUUID();
      const now = Date.now();
      const expiresAt = now + 5 * 60_000;
      this.database.db.prepare("INSERT INTO print_pairings(id,created_by,code_hash,expires_at,created_at) VALUES(?,?,?,?,?)")
        .run(id, userId, digestToken(code), expiresAt, now);
      this.database.bumpRevision();
      return { pairingId: id, code, expiresAt: new Date(expiresAt).toISOString() };
    });
  }

  claimPairing(input: { code: string; deviceId: string; name: string; capabilities: unknown }, rateKey: string): any {
    this.assertRateLimit(this.pairingClaimAttempts, rateKey, 10, PAIRING_RATE_WINDOW_MS, "配对尝试过于频繁，请稍后再试");
    return this.database.transaction(() => {
      const pairing = this.database.db.prepare("SELECT id FROM print_pairings WHERE code_hash=? AND used_at IS NULL AND expires_at>?")
        .get(digestToken(input.code), Date.now()) as { id: string } | undefined;
      invariant(Boolean(pairing), "UNAUTHENTICATED", "配对码无效或已过期");
      const existing = this.database.db.prepare("SELECT id FROM print_executors WHERE device_id=?").get(input.deviceId) as { id: string } | undefined;
      const id = existing?.id ?? randomUUID();
      const token = randomBytes(32).toString("base64url");
      const now = Date.now();
      if (existing) {
        this.database.db.prepare("UPDATE print_executors SET name=?,token_hash=?,state='ONLINE',last_seen_at=?,capabilities=?,updated_at=? WHERE id=?")
          .run(input.name, digestToken(token), now, JSON.stringify(input.capabilities ?? {}), now, id);
      } else {
        this.database.db.prepare(`INSERT INTO print_executors(id,device_id,name,token_hash,state,last_seen_at,capabilities,created_at,updated_at)
          VALUES(?,?,?,?,'ONLINE',?,?,?,?)`).run(id, input.deviceId, input.name, digestToken(token), now, JSON.stringify(input.capabilities ?? {}), now, now);
      }
      this.database.db.prepare("UPDATE print_pairings SET used_at=? WHERE id=?").run(now, pairing!.id);
      this.database.bumpRevision();
      return { executorId: id, token, name: input.name };
    });
  }

  heartbeat(token: string, capabilities?: unknown): any {
    const executor = this.authenticateExecutor(token);
    return this.database.transaction(() => {
      const now = Date.now();
      this.database.db.prepare("UPDATE print_executors SET state='ONLINE',last_seen_at=?,capabilities=COALESCE(?,capabilities),updated_at=? WHERE id=?")
        .run(now, capabilities === undefined ? null : JSON.stringify(capabilities), now, executor.id);
      return { executorId: executor.id, state: "ONLINE", serverTime: new Date(now).toISOString() };
    });
  }

  claimNext(token: string): any {
    const executor = this.authenticateExecutor(token);
    return this.claimForExecutor(executor.id);
  }

  claimLocalNative(identity: RequestIdentity): any {
    invariant(this.appMode === "desktop", "DESKTOP_ONLY", "本机打印领取接口只能由桌面应用使用");
    return this.write(identity, () => this.claimForExecutor("local-native"));
  }

  claimLocalNativeForJob(identity: RequestIdentity, jobId: string): any {
    invariant(this.appMode === "desktop", "DESKTOP_ONLY", "本机打印领取接口只能由桌面应用使用");
    return this.write(identity, () => {
      const job = this.database.db.prepare("SELECT executor_id executorId FROM print_jobs WHERE id=?").get(jobId) as { executorId: string } | undefined;
      if (!job) throw new AppError("NOT_FOUND", "打印任务不存在");
      invariant(job.executorId === "local-native", "INVALID_STATE", "该打印任务不属于本机执行器");
      return this.claimForExecutor("local-native", jobId);
    });
  }

  private claimForExecutor(executorId: string, jobId?: string): any {
    this.recoverStaleClaims();
    return this.database.transaction(() => {
      const jobCondition = jobId ? "AND j.id=?" : "";
      const item = this.database.db.prepare(`SELECT i.id,i.job_id jobId,i.ordinal,i.attempt_count attemptCount,i.payload_snapshot payloadSnapshot
        FROM print_items i JOIN print_jobs j ON j.id=i.job_id
        WHERE j.executor_id=? ${jobCondition} AND j.paused=0 AND i.state='QUEUED'
          AND NOT EXISTS(
            SELECT 1 FROM print_items active_item JOIN print_jobs active_job ON active_job.id=active_item.job_id
            WHERE active_job.printer_id=j.printer_id AND active_item.state='SENDING'
          )
        ORDER BY j.created_at,i.ordinal LIMIT 1`).get(executorId, ...(jobId ? [jobId] : [])) as any;
      if (!item) return { item: null };
      const attemptNo = item.attemptCount + 1;
      const claimToken = randomUUID();
      const now = Date.now();
      const changed = this.database.db.prepare("UPDATE print_items SET state='SENDING',attempt_count=?,claim_token=?,claimed_at=?,updated_at=? WHERE id=? AND state='QUEUED'")
        .run(attemptNo, claimToken, now, now, item.id).changes;
      if (!changed) return { item: null };
      this.database.db.prepare("INSERT INTO print_attempts(id,item_id,attempt_no,state,claim_token,started_at) VALUES(?,?,?,'SENDING',?,?)")
        .run(randomUUID(), item.id, attemptNo, claimToken, now);
      this.database.bumpRevision();
      return { item: { id: item.id, jobId: item.jobId, ordinal: item.ordinal - 1, attemptNo, claimToken, payload: JSON.parse(item.payloadSnapshot) } };
    });
  }

  report(token: string, itemId: string, input: { attemptNo: number; claimToken: string; state: "SUBMITTED" | "FAILED" | "UNKNOWN"; evidence?: string | undefined; osJobId?: string | undefined }): any {
    const executor = this.authenticateExecutor(token);
    return this.reportForExecutor(executor.id, itemId, input);
  }

  reportLocalNative(identity: RequestIdentity, itemId: string, input: { attemptNo: number; claimToken: string; state: "SUBMITTED" | "FAILED" | "UNKNOWN"; evidence?: string | undefined; osJobId?: string | undefined }): any {
    invariant(this.appMode === "desktop", "DESKTOP_ONLY", "本机打印回报接口只能由桌面应用使用");
    return this.write(identity, () => this.reportForExecutor("local-native", itemId, input));
  }

  reportLocalNativeByLease(identity: RequestIdentity, itemId: string, input: { leaseToken: string; outcome: "SUBMITTED" | "FAILED" | "UNKNOWN"; message?: string | undefined; osJobId?: string | undefined }): any {
    invariant(this.appMode === "desktop", "DESKTOP_ONLY", "本机打印回报接口只能由桌面应用使用");
    return this.write(identity, () => {
      const current = this.database.db.prepare(`SELECT attempt_count attemptNo FROM print_items
        WHERE id=? AND state='SENDING' AND claim_token=?`).get(itemId, input.leaseToken) as { attemptNo: number } | undefined;
      invariant(Boolean(current), "REFERENCE_CONFLICT", "打印任务回报已过期或领取凭证无效");
      return this.reportForExecutor("local-native", itemId, {
        attemptNo: current!.attemptNo,
        claimToken: input.leaseToken,
        state: input.outcome,
        evidence: input.message,
        osJobId: input.osJobId,
      });
    });
  }

  private reportForExecutor(executorId: string, itemId: string, input: { attemptNo: number; claimToken: string; state: "SUBMITTED" | "FAILED" | "UNKNOWN"; evidence?: string | undefined; osJobId?: string | undefined }): any {
    this.recoverStaleClaims();
    return this.database.transaction(() => {
      const item = this.database.db.prepare(`SELECT i.id,i.job_id jobId,i.state,i.attempt_count attemptCount,i.claim_token claimToken,j.executor_id executorId
        FROM print_items i JOIN print_jobs j ON j.id=i.job_id WHERE i.id=?`).get(itemId) as any;
      if (!item) throw new AppError("NOT_FOUND", "打印标签任务不存在");
      invariant(item.executorId === executorId && item.state === "SENDING" && item.attemptCount === input.attemptNo && item.claimToken === input.claimToken,
        "REFERENCE_CONFLICT", "打印任务回报已过期或不属于当前执行器");
      const now = Date.now();
      this.database.db.prepare("UPDATE print_items SET state=?,updated_at=? WHERE id=? AND state='SENDING' AND claim_token=?")
        .run(input.state, now, itemId, input.claimToken);
      this.database.db.prepare("UPDATE print_attempts SET state=?,os_job_id=?,error=?,finished_at=? WHERE item_id=? AND attempt_no=? AND claim_token=?")
        .run(input.state, input.osJobId ?? null, input.evidence ?? null, now, itemId, input.attemptNo, input.claimToken);
      if (input.state === "FAILED" || input.state === "UNKNOWN") this.database.db.prepare("UPDATE print_jobs SET paused=1,pause_reason=?,updated_at=? WHERE id=?")
        .run(input.state, now, item.jobId);
      this.database.bumpRevision();
      return this.getItem(itemId);
    });
  }

  revokeExecutor(id: string): any {
    return this.database.transaction(() => {
      const changed = this.database.db.prepare("UPDATE print_executors SET state='REVOKED',token_hash=?,updated_at=? WHERE id=?")
        .run(digestToken(randomUUID()), Date.now(), id).changes;
      if (!changed) throw new AppError("NOT_FOUND", "打印执行器不存在");
      this.database.bumpRevision();
      return { id, revoked: true };
    });
  }

  listExecutors(): any[] {
    const onlineCutoff = Date.now() - EXECUTOR_ONLINE_WINDOW_MS;
    return (this.database.db.prepare("SELECT id,device_id deviceId,name,state,last_seen_at lastSeenAt,capabilities FROM print_executors ORDER BY name").all() as any[])
      .map((row) => ({
        ...row,
        state: row.state === "ONLINE" && row.lastSeenAt < onlineCutoff ? "OFFLINE" : row.state,
        capabilities: parseCapabilities(row.capabilities),
        lastSeenAt: new Date(row.lastSeenAt).toISOString(),
      }));
  }

  recoverStaleClaims(): number {
    return this.database.transaction(() => {
      const cutoff = Date.now() - 60_000;
      const rows = this.database.db.prepare(`SELECT i.id,i.job_id jobId,i.attempt_count attemptNo,i.claim_token claimToken
        FROM print_items i WHERE i.state='SENDING' AND i.claimed_at IS NOT NULL AND i.claimed_at<=?`).all(cutoff) as any[];
      if (!rows.length) return 0;
      const now = Date.now();
      const updateItem = this.database.db.prepare("UPDATE print_items SET state='UNKNOWN',updated_at=? WHERE id=? AND state='SENDING' AND claim_token=?");
      const updateAttempt = this.database.db.prepare(`UPDATE print_attempts SET state='UNKNOWN',finished_at=?,error=COALESCE(error,'执行器未在领取时限内回报')
        WHERE item_id=? AND attempt_no=? AND claim_token=? AND state='SENDING'`);
      const pauseJob = this.database.db.prepare("UPDATE print_jobs SET paused=1,pause_reason='UNKNOWN',updated_at=? WHERE id=?");
      let recovered = 0;
      for (const row of rows) {
        if (!updateItem.run(now, row.id, row.claimToken).changes) continue;
        updateAttempt.run(now, row.id, row.attemptNo, row.claimToken);
        pauseJob.run(now, row.jobId);
        recovered += 1;
      }
      if (recovered) this.database.bumpRevision();
      return recovered;
    });
  }

  private authenticateExecutor(token: string): { id: string } {
    const row = this.database.db.prepare("SELECT id FROM print_executors WHERE token_hash=? AND state<>'REVOKED'").get(digestToken(token)) as { id: string } | undefined;
    if (!row) throw new AppError("UNAUTHENTICATED", "打印执行器令牌无效");
    return row;
  }

  private assertRateLimit(store: Map<string, number[]>, key: string, limit: number, windowMs: number, message: string): void {
    const now = Date.now();
    const recent = (store.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);
    if (recent.length >= limit) throw new AppError("RATE_LIMITED", message);
    recent.push(now);
    store.set(key, recent);
    if (store.size > 1_000) {
      for (const [entryKey, timestamps] of store) {
        if (!timestamps.some((timestamp) => now - timestamp < windowMs)) store.delete(entryKey);
      }
    }
  }

  private rememberPrintCreate(key: string, jobId: string): void {
    const now = Date.now();
    this.recentPrintCreates.set(key, {
      jobId,
      expiresAt: now + PRINT_CREATE_DEBOUNCE_MS,
    });
    if (this.recentPrintCreates.size <= 500) return;
    for (const [entryKey, entry] of this.recentPrintCreates) {
      if (entry.expiresAt <= now) this.recentPrintCreates.delete(entryKey);
    }
  }

  private getItem(itemId: string): any {
    const row = this.database.db.prepare(`SELECT id,job_id jobId,ordinal,state,attempt_count attemptCount,claim_token claimToken,
      acknowledged_unknown acknowledgedUnknown,updated_at updatedAt FROM print_items WHERE id=?`).get(itemId) as any;
    if (!row) throw new AppError("NOT_FOUND", "打印标签任务不存在");
    return { ...row, acknowledgedUnknown: Boolean(row.acknowledgedUnknown), updatedAt: new Date(row.updatedAt).toISOString() };
  }

  private simulateAllSuccessful(jobId: string): void {
    const rows = this.database.db.prepare("SELECT id FROM print_items WHERE job_id=? AND state='QUEUED' ORDER BY ordinal").all(jobId) as Array<{ id: string }>;
    const now = Date.now();
    for (const row of rows) {
      const claimToken = randomUUID();
      this.database.db.prepare("UPDATE print_items SET state='SENDING',attempt_count=1,claim_token=?,claimed_at=?,updated_at=? WHERE id=?")
        .run(claimToken, now, now, row.id);
      this.database.db.prepare(`INSERT INTO print_attempts(id,item_id,attempt_no,state,claim_token,os_job_id,started_at,finished_at)
        VALUES(?,?,1,'SUBMITTED',?,?,?,?)`).run(randomUUID(), row.id, claimToken, `sim-${row.id}`, now, now);
      this.database.db.prepare("UPDATE print_items SET state='SUBMITTED',updated_at=? WHERE id=? AND claim_token=?").run(now, row.id, claimToken);
    }
  }

  private write(identity: RequestIdentity, callback: () => any): any {
    const replay = this.idempotency.lookup(identity);
    if (replay) return replay;
    return this.database.transaction(() => {
      const repeated = this.idempotency.lookup(identity);
      if (repeated) return repeated;
      const value = callback();
      this.idempotency.persistSuccess(identity, value);
      return value;
    });
  }

  private counts(jobId: string): Record<string, number> {
    return Object.fromEntries((this.database.db.prepare("SELECT state,count(*) count FROM print_items WHERE job_id=? GROUP BY state").all(jobId) as any[]).map((row) => [row.state, row.count]));
  }

  private aggregateStatus(jobId: string): string {
    const counts = this.counts(jobId);
    if ((counts.UNKNOWN ?? 0) + (counts.FAILED ?? 0) > 0) return "ATTENTION";
    if ((counts.SENDING ?? 0) > 0) return "RUNNING";
    if ((counts.QUEUED ?? 0) > 0) return "QUEUED";
    if ((counts.CANCELLED ?? 0) > 0 && Object.keys(counts).length === 1) return "CANCELLED";
    return "SETTLED";
  }
}

const digestToken = (value: string): string => createHash("sha256").update(value).digest("hex");
const printCreateDebounceKey = (userId: string, input: PrintCreateInput): string =>
  createHash("sha256").update(JSON.stringify({
    userId,
    executorId: input.executorId,
    printerId: input.printerId,
    nodeIds: [...input.nodeIds].sort(),
    templateId: input.templateId,
    copies: input.copies,
  })).digest("hex");
const parseCapabilities = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
};
