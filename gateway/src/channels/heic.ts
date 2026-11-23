// An iPhone's photos are HEIC, which Claude doesn't read: they're turned into JPEGs on arrival
// (channels/imessage.ts). The work runs in a worker thread (heic-worker.mjs), so a large photo
// doesn't hold up the gateway, with a time limit and a memory limit of its own.
//
// The decoder is libheif-js (libheif and libde265 compiled to WebAssembly, LGPL-3.0), used
// unchanged as a dependency through heic-decode; the encoder is jpeg-js.
import { Worker } from "node:worker_threads";

const TIMEOUT_MS = 60_000;

export function isHeic(type: string, name: string): boolean {
  return /^image\/hei[cf](-sequence)?$/.test(type) || /\.hei[cf]$/i.test(name);
}

/** The photo as a JPEG (at most 2048 pixels on a side). Rejects when it isn't a readable HEIC. */
export function heicToJpeg(bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./heic-worker.mjs", import.meta.url), { workerData: { bytes: new Uint8Array(bytes) }, resourceLimits: { maxOldGenerationSizeMb: 768 } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("the photo took too long to convert"));
    }, TIMEOUT_MS);
    timer.unref();
    worker.once("message", (m: { jpeg: Uint8Array }) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(Buffer.from(m.jpeg));
    });
    worker.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error("the photo couldn't be converted"));
    });
  });
}
