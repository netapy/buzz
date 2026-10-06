import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { finalizeEvent, getPublicKey, nip98 } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";
import { parse as parseYaml } from "yaml";

export const VAULT_DATABASE = "buzz-desktop-web-vault";
export const VAULT_STORE = "identity";
export const VAULT_ID = "current";
export const encoder = new TextEncoder();

export type StoredIdentity = {
  id: typeof VAULT_ID;
  ciphertext: ArrayBuffer;
  iv: Uint8Array;
  pubkey: string;
  wrappingKey: CryptoKey;
};

let secretKey: Uint8Array | null = null;
let lockedPubkey: string | null = null;

export function getSecretKey(): Uint8Array | null {
  return secretKey;
}

export function getLockedPubkey(): string | null {
  return lockedPubkey;
}

export function setIdentity(
  key: Uint8Array | null,
  locked: string | null = null,
) {
  secretKey = key;
  lockedPubkey = locked;
}

export function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function openStore(name: string, store: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(store, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  name: string,
  store: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openStore(name, store);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(store, mode);
    const request = operation(transaction.objectStore(store));
    let result: T;
    request.onsuccess = () => {
      result = request.result;
    };
    transaction.oncomplete = () => {
      database.close();
      resolve(result);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
    transaction.onabort = transaction.onerror;
  });
}

export function withVault<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return withStore(VAULT_DATABASE, VAULT_STORE, mode, operation);
}

// What the service worker needs to turn a push wake into notifications:
// where to query, the lease filters that woke it, names for titles, and
// what it already showed.
export type PushContext = {
  id: "current";
  pubkey: string;
  relay: string;
  filters: Record<string, unknown>[];
  channels: Record<string, { name: string; dm: boolean }>;
  lastSeen?: number;
  notified?: string[];
};

export function readPushContext(): Promise<PushContext | undefined> {
  return withStore("buzz-desktop-web-push", "context", "readonly", (store) =>
    store.get("current"),
  );
}

export function writePushContext(context: PushContext): Promise<unknown> {
  return withStore("buzz-desktop-web-push", "context", "readwrite", (store) =>
    store.put(context),
  );
}

export async function loadIdentity(): Promise<Uint8Array | null> {
  const stored = await withVault<StoredIdentity | undefined>(
    "readonly",
    (store) => store.get(VAULT_ID),
  );
  if (!stored) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buffer(stored.iv) },
      stored.wrappingKey,
      stored.ciphertext,
    );
    const key = new Uint8Array(plaintext);
    if (getPublicKey(key) !== stored.pubkey)
      throw new Error("Browser identity is inconsistent.");
    return key;
  } catch {
    lockedPubkey = stored.pubkey;
    return null;
  }
}

export async function saveIdentity(key: Uint8Array): Promise<void> {
  const wrappingKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: buffer(iv) },
    wrappingKey,
    buffer(key),
  );
  await withVault("readwrite", (store) =>
    store.put({
      id: VAULT_ID,
      ciphertext,
      iv,
      pubkey: getPublicKey(key),
      wrappingKey,
    } satisfies StoredIdentity),
  );
}

export function requireSecretKey(): Uint8Array {
  if (!secretKey) throw new Error("Browser identity is locked.");
  return secretKey;
}

let activeRelayUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;

export function setActiveRelayUrl(url: string): void {
  activeRelayUrl = url.replace(/\/$/, "");
}

export function relayWsUrl(): string {
  return activeRelayUrl;
}

