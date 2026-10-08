import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rmdir, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { constants as fsConstants } from "node:fs";
import sharp from "sharp";
import type { NodeType, UploadInitInput } from "@inventory-hub/contracts";
import type { InventoryDatabase } from "../db/database.js";
import { AppError, invariant } from "../errors.js";
import { consumeMediaSelection, resolveMediaSelection } from "../native-selections.js";

interface UploadManifest {
  inputKey: string;
  stagingMainKey?: string;
  stagingThumbKey?: string;
  finalMainKey?: string;
  finalThumbKey?: string;
  main?: VariantInfo;
  thumb?: VariantInfo;
}

interface VariantInfo { width: number; height: number; bytes: number; checksum: string }

interface UploadRow {
  id: string;
  ownerUserId: string;
  state: string;
  rootId: string;
  byteLength: number;
  declaredMime: string;
  manifest: string;
  expiresAt: number;
  targetNodeId: string | null;
  reservedCode: string | null;
}

export interface PreparedImage {
  imageId: string;
  uploadId: string;
  rootId: string;
  mainKey: string;
  thumbKey: string;
  main: VariantInfo;
  thumb: VariantInfo;
}

const uploadSelect = `SELECT id,owner_user_id ownerUserId,state,root_id rootId,byte_length byteLength,
  declared_mime declaredMime,manifest,expires_at expiresAt,target_node_id targetNodeId,reserved_code reservedCode FROM uploads`;

export class MediaService {
  constructor(private readonly database: InventoryDatabase) {
    const root = database.activeRoot;
    mkdirSync(join(root.absolutePath, "media"), { recursive: true });
    mkdirSync(join(root.absolutePath, "staging"), { recursive: true });
    const identityPath = join(root.absolutePath, "storage.json");
    if (!existsSync(identityPath)) writeFileSync(identityPath, JSON.stringify({ rootUuid: root.rootUuid, generation: root.generation, layoutVersion: 1 }, null, 2));
  }

  init(userId: string, input: UploadInitInput) {
    this.assertMediaWritable();
    const existing = this.database.db.prepare(`${uploadSelect} WHERE owner_user_id=? AND id IN (SELECT id FROM uploads WHERE client_upload_id=?)`)
      .get(userId, input.clientUploadId) as UploadRow | undefined;
    if (existing) return this.publicUpload(existing);
    const uploadId = randomUUID();
    const root = this.database.activeRoot;
    invariant(root.state === "ONLINE", "STORAGE_OFFLINE", "图片目录当前不可用");
    const inputKey = `staging/${uploadId}/input.source`;
    const now = Date.now();
    const expiresAt = now + 24 * 60 * 60_000;
    this.database.db.prepare(`INSERT INTO uploads(id,owner_user_id,client_upload_id,state,root_id,original_filename,declared_mime,byte_length,manifest,expires_at,created_at,updated_at)
      VALUES(?,?,?,'UPLOADING',?,?,?,?,?,?,?,?)`).run(uploadId, userId, input.clientUploadId, root.id, input.filename, input.declaredMime,
      input.byteLength, JSON.stringify({ inputKey }), expiresAt, now, now);
    return { uploadId, uploadUrl: `/api/v1/uploads/${uploadId}/content`, expiresAt: new Date(expiresAt).toISOString(), state: "UPLOADING" };
  }

  get(userId: string, uploadId: string): ReturnType<MediaService["publicUpload"]> {
    const row = this.getUpload(userId, uploadId);
    return this.publicUpload(row);
  }

