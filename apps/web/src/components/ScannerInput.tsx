import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { Camera, CameraOff, Flashlight, Keyboard, ScanLine } from "lucide-react";
import { errorMessage } from "@/lib/api";
import { playScanSuccessSound, unlockScanSound } from "@/lib/scanSound";
import { normalizeCode } from "@/lib/utils";
import { Alert, Button, Input } from "./AntUi";

export function ScannerInput({ onCode, paused = false, label = "扫描或输入编号" }: { onCode: (code: string) => void | Promise<void>; paused?: boolean; label?: string }) {
  const [code, setCode] = useState("");
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [zoomRange, setZoomRange] = useState<{ min: number; max: number; step: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);
  const lastRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const mobile = typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
  function deliver(raw: string) {
    const normalized = normalizeCode(raw);
    if (!/^(W|C|I)[0-9]{6,}$/.test(normalized)) { setCameraError("编号格式应为 W、C 或 I 加至少 6 位数字"); return; }
    const now = Date.now();
    if (lastRef.current.code === normalized && now - lastRef.current.at < 1500) return;
    lastRef.current = { code: normalized, at: now };
    setCameraError(""); setCode("");
    void playScanSuccessSound();
    void Promise.resolve(onCode(normalized)).catch((error) => setCameraError(errorMessage(error)));
  }
  async function startCamera() {
    void unlockScanSound();
    if (!window.isSecureContext) {
      const secureDevelopmentUrl = location.port === "14237"
        ? `https://${location.hostname}:14239${location.pathname}`
        : "";
      setCameraError(location.protocol !== "https:"
        ? `当前使用的是 HTTP 页面，安装证书不会改变 HTTP 的安全级别。${secureDevelopmentUrl ? `开发测试请改用 ${secureDevelopmentUrl}。` : "请从设置中的局域网 HTTPS 地址进入。"}`
        : "当前 HTTPS 证书尚未被浏览器信任。iPhone/iPad 请在“设置 → 通用 → 关于本机 → 证书信任设置”中开启 Inventory Hub Local CA 的完全信任，然后彻底关闭并重新打开浏览器。");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) { setCameraError("此浏览器不支持实时摄像头扫码，请改用手动输入。 "); return; }
    setCameraError(""); setCameraOn(true);
  }
  function stopCamera() {
    controlsRef.current?.stop();
    controlsRef.current = null;
    videoTrackRef.current = null;
    if (videoRef.current?.srcObject) for (const track of (videoRef.current.srcObject as MediaStream).getTracks()) track.stop();
    setTorchAvailable(false);
    setTorchOn(false);
    setZoomRange(null);
    setCameraOn(false);
  }
  useEffect(() => {
    if (!cameraOn || paused || !videoRef.current) return;
    let disposed = false;
    const hints = new Map<DecodeHintType, unknown>();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    const reader = new BrowserMultiFormatReader(hints, {
      delayBetweenScanAttempts: 90,
      delayBetweenScanSuccess: 650,
    });
    reader.decodeFromConstraints({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    }, videoRef.current, (result) => {
      if (result && !disposed) deliver(result.getText());
    }).then(async (controls) => {
      if (disposed) {
        controls.stop();
        return;
      }
      controlsRef.current = controls;
      const stream = videoRef.current?.srcObject as MediaStream | null;
      const track = stream?.getVideoTracks()[0] ?? null;
      videoTrackRef.current = track;
      if (!track) return;
      const capabilities = (typeof track.getCapabilities === "function" ? track.getCapabilities() : {}) as MediaTrackCapabilities & {
        focusMode?: string[];
        torch?: boolean;
        zoom?: { min: number; max: number; step?: number };
      };
      setTorchAvailable(Boolean(capabilities.torch && controls.switchTorch));
      if (capabilities.zoom && capabilities.zoom.max > capabilities.zoom.min) {
        const initialZoom = Math.max(capabilities.zoom.min, Math.min(1, capabilities.zoom.max));
        setZoom(initialZoom);
        setZoomRange({
          min: capabilities.zoom.min,
          max: capabilities.zoom.max,
          step: capabilities.zoom.step || 0.1,
        });
      }
      if (capabilities.focusMode?.includes("continuous")) {
        try {
          await track.applyConstraints({
            advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
          });
        } catch {
          // Some mobile browsers report focus modes but reject manual constraints.
        }
      }
    }).catch((error: unknown) => {
      setCameraError(error instanceof DOMException && error.name === "NotAllowedError" ? "摄像头权限被拒绝，请在浏览器设置中允许或使用手动输入。" : "摄像头无法启动，可能正被其他应用占用。");
      setCameraOn(false);
    });
    return () => { disposed = true; controlsRef.current?.stop(); controlsRef.current = null; };
  }, [cameraOn, paused]);
  useEffect(() => {
    const visibility = () => { if (document.hidden) stopCamera(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("visibilitychange", visibility); stopCamera(); };
  }, []);
  return <div className="space-y-3"><form onSubmit={(event) => { event.preventDefault(); deliver(code); }}><label className="mb-1.5 block text-sm font-medium">{label}</label><div className="flex gap-2"><div className="relative flex-1"><Keyboard className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={code} onChange={(event) => setCode(event.target.value)} disabled={paused} autoComplete="off" autoCapitalize="characters" spellCheck={false} className="font-mono uppercase pl-9" placeholder="I000001" aria-label={label} /></div><Button type="submit" disabled={paused || !code.trim()}><ScanLine className="size-4" />识别</Button></div><p className="mt-1.5 text-xs text-muted-foreground">扫码枪请聚焦输入框并扫描；只在回车结束后识别，不会劫持普通键盘。</p></form>
    {mobile && <div>{cameraOn ? <div className="overflow-hidden rounded-lg bg-black"><div className="relative"><video ref={videoRef} muted playsInline autoPlay className="aspect-[4/3] w-full object-cover" /><div className="pointer-events-none absolute inset-x-[7%] inset-y-[28%] rounded-lg border-2 border-white/90 shadow-[0_0_0_999px_rgb(0_0_0/.28)]"><span className="absolute inset-x-3 top-1/2 h-px -translate-y-1/2 bg-red-400/90" /></div><p className="pointer-events-none absolute inset-x-3 top-3 text-center text-xs font-medium text-white drop-shadow">横向放置条码，保持画面清晰稳定</p></div><div className="flex flex-wrap items-center gap-2 bg-black/95 p-3">{torchAvailable && <Button type="button" variant={torchOn ? "default" : "secondary"} size="sm" onClick={() => { const next = !torchOn; void controlsRef.current?.switchTorch?.(next).then(() => setTorchOn(next)).catch(() => setCameraError("当前设备无法切换补光灯。")); }}><Flashlight className="size-4" />{torchOn ? "关闭补光灯" : "开启补光灯"}</Button>}{zoomRange && <label className="flex min-w-36 flex-1 items-center gap-2 text-xs text-white"><span>缩放</span><input type="range" min={zoomRange.min} max={zoomRange.max} step={zoomRange.step} value={zoom} className="min-w-0 flex-1 accent-blue-500" onChange={(event) => { const next = Number(event.target.value); setZoom(next); void videoTrackRef.current?.applyConstraints({ advanced: [{ zoom: next } as MediaTrackConstraintSet] }).catch(() => setCameraError("当前设备无法调整摄像头缩放。")); }} /></label>}<Button type="button" variant="secondary" size="sm" className="ml-auto" onClick={stopCamera}><CameraOff className="size-4" />暂停</Button></div></div> : <Button type="button" variant="outline" className="w-full" onClick={startCamera} disabled={paused}><Camera className="size-4" />开启后置摄像头连续扫码</Button>}</div>}
    {cameraError && <Alert title="扫码不可用" tone="warning">{cameraError}</Alert>}
  </div>;
}