export function relayHttpUrl(): string {
  const url = new URL(activeRelayUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

export type InvokeOptions = { headers?: HeadersInit };

export type CommandTable = Record<
  string,
  (
    args: Record<string, unknown>,
    options?: InvokeOptions,
  ) => unknown | Promise<unknown>
>;

export type RelayEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

export async function relayRequest<T>(path: string, body: unknown): Promise<T> {
  const url = `${relayHttpUrl()}${path}`;
  const auth = await nip98.getToken(
    url,
    "post",
    (template) =>
      finalizeEvent(
        {
          ...template,
          tags: [...template.tags, ["nonce", crypto.randomUUID()]],
        },
        requireSecretKey(),
      ),
    true,
    body as Record<string, unknown>,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Relay returned ${response.status}.`);
  }
  return response.json() as Promise<T>;
}

export function relayQuery(filters: Record<string, unknown>[]) {
  return relayRequest<RelayEvent[]>("/query", filters);
}

export async function submitEvent(event: RelayEvent) {
  const result = await relayRequest<{
    event_id: string;
    accepted: boolean;
    message: string;
  }>("/events", event);
  if (!result.accepted) throw new Error(result.message);
  return result;
}

export function signEvent(
  kind: number,
  content: string,
  tags: string[][],
  createdAt = Math.floor(Date.now() / 1000),
): RelayEvent {
  return finalizeEvent(
    { kind, content, tags, created_at: createdAt },
    requireSecretKey(),
  );
}

export async function publish(
  kind: number,
  content: string,
  tags: string[][],
): Promise<RelayEvent> {
  const event = signEvent(kind, content, tags);
  await submitEvent(event);
  return event;
}

export function tag(event: RelayEvent, name: string): string | null {
  return event.tags.find((candidate) => candidate[0] === name)?.[1] ?? null;
}

export function nipOaOwner(event: RelayEvent): string | null {
  for (const [name, owner, conditions, signature, ...extra] of event.tags) {
    if (
      name !== "auth" ||
      extra.length ||
      !/^[0-9a-f]{64}$/.test(owner) ||
      !/^[0-9a-f]{128}$/.test(signature) ||
      owner === event.pubkey
    )
      continue;
    const clauses = conditions
      ? conditions
          .split("&")
          .map((clause) => /^(kind=|created_at[<>])(0|[1-9]\d*)$/.exec(clause))
      : [];
    if (
      clauses.some(
        (clause) =>
          !clause ||
          Number(clause[2]) > (clause[1] === "kind=" ? 65_535 : 4_294_967_295),
      )
    )
      continue;
    try {
      const message = sha256(
        encoder.encode(
          `nostr:agent-auth:${event.pubkey.toLowerCase()}:${conditions}`,
        ),
      );
      if (schnorr.verify(hexToBytes(signature), message, hexToBytes(owner)))
        return owner;
    } catch {
      // Invalid tags are ordinary human profiles.
    }
  }
  return null;
}

export function archivedPubkeysFromSnapshot(
  snapshot: RelayEvent | undefined,
  relaySelf: string,
): string[] {
  try {
    const author = relaySelf.toLowerCase();
    if (
      !/^[0-9a-f]{64}$/.test(author) ||
      !snapshot ||
      snapshot.pubkey.toLowerCase() !== author ||
      !verifyEvent(snapshot)
    )
      return [];

    return snapshot.tags.flatMap(([name, pubkey]) => {
      const normalized = pubkey?.toLowerCase();
      return name === "p" && normalized && /^[0-9a-f]{64}$/.test(normalized)
        ? [normalized]
        : [];
    });
  } catch {
    return [];
  }
}

export function rawProfile(event: RelayEvent | undefined, pubkey: string) {
  const content = event ? JSON.parse(event.content || "{}") : {};
  const ownerPubkey = event ? nipOaOwner(event) : null;
  return {
    pubkey,
    display_name: content.display_name ?? content.name ?? null,
    avatar_url: content.picture ?? null,
    about: content.about ?? null,
    nip05_handle: content.nip05 ?? null,
    owner_pubkey: ownerPubkey,
    has_profile_event: event != null,
  };
}

export async function getRawProfile(pubkey = getPublicKey(requireSecretKey())) {
  const events = await relayQuery([
    { kinds: [0], authors: [pubkey], limit: 1 },
  ]);
  return rawProfile(events[0], pubkey);
}

export function rawChannelDetail<C extends object>(
  event: RelayEvent,
  channel: C,
) {
  const timestamp = new Date(event.created_at * 1000).toISOString();
  return {
    ...channel,
    created_by: event.pubkey,
    created_at: timestamp,
    updated_at: timestamp,
    topic_set_by: null,
    topic_set_at: null,
    purpose_set_by: null,
    purpose_set_at: null,
    topic_required: false,
    max_members: null,
    nip29_group_id: null,
  };
}

export function rawForumPost(event: RelayEvent, channelId: string) {
  return {
    event_id: event.id,
    pubkey: event.pubkey,
    sig: event.sig,
    content: event.content,
    kind: event.kind,
    created_at: event.created_at,
    channel_id: channelId,
    tags: event.tags,
    thread_summary: {
      reply_count: 0,
      descendant_count: 0,
      last_reply_at: null,
      participants: [],
    },
    reactions: null,
  };
}

export function rawNote(event: RelayEvent) {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    content: event.content,
    tags: event.tags,
  };
}

export function rawNotes(events: RelayEvent[]) {
  const last = events.at(-1);
  return {
    notes: events.map(rawNote),
    next_cursor: last ? { before: last.created_at, before_id: last.id } : null,
  };
}

export function rawWorkflow(event: RelayEvent) {
  const parsed = parseYaml(event.content);
  const definition =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  const id = tag(event, "d") ?? "";
  return {
    id,
    revision: event.id,
    name:
      typeof definition.name === "string" && definition.name.trim()
        ? definition.name
        : id,
    owner_pubkey: event.pubkey,
    channel_id: tag(event, "h"),
    definition,
    status: "active",
    created_at: event.created_at,
    updated_at: event.created_at,
  };
}

export async function getChannelMetadata(channelId: string) {
  const [event] = await relayQuery([
    { kinds: [39000], "#d": [channelId], limit: 1 },
  ]);
  if (!event) throw new Error("Channel not found.");
  return event;
}

export function parseCommandResponse(message: string) {
  return JSON.parse(
    message.startsWith("response:") ? message.slice(9) : message,
  );
}

export function mimeType(data: Uint8Array, filename = "") {
  if (data[0] === 0x89 && data[1] === 0x50) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data[0] === 0x47 && data[1] === 0x49) return "image/gif";
  if (
    String.fromCharCode(...data.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...data.slice(8, 12)) === "WEBP"
  )
    return "image/webp";
  if (String.fromCharCode(...data.slice(0, 4)) === "%PDF")
    return "application/pdf";
  if (String.fromCharCode(...data.slice(4, 8)) === "ftyp") return "video/mp4";
  const extension = filename.split(".").pop()?.toLowerCase();
  return (
    {
      mp3: "audio/mpeg",
      mp4: "video/mp4",
      mov: "video/quicktime",
      pdf: "application/pdf",
      txt: "text/plain",
      webm: "video/webm",
      zip: "application/zip",
    }[extension ?? ""] ?? "application/octet-stream"
  );
}

export function ascii(data: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

export function imageNeedsOriginal(
  data: Uint8Array,
  type: string,
  filename = "",
) {
  if (type === "image/gif" || /\.(?:agent|team)\.png$/i.test(filename))
    return true;
  const png = type === "image/png";
  if (!png && type !== "image/webp") return false;
  let offset = png ? 8 : 12;
  while (offset < data.length) {
    const header = png ? 12 : 8;
    if (offset + header > data.length) return true;
    const length = new DataView(
      data.buffer,
      data.byteOffset + offset + (png ? 0 : 4),
      4,
    ).getUint32(0, !png);
    const kind = ascii(data, offset + (png ? 4 : 0), 4);
    if (
      kind === "acTL" ||
      kind === "ANIM" ||
      kind === "ANMF" ||
      (kind === "VP8X" && ((data[offset + 8] ?? 0) & 2) !== 0)
    )
      return true;
    offset += header + length + (png ? 0 : length & 1);
  }
  return offset !== data.length;
}

// Ancillary PNG chunks the relay accepts (buzz-media validation.rs).
const PNG_RENDERING_CHUNKS = new Set(
  "cHRM gAMA sBIT sRGB bKGD hIST tRNS sPLT acTL fcTL fdAT".split(" "),
);

// Canvas encoders tag their output with a colour profile or EXIF (Chromium:
// JPEG APP2 and WebP ICCP; WebKit: PNG eXIf and JPEG APP1), which the relay
// rejects as metadata. Canvas pixels are already sRGB and upright, so those
// segments carry nothing the image needs.
export function stripEncoderMetadata(data: Uint8Array, type: string) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const kept: Uint8Array[] = [];
  if (type === "image/png") {
    kept.push(data.subarray(0, 8));
    for (let offset = 8; offset + 12 <= data.length; ) {
      const end = offset + 12 + view.getUint32(offset);
      const kind = ascii(data, offset + 4, 4);
      if (!(kind.charCodeAt(0) & 0x20) || PNG_RENDERING_CHUNKS.has(kind))
        kept.push(data.subarray(offset, end));
      offset = end;
    }
  } else if (type === "image/jpeg") {
    // Header segments up to the scan; APP14 (Adobe colour transform) stays.
    let offset = 2;
    kept.push(data.subarray(0, 2));
    while (
      offset + 4 <= data.length &&
      data[offset] === 0xff &&
      data[offset + 1] !== 0xda
    ) {
      const marker = data[offset + 1] ?? 0;
      const end = offset + 2 + view.getUint16(offset + 2);
      if (
        !(
          (marker >= 0xe1 && marker <= 0xef && marker !== 0xee) ||
          marker === 0xfe
        )
      )
        kept.push(data.subarray(offset, end));
      offset = end;
    }
    kept.push(data.subarray(offset));
  } else if (type === "image/webp") {
    kept.push(data.slice(0, 12));
    for (let offset = 12; offset + 8 <= data.length; ) {
      const length = view.getUint32(offset + 4, true);
      const end = offset + 8 + length + (length & 1);
      const kind = ascii(data, offset, 4);
      if (kind === "VP8X") {
        const chunk = data.slice(offset, end);
        chunk[8] = (chunk[8] ?? 0) & ~(0x20 | 0x08 | 0x04); // ICC, EXIF, XMP
        kept.push(chunk);
      } else if (kind !== "ICCP" && kind !== "EXIF" && kind !== "XMP ")
        kept.push(data.subarray(offset, end));
      offset = end;
    }
  } else return data;
  const out = new Uint8Array(
    kept.reduce((size, part) => size + part.length, 0),
  );
  let at = 0;
  for (const part of kept) {
    out.set(part, at);
    at += part.length;
  }
  if (type === "image/webp")
    new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}

export function blossomAuth(verb: "get" | "upload", hash?: string) {
  const now = Math.floor(Date.now() / 1000);
  const tags = [
    ["t", verb],
    ["expiration", String(now + (verb === "get" ? 60 : 3600))],
    ["server", new URL(relayHttpUrl()).host],
  ];
  if (hash) tags.splice(1, 0, ["x", hash]);
  const event = signEvent(
    24242,
    verb === "get" ? "Get buzz-media" : "Upload buzz-media",
    tags,
    now,
  );
  return `Nostr ${bytesToBase64(encoder.encode(JSON.stringify(event)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")}`;
}

export async function prepareImageForUpload(
  data: Uint8Array,
  type: string,
  filename = "",
) {
  // ponytail: Canvas flattens animations and snapshot payloads; reject them
  // until web support justifies a dedicated lossless encoder.
  if (imageNeedsOriginal(data, type, filename))
    throw new Error(
      "Buzz Web cannot safely clean this image without changing it.",
    );
  const bitmap = await createImageBitmap(new Blob([buffer(data)], { type }));
  try {
    if (
      bitmap.width === 0 ||
      bitmap.height === 0 ||
      bitmap.width * bitmap.height > 25_000_000
    )
      throw new Error("Image dimensions are too large.");
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Unable to clean image.");
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, type),
    );
    if (!blob) throw new Error("Unable to clean image.");
    if (blob.size > 50 * 1024 * 1024) throw new Error("Image is too large.");
    // WebKit has no WebP encoder and answers PNG.
    const encoded = blob.type || type;
    return {
      data: stripEncoderMetadata(
        new Uint8Array(await blob.arrayBuffer()),
        encoded,
      ),
      type: encoded,
    };
  } finally {
    bitmap.close();
  }
}

export async function pickFiles(accept: string, multiple: boolean) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.multiple = multiple;
  return new Promise<File[]>((resolve) => {
    input.addEventListener(
      "change",
      () => resolve(Array.from(input.files ?? [])),
      { once: true },
    );
    input.click();
  });
}

export const STARTER_CHANNELS = [
  {
    slug: "general",
    name: "general",
    description: "General conversation and community updates.",
  },
  {
    slug: "welcome-everyone",
    name: "welcome-everyone",
    description: "Say hi, ask a question, or share what brought you here.",
  },
] as const;

export function isStarterChannel(
  channel: {
    name: string;
    channel_type: string;
    visibility: string;
    archived_at: string | null;
  },
  spec: (typeof STARTER_CHANNELS)[number],
) {
  return (
    channel.name.trim().toLowerCase() === spec.name &&
    channel.channel_type === "stream" &&
    channel.visibility === "open" &&
    channel.archived_at === null
  );
}

export async function starterChannelId(slug: string) {
  const namespace = Uint8Array.from(
    "3ce33bea8f095f1b9c858a7d2659e6b0".match(/../g) ?? [],
    (byte) => Number.parseInt(byte, 16),
  );
  const name = encoder.encode(`starter-channel:v1:${relayHttpUrl()}:${slug}`);
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-1",
      buffer(Uint8Array.from([...namespace, ...name])),
    ),
  );
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Array.from(digest.slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