  async acceptContent(userId: string, uploadId: string, bytes: Buffer): Promise<{ state: string; uploadId: string }> {
    this.assertMediaWritable();
    const row = this.getUpload(userId, uploadId);
    invariant(row.state === "UPLOADING" || row.state === "FAILED", "INVALID_STATE", "当前上传状态不接受内容");
    invariant(bytes.byteLength === row.byteLength, "VALIDATION_ERROR", "上传大小与登记大小不一致");
    invariant(bytes.byteLength <= 25 * 1024 * 1024, "FILE_TOO_LARGE", "单张图片不能超过 25 MiB");
    const root = this.database.activeRoot;
    invariant(row.rootId === root.id && root.state === "ONLINE", "STORAGE_OFFLINE", "图片目录当前不可用");
    const manifest = JSON.parse(row.manifest) as UploadManifest;
    const inputPath = this.safePath(root.absolutePath, manifest.inputKey);
    await mkdir(dirname(inputPath), { recursive: true });
    await writeFile(inputPath, bytes, { flag: "w" });
    this.database.db.prepare("UPDATE uploads SET state='PROCESSING',error_code=NULL,updated_at=? WHERE id=?").run(Date.now(), uploadId);
    try {
      const metadata = await sharp(inputPath, { animated: false, limitInputPixels: 60_000_000 }).metadata();
      invariant(Boolean(metadata.width && metadata.height), "UNSUPPORTED_IMAGE", "无法读取图片尺寸");
      invariant((metadata.width ?? 0) * (metadata.height ?? 0) <= 60_000_000, "PIXEL_LIMIT", "图片像素超过 6000 万限制");
      invariant(["jpeg", "png", "webp"].includes(metadata.format ?? ""), "UNSUPPORTED_IMAGE", "仅支持 JPEG、PNG 和 WebP 静态图片");
      invariant((metadata.pages ?? 1) === 1, "UNSUPPORTED_IMAGE", "暂不支持动画图片");
      const stagingMainKey = `staging/${uploadId}/main.part`;
      const stagingThumbKey = `staging/${uploadId}/thumb.part`;
      const mainPath = this.safePath(root.absolutePath, stagingMainKey);
      const thumbPath = this.safePath(root.absolutePath, stagingThumbKey);
      const mainResult = await sharp(inputPath, { limitInputPixels: 60_000_000 }).rotate().resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toFile(mainPath);
      const thumbResult = await sharp(inputPath, { limitInputPixels: 60_000_000 }).rotate().resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true }).webp({ quality: 75 }).toFile(thumbPath);
      const [mainBytes, thumbBytes] = await Promise.all([readFile(mainPath), readFile(thumbPath)]);
      manifest.stagingMainKey = stagingMainKey;
      manifest.stagingThumbKey = stagingThumbKey;
      manifest.main = { width: mainResult.width, height: mainResult.height, bytes: mainResult.size, checksum: digest(mainBytes) };
      manifest.thumb = { width: thumbResult.width, height: thumbResult.height, bytes: thumbResult.size, checksum: digest(thumbBytes) };
      this.database.db.prepare("UPDATE uploads SET state='READY',manifest=?,updated_at=? WHERE id=?")
        .run(JSON.stringify(manifest), Date.now(), uploadId);
      return { uploadId, state: "READY" };
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError("UNSUPPORTED_IMAGE", "图片解码或处理失败");
      this.database.db.prepare("UPDATE uploads SET state='FAILED',error_code=?,updated_at=? WHERE id=?").run(appError.code, Date.now(), uploadId);
      throw appError;
    }
  }

  async prepare(userId: string, uploadIds: string[], nodeId: string, code: string, type: NodeType): Promise<PreparedImage[]> {
    this.assertMediaWritable();
    const root = this.database.activeRoot;
    invariant(root.state === "ONLINE", "STORAGE_OFFLINE", "图片目录当前不可用");
    const folder = type === "ITEM" ? "items" : type === "BAG" ? "bags" : type === "BOX" ? "boxes" : "warehouses";
    const prepared: PreparedImage[] = [];
    for (const uploadId of uploadIds) {
      const row = this.getUpload(userId, uploadId);
      invariant(["READY", "FILES_READY"].includes(row.state), row.state === "ATTACHED" ? "UPLOAD_ALREADY_ATTACHED" : "INVALID_STATE", "图片尚未处理完成或已经绑定");
      const manifest = JSON.parse(row.manifest) as UploadManifest;
      invariant(Boolean(manifest.main && manifest.thumb), "DATA_INTEGRITY_ERROR", "上传清单缺少图片变体");
      const imageId = uploadId;
      const mainKey = manifest.finalMainKey ?? `media/${folder}/${code}/img_${imageId}.main.ihimg`;
      const thumbKey = manifest.finalThumbKey ?? `media/${folder}/${code}/img_${imageId}.thumb.ihimg`;
      if (row.state === "READY") {
        await mkdir(dirname(this.safePath(root.absolutePath, mainKey)), { recursive: true });
        await rename(this.safePath(root.absolutePath, manifest.stagingMainKey!), this.safePath(root.absolutePath, mainKey));
        await rename(this.safePath(root.absolutePath, manifest.stagingThumbKey!), this.safePath(root.absolutePath, thumbKey));
        manifest.finalMainKey = mainKey;
        manifest.finalThumbKey = thumbKey;
        this.database.db.prepare(`UPDATE uploads SET state='FILES_READY',manifest=?,target_node_id=?,reserved_code=?,updated_at=? WHERE id=?`)
          .run(JSON.stringify(manifest), nodeId, code, Date.now(), uploadId);
      } else {
        invariant(row.targetNodeId === nodeId && row.reservedCode === code, "UPLOAD_ALREADY_ATTACHED", "图片已被另一个档案请求占用");
      }
      prepared.push({ imageId, uploadId, rootId: root.id, mainKey, thumbKey, main: manifest.main!, thumb: manifest.thumb! });
    }
    return prepared;
  }

  insertPrepared(nodeId: string, prepared: PreparedImage[]): void {
    const now = Date.now();
    const temporaryPaths: string[] = [];
    prepared.forEach((image, index) => {
      const upload = this.database.db.prepare("SELECT manifest FROM uploads WHERE id=?").get(image.uploadId) as { manifest: string } | undefined;
      invariant(Boolean(upload), "DATA_INTEGRITY_ERROR", "图片上传记录不存在");
      const manifest = JSON.parse(upload!.manifest) as UploadManifest;
      temporaryPaths.push(manifest.inputKey, ...[manifest.stagingMainKey, manifest.stagingThumbKey].filter((key): key is string => Boolean(key)));
      this.database.db.prepare(`INSERT INTO images(id,owner_node_id,root_id,main_key,thumb_key,mime,main_width,main_height,main_bytes,
        thumb_width,thumb_height,thumb_bytes,main_checksum,thumb_checksum,sort_order,processing_version,status,created_at,updated_at)
        VALUES(?,?,?,?,?,'image/webp',?,?,?,?,?,?,?,?,?,1,'ACTIVE',?,?)`).run(image.imageId, nodeId, image.rootId, image.mainKey, image.thumbKey,
        image.main.width, image.main.height, image.main.bytes, image.thumb.width, image.thumb.height, image.thumb.bytes,
        image.main.checksum, image.thumb.checksum, index, now, now);
      this.database.db.prepare("UPDATE uploads SET state='ATTACHED',updated_at=? WHERE id=?").run(now, image.uploadId);
    });
    this.queuePathsCleanup(temporaryPaths, "TEMP_ONLY");
  }

  listForNode(nodeId: string): any[] {
    return this.database.db.prepare(`SELECT id,mime,main_width mainWidth,main_height mainHeight,main_bytes mainBytes,
      thumb_width thumbWidth,thumb_height thumbHeight,thumb_bytes thumbBytes,sort_order sortOrder,status
      FROM images WHERE owner_node_id=? AND status='ACTIVE' ORDER BY sort_order,id`).all(nodeId).map((image: any) => ({
        ...image,
        mainUrl: `/api/v1/images/${image.id}?variant=main`,
        thumbUrl: `/api/v1/images/${image.id}?variant=thumb`,
      }));
  }

  async readImage(imageId: string, variant: "main" | "thumb"): Promise<Buffer> {
    const row = this.database.db.prepare(`SELECT i.status,r.absolute_path absolutePath,r.state,
      i.main_key mainKey,i.thumb_key thumbKey FROM images i JOIN storage_roots r ON r.id=i.root_id WHERE i.id=?`).get(imageId) as any;
    if (!row) throw new AppError("NOT_FOUND", "图片不存在");
    if (row.status !== "ACTIVE") throw new AppError("NODE_DELETED", "图片已撤销");
    invariant(row.state === "ONLINE", "STORAGE_OFFLINE", "图片目录当前不可用");
    const path = this.safePath(row.absolutePath, variant === "main" ? row.mainKey : row.thumbKey);
    try {
      const [realRoot, realFile] = await Promise.all([realpath(row.absolutePath), realpath(path)]);
      invariant(realFile === realRoot || realFile.startsWith(`${realRoot}${sep}`), "DATA_INTEGRITY_ERROR", "图片路径越过授权目录");
      return await readFile(realFile);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("MEDIA_MISSING", "图片文件缺失", { details: { imageId, variant } });
    }
  }

  /** Read a ready, user-owned upload without attaching it to an item. */
  async readRecognitionUpload(userId: string, uploadId: string): Promise<Buffer> {
    this.assertMediaWritable();
    const row = this.getUpload(userId, uploadId);
    invariant(row.state === "READY" && row.expiresAt > Date.now(), "INVALID_STATE", "图片尚未就绪或已过期，请重新上传");
    const root = this.database.activeRoot;
    invariant(row.rootId === root.id && root.state === "ONLINE", "STORAGE_OFFLINE", "图片目录当前不可用");
    const manifest = JSON.parse(row.manifest) as UploadManifest;
    invariant(manifest.stagingMainKey, "MEDIA_MISSING", "图片文件缺失");
    try {
      const [realRoot, realFile] = await Promise.all([
        realpath(root.absolutePath), realpath(this.safePath(root.absolutePath, manifest.stagingMainKey)),
      ]);
      invariant(realFile.startsWith(`${realRoot}${sep}`), "DATA_INTEGRITY_ERROR", "图片路径越过授权目录");
      return await readFile(realFile);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("MEDIA_MISSING", "图片文件缺失，请重新上传");
    }
  }

  queueImageCleanup(imageRows: Array<{ mainKey: string; thumbKey: string }>, kind = "IMAGE_DELETE"): string | null {
    return this.queuePathsCleanup(imageRows.flatMap((row) => [row.mainKey, row.thumbKey]), kind);
  }

  private queuePathsCleanup(paths: string[], kind: string): string | null {
    const uniquePaths = [...new Set(paths.filter(Boolean))];
    if (!uniquePaths.length) return null;
    this.assertMediaWritable();
    const root = this.database.activeRoot;
    const id = randomUUID();
    const now = Date.now();
    this.database.db.prepare(`INSERT INTO cleanup_jobs(id,root_uuid,root_generation,paths_manifest,kind,state,attempts,next_attempt_at,created_at,updated_at)
      VALUES(?,?,?,?,?,'PENDING',0,?,?,?)`).run(id, root.rootUuid, root.generation,
      JSON.stringify(uniquePaths), kind, now, now, now);
    return id;
  }

  async processCleanupJobs(): Promise<number> {
    const maintenance = (this.database.db.prepare("SELECT maintenance_state state FROM system_settings WHERE singleton_id=1").get() as { state: string }).state;
    if (maintenance !== "ONLINE") return 0;
    const root = this.database.activeRoot;
    if (root.state !== "ONLINE") return 0;
    const jobs = this.database.db.prepare(`SELECT id,root_uuid rootUuid,root_generation rootGeneration,paths_manifest pathsManifest
      FROM cleanup_jobs WHERE state IN ('PENDING','RETRY_WAIT','WAITING') AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT 20`).all(Date.now()) as any[];
    let processed = 0;
    for (const job of jobs) {
      if (job.rootUuid !== root.rootUuid || Number(job.rootGeneration) !== root.generation) {
        this.database.db.prepare("UPDATE cleanup_jobs SET state='WAITING',next_attempt_at=?,last_error=?,updated_at=? WHERE id=?")
          .run(Date.now() + 60_000, "目标媒体根当前不是活动根，等待根身份恢复或迁移接管", Date.now(), job.id);
        continue;
      }
      processed += 1;
      this.database.db.prepare("UPDATE cleanup_jobs SET state='RUNNING',attempts=attempts+1,updated_at=? WHERE id=?").run(Date.now(), job.id);
      try {
        for (const key of JSON.parse(job.pathsManifest) as string[]) {
          const path = this.safePath(root.absolutePath, key);
          try { await unlink(path); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
          const topLevel = key.split("/")[0];
          if (topLevel) await this.removeEmptyParents(dirname(path), this.safePath(root.absolutePath, topLevel));
        }
        this.database.db.prepare("UPDATE cleanup_jobs SET state='REMOVED',updated_at=? WHERE id=?").run(Date.now(), job.id);
      } catch (error) {
        this.database.db.prepare("UPDATE cleanup_jobs SET state='RETRY_WAIT',next_attempt_at=?,last_error=?,updated_at=? WHERE id=?")
          .run(Date.now() + 60_000, String(error), Date.now(), job.id);
      }
    }
    return processed;
  }

  async preflightMigration(selectionToken: string): Promise<any> {
    const selected = resolveMediaSelection(selectionToken);
    invariant(Boolean(selected), "DESKTOP_ONLY", "目录选择凭证无效或已过期");
    const source = this.database.activeRoot;
    invariant(source.state === "ONLINE", "STORAGE_OFFLINE", "当前图片目录不可用，不能迁移");
    const selectedInfo = await lstat(selected!);
    invariant(selectedInfo.isDirectory() && !selectedInfo.isSymbolicLink(), "VALIDATION_ERROR", "请选择真实本地目录，不能使用符号链接");
    await access(selected!, fsConstants.R_OK | fsConstants.W_OK);
    const targetPath = basename(selected!) === "InventoryHubMedia" ? resolve(selected!) : resolve(selected!, "InventoryHubMedia");
    const sourcePath = resolve(source.absolutePath);
    invariant(targetPath !== sourcePath, "VALIDATION_ERROR", "新旧图片目录不能相同");
    invariant(!targetPath.startsWith(`${sourcePath}${sep}`) && !sourcePath.startsWith(`${targetPath}${sep}`), "VALIDATION_ERROR", "新旧图片目录不能互为父子目录");
    if (existsSync(targetPath)) {
      const targetInfo = await lstat(targetPath);
      invariant(targetInfo.isDirectory() && !targetInfo.isSymbolicLink(), "VALIDATION_ERROR", "目标专属目录无效");
      const entries = await readdir(targetPath);
      invariant(entries.length === 0, "REFERENCE_CONFLICT", "目标 InventoryHubMedia 目录必须为空");
    }
    const files = await this.controlledFiles(sourcePath);
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const space = await statfs(selected!);
    const freeBytes = Number(space.bavail) * Number(space.bsize);
    const requiredBytes = totalBytes + Math.max(Math.ceil(totalBytes * 0.1), 256 * 1024 * 1024);
    invariant(freeBytes >= requiredBytes, "VALIDATION_ERROR", "目标磁盘空间不足", { totalBytes, requiredBytes, freeBytes });
    const id = randomUUID();
    const now = Date.now();
    this.database.db.prepare(`INSERT INTO storage_migrations(id,from_root_id,state,manifest,checkpoint,created_at,updated_at)
      VALUES(?,?,'PREFLIGHT',?,?,?,?)`).run(id, source.id, JSON.stringify({ targetPath, files, totalBytes, rootUuid: source.rootUuid, nextGeneration: source.generation + 1 }), JSON.stringify({ copied: 0, verified: 0 }), now, now);
    return { id, state: "PREFLIGHT", totalBytes, fileCount: files.length, freeBytes, requiredBytes, targetName: basename(targetPath) };
  }

  async startMigration(selectionToken: string, migrationId: string): Promise<any> {
    const selected = consumeMediaSelection(selectionToken);
    invariant(Boolean(selected), "DESKTOP_ONLY", "目录选择凭证无效或已使用");
    const row = this.migrationRow(migrationId);
    invariant(row.state === "PREFLIGHT", "INVALID_STATE", "迁移计划当前不能启动");
    const manifest = JSON.parse(row.manifest) as { targetPath: string; files: Array<{ key: string; bytes: number; checksum: string }>; totalBytes: number; rootUuid: string; nextGeneration: number };
    const expectedTarget = basename(selected!) === "InventoryHubMedia" ? resolve(selected!) : resolve(selected!, "InventoryHubMedia");
    invariant(expectedTarget === manifest.targetPath, "DESKTOP_ONLY", "目录选择与预检目标不一致");
    const source = this.database.activeRoot;
    const lease = randomUUID();
    this.database.transaction(() => {
      invariant(this.database.activeRoot.id === row.fromRootId, "REFERENCE_CONFLICT", "当前图片根已变化");
      this.database.db.prepare("UPDATE system_settings SET maintenance_state='MEDIA_MIGRATING' WHERE singleton_id=1").run();
      this.database.db.prepare("UPDATE storage_migrations SET state='COPYING',lease_token=?,updated_at=? WHERE id=?").run(lease, Date.now(), migrationId);
    });
    try {
      await mkdir(manifest.targetPath, { recursive: true });
      let copied = 0;
      for (const file of manifest.files) {
        if (this.migrationRow(migrationId).state === "CANCEL_REQUESTED") throw new Error("__MIGRATION_CANCELLED__");
        const sourceFile = this.safePath(source.absolutePath, file.key);
        const targetFile = this.safePath(manifest.targetPath, file.key);
        await mkdir(dirname(targetFile), { recursive: true });
        await copyFile(sourceFile, targetFile);
        copied += 1;
        this.database.db.prepare("UPDATE storage_migrations SET checkpoint=?,updated_at=? WHERE id=? AND lease_token=?")
          .run(JSON.stringify({ copied, verified: 0 }), Date.now(), migrationId, lease);
      }
      await writeFile(join(manifest.targetPath, "storage.json"), JSON.stringify({ rootUuid: manifest.rootUuid, generation: manifest.nextGeneration, layoutVersion: 1 }, null, 2));
      this.database.db.prepare("UPDATE storage_migrations SET state='VERIFYING',updated_at=? WHERE id=? AND lease_token=?").run(Date.now(), migrationId, lease);
      let verified = 0;
      for (const file of manifest.files) {
        if (this.migrationRow(migrationId).state === "CANCEL_REQUESTED") throw new Error("__MIGRATION_CANCELLED__");
        const bytes = await readFile(this.safePath(manifest.targetPath, file.key));
        invariant(bytes.byteLength === file.bytes && digest(bytes) === file.checksum, "DATA_INTEGRITY_ERROR", "迁移文件校验失败", { key: file.key });
        verified += 1;
      }
      const newRootId = randomUUID();
      const now = Date.now();
      this.database.transaction(() => {
        this.database.db.prepare(`INSERT INTO storage_roots(id,root_uuid,absolute_path,layout_version,generation,state,last_verified_at,created_at,updated_at)
          VALUES(?,?,?,1,?,'ONLINE',?,?,?)`).run(newRootId, manifest.rootUuid, manifest.targetPath, manifest.nextGeneration, now, now, now);
        this.database.db.prepare("UPDATE images SET root_id=? WHERE root_id=?").run(newRootId, source.id);
        this.database.db.prepare("UPDATE uploads SET root_id=? WHERE root_id=?").run(newRootId, source.id);
        this.database.db.prepare("UPDATE cleanup_jobs SET root_generation=? WHERE root_uuid=? AND state<>'REMOVED'").run(manifest.nextGeneration, manifest.rootUuid);
        this.database.db.prepare("UPDATE storage_roots SET state='OLD_COPY',updated_at=? WHERE id=?").run(now, source.id);
        this.database.db.prepare("UPDATE system_settings SET active_root_id=?,maintenance_state='ONLINE' WHERE singleton_id=1").run(newRootId);
        this.database.db.prepare("UPDATE storage_migrations SET to_root_id=?,state='COMMITTED',checkpoint=?,updated_at=? WHERE id=? AND lease_token=?")
          .run(newRootId, JSON.stringify({ copied, verified }), now, migrationId, lease);
      });
      return this.migrationStatus(migrationId);
    } catch (error) {
      const cancelled = error instanceof Error && error.message === "__MIGRATION_CANCELLED__";
      this.database.transaction(() => {
        this.database.db.prepare("UPDATE system_settings SET maintenance_state='ONLINE' WHERE singleton_id=1").run();
        this.database.db.prepare("UPDATE storage_migrations SET state=?,error_code=?,updated_at=? WHERE id=?")
          .run(cancelled ? "CANCELLED" : "FAILED", cancelled ? null : error instanceof AppError ? error.code : "INTERNAL_ERROR", Date.now(), migrationId);
      });
      if (cancelled) return this.migrationStatus(migrationId);
      throw error;
    }
  }

  migrationStatus(id: string): any {
    const row = this.migrationRow(id);
    const manifest = JSON.parse(row.manifest) as { totalBytes: number; files: unknown[]; targetPath: string };
    return { id: row.id, state: row.state, totalBytes: manifest.totalBytes, fileCount: manifest.files.length, checkpoint: JSON.parse(row.checkpoint), errorCode: row.errorCode, updatedAt: new Date(row.updatedAt).toISOString(), oldCopyPending: row.state === "COMMITTED" };
  }

  cancelMigration(id: string): any {
    return this.database.transaction(() => {
      const row = this.migrationRow(id);
      invariant(["PREFLIGHT", "COPYING", "VERIFYING"].includes(row.state), "INVALID_STATE", "根指针切换后不能取消迁移");
      this.database.db.prepare("UPDATE storage_migrations SET state=?,updated_at=? WHERE id=?")
        .run(row.state === "PREFLIGHT" ? "CANCELLED" : "CANCEL_REQUESTED", Date.now(), id);
      return this.migrationStatus(id);
    });
  }

  async cleanupOldCopy(id: string, confirmation: string): Promise<any> {
    const row = this.migrationRow(id);
    invariant(row.state === "COMMITTED" && confirmation === "DELETE_OLD_COPY", "INVALID_STATE", "旧副本清理确认无效");
    const fromRoot = this.database.db.prepare("SELECT absolute_path absolutePath FROM storage_roots WHERE id=?").get(row.fromRootId) as { absolutePath: string };
    const manifest = JSON.parse(row.manifest) as { files: Array<{ key: string }> };
    for (const file of manifest.files) {
      try { await unlink(this.safePath(fromRoot.absolutePath, file.key)); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    }
    const directories = [...new Set(manifest.files.map((file) => dirname(this.safePath(fromRoot.absolutePath, file.key))))].sort((a, b) => b.length - a.length);
    for (const directory of directories) { try { await rmdir(directory); } catch {} }
    try { await unlink(join(fromRoot.absolutePath, "storage.json")); } catch {}
    this.database.transaction(() => {
      this.database.db.prepare("UPDATE storage_migrations SET state='OLD_COPY_CLEANED',updated_at=? WHERE id=?").run(Date.now(), id);
      this.database.db.prepare("UPDATE storage_roots SET state='RETIRED',updated_at=? WHERE id=?").run(Date.now(), row.fromRootId);
    });
    return this.migrationStatus(id);
  }

  cancel(userId: string, uploadId: string): void {
    const row = this.getUpload(userId, uploadId);
    invariant(row.state !== "ATTACHED", "UPLOAD_ALREADY_ATTACHED", "已经绑定的图片不能取消上传");
    this.database.db.prepare("UPDATE uploads SET state='CANCELLED',updated_at=? WHERE id=?").run(Date.now(), uploadId);
    const manifest = JSON.parse(row.manifest) as UploadManifest;
    this.queuePathsCleanup([
      manifest.inputKey,
      ...[manifest.stagingMainKey, manifest.stagingThumbKey, manifest.finalMainKey, manifest.finalThumbKey].filter((key): key is string => Boolean(key)),
    ], "TEMP_ONLY");
  }

  private getUpload(userId: string, uploadId: string): UploadRow {
    const row = this.database.db.prepare(`${uploadSelect} WHERE id=? AND owner_user_id=?`).get(uploadId, userId) as UploadRow | undefined;
    if (!row) throw new AppError("NOT_FOUND", "上传任务不存在");
    return row;
  }

  private assertMediaWritable(): void {
    const state = (this.database.db.prepare("SELECT maintenance_state state FROM system_settings WHERE singleton_id=1").get() as { state: string }).state;
    invariant(state === "ONLINE", "MAINTENANCE", "图片目录正在维护，请稍后再试");
  }

  private migrationRow(id: string): { id: string; fromRootId: string; state: string; manifest: string; checkpoint: string; errorCode: string | null; updatedAt: number } {
    const row = this.database.db.prepare(`SELECT id,from_root_id fromRootId,state,manifest,checkpoint,error_code errorCode,updated_at updatedAt FROM storage_migrations WHERE id=?`).get(id) as any;
    if (!row) throw new AppError("NOT_FOUND", "图片目录迁移任务不存在");
    return row;
  }

  private async controlledFiles(root: string): Promise<Array<{ key: string; bytes: number; checksum: string }>> {
    const files: Array<{ key: string; bytes: number; checksum: string }> = [];
    const visit = async (directory: string) => {
      if (!existsSync(directory)) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        invariant(!entry.isSymbolicLink(), "DATA_INTEGRITY_ERROR", "媒体目录包含符号链接，不能迁移");
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) {
          const bytes = await readFile(path);
          files.push({ key: relative(root, path), bytes: bytes.byteLength, checksum: digest(bytes) });
        }
      }
    };
    await visit(join(root, "media"));
    await visit(join(root, "staging"));
    return files.sort((a, b) => a.key.localeCompare(b.key));
  }

  private publicUpload(row: UploadRow) {
    const manifest = JSON.parse(row.manifest) as UploadManifest;
    return {
      uploadId: row.id,
      uploadUrl: `/api/v1/uploads/${row.id}/content`,
      state: row.state,
      expiresAt: new Date(row.expiresAt).toISOString(),
      dimensions: manifest.main ? { width: manifest.main.width, height: manifest.main.height } : null,
      errorCode: (this.database.db.prepare("SELECT error_code errorCode FROM uploads WHERE id=?").get(row.id) as any)?.errorCode ?? null,
    };
  }

  private safePath(root: string, key: string): string {
    invariant(!key.startsWith("/") && !key.includes("..") && !key.includes("\\"), "DATA_INTEGRITY_ERROR", "非法媒体路径");
    const path = resolve(root, key);
    const rel = relative(resolve(root), path);
    invariant(rel !== ".." && !rel.startsWith(`..${sep}`) && !resolve(path).startsWith(`${resolve(root)}${sep}..`), "DATA_INTEGRITY_ERROR", "媒体路径越界");
    return path;
  }

  private async removeEmptyParents(start: string, boundary: string): Promise<void> {
    let current = resolve(start);
    const stop = resolve(boundary);
    while (current !== stop && current.startsWith(`${stop}${sep}`)) {
      try { await rmdir(current); }
      catch { return; }
      current = dirname(current);
    }
  }
}

const digest = (value: Buffer): string => createHash("sha256").update(value).digest("hex");
