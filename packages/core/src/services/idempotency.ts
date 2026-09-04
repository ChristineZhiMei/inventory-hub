import { randomUUID } from "node:crypto";
import type { InventoryDatabase } from "../db/database.js";
import { AppError } from "../errors.js";

export interface RequestIdentity {
  userId: string;
  requestId: string;
  method: string;
  route: string;
  payload: unknown;
}

export class IdempotencyService {
  private readonly inFlight = new Set<string>();
  constructor(private readonly database: InventoryDatabase) {}

  lookup(identity: RequestIdentity): unknown | undefined {
    const row = this.database.db.prepare(`SELECT method,route,payload_hash payloadHash,state,result_json resultJson
      FROM request_results WHERE user_id=? AND request_id=?`).get(identity.userId, identity.requestId) as { method: string; route: string; payloadHash: string; state: string; resultJson: string } | undefined;
    if (!row) return undefined;
    const payloadHash = this.database.payloadHash(identity.payload);
    if (row.method !== identity.method || row.route !== identity.route || row.payloadHash !== payloadHash) {
      throw new AppError("IDEMPOTENCY_CONFLICT", "相同请求编号对应了不同接口或内容");
    }
    const result = JSON.parse(row.resultJson) as { ok: boolean; value?: unknown; error?: { code: any; message: string; details?: unknown } };
    if (!result.ok && result.error) throw new AppError(result.error.code, result.error.message, { details: result.error.details });
    return result.value;
  }

  begin(identity: RequestIdentity): void {
    const key = `${identity.userId}:${identity.requestId}`;
    if (this.inFlight.has(key)) throw new AppError("REQUEST_RUNNING", "原请求仍在处理中");
    this.inFlight.add(key);
  }

  finish(identity: RequestIdentity): void {
    this.inFlight.delete(`${identity.userId}:${identity.requestId}`);
  }

  persistSuccess(identity: RequestIdentity, value: unknown): void {
    this.database.db.prepare(`INSERT INTO request_results(id,user_id,request_id,method,route,payload_hash,state,result_json,created_at)
      VALUES(?,?,?,?,?,?, 'SUCCEEDED',?,?)`).run(randomUUID(), identity.userId, identity.requestId, identity.method, identity.route,
      this.database.payloadHash(identity.payload), JSON.stringify({ ok: true, value }), Date.now());
  }

  persistRejected(identity: RequestIdentity, error: AppError): void {
    const existing = this.database.db.prepare("SELECT 1 FROM request_results WHERE user_id=? AND request_id=?").get(identity.userId, identity.requestId);
    if (existing) return;
    this.database.transaction(() => {
      const repeated = this.database.db.prepare("SELECT 1 FROM request_results WHERE user_id=? AND request_id=?").get(identity.userId, identity.requestId);
      if (repeated) return;
      this.database.db.prepare(`INSERT INTO request_results(id,user_id,request_id,method,route,payload_hash,state,result_json,created_at)
        VALUES(?,?,?,?,?,?,'REJECTED',?,?)`).run(randomUUID(), identity.userId, identity.requestId, identity.method, identity.route,
        this.database.payloadHash(identity.payload), JSON.stringify({ ok: false, error: { code: error.code, message: error.message, details: error.details } }), Date.now());
    });
  }

  get(userId: string, requestId: string): { state: string; result?: unknown } | undefined {
    if (this.inFlight.has(`${userId}:${requestId}`)) return { state: "RUNNING" };
    const row = this.database.db.prepare("SELECT state,result_json resultJson FROM request_results WHERE user_id=? AND request_id=?")
      .get(userId, requestId) as { state: string; resultJson: string } | undefined;
    if (!row) return undefined;
    return { state: row.state, result: JSON.parse(row.resultJson).value };
  }
}
