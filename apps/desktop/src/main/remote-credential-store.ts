import { app, safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface RemoteExecutorCredential {
  remoteOrigin: string;
  deviceId: string;
  executorId: string;
  executorName: string;
  selectedPrinterId: string;
  token: string;
}

export interface RemoteCredentialStore {
  load(remoteOrigin: string): RemoteExecutorCredential | null;
  getDeviceId(): string;
  save(credential: RemoteExecutorCredential): void;
  clear(): void;
}

interface PersistedRemoteCredential {
  version: 1;
  deviceId: string;
  remoteOrigin?: string;
  executorId?: string;
  executorName?: string;
  selectedPrinterId?: string;
  encryptedToken?: string;
}

export class SafeStorageRemoteCredentialStore implements RemoteCredentialStore {
  private readonly credentialPath = join(
    app.getPath("userData"),
    "config",
    "remote-print-executor.json",
  );

  load(remoteOrigin: string): RemoteExecutorCredential | null {
    const stored = this.readPersisted();
    if (
      !stored?.remoteOrigin ||
      stored.remoteOrigin !== remoteOrigin ||
      !stored.executorId ||
      !stored.executorName ||
      !stored.selectedPrinterId ||
      !stored.encryptedToken
    ) {
      return null;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS_CREDENTIAL_STORAGE_UNAVAILABLE");
    }
    let token: string;
    try {
      token = safeStorage.decryptString(Buffer.from(stored.encryptedToken, "base64"));
    } catch {
      throw new Error("REMOTE_PRINT_CREDENTIAL_UNREADABLE");
    }
    if (!token) throw new Error("REMOTE_PRINT_CREDENTIAL_UNREADABLE");
    return {
      remoteOrigin,
      deviceId: stored.deviceId,
      executorId: stored.executorId,
      executorName: stored.executorName,
      selectedPrinterId: stored.selectedPrinterId,
      token,
    };
  }

  getDeviceId(): string {
    try {
      const stored = this.readPersisted();
      if (stored?.deviceId) return stored.deviceId;
    } catch {
      // A corrupt non-secret record is replaced when the user pairs again.
    }
    const deviceId = randomUUID();
    this.writePersisted({ version: 1, deviceId });
    return deviceId;
  }

  save(credential: RemoteExecutorCredential): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS_CREDENTIAL_STORAGE_UNAVAILABLE");
    }
    const encryptedToken = safeStorage.encryptString(credential.token).toString("base64");
    this.writePersisted({
      version: 1,
      deviceId: credential.deviceId,
      remoteOrigin: credential.remoteOrigin,
      executorId: credential.executorId,
      executorName: credential.executorName,
      selectedPrinterId: credential.selectedPrinterId,
      encryptedToken,
    });
  }

  clear(): void {
    let deviceId: string;
    try {
      deviceId = this.readPersisted()?.deviceId ?? randomUUID();
    } catch {
      deviceId = randomUUID();
    }
    this.writePersisted({ version: 1, deviceId });
  }

  private readPersisted(): PersistedRemoteCredential | null {
    if (!existsSync(this.credentialPath)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.credentialPath, "utf8"));
    } catch {
      throw new Error("REMOTE_PRINT_CREDENTIAL_FILE_INVALID");
    }
    if (!isPersistedCredential(parsed)) {
      throw new Error("REMOTE_PRINT_CREDENTIAL_FILE_INVALID");
    }
    return parsed;
  }

  private writePersisted(value: PersistedRemoteCredential): void {
    const directory = dirname(this.credentialPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.credentialPath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, this.credentialPath);
    chmodSync(this.credentialPath, 0o600);
  }
}

function isPersistedCredential(value: unknown): value is PersistedRemoteCredential {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.deviceId !== "string" || record.deviceId.length > 120) {
    return false;
  }
  for (const key of [
    "remoteOrigin",
    "executorId",
    "executorName",
    "selectedPrinterId",
    "encryptedToken",
  ]) {
    const field = record[key];
    if (field !== undefined && (typeof field !== "string" || field.length > 4096)) return false;
  }
  return true;
}
