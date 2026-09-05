import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { Camera, CameraOff, Keyboard, ScanLine } from "lucide-react";
import { errorMessage } from "@/lib/api";
import { playScanSuccessSound, unlockScanSound } from "@/lib/scanSound";
import { normalizeCode } from "@/lib/utils";
import { Alert, Button, Input } from "./AntUi";

export function ScannerInput({ onCode, paused = false, label = "扫描或输入编号" }: { onCode: (code: string) => void | Promise<void>; paused?: boolean; label?: string }) {
  const [code, setCode] = useState("");
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
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
  function stopCamera() { controlsRef.current?.stop(); controlsRef.current = null; if (videoRef.current?.srcObject) for (const track of (videoRef.current.srcObject as MediaStream).getTracks()) track.stop(); setCameraOn(false); }
  useEffect(() => {
    if (!cameraOn || paused || !videoRef.current) return;
    let disposed = false;
    const reader = new BrowserMultiFormatReader();
    reader.decodeFromConstraints({ video: { facingMode: { ideal: "environment" } }, audio: false }, videoRef.current, (result) => { if (result && !disposed) deliver(result.getText()); }).then((controls) => { if (disposed) controls.stop(); else controlsRef.current = controls; }).catch((error: unknown) => { setCameraError(error instanceof DOMException && error.name === "NotAllowedError" ? "摄像头权限被拒绝，请在浏览器设置中允许或使用手动输入。" : "摄像头无法启动，可能正被其他应用占用。"); setCameraOn(false); });
    return () => { disposed = true; controlsRef.current?.stop(); controlsRef.current = null; };
  }, [cameraOn, paused]);
  useEffect(() => {
    const visibility = () => { if (document.hidden) stopCamera(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("visibilitychange", visibility); stopCamera(); };
  }, []);
  return <div className="space-y-3"><form onSubmit={(event) => { event.preventDefault(); deliver(code); }}><label className="mb-1.5 block text-sm font-medium">{label}</label><div className="flex gap-2"><div className="relative flex-1"><Keyboard className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={code} onChange={(event) => setCode(event.target.value)} disabled={paused} autoComplete="off" autoCapitalize="characters" spellCheck={false} className="font-mono uppercase pl-9" placeholder="I000001" aria-label={label} /></div><Button type="submit" disabled={paused || !code.trim()}><ScanLine className="size-4" />识别</Button></div><p className="mt-1.5 text-xs text-muted-foreground">扫码枪请聚焦输入框并扫描；只在回车结束后识别，不会劫持普通键盘。</p></form>
    {mobile && <div>{cameraOn ? <div className="relative overflow-hidden rounded-lg bg-black"><video ref={videoRef} muted playsInline className="aspect-[4/3] w-full object-cover" /><div className="pointer-events-none absolute inset-[18%] rounded-lg border-2 border-white/80 shadow-[0_0_0_999px_rgb(0_0_0/.28)]" /><Button type="button" variant="secondary" className="absolute bottom-3 left-1/2 -translate-x-1/2" onClick={stopCamera}><CameraOff className="size-4" />暂停摄像头</Button></div> : <Button type="button" variant="outline" className="w-full" onClick={startCamera} disabled={paused}><Camera className="size-4" />开启后置摄像头连续扫码</Button>}</div>}
    {cameraError && <Alert title="扫码不可用" tone="warning">{cameraError}</Alert>}
  </div>;
}
