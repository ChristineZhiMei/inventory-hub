import { useEffect, useRef } from "react";
import JsBarcode from "jsbarcode";

export function CodeLabel({ code, name, compact = false }: { code: string; name?: string; compact?: boolean }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!ref.current || !code) return;
    try { JsBarcode(ref.current, code, { format: "CODE128", width: compact ? 1.45 : 2, height: compact ? 44 : 68, margin: 0, displayValue: false, background: "transparent", lineColor: "currentColor" }); }
    catch { ref.current.replaceChildren(); }
  }, [code, compact]);
  return <div className="inline-flex max-w-full flex-col items-center rounded-md border bg-white p-4 text-slate-950"><svg ref={ref} className="max-w-full" role="img" aria-label={`${code} 条形码`} /><p className="mt-2 font-mono text-lg font-semibold tracking-widest">{code}</p>{name && !compact && <p className="mt-1 max-w-64 truncate text-sm text-slate-600">{name}</p>}</div>;
}
