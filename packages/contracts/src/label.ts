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
export function renderLabelHtml(label: { code: string; name?: string | undefined }, paper: LabelPaper, barcodeSource: string): string {
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
body { color: #000; background: #fff; font-family: Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif; }
main { width: 100%; height: 100%; padding: ${marginMm}mm; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1mm; }
img { display: block; width: 100%; height: 10mm; object-fit: fill; flex-shrink: 0; }
.code { max-width: 100%; white-space: nowrap; font: 700 10pt 'Courier New', monospace; }
.name { max-width: 100%; font-size: 9pt; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style></head><body><main>
<img alt="${escapeHtml(label.code)}" src="${escapeHtml(barcodeSource)}">
<div class="code">${escapeHtml(label.code)}</div>
${label.name ? `<div class="name">${escapeHtml(label.name)}</div>` : ""}
</main></body></html>`;
}
