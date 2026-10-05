import {
  type CommandTable,
  type InvokeOptions,
  blossomAuth,
  buffer,
  mimeType,
  pickFiles,
  prepareImageForUpload,
  relayHttpUrl,
} from "./core";
import { emitWebEvent } from "./events";

// Same cap as the native download/fetch commands.
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

// Cancellation registries mirror the native ones: a cancel that arrives before
// the request begins is retained, and release always clears the entry.
const uploads = new Map<string, AbortController>();
const fetches = new Map<string, AbortController>();

function begin(registry: Map<string, AbortController>, id: string) {
  let controller = registry.get(id);
  if (!controller) {
    controller = new AbortController();
    registry.set(id, controller);
  }
  return controller.signal;
}

function cancel(registry: Map<string, AbortController>, id: unknown) {
  begin(registry, String(id));
  registry.get(String(id))?.abort();
}

export function sanitizeFilename(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").trim();
  const cleaned = Array.from(base.replace(/\p{Cc}/gu, ""))
    .slice(0, 255)
    .join("");
  return cleaned || "file";
}

export function rawUploadHeader(
  headers: HeadersInit | undefined,
  name: string,
): string | undefined {
  const value = new Headers(headers).get(name);
  if (value === null) return undefined;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    throw new Error(`invalid ${name} header`);
  }
}

export function rawUploadBody(body: unknown): Uint8Array {
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body))
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  throw new Error("raw upload requires a byte body");
}

function relayError(text: string, fallback: string): string {
  try {
    const { error } = JSON.parse(text);
    if (typeof error === "string" && error) return error;
  } catch {
    // Plain-text relay errors are shown as-is.
  }
  return text || fallback;
}

function put(
  url: string,
  headers: Record<string, string>,
  body: ArrayBuffer,
  progressId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  // XHR rather than fetch: browsers only report upload progress through it.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers))
      xhr.setRequestHeader(name, value);
    if (progressId)
      xhr.upload.onprogress = (event) =>
        emitWebEvent("media-upload-progress", {
          id: progressId,
          sent: event.loaded,
          total: event.lengthComputable ? event.total : body.byteLength,
        });
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300)
        return reject(
          new Error(relayError(xhr.responseText, "Media upload failed.")),
        );
      try {
        resolve(JSON.parse(xhr.responseText));
      } catch {
        reject(new Error("Relay returned an invalid upload response."));
      }
    };
    xhr.onerror = () => reject(new Error("Media upload failed."));
    xhr.onabort = () => reject(new Error("upload cancelled"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    if (signal?.aborted) return xhr.abort();
    xhr.send(body);
  });
}

export async function uploadMedia(
  data: Uint8Array,
  filename?: string,
  progressId?: string,
) {
  const signal = progressId ? begin(uploads, progressId) : undefined;
  const phase = (name: string) =>
    progressId &&
    emitWebEvent("media-upload-phase", { id: progressId, phase: name });
  try {
    if (data.length === 0) throw new Error("empty upload");
    if (signal?.aborted) throw new Error("upload cancelled");
    phase("preparing");
    let type = mimeType(data, filename);
    const originalType = type;
    if (type.startsWith("image/")) {
      ({ data, type } = await prepareImageForUpload(data, type, filename));
      if (filename && type !== originalType)
        filename = `${filename.replace(/\.[^./\\]+$/, "")}.${type === "image/jpeg" ? "jpg" : type.split("/")[1]}`;
    }
    const body = buffer(data);
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", body)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const descriptor = await put(
      `${relayHttpUrl()}/upload`,
      {
        Authorization: blossomAuth("upload", hash),
        "Content-Type": type,
        "X-SHA-256": hash,
      },
      body,
      progressId,
      signal,
    );
    phase("finishing");
    return filename
      ? { ...descriptor, filename: sanitizeFilename(filename) }
      : descriptor;
  } finally {
    if (progressId) uploads.delete(progressId);
  }
}

function mediaUrl(value: unknown): URL {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("invalid URL");
  }
  if (url.origin !== relayHttpUrl())
    throw new Error("download URL must match the relay origin");
  if (!url.pathname.startsWith("/media/"))
    throw new Error("download URL must be a /media/ path");
  return url;
}

