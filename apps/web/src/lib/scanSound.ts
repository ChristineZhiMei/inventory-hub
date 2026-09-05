const DATABASE_NAME = "inventory-hub-client-preferences";
const DATABASE_VERSION = 1;
const STORE_NAME = "media";
const SOUND_KEY = "scan-success-sound";
const MODE_KEY = "inventory-hub.scan-sound-mode";
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export type ScanSoundMode = "default" | "custom" | "off";

export interface ScanSoundPreference {
  mode: ScanSoundMode;
  fileName: string | null;
  byteLength: number | null;
}

interface StoredSound {
  key: typeof SOUND_KEY;
  fileName: string;
  mimeType: string;
  byteLength: number;
  updatedAt: number;
  bytes: ArrayBuffer;
}

let audioContext: AudioContext | null = null;
let customBuffer: { updatedAt: number; value: AudioBuffer } | null = null;

function currentMode(): ScanSoundMode {
  const mode = localStorage.getItem(MODE_KEY);
  return mode === "custom" || mode === "off" ? mode : "default";
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开本地音效存储"));
  });
}

async function storedSound(): Promise<StoredSound | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(SOUND_KEY);
      request.onsuccess = () => resolve((request.result as StoredSound | undefined) ?? null);
      request.onerror = () => reject(request.error || new Error("无法读取自定义音效"));
    });
  } finally {
    database.close();
  }
}

function context(): AudioContext {
  if (!audioContext) audioContext = new AudioContext();
  return audioContext;
}

export async function scanSoundPreference(): Promise<ScanSoundPreference> {
  const stored = await storedSound();
  const mode = currentMode();
  return {
    mode: mode === "custom" && !stored ? "default" : mode,
    fileName: stored?.fileName ?? null,
    byteLength: stored?.byteLength ?? null,
  };
}

export async function saveScanSound(file: File): Promise<ScanSoundPreference> {
  if (!file.type.startsWith("audio/")) throw new Error("请选择音频文件");
  if (file.size > MAX_AUDIO_BYTES) throw new Error("音频文件不能超过 8 MB");
  const value: StoredSound = {
    key: SOUND_KEY,
    fileName: file.name,
    mimeType: file.type,
    byteLength: file.size,
    updatedAt: Date.now(),
    bytes: await file.arrayBuffer(),
  };
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readwrite")
        .objectStore(STORE_NAME)
        .put(value);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error("无法保存自定义音效"));
    });
  } finally {
    database.close();
  }
  customBuffer = null;
  localStorage.setItem(MODE_KEY, "custom");
  return { mode: "custom", fileName: value.fileName, byteLength: value.byteLength };
}

export function setScanSoundMode(mode: ScanSoundMode): void {
  localStorage.setItem(MODE_KEY, mode);
}

export async function removeScanSound(): Promise<ScanSoundPreference> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readwrite")
        .objectStore(STORE_NAME)
        .delete(SOUND_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error("无法删除自定义音效"));
    });
  } finally {
    database.close();
  }
  customBuffer = null;
  localStorage.setItem(MODE_KEY, "default");
  return { mode: "default", fileName: null, byteLength: null };
}

export async function unlockScanSound(): Promise<void> {
  if (currentMode() === "off") return;
  const audio = context();
  if (audio.state === "suspended") await audio.resume();
}

async function playDefaultSound(audio: AudioContext): Promise<void> {
  const start = audio.currentTime;
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, start);
  oscillator.frequency.exponentialRampToValueAtTime(1174, start + 0.09);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.22, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.15);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.16);
}

async function playCustomSound(audio: AudioContext): Promise<boolean> {
  const stored = await storedSound();
  if (!stored) return false;
  if (!customBuffer || customBuffer.updatedAt !== stored.updatedAt) {
    customBuffer = {
      updatedAt: stored.updatedAt,
      value: await audio.decodeAudioData(stored.bytes.slice(0)),
    };
  }
  const source = audio.createBufferSource();
  source.buffer = customBuffer.value;
  source.connect(audio.destination);
  source.start();
  return true;
}

export async function playScanSuccessSound(): Promise<void> {
  const mode = currentMode();
  if (mode === "off") return;
  try {
    const audio = context();
    if (audio.state === "suspended") await audio.resume();
    if (mode !== "custom" || !(await playCustomSound(audio))) {
      await playDefaultSound(audio);
    }
  } catch {
    // Audio playback can be blocked by browser policy. Scanning must remain available.
  }
}
