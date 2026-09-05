export interface LabelPaper {
  widthMm: number;
  heightMm: number;
  marginMm: number;
}

export function labelPaper(templateId = "default-40x30"): LabelPaper {
  return { widthMm: templateId === "default-50x30" ? 50 : 40, heightMm: 30, marginMm: 1.5 };
}

export const labelBarcodeOptions = {
  bcid: "code128", scale: 3, height: 10, includetext: false,
  paddingwidth: 0, paddingheight: 0, backgroundcolor: "FFFFFF",
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// Screen preview and Electron printing consume this exact document.
export function renderLabelHtml(
  label: {
    code: string;
    name?: string | undefined;
    specifications?: Array<{ name: string }> | undefined;
    categories?: Array<{ name: string }> | undefined;
  },
  paper: LabelPaper,
  barcodeSource: string,
): string {
  const { widthMm, heightMm, marginMm } = paper;
  if (![widthMm, heightMm, marginMm].every(Number.isFinite) || widthMm <= 0 || heightMm <= 0 || marginMm < 0) {
    throw new Error("INVALID_LABEL_PAPER");
  }
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:">
<title>${escapeHtml(label.code)}</title>
<style>
@page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
* { box-sizing: border-box; }
html, body { width: ${widthMm}mm; height: ${heightMm}mm; margin: 0; overflow: hidden; }
body { color: #000; background: #fff; font-family: 'PingFang SC', 'Hiragino Sans GB', 'STHeiti', 'Microsoft YaHei', 'Noto Sans CJK SC', Arial, sans-serif; }
main { width: 100%; height: 100%; padding: ${marginMm}mm; display: flex; flex-direction: column; }
.meta { width: 100%; min-width: 0; overflow: hidden; font-family: 'PingFang SC', 'Hiragino Sans GB', 'STHeiti', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif; font-size: 7pt; font-weight: 600; line-height: 1.15; text-align: left; }
.line { width: 100%; overflow-wrap: anywhere; }
.barcode { width: 100%; flex-shrink: 0; margin-top: auto; text-align: center; }
.barcode img { display: block; width: 100%; height: 9mm; object-fit: fill; }
.code { margin-top: .35mm; font: 600 6pt/1.05 Arial, sans-serif; letter-spacing: .2mm; white-space: nowrap; }
</style></head><body><main>
<div class="meta">
<div class="line">名称：${escapeHtml(label.name || "—")}</div>
<div class="line">规格：${escapeHtml(label.specifications?.map((item) => item.name).join("/") || "—")}</div>
<div class="line">分类：${escapeHtml(label.categories?.map((item) => item.name).join("、") || "—")}</div>
</div>
<div class="barcode">
<img alt="${escapeHtml(label.code)}" src="${escapeHtml(barcodeSource)}">
<div class="code">${escapeHtml(label.code)}</div>
</div>
</main></body></html>`;
}