async function fetchMedia(
  value: unknown,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const url = mediaUrl(value);
  try {
    // Never follow redirects: the read token must not leave the relay origin.
    const response = await fetch(url, {
      credentials: "omit",
      headers: { Authorization: blossomAuth("get") },
      redirect: "error",
      signal,
    });
    if (!response.ok)
      throw new Error(
        relayError(await response.text(), `relay returned ${response.status}`),
      );
    if (Number(response.headers.get("content-length")) > MAX_DOWNLOAD_BYTES)
      throw new Error("file too large (max 50 MiB)");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES)
      throw new Error("file too large (max 50 MiB)");
    return bytes;
  } catch (error) {
    if (signal?.aborted) throw new Error("media fetch cancelled");
    throw error;
  }
}

export function saveBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.click();
  // Revoking synchronously can cancel the download in Firefox and Safari.
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

async function download(url: unknown, filename: string): Promise<boolean> {
  const bytes = new Uint8Array(await fetchMedia(url));
  saveBlob(
    new Blob([bytes], { type: mimeType(bytes, filename) }),
    sanitizeFilename(filename),
  );
  return true;
}

async function toPng(bytes: ArrayBuffer): Promise<Blob> {
  const bitmap = await createImageBitmap(new Blob([bytes])).catch(() => {
    throw new Error("failed to decode image");
  });
  try {
    if (bitmap.width * bitmap.height * 4 > MAX_DOWNLOAD_BYTES)
      throw new Error("image too large to copy to clipboard");
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!png) throw new Error("failed to decode image");
    return png;
  } finally {
    bitmap.close();
  }
}

export const mediaCommands: CommandTable = {
  upload_media_bytes_raw: (
    body: unknown,
    options?: InvokeOptions,
  ): Promise<unknown> =>
    uploadMedia(
      rawUploadBody(body),
      rawUploadHeader(options?.headers, "x-buzz-filename"),
      rawUploadHeader(options?.headers, "x-buzz-progress-id"),
    ),
  upload_media_bytes: ({ data, filename, progressId }) =>
    uploadMedia(
      Uint8Array.from(data as number[]),
      filename ? String(filename) : undefined,
      progressId ? String(progressId) : undefined,
    ),
  pick_and_upload_media: async ({ progressId }) => {
    // Sequential under one progress id, like the native picker.
    const descriptors = [];
    for (const file of await pickFiles("", true))
      descriptors.push(
        await uploadMedia(
          new Uint8Array(await file.arrayBuffer()),
          file.name,
          progressId ? String(progressId) : undefined,
        ),
      );
    return descriptors;
  },
  pick_and_upload_image: async () => {
    const [file] = await pickFiles("image/*", false);
    if (!file) return null;
    const data = new Uint8Array(await file.arrayBuffer());
    if (!mimeType(data).startsWith("image/"))
      throw new Error("selected file is not a supported image");
    return uploadMedia(data, file.name);
  },
  cancel_media_upload: ({ progressId }) => cancel(uploads, progressId),
  release_media_upload: ({ progressId }) => {
    uploads.delete(String(progressId));
  },
  fetch_media_bytes: async ({ url, requestId }) => {
    const id = requestId ? String(requestId) : undefined;
    try {
      return await fetchMedia(url, id ? begin(fetches, id) : undefined);
    } finally {
      if (id) fetches.delete(id);
    }
  },
  cancel_media_fetch: ({ requestId }) => cancel(fetches, requestId),
  release_media_fetch: ({ requestId }) => {
    fetches.delete(String(requestId));
  },
  download_file: ({ url, filename }) => download(url, String(filename ?? "")),
  download_image: ({ url }) =>
    download(url, mediaUrl(url).pathname.split("/").pop() || "image.png"),
  copy_image_to_clipboard: async ({ url }) => {
    mediaUrl(url);
    // Hand the clipboard a pending blob synchronously: Safari only allows the
    // write inside the click's user activation, which the fetch would outlive.
    const png = fetchMedia(url).then(toPng);
    await Promise.all([
      navigator.clipboard.write([new ClipboardItem({ "image/png": png })]),
      png,
    ]);
  },
};
