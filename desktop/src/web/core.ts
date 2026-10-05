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

export function openVault(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(VAULT_DATABASE, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(VAULT_STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function withVault<T>(
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

export type CommandTable = Record<
  string,
  (args: Record<string, unknown>) => unknown | Promise<unknown>
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

export async function resolveThread(parentEventId: string) {
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

export function rawChannel(event: RelayEvent, isMember = true) {
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

export function rawChannelDetail(event: RelayEvent) {
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

export function rawForumReply(
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

export function blossomAuth(verb: "get" | "upload", hash?: string) {
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

export async function uploadBytes(data: Uint8Array, filename?: string) {
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

export async function getRawChannels() {
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

export async function ensureRawStarterChannels() {
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
