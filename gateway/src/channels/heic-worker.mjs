// Turns an iPhone's HEIC photo into a JPEG, off the gateway's main thread (decoding a 12-megapixel
// photo in WebAssembly and encoding it in JavaScript takes a few seconds). Started by heic.ts with
// the photo's bytes; posts the JPEG back. Photos larger than 2048 pixels on a side are halved (or
// more) by averaging, which is what a model reads anyway and keeps the JPEG small.
import { parentPort, workerData } from "node:worker_threads";
import decode from "heic-decode";
import jpeg from "jpeg-js";

const MAX_SIDE = 2048;
const { width, height, data } = await decode({ buffer: workerData.bytes });
const f = Math.max(1, Math.ceil(Math.max(width, height) / MAX_SIDE));
let out = { data, width, height };
if (f > 1) {
  const w = Math.floor(width / f);
  const h = Math.floor(height / f);
  const small = new Uint8Array(w * h * 4);
  const n = f * f;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < f; dy++) {
        let i = ((y * f + dy) * width + x * f) * 4;
        for (let dx = 0; dx < f; dx++, i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
        }
      }
      const o = (y * w + x) * 4;
      small[o] = r / n;
      small[o + 1] = g / n;
      small[o + 2] = b / n;
      small[o + 3] = 255;
    }
  }
  out = { data: small, width: w, height: h };
}
const encoded = jpeg.encode(out, 82);
parentPort.postMessage({ jpeg: new Uint8Array(encoded.data), width: out.width, height: out.height });
