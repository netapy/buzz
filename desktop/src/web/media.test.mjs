import assert from "node:assert/strict";
import test from "node:test";

import { generateSecretKey } from "nostr-tools";

globalThis.location = new URL("https://buzz.test/");
const { setIdentity } = await import("./core.ts");
const { listen } = await import("./events.ts");
const { mediaCommands, rawUploadBody, rawUploadHeader, sanitizeFilename } =
  await import("./media.ts");

setIdentity(generateSecretKey());

// Same encoding as encodeRawIpcHeader in shared/api/tauriMedia.ts.
function encodeHeader(value) {
  let binary = "";
  for (const byte of new TextEncoder().encode(value))
    binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

const PDF = new TextEncoder().encode("%PDF-1.4\n%test\n");

class FakeXhr {
  static last = null;
  static respond = { status: 200, body: "{}" };
  upload = {};
  headers = {};
  open(method, url) {
    Object.assign(this, { method, url });
  }
  setRequestHeader(name, value) {
    this.headers[name] = value;
  }
  abort() {
    this.onabort?.();
  }
  send(body) {
    FakeXhr.last = this;
    this.body = body;
    queueMicrotask(() => {
      if (this.hold) return;
      this.upload.onprogress?.({
        loaded: body.byteLength,
        total: body.byteLength,
        lengthComputable: true,
      });
      this.status = FakeXhr.respond.status;
      this.responseText = FakeXhr.respond.body;
      this.onload();
    });
  }
}
globalThis.XMLHttpRequest = FakeXhr;

test("raw upload headers decode unicode filenames like the Rust side", () => {
  const headers = { "x-buzz-filename": encodeHeader("clip 🎬.mp4") };
  assert.equal(rawUploadHeader(headers, "x-buzz-filename"), "clip 🎬.mp4");
  assert.equal(rawUploadHeader(headers, "x-buzz-progress-id"), undefined);
  assert.equal(rawUploadHeader(undefined, "x-buzz-filename"), undefined);
  assert.throws(
    () => rawUploadHeader({ "x-buzz-filename": "_w" }, "x-buzz-filename"),
    /invalid x-buzz-filename header/,
  );
});

test("raw upload body accepts bytes and rejects JSON args", () => {
  const view = new Uint8Array([9, 1, 2, 3]).subarray(1);
  assert.deepEqual([...rawUploadBody(view)], [1, 2, 3]);
  assert.deepEqual([...rawUploadBody(new Uint8Array([4]).buffer)], [4]);
  assert.throws(() => rawUploadBody({ data: [1] }), /requires a byte body/);
});

test("sanitizeFilename matches media_filename.rs", () => {
  assert.equal(sanitizeFilename("report.pdf"), "report.pdf");
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("C:\\Users\\me\\doc.docx"), "doc.docx");
  assert.equal(sanitizeFilename(""), "file");
  assert.equal(sanitizeFilename("/"), "file");
  assert.equal(sanitizeFilename("a\nb\tc.txt"), "abc.txt");
});

test("raw upload sends Blossom PUT, emits progress/phase and returns descriptor", async () => {
  const events = [];
  const stops = await Promise.all(
    ["media-upload-progress", "media-upload-phase"].map((name) =>
      listen(name, (event) => events.push([name, event.payload])),
    ),
  );
  FakeXhr.respond = {
    status: 200,
    body: JSON.stringify({ url: "https://buzz.test/media/x.pdf", size: 15 }),
  };
  const descriptor = await mediaCommands.upload_media_bytes_raw(PDF, {
    headers: {
      "x-buzz-filename": encodeHeader("dir/Rapport été.pdf"),
      "x-buzz-progress-id": encodeHeader("p1"),
    },
  });
  for (const stop of stops) stop();
  assert.equal(descriptor.filename, "Rapport été.pdf");
  assert.equal(descriptor.url, "https://buzz.test/media/x.pdf");
  const xhr = FakeXhr.last;
  assert.equal(xhr.method, "PUT");
  assert.equal(xhr.url, "https://buzz.test/upload");
  assert.equal(xhr.headers["Content-Type"], "application/pdf");
  assert.match(xhr.headers.Authorization, /^Nostr /);
  assert.match(xhr.headers["X-SHA-256"], /^[\da-f]{64}$/);
  assert.deepEqual(events, [
    ["media-upload-phase", { id: "p1", phase: "preparing" }],
    ["media-upload-progress", { id: "p1", sent: 15, total: 15 }],
    ["media-upload-phase", { id: "p1", phase: "finishing" }],
  ]);
});

test("relay JSON errors surface their message", async () => {
  FakeXhr.respond = {
    status: 415,
    body: '{"error":"disallowed content type: audio/mpeg"}',
  };
  await assert.rejects(
    mediaCommands.upload_media_bytes({ data: [...PDF] }),
    /^Error: disallowed content type: audio\/mpeg$/,
  );
});

test("upload cancellation works before and during the request", async () => {
  await mediaCommands.cancel_media_upload({ progressId: "early" });
  await assert.rejects(
    mediaCommands.upload_media_bytes({ data: [...PDF], progressId: "early" }),
    /upload cancelled/,
  );
  await mediaCommands.release_media_upload({ progressId: "early" });

  const pending = mediaCommands.upload_media_bytes({
    data: [...PDF],
    progressId: "late",
  });
  const original = FakeXhr.prototype.send;
  FakeXhr.prototype.send = function (body) {
    this.hold = true;
    original.call(this, body);
  };
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await mediaCommands.cancel_media_upload({ progressId: "late" });
    await assert.rejects(pending, /upload cancelled/);
  } finally {
    FakeXhr.prototype.send = original;
  }
  await mediaCommands.release_media_upload({ progressId: "late" });
});

test("cancel/release never throw for unknown ids", () => {
  for (const command of [
    "cancel_media_upload",
    "release_media_upload",
    "cancel_media_fetch",
    "release_media_fetch",
  ])
    mediaCommands[command]({ progressId: "nope", requestId: "nope" });
  assert.equal(
    mediaCommands.cancel_media_upload({ progressId: "nope" }),
    undefined,
  );
});

test("media fetches stay on the relay origin and /media/ path", async () => {
  await assert.rejects(
    mediaCommands.fetch_media_bytes({ url: "https://evil.test/media/a.png" }),
    /must match the relay origin/,
  );
  await assert.rejects(
    mediaCommands.download_file({
      url: "https://buzz.test/api/x",
      filename: "x",
    }),
    /must be a \/media\/ path/,
  );
  await assert.rejects(
    mediaCommands.copy_image_to_clipboard({ url: "not a url" }),
    /invalid URL/,
  );
});

test("fetch_media_bytes sends Blossom GET auth and maps cancellation", async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), init };
    if (init.signal.aborted) throw new DOMException("aborted", "AbortError");
    return new Response(PDF);
  };
  try {
    const bytes = await mediaCommands.fetch_media_bytes({
      url: "https://buzz.test/media/abc.pdf",
      requestId: "r1",
    });
    assert.equal(new Uint8Array(bytes).length, PDF.length);
    assert.match(seen.init.headers.Authorization, /^Nostr /);
    assert.equal(seen.init.redirect, "error");

    mediaCommands.cancel_media_fetch({ requestId: "r2" });
    await assert.rejects(
      mediaCommands.fetch_media_bytes({
        url: "https://buzz.test/media/abc.pdf",
        requestId: "r2",
      }),
      /media fetch cancelled/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
