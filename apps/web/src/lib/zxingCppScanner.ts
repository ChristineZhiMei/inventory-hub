type ZXingReaderModule = typeof import("zxing-wasm/reader");

let modulePromise: Promise<ZXingReaderModule> | null = null;

async function loadReader(): Promise<ZXingReaderModule> {
  if (!modulePromise) {
    const loading = Promise.all([
      import("zxing-wasm/reader"),
      import("zxing-wasm/reader/zxing_reader.wasm?url"),
    ]).then(async ([reader, wasm]) => {
      await reader.prepareZXingModule({
        overrides: {
          locateFile: (path: string) => path.endsWith(".wasm")
            ? wasm.default
            : path,
        },
        fireImmediately: true,
      });
      return reader;
    });
    modulePromise = loading.catch((error: unknown) => {
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}

export async function warmupZXingCppScanner(): Promise<void> {
  await loadReader();
}

export async function decodeCode128WithZXingCpp(
  image: ImageData,
  thresholded: boolean,
): Promise<string | null> {
  const reader = await loadReader();
  const results = await reader.readBarcodes(image, {
    formats: ["Code128"],
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: true,
    binarizer: thresholded ? "BoolCast" : "LocalAverage",
    minLineCount: 1,
    maxNumberOfSymbols: 1,
    returnErrors: false,
  });
  return results.find((result) => !result.error && result.text)?.text ?? null;
}
