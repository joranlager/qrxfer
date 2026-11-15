// Decodes camera frames off the main thread with zxing-cpp (WebAssembly).
// Finds many QR codes in one frame.
//
// build.mjs replaces the importScripts line below with the contents of vendor/zxing-reader.js,
// and sets self.WASM_URL to an inline copy of vendor/zxing_reader.wasm.
importScripts('vendor/zxing-reader.js');

const WASM_URL = self.WASM_URL || new URL('vendor/zxing_reader.wasm', self.location.href).href;

ZXingWASM.prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) => (path.endsWith('.wasm') ? WASM_URL : prefix + path),
  },
  fireImmediately: true,
}).then(
  () => self.postMessage({ type: 'ready' }),
  (e) => self.postMessage({ type: 'error', message: String(e) })
);

const OPTIONS = {
  formats: ['QRCode'],
  tryHarder: true,
  tryRotate: true,
  tryInvert: false,
  tryDownscale: true,
  maxNumberOfSymbols: 64,
};

self.onmessage = async (e) => {
  const { id, width, height, buffer } = e.data;
  try {
    const img = new ImageData(new Uint8ClampedArray(buffer), width, height);
    const results = await ZXingWASM.readBarcodes(img, OPTIONS);
    const codes = [];
    for (const r of results) if (r.isValid && r.bytes && r.bytes.length) codes.push(r.bytes.slice());
    self.postMessage({ type: 'result', id, codes, buffer }, [buffer]);
  } catch (err) {
    self.postMessage({ type: 'result', id, codes: [], buffer, error: String(err) }, [buffer]);
  }
};
