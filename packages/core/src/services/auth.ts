import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { InventoryDatabase } from "../db/database.js";
import type { InventoryConfig } from "../config.js";
import { AppError, invariant } from "../errors.js";

interface UserRow { id: string; username: string; passwordHash: string; passwordParams: string; version: number }
interface SessionRow { id: string; userId: string; username: string; csrfHash: string; expiresAt: number; lastSeenAt: number }

const SESSION_AGE = 7 * 24 * 60 * 60 * 1000;
const IDLE_AGE = 24 * 60 * 60 * 1000;

export class AuthService {
  readonly cookieName = "inventory_hub_session";
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly database: InventoryDatabase, private readonly config: InventoryConfig) {}

  get initialized(): boolean {
    return Boolean(this.database.db.prepare("SELECT 1 FROM users LIMIT 1").get());
  }

  setup(username: string, password: string): { id: string; username: string } {
    invariant(!this.initialized, "INVALID_STATE", "系统已经完成初始化");
    this.validateCredentials(username, password);
    const id = randomUUID();
    const now = Date.now();
    this.database.transaction(() => {
      invariant(!this.initialized, "INVALID_STATE", "系统已经完成初始化");
      this.database.db.prepare(`INSERT INTO users(id,username,password_hash,password_params,version,created_at,updated_at)
        VALUES(?,?,?,?,1,?,?)`).run(id, username.trim(), this.hashPassword(password), JSON.stringify({ algorithm: "scrypt", N: 32768, r: 8, p: 1, keylen: 64 }), now, now);
    });
    return { id, username: username.trim() };
  }

  login(username: string, password: string, rateKey: string): { user: { id: string; username: string }; token: string; csrfToken: string; expiresAt: string } {
    const recent = (this.failures.get(rateKey) ?? []).filter((time) => Date.now() - time < 15 * 60_000);
    if (recent.length >= 5) throw new AppError("RATE_LIMITED", "登录尝试次数过多，请稍后再试");
    const row = this.database.db.prepare(`SELECT id,username,password_hash passwordHash,password_params passwordParams,version
      FROM users WHERE username=?`).get(username.trim()) as UserRow | undefined;
    if (!row || !this.verifyPassword(password, row.passwordHash)) {
      recent.push(Date.now());
      this.failures.set(rateKey, recent);
      throw new AppError("UNAUTHENTICATED", "用户名或密码错误");
    }
    this.failures.delete(rateKey);
    const token = randomBytes(32).toString("base64url");
    const csrfToken = this.csrfForToken(token);
    const now = Date.now();
    const expiresAt = now + SESSION_AGE;
    this.database.db.prepare(`INSERT INTO sessions(id,user_id,token_hash,csrf_hash,created_at,last_seen_at,expires_at)
      VALUES(?,?,?,?,?,?,?)`).run(randomUUID(), row.id, this.hashToken(token), this.hashToken(csrfToken), now, now, expiresAt);
    return { user: { id: row.id, username: row.username }, token, csrfToken, expiresAt: new Date(expiresAt).toISOString() };
  }

  authenticate(token: string | undefined): { userId: string; username: string; sessionId: string; csrfToken: string; expiresAt: string } {
    if (!token) throw new AppError("UNAUTHENTICATED", "请先登录");
    const row = this.database.db.prepare(`SELECT s.id,s.user_id userId,u.username,s.csrf_hash csrfHash,s.expires_at expiresAt,s.last_seen_at lastSeenAt
      FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL`)
      .get(this.hashToken(token)) as SessionRow | undefined;
    const now = Date.now();
    if (!row || row.expiresAt <= now || now - row.lastSeenAt > IDLE_AGE) {
      if (row) this.database.db.prepare("UPDATE sessions SET revoked_at=? WHERE id=?").run(now, row.id);
      throw new AppError("UNAUTHENTICATED", "登录已过期，请重新登录");
    }
    const csrfToken = this.csrfForToken(token);
    const expectedCsrfHash = this.hashToken(csrfToken);
    const storedCsrfHash = Buffer.from(row.csrfHash);
    const actualCsrfHash = Buffer.from(expectedCsrfHash);
    if (storedCsrfHash.length !== actualCsrfHash.length || !timingSafeEqual(storedCsrfHash, actualCsrfHash)) {
      this.database.db.prepare("UPDATE sessions SET revoked_at=? WHERE id=?").run(now, row.id);
      throw new AppError("UNAUTHENTICATED", "登录安全状态已变化，请重新登录");
    }
    if (now - row.lastSeenAt > 60_000) this.database.db.prepare("UPDATE sessions SET last_seen_at=? WHERE id=?").run(now, row.id);
    return { userId: row.userId, username: row.username, sessionId: row.id, csrfToken, expiresAt: new Date(row.expiresAt).toISOString() };
  }

  assertCsrf(token: string | undefined, supplied: string | undefined): void {
    invariant(Boolean(token && supplied), "CSRF_INVALID", "缺少请求安全令牌");
    const expected = this.csrfForToken(token!);
    const left = Buffer.from(expected);
    const right = Buffer.from(supplied!);
    invariant(left.length === right.length && timingSafeEqual(left, right), "CSRF_INVALID", "请求安全令牌无效");
  }

  logout(token: string): void {
    this.database.db.prepare("UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL").run(Date.now(), this.hashToken(token));
  }

  changePassword(userId: string, currentPassword: string, newPassword: string): void {
    this.validateCredentials("valid-user", newPassword);
    const row = this.database.db.prepare("SELECT password_hash passwordHash FROM users WHERE id=?").get(userId) as { passwordHash: string } | undefined;
    invariant(row && this.verifyPassword(currentPassword, row.passwordHash), "UNAUTHENTICATED", "当前密码错误");
    const now = Date.now();
    this.database.transaction(() => {
      this.database.db.prepare("UPDATE users SET password_hash=?,version=version+1,updated_at=? WHERE id=?")
        .run(this.hashPassword(newPassword), now, userId);
      this.database.db.prepare("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL").run(now, userId);
    });
  }

  revokeOthers(userId: string, sessionId: string, currentPassword: string): void {
    const row = this.database.db.prepare("SELECT password_hash passwordHash FROM users WHERE id=?").get(userId) as { passwordHash: string } | undefined;
    invariant(row && this.verifyPassword(currentPassword, row.passwordHash), "UNAUTHENTICATED", "当前密码错误");
    this.database.db.prepare("UPDATE sessions SET revoked_at=? WHERE user_id=? AND id<>? AND revoked_at IS NULL").run(Date.now(), userId, sessionId);
  }

  cookieHeader(token: string, clear = false): string {
    const parts = [`${this.cookieName}=${clear ? "" : token}`, "Path=/", "HttpOnly", "SameSite=Strict"];
    if (clear) parts.push("Max-Age=0"); else parts.push(`Max-Age=${SESSION_AGE / 1000}`);
    if (this.config.secureCookies) parts.push("Secure");
    return parts.join("; ");
  }

  parseCookie(header: string | undefined): string | undefined {
    return header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${this.cookieName}=`))?.slice(this.cookieName.length + 1) || undefined;
  }

  private validateCredentials(username: string, password: string): void {
    invariant(username.trim().length >= 3 && username.trim().length <= 32, "VALIDATION_ERROR", "用户名长度需为 3 到 32 个字符");
    invariant(password.length >= 12 && password.length <= 128, "VALIDATION_ERROR", "密码长度需为 12 到 128 个字符");
  }

  private hashPassword(password: string): string {
    const salt = randomBytes(16);
    const derived = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return `scrypt$32768$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
  }

  private verifyPassword(password: string, stored: string): boolean {
    try {
      const [, n, r, p, saltText, hashText] = stored.split("$");
      if (!n || !r || !p || !saltText || !hashText) return false;
      const expected = Buffer.from(hashText, "base64url");
      const actual = scryptSync(password, Buffer.from(saltText, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  private hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
  private csrfForToken(token: string): string { return createHmac("sha256", this.config.sessionSecret).update(token).digest("base64url"); }
}
