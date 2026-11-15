Open the app on the receiver, choose Receive and point the camera at this screen. After the countdown, all data codes are sent once. When they are done, only parity codes are sent, until you stop. A parity code can replace any lost code (like PAR files), so the receiver never has to wait for one particular code to come around again. Turn the screen brightness up. If the receiver misses codes: increase the time per packet, lower the bytes per QR code, or use fewer QR codes per packet.

## Development

All development happens in `index_dev.html` and the files it lists (`style.css`, `app.js`, `protocol.js`, `decoder-worker.js`, `vendor/`). The head of `index_dev.html` documents every library and resource the app uses.

Run the development page from a local web server (ES modules and the decoder worker do not run from `file://`):

```
python -m http.server 8080
```

then open http://localhost:8080/index_dev.html.

## Build

`index.html` is generated, so do not edit it by hand. Build it with Node 18 or newer (no dependencies):

```
node build.mjs
```

The build inlines the stylesheet, the JavaScript (the app, the protocol and the QR generator), the decoder worker with its zxing-cpp library and WebAssembly binary, the logo and the favicon into one self-contained `index.html`. The manifest and the install icons stay separate files because installing the app needs real files. The GitHub Pages workflow runs the build before deploying, so the live page is always built from `index_dev.html`.

## Third-party notices

QRXFER bundles the following third-party components. Each keeps its own license.

| Component | Files | License | Copyright |
|---|---|---|---|
| QR code generator (`qrcode.mjs`) | `vendor/qrcode.mjs` | MIT | Copyright (c) 2009 Kazuhiko Arase |
| zxing-wasm JavaScript wrapper (`zxing-reader.js`), version 3.1.6 | `vendor/zxing-reader.js` | MIT | Copyright (c) 2023 Ze-Zheng Wu |
| zxing-cpp WebAssembly reader (`zxing_reader.wasm`), built from zxing-cpp commit `2c3dcfe` | `vendor/zxing_reader.wasm` | Apache-2.0 | zxing-cpp contributors |

The MIT license text for the zxing-wasm wrapper is in [`vendor/LICENSE-zxing-wasm.txt`](vendor/LICENSE-zxing-wasm.txt). The Apache License 2.0 text for zxing-cpp is in [`vendor/LICENSE-zxing-cpp.txt`](vendor/LICENSE-zxing-cpp.txt). The MIT license for `qrcode.mjs` is at http://www.opensource.org/licenses/mit-license.php, as stated in the file header.

Sources: the wrapper is [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) and the reader is [zxing-cpp](https://github.com/zxing-cpp/zxing-cpp).
