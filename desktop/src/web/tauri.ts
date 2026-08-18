import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  nip44,
  nip98,
} from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";
import { parse as parseYaml } from "yaml";

import { truncatePubkey } from "@/shared/lib/pubkey";

const VAULT_DATABASE = "buzz-desktop-web-vault";
const VAULT_STORE = "identity";
const VAULT_ID = "current";
const encoder = new TextEncoder();

type StoredIdentity = {
  id: typeof VAULT_ID;
  ciphertext: ArrayBuffer;
  iv: Uint8Array;
  pubkey: string;
  wrappingKey: CryptoKey;
};

let secretKey: Uint8Array | null = null;
let lockedPubkey: string | null = null;

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function openVault(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(VAULT_DATABASE, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(VAULT_STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withVault<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openVault();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(VAULT_STORE, mode);
    const request = operation(transaction.objectStore(VAULT_STORE));
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

async function loadIdentity(): Promise<Uint8Array | null> {
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

async function saveIdentity(key: Uint8Array): Promise<void> {
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

function attachMediaAuthBridge(): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "buzz-media-auth-request") return;
    let authorization: string | null = null;
    try {
      if (secretKey) authorization = blossomAuth("get");
    } catch {
      authorization = null;
    }
    event.source?.postMessage({
      type: "buzz-media-auth",
      id: event.data.id,
      authorization,
    });
  });
}

export async function initializeBrowserIdentity(): Promise<void> {
  const manifest = document.createElement("link");
  manifest.rel = "manifest";
  manifest.href = "/manifest.webmanifest";
  document.head.append(manifest);
  attachMediaAuthBridge();
  if ("serviceWorker" in navigator)
    void navigator.serviceWorker.register("/sw.js?v=20260816-media-auth");
  void navigator.storage?.persist?.();
  secretKey = await loadIdentity();
  if (!secretKey && !lockedPubkey) {
    secretKey = generateSecretKey();
    await saveIdentity(secretKey);
  }
}

function requireSecretKey(): Uint8Array {
  if (!secretKey) throw new Error("Browser identity is locked.");
  return secretKey;
}

let activeRelayUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;

function relayWsUrl(): string {
  return activeRelayUrl;
}

function relayHttpUrl(): string {
  const url = new URL(activeRelayUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

let nextSocketId = 1;
const sockets = new Map<number, WebSocket>();
let nextRelayLiveReadAt = Date.now() + 6_000;

async function paceRelayRead(frame: string): Promise<void> {
  let type: unknown, subscriptionId: unknown;
  try {
    [type, subscriptionId] = JSON.parse(frame);
  } catch {
    return;
  }
  if (type !== "REQ" || !String(subscriptionId).startsWith("live-")) return;

  // Give startup reads the first relay window, then use half the budget for
  // background subscriptions and leave the rest for interactive traffic.
  const now = Date.now();
  const scheduledAt = Math.max(now, nextRelayLiveReadAt);
  nextRelayLiveReadAt = scheduledAt + 200;
  if (scheduledAt > now)
    await new Promise((resolve) =>
      window.setTimeout(resolve, scheduledAt - now),
    );
}

type RelayEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

async function relayRequest<T>(path: string, body: unknown): Promise<T> {
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

function relayQuery(filters: Record<string, unknown>[]) {
  return relayRequest<RelayEvent[]>("/query", filters);
}

async function submitEvent(event: RelayEvent) {
  const result = await relayRequest<{
    event_id: string;
    accepted: boolean;
    message: string;
  }>("/events", event);
  if (!result.accepted) throw new Error(result.message);
  return result;
}

function signEvent(
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

async function publish(
  kind: number,
  content: string,
  tags: string[][],
): Promise<RelayEvent> {
  const event = signEvent(kind, content, tags);
  await submitEvent(event);
  return event;
}

function tag(event: RelayEvent, name: string): string | null {
  return event.tags.find((candidate) => candidate[0] === name)?.[1] ?? null;
}

function nipOaOwner(event: RelayEvent): string | null {
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

async function resolveThread(parentEventId: string) {
  const [parent] = await relayQuery([
    {
      ids: [parentEventId],
      kinds: [9, 40002, 45001, 45003, 48100],
      limit: 1,
    },
  ]);
  if (!parent) throw new Error("Parent event not found.");
  const root =
    parent.tags.find(
      (candidate) => candidate[0] === "e" && candidate[3] === "root",
    )?.[1] ??
    parent.tags.find(
      (candidate) => candidate[0] === "e" && candidate[3] === "reply",
    )?.[1] ??
    parentEventId;
  return { parent: parentEventId, root };
}

function rawProfile(event: RelayEvent | undefined, pubkey: string) {
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

async function getRawProfile(pubkey = getPublicKey(requireSecretKey())) {
  const events = await relayQuery([
    { kinds: [0], authors: [pubkey], limit: 1 },
  ]);
  return rawProfile(events[0], pubkey);
}

function rawChannel(event: RelayEvent, isMember = true) {
  const channelId = tag(event, "d") ?? "";
  const channelType =
    tag(event, "t") ??
    (event.tags.some((candidate) => candidate[0] === "hidden")
      ? "dm"
      : "stream");
  const participants = event.tags
    .filter((candidate) => candidate[0] === "p")
    .map((candidate) => candidate[1]);
  return {
    id: channelId,
    name: tag(event, "name") ?? "",
    channel_type: channelType,
    visibility:
      event.tags.some((candidate) => candidate[0] === "private") ||
      tag(event, "visibility") === "private"
        ? "private"
        : "open",
    description: tag(event, "about") ?? "",
    topic: tag(event, "topic"),
    purpose: tag(event, "purpose"),
    member_count: 0,
    member_pubkeys: [] as string[],
    last_message_at: null as string | null,
    archived_at:
      tag(event, "archived") === "true"
        ? new Date(event.created_at * 1000).toISOString()
        : null,
    participants,
    participant_pubkeys: participants,
    is_member: isMember,
    ttl_seconds: tag(event, "ttl") ? Number(tag(event, "ttl")) : null,
    ttl_deadline: tag(event, "ttl_deadline"),
  };
}

function rawChannelDetail(event: RelayEvent) {
  const channel = rawChannel(event);
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

function rawForumPost(event: RelayEvent, channelId: string) {
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

function rawForumReply(
  event: RelayEvent,
  channelId: string,
  rootEventId: string,
) {
  const parent =
    event.tags.find(
      (candidate) => candidate[0] === "e" && candidate[3] === "reply",
    )?.[1] ?? rootEventId;
  const root =
    event.tags.find(
      (candidate) => candidate[0] === "e" && candidate[3] === "root",
    )?.[1] ?? rootEventId;
  return {
    ...rawForumPost(event, channelId),
    parent_event_id: parent,
    root_event_id: root,
    depth: parent === root ? 1 : 2,
    broadcast: false,
  };
}

function rawNote(event: RelayEvent) {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    content: event.content,
    tags: event.tags,
  };
}

function rawNotes(events: RelayEvent[]) {
  const last = events.at(-1);
  return {
    notes: events.map(rawNote),
    next_cursor: last ? { before: last.created_at, before_id: last.id } : null,
  };
}

function rawWorkflow(event: RelayEvent) {
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

async function getChannelMetadata(channelId: string) {
  const [event] = await relayQuery([
    { kinds: [39000], "#d": [channelId], limit: 1 },
  ]);
  if (!event) throw new Error("Channel not found.");
  return event;
}

function parseCommandResponse(message: string) {
  return JSON.parse(
    message.startsWith("response:") ? message.slice(9) : message,
  );
}

function mimeType(data: Uint8Array, filename = "") {
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

function ascii(data: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

function imageNeedsOriginal(data: Uint8Array, type: string, filename = "") {
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

function blossomAuth(verb: "get" | "upload", hash?: string) {
  const now = Math.floor(Date.now() / 1000);
  const tags = [
    ["t", verb],
    ["expiration", String(now + (verb === "get" ? 600 : 3600))],
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
    return {
      data: new Uint8Array(await blob.arrayBuffer()),
      type: blob.type || type,
    };
  } finally {
    bitmap.close();
  }
}

async function uploadBytes(data: Uint8Array, filename?: string) {
  if (data.length === 0) throw new Error("Empty upload.");
  let type = mimeType(data, filename);
  const originalType = type;
  if (type.startsWith("image/")) {
    const prepared = await prepareImageForUpload(data, type, filename);
    data = prepared.data;
    type = prepared.type;
    if (filename && type !== originalType) {
      const extension = type === "image/jpeg" ? "jpg" : type.split("/")[1];
      filename = `${filename.replace(/\.[^./\\]+$/, "")}.${extension}`;
    }
  }
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(data))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const response = await fetch(`${relayHttpUrl()}/upload`, {
    method: "PUT",
    headers: {
      Authorization: blossomAuth("upload", hash),
      "Content-Type": type,
      "X-SHA-256": hash,
    },
    body: buffer(data),
  });
  const error = response.ok ? "" : await response.text();
  if (!response.ok) throw new Error(error || "Upload failed.");
  return {
    ...(await response.json()),
    ...(filename ? { filename: filename.split(/[\\/]/).pop() } : {}),
  };
}

async function pickFiles(accept: string, multiple: boolean) {
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

async function getRawChannels() {
  const pubkey = getPublicKey(requireSecretKey());
  const [memberEvents, metadata, hidden] = await Promise.all([
    relayQuery([{ kinds: [39002], "#p": [pubkey], limit: 1000 }]),
    relayQuery([{ kinds: [39000], limit: 1000 }]),
    relayQuery([{ kinds: [30622], "#p": [pubkey], limit: 1 }]),
  ]);
  const memberIds = new Set(
    memberEvents.map((event) => tag(event, "d")).filter(Boolean),
  );
  const hiddenIds = new Set(
    hidden[0]?.tags
      .filter((candidate) => candidate[0] === "h")
      .map((candidate) => candidate[1]) ?? [],
  );
  const channels = metadata
    .map((event) => rawChannel(event, memberIds.has(tag(event, "d") ?? "")))
    .filter(
      (channel) => channel.channel_type !== "dm" || !hiddenIds.has(channel.id),
    );
  const ids = channels.map((channel) => channel.id);
  if (ids.length === 0) return channels;
  const [members, messages] = await Promise.all([
    relayQuery([{ kinds: [39002], "#d": ids, limit: ids.length }]),
    relayQuery(
      ids.map((channelId) => ({
        kinds: [9, 40002],
        "#h": [channelId],
        limit: 1,
      })),
    ),
  ]);
  for (const channel of channels) {
    const memberEvent = members.find((event) => tag(event, "d") === channel.id);
    channel.member_pubkeys =
      memberEvent?.tags
        .filter((candidate) => candidate[0] === "p")
        .map((candidate) => candidate[1]) ?? [];
    channel.member_count = new Set(channel.member_pubkeys).size;
    const message = messages.find((event) => tag(event, "h") === channel.id);
    channel.last_message_at = message
      ? new Date(message.created_at * 1000).toISOString()
      : null;
  }
  return channels;
}

const STARTER_CHANNELS = [
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

function isStarterChannel(
  channel: ReturnType<typeof rawChannel>,
  spec: (typeof STARTER_CHANNELS)[number],
) {
  return (
    channel.name.trim().toLowerCase() === spec.name &&
    channel.channel_type === "stream" &&
    channel.visibility === "open" &&
    channel.archived_at === null
  );
}

async function starterChannelId(slug: string) {
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

async function ensureRawStarterChannels() {
  let channels = await getRawChannels();
  const created = new Set<string>();
  const ids: string[] = [];

  for (const spec of STARTER_CHANNELS) {
    if (channels.some((channel) => isStarterChannel(channel, spec))) continue;
    const id = await starterChannelId(spec.slug);
    ids.push(id);
    try {
      await publish(9007, "", [
        ["h", id],
        ["name", spec.name],
        ["visibility", "open"],
        ["channel_type", "stream"],
        ["about", spec.description],
      ]);
    } catch (error) {
      if (!String(error).includes("duplicate: channel already exists"))
        throw error;
    }
    created.add(id);
  }

  for (let attempt = 0; ids.length > 0 && attempt < 3; attempt++) {
    const metadata = await relayQuery([
      { kinds: [39000], "#d": ids, limit: ids.length },
    ]);
    for (const event of metadata) {
      const candidate = rawChannel(event, created.has(tag(event, "d") ?? ""));
      if (!channels.some((channel) => channel.id === candidate.id))
        channels.push(candidate);
    }
    if (
      STARTER_CHANNELS.every((spec) =>
        channels.some((channel) => isStarterChannel(channel, spec)),
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  if (
    !STARTER_CHANNELS.every((spec) =>
      channels.some((channel) => isStarterChannel(channel, spec)),
    )
  )
    channels = await getRawChannels();

  for (const spec of STARTER_CHANNELS) {
    const channel = channels.find((candidate) =>
      isStarterChannel(candidate, spec),
    );
    if (!channel)
      throw new Error("Starter channels were not available after setup");
    if (!channel.is_member) {
      await publish(9021, "", [["h", channel.id]]);
      channel.is_member = true;
    }
  }
  return channels;
}

export class Channel<T = unknown> {
  readonly id = crypto.randomUUID();
  onmessage: (message: T) => void;

  constructor(onmessage: (message: T) => void = () => {}) {
    this.onmessage = onmessage;
  }
}

export async function invoke<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  switch (command) {
    case "plugin:websocket|connect": {
      const id = nextSocketId++;
      const socket = new WebSocket(String(args.url));
      const channel = args.onMessage as Channel<unknown>;
      socket.addEventListener("message", (event) =>
        channel.onmessage({ type: "Text", data: event.data }),
      );
      socket.addEventListener("error", () =>
        channel.onmessage({ type: "Error" }),
      );
      socket.addEventListener("close", (event) => {
        sockets.delete(id);
        channel.onmessage({
          type: "Close",
          data: { code: event.code, reason: event.reason },
        });
      });
      sockets.set(id, socket);
      return (await new Promise<number>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(id), { once: true });
        socket.addEventListener(
          "error",
          () => reject(new Error("WebSocket error")),
          {
            once: true,
          },
        );
      })) as T;
    }
    case "plugin:websocket|send": {
      const socket = sockets.get(Number(args.id));
      if (!socket) throw new Error("WebSocket is closed.");
      const message = args.message as { type?: string; data?: string };
      const frame =
        message?.type === "Text" ? String(message.data) : String(message);
      await paceRelayRead(frame);
      socket.send(frame);
      return undefined as T;
    }
    case "plugin:websocket|disconnect":
      sockets.get(Number(args.id))?.close();
      sockets.delete(Number(args.id));
      return undefined as T;
    case "plugin:websocket|disconnect_all":
      for (const socket of sockets.values()) socket.close();
      sockets.clear();
      return undefined as T;
    case "get_default_relay_url":
    case "get_relay_ws_url":
      return relayWsUrl() as T;
    case "get_relay_http_url":
      return relayHttpUrl() as T;
    case "apply_workspace":
      activeRelayUrl = String(args.relayUrl || activeRelayUrl).replace(
        /\/$/,
        "",
      );
      return undefined as T;
    case "validate_repos_dir":
    case "acknowledge_pending_community_deep_link":
      return undefined as T;
    case "take_pending_community_deep_link":
      return null as T;
    case "get_legacy_workspace_storage":
      return {
        workspaces: null,
        activeWorkspaceId: null,
        onboardingCompletions: [],
      } as T;
    case "discover_acp_providers":
      return [] as T;
    case "copy_text_to_clipboard":
      await navigator.clipboard.writeText(String(args.text));
      return undefined as T;
    case "auto_connect_default_relay_enabled":
      return true as T;
    case "is_shared_identity":
      return false as T;
    case "get_identity": {
      const pubkey = secretKey ? getPublicKey(secretKey) : lockedPubkey;
      if (!pubkey) throw new Error("Browser identity is unavailable.");
      const npub = nip19.npubEncode(pubkey);
      return {
        pubkey,
        display_name: truncatePubkey(npub),
        lost: false,
        locked: lockedPubkey !== null,
        reset_failed: false,
      } as T;
    }
    case "get_nsec":
      return nip19.nsecEncode(requireSecretKey()) as T;
    case "import_identity": {
      const decoded = nip19.decode(String(args.nsec).trim());
      if (decoded.type !== "nsec") throw new Error("Invalid nsec.");
      await saveIdentity(decoded.data);
      secretKey = decoded.data;
      lockedPubkey = null;
      return invoke<T>("get_identity");
    }
    case "persist_current_identity":
      await saveIdentity(requireSecretKey());
      return invoke<T>("get_identity");
    case "sign_out":
      localStorage.clear();
      sessionStorage.clear();
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(VAULT_DATABASE);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("Browser vault is busy."));
      });
      location.reload();
      return undefined as T;
    case "sign_event":
      return JSON.stringify(
        signEvent(
          Number(args.kind),
          String(args.content),
          args.tags as string[][],
          Number(args.createdAt) || undefined,
        ),
      ) as T;
    case "create_auth_event":
      return invoke<T>("sign_event", {
        kind: 22242,
        content: "",
        tags: [
          ["relay", String(args.relayUrl)],
          ["challenge", String(args.challenge)],
        ],
      });
    case "nip44_encrypt_to_self": {
      const key = requireSecretKey();
      const conversationKey = nip44.v2.utils.getConversationKey(
        key,
        getPublicKey(key),
      );
      return nip44.v2.encrypt(String(args.plaintext), conversationKey) as T;
    }
    case "nip44_decrypt_from_self": {
      const key = requireSecretKey();
      const conversationKey = nip44.v2.utils.getConversationKey(
        key,
        getPublicKey(key),
      );
      return nip44.v2.decrypt(String(args.ciphertext), conversationKey) as T;
    }
    case "get_profile":
      return (await getRawProfile()) as T;
    case "get_user_profile":
      return (await getRawProfile(
        args.pubkey ? String(args.pubkey) : undefined,
      )) as T;
    case "get_users_batch": {
      const pubkeys = args.pubkeys as string[];
      const events = await relayQuery([
        { kinds: [0], authors: pubkeys, limit: pubkeys.length },
      ]);
      const byPubkey = new Map(events.map((event) => [event.pubkey, event]));
      return {
        profiles: Object.fromEntries(
          pubkeys
            .filter((pubkey) => byPubkey.has(pubkey))
            .map((pubkey) => {
              const profile = rawProfile(byPubkey.get(pubkey), pubkey);
              return [
                pubkey,
                {
                  display_name: profile.display_name,
                  name: profile.display_name,
                  avatar_url: profile.avatar_url,
                  nip05_handle: profile.nip05_handle,
                  owner_pubkey: profile.owner_pubkey,
                  is_agent: profile.owner_pubkey != null,
                },
              ];
            }),
        ),
        missing: pubkeys.filter((pubkey) => !byPubkey.has(pubkey)),
      } as T;
    }
    case "search_users": {
      const query = String(args.query ?? "").trim();
      const limit = Math.min(Number(args.limit) || 8, 500);
      const page = Math.max(Number(args.cursor) || 1, 1);
      const events = await relayQuery([
        {
          kinds: [0],
          limit,
          page,
          ...(query ? { search: query, search_mode: "prefix" } : {}),
        },
      ]);
      return {
        users: events.map((event) => {
          const profile = rawProfile(event, event.pubkey);
          return {
            pubkey: event.pubkey,
            display_name: profile.display_name,
            avatar_url: profile.avatar_url,
            nip05_handle: profile.nip05_handle,
            owner_pubkey: profile.owner_pubkey,
            is_agent: profile.owner_pubkey != null,
          };
        }),
        next_cursor: events.length >= limit ? String(page + 1) : null,
      } as T;
    }
    case "list_archived_identities": {
      const response = await fetch(`${relayHttpUrl()}/info`, {
        headers: { Accept: "application/nostr+json" },
      });
      if (!response.ok) return { archived: [] } as T;
      const relaySelf = ((await response.json()) as { self?: unknown }).self;
      if (typeof relaySelf !== "string" || !/^[0-9a-f]{64}$/i.test(relaySelf))
        return { archived: [] } as T;
      const [snapshot] = await relayQuery([
        {
          authors: [relaySelf.toLowerCase()],
          kinds: [13535],
          limit: 1,
        },
      ]);
      return {
        archived: archivedPubkeysFromSnapshot(snapshot, relaySelf),
      } as T;
    }
    case "update_profile": {
      const current = await getRawProfile();
      const content = JSON.stringify({
        display_name: args.displayName ?? current.display_name,
        picture: args.avatarUrl ?? current.avatar_url,
        about: args.about ?? current.about,
        nip05: args.nip05Handle ?? current.nip05_handle,
      });
      const event = finalizeEvent(
        {
          kind: 0,
          content,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
        },
        requireSecretKey(),
      );
      await submitEvent(event);
      return rawProfile(event, event.pubkey) as T;
    }
    case "get_channels": {
      const channels = await getRawChannels();
      return {
        hash: bytesToBase64(sha256(encoder.encode(JSON.stringify(channels)))),
        channels,
        last_messages: Object.fromEntries(
          channels
            .filter((channel) => channel.last_message_at !== null)
            .map((channel) => [channel.id, channel.last_message_at]),
        ),
      } as T;
    }
    case "ensure_starter_channels":
      return (await ensureRawStarterChannels()) as T;
    case "create_channel": {
      const channelId = crypto.randomUUID();
      const tags = [
        ["h", channelId],
        ["name", String(args.name).trim()],
        ["visibility", String(args.visibility)],
        ["channel_type", String(args.channelType)],
      ];
      if (args.description) tags.push(["about", String(args.description)]);
      if (args.ttlSeconds) tags.push(["ttl", String(args.ttlSeconds)]);
      await publish(9007, "", tags);
      return rawChannel(await getChannelMetadata(channelId), true) as T;
    }
    case "open_dm": {
      const event = signEvent(
        41010,
        "",
        (args.pubkeys as string[]).map((pubkey) => ["p", pubkey.toLowerCase()]),
      );
      const result = await submitEvent(event);
      const { channel_id: channelId } = parseCommandResponse(
        result.message,
      ) as {
        channel_id: string;
      };
      return rawChannel(await getChannelMetadata(channelId), true) as T;
    }
    case "hide_dm":
      await publish(41012, "", [["h", String(args.channelId)]]);
      return undefined as T;
    case "get_channel_details":
      return rawChannelDetail(
        await getChannelMetadata(String(args.channelId)),
      ) as T;
    case "update_channel": {
      const input = args.input as Record<string, unknown>;
      const tags = [["h", String(input.channelId)]];
      if (input.name !== undefined)
        tags.push(["name", String(input.name).trim()]);
      if (input.description !== undefined)
        tags.push(["about", String(input.description)]);
      if (input.visibility !== undefined)
        tags.push(["visibility", String(input.visibility)]);
      if ("ttlSeconds" in input)
        tags.push([
          "ttl",
          input.ttlSeconds == null ? "" : String(input.ttlSeconds),
        ]);
      await publish(9002, "", tags);
      return rawChannelDetail(
        await getChannelMetadata(String(input.channelId)),
      ) as T;
    }
    case "set_channel_topic":
      await publish(9002, "", [
        ["h", String(args.channelId)],
        ["topic", String(args.topic)],
      ]);
      return undefined as T;
    case "set_channel_purpose":
      await publish(9002, "", [
        ["h", String(args.channelId)],
        ["purpose", String(args.purpose)],
      ]);
      return undefined as T;
    case "archive_channel":
    case "unarchive_channel":
      await publish(9002, "", [
        ["h", String(args.channelId)],
        ["archived", command === "archive_channel" ? "true" : "false"],
      ]);
      return undefined as T;
    case "delete_channel":
      await publish(9008, "", [["h", String(args.channelId)]]);
      return undefined as T;
    case "get_channel_members": {
      const [members] = await relayQuery([
        { kinds: [39002], "#d": [String(args.channelId)], limit: 1 },
      ]);
      if (!members) return { members: [], next_cursor: null } as T;
      const rows = members.tags
        .filter((candidate) => candidate[0] === "p")
        .map((candidate) => ({
          pubkey: candidate[1],
          role: candidate[3] || "member",
          is_agent: candidate[3] === "bot",
          joined_at: null,
          display_name: null as string | null,
        }));
      const profiles = await relayQuery([
        {
          kinds: [0],
          authors: rows.map((row) => row.pubkey),
          limit: rows.length,
        },
      ]);
      for (const row of rows) {
        row.display_name = rawProfile(
          profiles.find((event) => event.pubkey === row.pubkey),
          row.pubkey,
        ).display_name;
      }
      return { members: rows, next_cursor: null } as T;
    }
    case "add_channel_members": {
      const added: string[] = [];
      const errors: Array<{ pubkey: string; error: string }> = [];
      for (const pubkey of args.pubkeys as string[]) {
        try {
          const tags = [
            ["h", String(args.channelId)],
            ["p", pubkey.toLowerCase()],
          ];
          if (args.role && args.role !== "member")
            tags.push(["role", String(args.role)]);
          await publish(9000, "", tags);
          added.push(pubkey);
        } catch (error) {
          errors.push({ pubkey, error: String(error) });
        }
      }
      return { added, errors } as T;
    }
    case "remove_channel_member":
      await publish(9001, "", [
        ["h", String(args.channelId)],
        ["p", String(args.pubkey).toLowerCase()],
      ]);
      return undefined as T;
    case "change_channel_member_role":
      await publish(9000, "", [
        ["h", String(args.channelId)],
        ["p", String(args.pubkey).toLowerCase()],
        ["role", String(args.role)],
      ]);
      return undefined as T;
    case "join_channel":
    case "leave_channel":
      await publish(command === "join_channel" ? 9021 : 9022, "", [
        ["h", String(args.channelId)],
      ]);
      return undefined as T;
    case "get_channel_window": {
      const cursor = args.cursor as {
        created_at: number;
        event_id: string;
      } | null;
      return (await relayQuery([
        {
          "#h": [String(args.channelId)],
          kinds: [
            9, 40002, 40008, 40099, 43001, 43002, 43003, 43004, 43005, 43006,
            48100,
          ],
          limit: Math.min(Number(args.limitRows) || 50, 200),
          top_level: true,
          include_summaries: true,
          include_aux: true,
          ...(cursor
            ? { until: cursor.created_at, before_id: cursor.event_id }
            : {}),
        },
      ])) as T;
    }
    case "get_thread_replies": {
      const cursor = args.cursor as {
        created_at: number;
        event_id: string;
      } | null;
      const limit = Math.min(Number(args.limit) || 200, 500);
      const events = await relayQuery([
        {
          "#e": [String(args.rootEventId)],
          kinds: [
            9, 40002, 40008, 40099, 43001, 43002, 43003, 43004, 43005, 43006,
            48100,
          ],
          depth_limit: Number(args.depthLimit) || 64,
          limit,
          ...(args.channelId ? { "#h": [String(args.channelId)] } : {}),
          ...(cursor
            ? {
                thread_cursor: cursor.created_at,
                thread_cursor_id: cursor.event_id,
              }
            : {}),
        },
      ]);
      const last = events.at(-1);
      return {
        events,
        next_cursor:
          events.length >= limit && last
            ? { created_at: last.created_at, event_id: last.id }
            : null,
      } as T;
    }
    case "get_channel_messages_before": {
      const limit = Math.min(Number(args.limit) || 200, 500);
      const events = await relayQuery([
        {
          "#h": [String(args.channelId)],
          kinds: [
            9, 40002, 40008, 40099, 43001, 43002, 43003, 43004, 43005, 43006,
            48100,
          ],
          until: Number(args.before),
          limit,
          ...(args.beforeId ? { before_id: String(args.beforeId) } : {}),
        },
      ]);
      const last = events.at(-1);
      return {
        events,
        next_cursor:
          events.length >= limit && last
            ? { created_at: last.created_at, event_id: last.id }
            : null,
      } as T;
    }
    case "get_forum_posts": {
      const limit = Math.min(Number(args.limit) || 20, 100);
      const events = await relayQuery([
        {
          kinds: [45001],
          "#h": [String(args.channelId)],
          limit,
          ...(args.before ? { until: Number(args.before) } : {}),
        },
      ]);
      return {
        messages: events.map((event) =>
          rawForumPost(event, String(args.channelId)),
        ),
        next_cursor: events.at(-1)?.created_at ?? null,
      } as T;
    }
    case "get_forum_thread": {
      const events = await relayQuery([
        {
          ids: [String(args.eventId)],
          kinds: [9, 40002, 45001, 45003],
        },
        {
          kinds: [9, 45003],
          "#e": [String(args.eventId)],
          "#h": [String(args.channelId)],
        },
      ]);
      const root = events.find((event) => event.id === args.eventId);
      if (!root) throw new Error("Forum thread root event not found.");
      const replies = events
        .filter((event) => event.id !== root.id)
        .map((event) => rawForumReply(event, String(args.channelId), root.id));
      return {
        root: rawForumPost(root, String(args.channelId)),
        replies,
        total_replies: replies.length,
        next_cursor: null,
      } as T;
    }
    case "get_canvas": {
      const [event] = await relayQuery([
        {
          kinds: [40100],
          "#h": [String(args.channelId)],
          limit: 1,
        },
      ]);
      return {
        content: event?.content ?? "",
        event_id: event?.id ?? null,
        updated_at: event?.created_at ?? null,
        author: event?.pubkey ?? null,
      } as T;
    }
    case "set_canvas": {
      const event = await publish(40100, String(args.content), [
        ["h", String(args.channelId)],
      ]);
      return { ok: true, event_id: event.id } as T;
    }
    case "get_event": {
      const [event] = await relayQuery([
        {
          ids: [String(args.eventId)],
          kinds: [
            0, 1, 3, 5, 7, 9, 30078, 40002, 40003, 40008, 40099, 40100, 45001,
            45003, 48100,
          ],
          limit: 1,
        },
      ]);
      if (!event) throw new Error("Event not found.");
      return JSON.stringify(event) as T;
    }
    case "send_channel_message": {
      const parentId = args.parentEventId ? String(args.parentEventId) : null;
      const thread = parentId ? await resolveThread(parentId) : null;
      const tags: string[][] = [["h", String(args.channelId)]];
      if (thread && thread.root === thread.parent) {
        tags.push(["e", thread.root, "", "reply"]);
      } else if (thread) {
        tags.push(["e", thread.root, "", "root"]);
        tags.push(["e", thread.parent, "", "reply"]);
      }
      for (const pubkey of (args.mentionPubkeys as string[] | null) ?? []) {
        tags.push(["p", pubkey.toLowerCase()]);
      }
      tags.push(
        ...((args.mediaTags as string[][] | null) ?? []),
        ...((args.emojiTags as string[][] | null) ?? []),
        ...((args.mentionTags as string[][] | null) ?? []),
      );
      const event = await publish(
        Number(args.kind) || 9,
        String(args.content).trim(),
        tags,
      );
      return {
        event_id: event.id,
        parent_event_id: parentId,
        root_event_id: thread?.root ?? null,
        depth: !thread ? 0 : thread.root === thread.parent ? 1 : 2,
        created_at: event.created_at,
      } as T;
    }
    case "upload_media_bytes":
      return (await uploadBytes(
        Uint8Array.from(args.data as number[]),
        args.filename ? String(args.filename) : undefined,
      )) as T;
    case "pick_and_upload_media": {
      const files = await pickFiles("", true);
      return (await Promise.all(
        files.map(async (file) =>
          uploadBytes(new Uint8Array(await file.arrayBuffer()), file.name),
        ),
      )) as T;
    }
    case "pick_and_upload_image": {
      const [file] = await pickFiles("image/*", false);
      return (
        file
          ? await uploadBytes(
              new Uint8Array(await file.arrayBuffer()),
              file.name,
            )
          : null
      ) as T;
    }
    case "fetch_media_bytes": {
      const url = new URL(String(args.url));
      if (url.origin !== relayHttpUrl())
        throw new Error("Media URL is outside the active community.");
      const response = await fetch(url, {
        headers: { Authorization: blossomAuth("get") },
      });
      if (!response.ok)
        throw new Error((await response.text()) || "Media download failed.");
      return (await response.arrayBuffer()) as T;
    }
    case "edit_message":
      await publish(40003, String(args.content).trim(), [
        ["h", String(args.channelId)],
        ["e", String(args.eventId)],
        ...((args.mentionPubkeys as string[] | null) ?? []).map((pubkey) => [
          "p",
          pubkey.toLowerCase(),
        ]),
        ...((args.mediaTags as string[][]) ?? []),
        ...((args.emojiTags as string[][]) ?? []),
      ]);
      return undefined as T;
    case "delete_message":
      await publish(5, "", [
        ["h", String(args.channelId)],
        ["e", String(args.eventId)],
      ]);
      return undefined as T;
    case "add_reaction": {
      const emoji = String(args.emoji).trim();
      const tags = [["e", String(args.eventId)]];
      if (args.emojiUrl) {
        tags.push([
          "emoji",
          emoji.replace(/^:+|:+$/g, "").toLowerCase(),
          String(args.emojiUrl),
        ]);
      }
      await publish(7, emoji, tags);
      return undefined as T;
    }
    case "remove_reaction": {
      const reactions = await relayQuery([
        {
          kinds: [7],
          "#e": [String(args.eventId)],
          authors: [getPublicKey(requireSecretKey())],
          limit: 100,
        },
      ]);
      const reaction = reactions.find(
        (event) => event.content.trim() === String(args.emoji).trim(),
      );
      if (reaction) await publish(5, "", [["e", reaction.id]]);
      return undefined as T;
    }
    case "search_messages": {
      const events = await relayQuery([
        {
          kinds: [9, 40002, 45001, 45003],
          search: String(args.q).trim(),
          search_mode: "prefix",
          limit: Math.min(Number(args.limit) || 20, 100),
          ...(args.channelId ? { "#h": [String(args.channelId)] } : {}),
        },
      ]);
      return {
        hits: events.map((event) => ({
          event_id: event.id,
          content: event.content,
          kind: event.kind,
          pubkey: event.pubkey,
          channel_id: tag(event, "h"),
          channel_name: null,
          created_at: event.created_at,
          score: 1,
        })),
        found: events.length,
      } as T;
    }
    case "get_global_notes":
    case "get_user_notes":
    case "get_notes_timeline": {
      const authors =
        command === "get_user_notes"
          ? [String(args.pubkey)]
          : command === "get_notes_timeline"
            ? (args.pubkeys as string[])
            : undefined;
      const limit =
        command === "get_notes_timeline"
          ? Math.min(
              (Number(args.limitPerUser) || 10) * (authors?.length ?? 0),
              200,
            )
          : Math.min(Number(args.limit) || 50, 200);
      const events = await relayQuery([
        {
          kinds: [1],
          limit,
          ...(authors ? { authors } : {}),
          ...(args.before ? { until: Number(args.before) } : {}),
          ...(args.beforeId ? { before_id: String(args.beforeId) } : {}),
        },
      ]);
      return rawNotes(events) as T;
    }
    case "get_note": {
      const [event] = await relayQuery([
        { kinds: [1], ids: [String(args.noteId)], limit: 1 },
      ]);
      return (event ? rawNote(event) : null) as T;
    }
    case "publish_note": {
      const tags: string[][] = [];
      if (args.replyTo) tags.push(["e", String(args.replyTo), "", "reply"]);
      for (const pubkey of (args.mentionPubkeys as string[] | null) ?? [])
        tags.push(["p", pubkey.toLowerCase()]);
      tags.push(...((args.mediaTags as string[][] | null) ?? []));
      const event = signEvent(1, String(args.content), tags);
      return (await submitEvent(event)) as T;
    }
    case "get_contact_list": {
      const pubkey = String(args.pubkey);
      const [event] = await relayQuery([
        { kinds: [3], authors: [pubkey], limit: 1 },
      ]);
      return {
        id: event?.id ?? "",
        pubkey,
        created_at: event?.created_at ?? 0,
        tags: event?.tags ?? [],
        content: event?.content ?? "",
      } as T;
    }
    case "set_contact_list": {
      const contacts = args.contacts as Array<{
        pubkey: string;
        relay_url?: string | null;
        petname?: string | null;
      }>;
      const event = signEvent(
        3,
        "",
        contacts.map((contact) => [
          "p",
          contact.pubkey.toLowerCase(),
          contact.relay_url ?? "",
          contact.petname ?? "",
        ]),
      );
      return (await submitEvent(event)) as T;
    }
    case "get_note_reactions": {
      const noteIds = args.noteIds as string[];
      if (noteIds.length === 0) return [] as T;
      const reactions = await relayQuery([
        { kinds: [7], "#e": noteIds, limit: 500 },
      ]);
      const summaries = new Map<
        string,
        { note_id: string; emoji: string; pubkeys: Set<string> }
      >();
      for (const reaction of reactions) {
        const noteId = [...reaction.tags]
          .reverse()
          .find((candidate) => candidate[0] === "e")?.[1];
        if (!noteId || !noteIds.includes(noteId)) continue;
        const emoji = reaction.content || "+";
        const key = `${noteId}\0${emoji}`;
        const summary = summaries.get(key) ?? {
          note_id: noteId,
          emoji,
          pubkeys: new Set(),
        };
        summary.pubkeys.add(reaction.pubkey);
        summaries.set(key, summary);
      }
      return Array.from(summaries.values()).map((summary) => ({
        note_id: summary.note_id,
        emoji: summary.emoji,
        count: summary.pubkeys.size,
        pubkeys: Array.from(summary.pubkeys).sort(),
      })) as T;
    }
    case "get_liked_notes": {
      const reactions = await relayQuery([
        {
          kinds: [7],
          authors: [String(args.authorPubkey)],
          limit: Math.min((Number(args.limit) || 50) * 4, 1000),
        },
      ]);
      const ids = Array.from(
        new Set(
          reactions
            .map(
              (event) =>
                [...event.tags]
                  .reverse()
                  .find((candidate) => candidate[0] === "e")?.[1],
            )
            .filter((id): id is string => Boolean(id)),
        ),
      ).slice(0, Math.min(Number(args.limit) || 50, 200));
      return rawNotes(
        ids.length
          ? await relayQuery([{ kinds: [1], ids, limit: ids.length }])
          : [],
      ) as T;
    }
    case "get_feed": {
      const pubkey = getPublicKey(requireSecretKey());
      const types = String(args.types ?? "");
      const wants = (name: string) => !types || types.split(",").includes(name);
      const filters: Record<string, unknown>[] = [];
      if (wants("mentions"))
        filters.push({
          kinds: [9, 40002, 1, 45001, 45003],
          "#p": [pubkey],
          limit: Math.min(Number(args.limit) || 50, 100),
          ...(args.since ? { since: Number(args.since) } : {}),
        });
      if (wants("needs_action"))
        filters.push({
          kinds: [46010, 46011, 46012],
          "#p": [pubkey],
          limit: 20,
          ...(args.since ? { since: Number(args.since) } : {}),
        });
      const events = filters.length ? await relayQuery(filters) : [];
      const item = (event: RelayEvent, category: string) => ({
        id: event.id,
        kind: event.kind,
        pubkey: event.pubkey,
        content: event.content,
        created_at: event.created_at,
        channel_id: tag(event, "h"),
        channel_name: "",
        channel_type: null,
        tags: event.tags,
        category,
      });
      const mentions = events
        .filter((event) => event.kind < 46010 || event.kind > 46012)
        .map((event) => item(event, "mentions"));
      const needsAction = events
        .filter((event) => event.kind >= 46010 && event.kind <= 46012)
        .map((event) => item(event, "needs_action"));
      return {
        feed: {
          mentions,
          needs_action: needsAction,
          activity: [],
          agent_activity: [],
        },
        meta: {
          since: Number(args.since) || 0,
          total: mentions.length + needsAction.length,
          generated_at: Math.floor(Date.now() / 1000),
        },
      } as T;
    }
    case "list_relay_agents":
    case "revalidate_relay_agents": {
      const events = await relayQuery([{ kinds: [10100], limit: 1000 }]);
      const wanted = new Set(
        command === "revalidate_relay_agents"
          ? ((args.pubkeys as string[] | undefined) ?? []).map((pubkey) =>
              pubkey.toLowerCase(),
            )
          : [],
      );
      return events
        .filter(
          (event) =>
            wanted.size === 0 || wanted.has(event.pubkey.toLowerCase()),
        )
        .map((event) => {
          const content = JSON.parse(event.content || "{}");
          return {
            ...content,
            pubkey: event.pubkey,
            owner_pubkey: content.owner_pubkey ?? content.ownerPubkey ?? null,
            name:
              content.name ??
              content.display_name ??
              nip19.npubEncode(event.pubkey),
            agent_type: content.agent_type ?? "agent",
            channels: content.channels ?? [],
            channel_ids: content.channel_ids ?? [],
            capabilities: content.capabilities ?? [],
            status: content.status ?? "offline",
          };
        }) as T;
    }
    case "grant_approval":
    case "deny_approval": {
      const event = await publish(
        command === "grant_approval" ? 46030 : 46031,
        String(args.note ?? ""),
        [["t", String(args.token)]],
      );
      return { event_id: event.id } as T;
    }
    case "get_channel_workflows":
    case "get_channels_workflows": {
      const channelIds =
        command === "get_channel_workflows"
          ? [String(args.channelId)]
          : (args.channelIds as string[]);
      if (channelIds.length === 0) return [] as T;
      const channels = new Set(channelIds);
      const workflows = await relayQuery([{ kinds: [30620] }]);
      const authors = [...new Set(workflows.map((event) => event.pubkey))];
      const deletions = authors.length
        ? await relayQuery([{ kinds: [5], authors }])
        : [];
      const deleted = new Set(
        deletions.flatMap((event) =>
          event.tags
            .filter((candidate) => candidate[0] === "a")
            .map((candidate) => candidate[1]),
        ),
      );
      return workflows
        .filter(
          (event) =>
            channels.has(tag(event, "h") ?? "") &&
            !deleted.has(`30620:${event.pubkey}:${tag(event, "d") ?? ""}`),
        )
        .map(rawWorkflow) as T;
    }
    case "get_workflow": {
      const [event] = await relayQuery([
        { kinds: [30620], "#d": [String(args.workflowId)], limit: 1 },
      ]);
      if (!event) throw new Error("workflow not found");
      return rawWorkflow(event) as T;
    }
    case "create_workflow": {
      const id = crypto.randomUUID();
      const event = await publish(30620, String(args.yamlDefinition), [
        ["d", id],
        ["h", String(args.channelId)],
      ]);
      const workflow = rawWorkflow(event);
      return {
        ...workflow,
        webhook_secret: null,
      } as T;
    }
    case "update_workflow": {
      const id = String(args.workflowId);
      const [previous] = await relayQuery([
        { kinds: [30620], "#d": [id], limit: 1 },
      ]);
      const channelId = previous && tag(previous, "h");
      if (!channelId) throw new Error("workflow not found");
      if (
        args.expectedRevision &&
        previous.id !== String(args.expectedRevision)
      )
        throw new Error("workflow revision conflict");
      const event = await publish(30620, String(args.yamlDefinition), [
        ["d", id],
        ["h", channelId],
      ]);
      return {
        ...rawWorkflow(event),
        created_at: previous.created_at,
        webhook_secret: null,
      } as T;
    }
    case "delete_workflow":
      await publish(5, "", [
        [
          "a",
          `30620:${getPublicKey(requireSecretKey())}:${String(args.workflowId)}`,
        ],
      ]);
      return undefined as T;
    case "get_workflow_runs":
    case "get_run_approvals":
      return [] as T;
    case "trigger_workflow": {
      const event = await publish(46020, "", [["d", String(args.workflowId)]]);
      return { event_id: event.id } as T;
    }
    case "relay_requires_membership": {
      const response = await fetch(`${relayHttpUrl()}/info`, {
        headers: { Accept: "application/nostr+json" },
      });
      if (!response.ok) throw new Error(`Relay returned ${response.status}.`);
      const info = (await response.json()) as { supported_nips?: number[] };
      return info.supported_nips?.includes(43) as T;
    }
    case "get_presence":
      return Object.fromEntries(
        ((args.pubkeys as string[]) ?? []).map((pubkey) => [pubkey, "offline"]),
      ) as T;
    case "get_os_idle_seconds":
      return null as T;
    case "list_managed_agents":
    case "list_managed_agent_runtimes":
    case "list_personas":
    case "list_save_subscriptions":
    case "list_teams":
    case "reconcile_managed_agent_runtimes":
      return [] as T;
    case "observer_archive_default_enabled":
    case "agent_metric_archive_default_enabled":
      return false as T;
    case "get_baked_build_env":
    case "get_baked_build_env_keys":
      return [] as T;
    case "get_global_agent_config":
      return {
        env_vars: {},
        provider: null,
        model: null,
        preferred_runtime: null,
      } as T;
    case "get_runtime_file_config":
      return null as T;
    case "reconcile_inbound_persona_event":
      return undefined as T;
    case "set_prevent_sleep_active":
    case "set_window_vibrancy":
    case "relay_reconnect_hook":
      return undefined as T;
    case "relay_reconnect_hook_configured":
      return false as T;
    case "get_media_proxy_port":
      return 0 as T;
    case "take_pending_entity_deep_link":
    case "take_pending_navigation_deep_link":
      return null as T;
    case "merge_save_subscription_kinds":
    case "remove_save_subscription_kind":
      return undefined as T;
    default:
      throw new Error(`Unsupported browser command: ${command}`);
  }
}

export function isTauri(): boolean {
  return false;
}

export async function listen(): Promise<() => void> {
  return () => {};
}

export async function emit(): Promise<void> {}

export function getCurrentWindow() {
  return {
    isFullscreen: async () => false,
    onFocusChanged: async () => () => {},
    onResized: async () => () => {},
    requestUserAttention: async () => {},
    setBadgeCount: async () => {},
    setBadgeLabel: async () => {},
    setFocus: async () => {},
    show: async () => {},
    startDragging: async () => {},
    theme: async () => null,
    unminimize: async () => {},
  };
}

export function getCurrentWebview() {
  return { setZoom: async () => {} };
}

export async function openUrl(url: string | URL): Promise<void> {
  window.open(String(url), "_blank", "noopener,noreferrer");
}

export async function homeDir(): Promise<string> {
  return "";
}

export async function getVersion(): Promise<string> {
  return "web";
}

export async function check(): Promise<null> {
  return null;
}

export async function relaunch(): Promise<void> {
  location.reload();
}

export async function isPermissionGranted(): Promise<boolean> {
  return Notification.permission === "granted";
}

export async function requestPermission(): Promise<NotificationPermission> {
  return Notification.requestPermission();
}

export async function onAction(): Promise<() => void> {
  return () => {};
}

export const UserAttentionType = { Critical: 1, Informational: 2 };

export type UnlistenFn = () => void;
export type Update = never;
