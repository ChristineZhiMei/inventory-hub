import { labelPaper, renderLabelHtml, type LabelPaper } from "@inventory-hub/contracts";
import { printPreferences } from "@/lib/localPrinting";

export function CodeLabel({ code, name, paper }: { code: string; name?: string; paper?: LabelPaper }) {
  const dimensions = paper ?? labelPaper(`default-${printPreferences().paper}`);
  const html = renderLabelHtml({ code, name }, dimensions,
    `${window.location.origin}/api/v1/codes/${encodeURIComponent(code)}/barcode`);
  return <iframe title={`${code} 标签预览`} sandbox="allow-same-origin" srcDoc={html}
    className="block shrink-0 border-0 bg-white"
    style={{ width: `${dimensions.widthMm}mm`, height: `${dimensions.heightMm}mm` }} />;
}
