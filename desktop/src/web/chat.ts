import { finalizeEvent, getPublicKey } from "nostr-tools";

import {
  authoredStore,
  mentionedStore,
  mutedStore,
  participationStore,
} from "@/features/channels/unreadMembership";

import {
  type CommandTable,
  type RelayEvent,
  STARTER_CHANNELS,
  encoder,
  getSecretKey,
  isStarterChannel,
  nipOaOwner,
  publish,
  rawForumPost,
  rawProfile,
  relayHttpUrl,
  relayQuery,
  relayWsUrl,
  requireSecretKey,
  starterChannelId,
  submitEvent,
  tag,
} from "./core";

// Browser ports of the native chat commands in desktop/src-tauri. Each command
// mirrors its Rust handler's relay filters, validation, and response shape.

type Tags = string[][];
type Args = Record<string, unknown>;

const HEX64 = /^[0-9a-f]{64}$/i;
const UUID =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const CONTROL = /\p{Cc}/u;
const MAX_CONTENT_BYTES = 64 * 1024;
const LINK_PREVIEW_NONE = ["link-preview", "none"];

const REPAIR_KINDS = [
  5, 7, 9, 9005, 40001, 40002, 40003, 40008, 40099, 45001, 45003, 48100, 48101,
  48102, 48103,
];
const GET_EVENT_KINDS = [
  0, 1, 3, 5, 7, 9, 30078, 40002, 40003, 40008, 40099, 40100, 45001, 45003,
  48100,
];
const FEED_MENTION_KINDS = [
  9, 40002, 1, 45001, 45003, 1618, 1619, 1621, 1630, 1631, 1632, 1633,
];

const optionalString = (value: unknown) =>
  value == null ? null : String(value);
const bytes = (value: string) => encoder.encode(value).length;

/** `relay::relay_http_base_url`: string rewrite that keeps any path. */
export function relayHttpBase(relayUrl: string): string {
  const trimmed = relayUrl.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("wss://")) return `https://${trimmed.slice(6)}`;
  if (trimmed.startsWith("ws://")) return `http://${trimmed.slice(5)}`;
  return trimmed;
}

function hasTag(tags: Tags, name: string, value: string, ignoreCase = false) {
  return tags.some(
    (candidate) =>
      candidate[0] === name &&
      candidate[1] !== undefined &&
      (ignoreCase
        ? candidate[1].toLowerCase() === value.toLowerCase()
        : candidate[1] === value),
  );
}

// ── Reconnect repair ────────────────────────────────────────────────────────

export function channelReconnectRepairFilter(args: Args) {
  const channelId = String(args.channelId);
  const limit = Number(args.limit);
  const until = args.until == null ? null : Number(args.until);
  const beforeId = optionalString(args.beforeId);
  if (!UUID.test(channelId)) throw new Error("invalid channel id");
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error("limit must be between 1 and 500");
  if (beforeId !== null && until === null)
    throw new Error("before_id requires until");
  if (beforeId !== null && !HEX64.test(beforeId))
    throw new Error("before_id must be a 64-character hex event id");
  return {
    "#h": [channelId],
    kinds: REPAIR_KINDS,
    since: Number(args.since),
    limit,
    ...(until !== null ? { until } : {}),
    ...(beforeId !== null ? { before_id: beforeId } : {}),
  };
}

// ── Unread catch-up ─────────────────────────────────────────────────────────

type CatchUpChannel = {
  id: string;
  type: string;
  name: string;
  readAt: number | null;
};
type CatchUpRequest = {
  channels: CatchUpChannel[];
  selfPubkey: string;
  mutedChannelIds: string[];
};
type Membership = Partial<Record<string, Set<string>>>;

export function threadReference(tags: Tags) {
  const eventTags = tags.filter(
    (candidate) => candidate[0] === "e" && candidate[1] !== undefined,
  );
  const root = eventTags.find((candidate) => candidate[3] === "root");
  const reply = eventTags
    .filter((candidate) => candidate[3] === "reply")
    .at(-1);
  if (!reply) return { parentId: null, rootId: null };
  return { parentId: reply[1], rootId: root?.[1] ?? reply[1] };
}

/** Port of `unread_catch_up::classify_batch`, two passes over the batch. */
export function classifyCatchUp(
  request: CatchUpRequest,
  fetched: { channel: CatchUpChannel; events: RelayEvent[] }[],
  membership: Membership,
) {
  const self = request.selfPubkey.toLowerCase();
  const muted = new Set(request.mutedChannelIds);
  const participated = new Set(membership.participated);
  const authored = new Set(membership.authored);
  const mentioned = new Set(membership.mentioned);

  const discoveries = fetched.map(({ events }) => {
    const discovered = {
      participated: [] as string[],
      authored: [] as string[],
      mentioned: [] as string[],
    };
    for (const event of events) {
      const { rootId } = threadReference(event.tags);
      if (event.pubkey.toLowerCase() === self) {
        if (rootId !== null) {
          if (!participated.has(rootId)) {
            participated.add(rootId);
            discovered.participated.push(rootId);
          }
        } else if (!authored.has(event.id)) {
          authored.add(event.id);
          discovered.authored.push(event.id);
        }
      } else if (
        hasTag(event.tags, "p", self, true) &&
        rootId !== null &&
        !mentioned.has(rootId)
      ) {
        mentioned.add(rootId);
        discovered.mentioned.push(rootId);
      }
    }
    return discovered;
  });

  const shouldNotify = (event: RelayEvent) => {
    if (
      hasTag(event.tags, "broadcast", "1") ||
      hasTag(event.tags, "p", self, true)
    )
      return true;
    const channelId = event.tags.find((candidate) => candidate[0] === "h")?.[1];
    if (channelId !== undefined && muted.has(channelId)) return false;
    const { parentId, rootId } = threadReference(event.tags);
    if (parentId === null) return true;
    if (rootId === null || membership.muted_root?.has(rootId)) return false;
    return (
      participated.has(rootId) ||
      Boolean(membership.followed?.has(rootId)) ||
      authored.has(rootId)
    );
  };

  const outputs = fetched.map(({ channel, events }, index) => {
    const dm = channel.type === "dm";
    const observedEvents = [];
    const activityRows = [];
    let maxTrigger = 0;
    for (const event of events) {
      if (
        event.pubkey.toLowerCase() === self ||
        (channel.readAt !== null && event.created_at <= channel.readAt) ||
        !shouldNotify(event)
      )
        continue;
      const reference = threadReference(event.tags);
      const broadcast = hasTag(event.tags, "broadcast", "1");
      const threaded = reference.parentId !== null && !broadcast;
      const highPriority =
        dm || threaded || broadcast || hasTag(event.tags, "p", self, true);
      maxTrigger = Math.max(maxTrigger, event.created_at);
      observedEvents.push({
        id: event.id,
        createdAt: event.created_at,
        rootId: broadcast ? null : reference.rootId,
        highPriority,
        countsTowardBadge: dm || threaded || highPriority,
        countsTowardAppBadge: dm || (!threaded && highPriority),
      });
      if (threaded)
        activityRows.push({
          id: event.id,
          kind: event.kind,
          pubkey: event.pubkey,
          content: event.content,
          createdAt: event.created_at,
          channelId: channel.id,
          channelName: channel.name,
          tags: event.tags,
        });
    }
    return {
      status: "success" as const,
      channelId: channel.id,
      observedEvents,
      maxTrigger,
      activityRows,
      discovered: discoveries[index],
    };
  });

  // Keep only the newest 100 distinct thread replies across the whole batch.
  const seen = new Set<string>();
  const allowed = new Set(
    outputs
      .flatMap((output) => output.activityRows)
      .sort((left, right) => left.createdAt - right.createdAt)
      .filter((row) => !seen.has(row.id) && seen.add(row.id))
      .slice(-100)
      .map((row) => row.id),
  );
  for (const output of outputs)
    output.activityRows = output.activityRows.filter((row) =>
      allowed.has(row.id),
    );
  return outputs;
}

/**
 * Native catch-up reads membership from the observed-unread SQLite store. The
 * browser has no native store (`observed_unread_open_scope` is unavailable), so
 * the renderer's localStorage sets are the authoritative equivalent.
 */
function loadBrowserMembership(pubkey: string): Membership {
  let followed: unknown = [];
  try {
    followed = JSON.parse(
      localStorage.getItem(`buzz-thread-follows.v1:${pubkey}`) ?? "[]",
    );
  } catch {}
  return {
    participated: participationStore.read(pubkey),
    authored: authoredStore.read(pubkey),
    mentioned: mentionedStore.read(pubkey),
    muted_root: mutedStore.read(pubkey),
    followed: new Set(
      (Array.isArray(followed) ? followed : [])
        .map((entry) => entry?.rootId)
        .filter((rootId): rootId is string => typeof rootId === "string"),
    ),
  };
}

async function unreadCatchUp(request: CatchUpRequest) {
  const owner = getPublicKey(requireSecretKey());
  if (owner !== request.selfPubkey.toLowerCase())
    throw new Error("unread catch-up identity does not match active scope");
  const relayUrl = relayWsUrl();
  const fetched: { channel: CatchUpChannel; events: RelayEvent[] }[] = [];
  const failures: { status: "error"; channelId: string; error: string }[] = [];
  const results = new Array<RelayEvent[] | undefined>(request.channels.length);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < request.channels.length; index = next++) {
      const channel = request.channels[index];
      try {
        results[index] = await relayQuery([
          {
            kinds:
              channel.type === "dm"
                ? [9, 40002, 45001, 45003, 48100]
                : [9, 40002, 45001, 45003],
            "#h": [channel.id],
            since: channel.readAt === null ? 0 : channel.readAt + 1,
            limit: 1_000,
          },
        ]);
      } catch (error) {
        failures.push({
          status: "error",
          channelId: channel.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  request.channels.forEach((channel, index) => {
    const events = results[index];
    if (events) fetched.push({ channel, events: events.slice(0, 1_000) });
  });

  const current = getSecretKey();
  if (!current || getPublicKey(current) !== owner || relayWsUrl() !== relayUrl)
    throw new Error("unread catch-up scope changed while fetching");
  return {
    channels: [
      ...classifyCatchUp(request, fetched, loadBrowserMembership(owner)),
      ...failures,
    ],
  };
}

// ── Channel list (commands/channels/fetch.rs) ───────────────────────────────

const iso = (seconds: number) =>
  new Date(seconds * 1000).toISOString().replace(".000Z", "Z");

/** Port of `nostr_convert::channel_info_from_event` (no summary sidecar). */
export function channelInfo(event: RelayEvent, isMember = true) {
  const id = tag(event, "d");
  if (id === null) throw new Error("kind:39000 missing required `d` tag");
  const has = (name: string) =>
    event.tags.some((candidate) => candidate[0] === name);
  const visibility = tag(event, "visibility");
  const ttl = Number(tag(event, "ttl") ?? Number.NaN);
  const participants = event.tags
    .filter((candidate) => candidate[0] === "p" && candidate[1] !== undefined)
    .map((candidate) => candidate[1]);
  return {
    id,
    name: tag(event, "name") ?? "",
    channel_type: tag(event, "t") ?? (has("hidden") ? "dm" : "stream"),
    visibility:
      has("public") || visibility === "open"
        ? ("open" as const)
        : has("private") || visibility === "private"
          ? ("private" as const)
          : ("open" as const),
    description: tag(event, "about") ?? "",
    topic: tag(event, "topic"),
    purpose: tag(event, "purpose"),
    member_count: 0,
    member_pubkeys: [] as string[],
    last_message_at: null as string | null,
    archived_at:
      tag(event, "archived") === "true" ? iso(event.created_at) : null,
    participants,
    participant_pubkeys: [...participants],
    is_member: isMember,
    ttl_seconds:
      Number.isInteger(ttl) && ttl >= -(2 ** 31) && ttl < 2 ** 31 ? ttl : null,
    ttl_deadline: tag(event, "ttl_deadline"),
  };
}
type ChannelInfo = ReturnType<typeof channelInfo>;

// Native `AppState::pending_owned_channels`: channels this identity created
// whose kind:39002 owner entry has not propagated yet, keyed `pubkey:id`.
const pendingOwned = new Set<string>();

/** `query_relay_all`: drain a filter with the composite `(until, before_id)` cursor. */
async function queryAll(filter: Record<string, unknown>) {
  const all: RelayEvent[] = [];
  let cursor = {};
  for (;;) {
    const page = await relayQuery([{ ...filter, ...cursor, limit: 500 }]);
    all.push(...page);
    const last = page.at(-1);
    if (page.length < 500 || !last) return all;
    cursor = { until: last.created_at, before_id: last.id };
  }
}

function collectMembers(events: RelayEvent[]) {
  const members = new Map<string, string[]>();
  for (const event of events) {
    const channelId = tag(event, "d");
    if (channelId === null) continue;
    const pubkeys = new Set<string>();
    for (const [name, pubkey] of event.tags)
      if (name === "p" && pubkey) pubkeys.add(pubkey);
    members.set(channelId, [...pubkeys]);
  }
  return members;
}

/** Port of `fetch_channels` for `MemberOnly` / `IncludeOpenDirectory`. */
async function fetchChannels(includeOpenDirectory: boolean) {
  const me = getPublicKey(requireSecretKey());
  const pending = [...pendingOwned]
    .filter((key) => key.startsWith(`${me}:`))
    .map((key) => key.slice(me.length + 1));
  const [[metaEvents, membership], otherEvents, hiddenDms] = await Promise.all([
    (async () => {
      const memberEvents = await queryAll({ kinds: [39002], "#p": [me] });
      const ids = [
        ...new Set(
          memberEvents
            .map((event) => tag(event, "d"))
            .filter((id): id is string => id !== null),
        ),
      ].sort();
      for (const id of ids) pendingOwned.delete(`${me}:${id}`);
      const meta = ids.length
        ? await relayQuery([{ kinds: [39000], "#d": ids, limit: ids.length }])
        : [];
      return [meta, collectMembers(memberEvents)] as const;
    })(),
    includeOpenDirectory
      ? queryAll({ kinds: [39000] })
      : pending.length
        ? relayQuery([{ kinds: [39000], "#d": pending, limit: pending.length }])
        : [],
    relayQuery([{ kinds: [30622], "#p": [me], limit: 1 }])
      .catch(() => [])
      .then((events) => {
        const latest = events.reduce<RelayEvent | undefined>(
          (best, event) =>
            !best || event.created_at > best.created_at ? event : best,
          undefined,
        );
        return new Set(
          latest?.tags
            .filter((candidate) => candidate[0] === "h" && candidate[1])
            .map((candidate) => candidate[1]),
        );
      }),
  ]);

  const memberIds = new Set(metaEvents.map((event) => tag(event, "d")));
  const channels: ChannelInfo[] = [];
  const add = (event: RelayEvent, isMember: boolean) => {
    try {
      channels.push(channelInfo(event, isMember));
    } catch {}
  };
  for (const event of metaEvents) add(event, true);
  for (const event of otherEvents) {
    const id = tag(event, "d");
    if (id !== null && memberIds.has(id)) continue;
    add(event, id !== null && pendingOwned.has(`${me}:${id}`));
  }

  if (channels.length > 0) {
    const missing = channels
      .map((channel) => channel.id)
      .filter((id) => !membership.has(id));
    const filters = channels.map((channel) => ({
      kinds: [9, 40002, 45001, 45003],
      "#h": [channel.id],
      limit: 1,
    }));
    const [rosters, messages] = await Promise.all([
      missing.length
        ? relayQuery([
            { kinds: [39002], "#d": missing, limit: missing.length },
          ]).catch(() => [])
        : [],
      (async () => {
        // The relay bounds explicit `#h` filters per request at 128.
        const events: RelayEvent[] = [];
        for (let offset = 0; offset < filters.length; offset += 128)
          events.push(
            ...(await relayQuery(filters.slice(offset, offset + 128))),
          );
        return events;
      })(),
    ]);
    for (const [id, pubkeys] of collectMembers(rosters))
      membership.set(id, pubkeys);
    const lastAt = new Map<string, number>();
    for (const event of messages) {
      const id = tag(event, "h");
      if (id !== null && event.created_at > (lastAt.get(id) ?? -1))
        lastAt.set(id, event.created_at);
    }
    for (const channel of channels) {
      const pubkeys = membership.get(channel.id);
      if (pubkeys) {
        channel.member_count = pubkeys.length;
        channel.member_pubkeys = [...pubkeys];
      }
      const at = lastAt.get(channel.id);
      if (at !== undefined) channel.last_message_at = iso(at);
    }
  }
  return channels.filter(
    (channel) => channel.channel_type !== "dm" || !hiddenDms.has(channel.id),
  );
}

/** `compute_channels_hash`: FNV-1a 64 over the id-sorted stable projection. */
export function channelsHash(channels: ChannelInfo[]) {
  const canonical = JSON.stringify(
    [...channels]
      .sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      )
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        channel_type: channel.channel_type,
        visibility: channel.visibility,
        description: channel.description,
        topic: channel.topic,
        purpose: channel.purpose,
        member_count: channel.member_count,
        member_pubkeys: channel.member_pubkeys,
        archived_at: channel.archived_at,
        participants: channel.participants,
        participant_pubkeys: channel.participant_pubkeys,
        is_member: channel.is_member,
        ttl_seconds: channel.ttl_seconds,
        ttl_deadline: channel.ttl_deadline,
      })),
  );
  return fnv1a64(canonical);
}

export function fnv1a64(text: string) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of encoder.encode(text))
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return hash.toString(16).padStart(16, "0");
}

async function createChannel(args: Args) {
  const visibility = String(args.visibility);
  const channelType = String(args.channelType);
  if (visibility !== "open" && visibility !== "private")
    throw new Error(`invalid visibility: ${visibility}`);
  if (channelType !== "stream" && channelType !== "forum")
    throw new Error(`invalid channel_type: ${channelType}`);
  const name = String(args.name)
    .replace(/^[#\s]+/, "")
    .trimEnd();
  if (!name) throw new Error("channel name is required");
  const id = crypto.randomUUID();
  const tags = [
    ["h", id],
    ["name", name],
    ["visibility", visibility],
    ["channel_type", channelType],
  ];
  if (args.description != null) tags.push(["about", String(args.description)]);
  if (args.ttlSeconds != null) tags.push(["ttl", String(args.ttlSeconds)]);
  const key = requireSecretKey();
  await submitEvent(
    finalizeEvent(
      {
        kind: 9007,
        content: "",
        tags,
        created_at: Math.floor(Date.now() / 1000),
      },
      key,
    ),
  );
  pendingOwned.add(`${getPublicKey(key)}:${id}`);
  const [event] = await relayQuery([
    { kinds: [39000], "#d": [id], limit: 1, consistency: "strong" },
  ]);
  if (!event) throw new Error("channel created but metadata not yet available");
  return channelInfo(event);
}

async function ensureStarterChannels() {
  const changedChannelIds: string[] = [];
  try {
    let channels = await fetchChannels(true);
    const me = getPublicKey(requireSecretKey());
    const created = new Set<string>();
    const starterIds: string[] = [];
    const hasAll = () =>
      STARTER_CHANNELS.every((spec) =>
        channels.some((channel) => isStarterChannel(channel, spec)),
      );

    for (const spec of STARTER_CHANNELS) {
      if (channels.some((channel) => isStarterChannel(channel, spec))) continue;
      const id = await starterChannelId(spec.slug);
      starterIds.push(id);
      try {
        await publish(9007, "", [
          ["h", id],
          ["name", spec.name],
          ["visibility", "open"],
          ["channel_type", "stream"],
          ["about", spec.description],
        ]);
        created.add(id);
        changedChannelIds.push(id);
      } catch (error) {
        if (!String(error).includes("duplicate: channel already exists"))
          throw error;
      }
      pendingOwned.add(`${me}:${id}`);
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const metadata = starterIds.length
        ? await relayQuery([
            {
              kinds: [39000],
              "#d": starterIds,
              limit: starterIds.length,
              consistency: "strong",
            },
          ])
        : [];
      for (const event of metadata) {
        const channel = channelInfo(event, false);
        if (created.has(channel.id)) channel.is_member = true;
        if (!channels.some((existing) => existing.id === channel.id))
          channels.push(channel);
      }
      if (hasAll()) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!hasAll()) channels = await fetchChannels(true);
    if (!hasAll())
      throw new Error(
        "starter channels created but metadata not yet available",
      );

    for (const spec of STARTER_CHANNELS) {
      const channel = channels.find((candidate) =>
        isStarterChannel(candidate, spec),
      );
      if (!channel || channel.is_member) continue;
      await publish(9021, "", [["h", channel.id]]);
      channel.is_member = true;
      changedChannelIds.push(channel.id);
    }
    return { channels, changed_channel_ids: changedChannelIds, error: null };
  } catch (error) {
    return {
      channels: [],
      changed_channel_ids: changedChannelIds,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── Sending ─────────────────────────────────────────────────────────────────

function checkPubkey(pubkey: string) {
  if (!HEX64.test(pubkey))
    throw new Error(
      `pubkey must be a 64-character hex string (got ${pubkey.length} chars)`,
    );
}

function prefixedTags(tags: Tags | null | undefined, prefix: string): Tags {
  return (tags ?? []).map((candidate) => {
    if (candidate[0] !== prefix)
      throw new Error(`${prefix} tags must use '${prefix}' prefix`);
    return candidate;
  });
}

function mentionReferenceTags(tags: Tags | null | undefined): Tags {
  return (tags ?? []).map((mention) => {
    if (mention[0] !== "mention")
      throw new Error("mention reference tags must use 'mention' prefix");
    if (mention[1] === undefined)
      throw new Error("mention reference tag missing pubkey");
    if (
      mention.length > 3 ||
      (mention.length === 3 && mention[2] !== "agent-address")
    )
      throw new Error("mention reference tag has invalid display metadata");
    checkPubkey(mention[1]);
    return ["mention", mention[1].toLowerCase(), ...mention.slice(2)];
  });
}

function validMediaPair(url: string, hash: string, relayBase: URL) {
  if (!url && !hash) return true;
  if (!url || !/^[0-9a-f]{64}$/.test(hash) || !URL.canParse(url)) return false;
  const parsed = new URL(url);
  const filename = parsed.pathname.startsWith("/media/")
    ? parsed.pathname.slice(7)
    : null;
  if (
    parsed.origin !== relayBase.origin ||
    parsed.username ||
    parsed.password ||
    url.includes("?") ||
    url.includes("#") ||
    filename === null ||
    filename.includes("/") ||
    filename.includes("%")
  )
    return false;
  const dot = filename.indexOf(".");
  return (
    dot > 0 &&
    filename.slice(0, dot) === hash &&
    ["jpg", "png", "gif", "webp"].includes(filename.slice(dot + 1))
  );
}

/** Port of `link_preview_tags::append`. */
export function linkPreviewTags(
  tags: Tags | null | undefined,
  relayBase: string,
): Tags {
  const previews = tags ?? [];
  if (previews.length > 8)
    throw new Error("too many link preview snapshots (max 8)");
  const base = new URL(relayBase);
  const seen = new Set<string>();
  const text = (value: string, max: number, newlines: boolean) =>
    bytes(value) <= max &&
    !CONTROL.test(newlines ? value.replaceAll("\n", "") : value);
  return previews.map((preview) => {
    if (
      preview.length === 2 &&
      preview[0] === "link-preview" &&
      preview[1] === "none"
    ) {
      if (previews.length !== 1)
        throw new Error("link-preview suppression cannot include snapshots");
      return preview;
    }
    const url = URL.canParse(preview[3] ?? "") ? new URL(preview[3]) : null;
    const valid =
      preview.length === 11 &&
      preview[0] === "link-preview" &&
      preview[1] === "snapshot" &&
      preview[2] === "1" &&
      url?.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !preview[3].includes("#") &&
      !seen.has(preview[3]) &&
      seen.add(preview[3]) &&
      text(preview[4], 300, false) &&
      text(preview[5], 100, false) &&
      text(preview[6], 1000, true) &&
      validMediaPair(preview[7], preview[8], base) &&
      validMediaPair(preview[9], preview[10], base);
    if (!valid) throw new Error("invalid link-preview snapshot tag");
    return preview;
  });
}

function sentFromThreadTag(source: string[] | null | undefined): Tags {
  if (!source) return [];
  if (
    (source.length !== 2 && source.length !== 3) ||
    source[0] !== "buzz:sent-from-thread"
  )
    throw new Error("invalid sent-from-thread tag shape");
  if (!HEX64.test(source[1].trim()))
    throw new Error("sent-from-thread tag has invalid root event ID");
  const excerpt = source[2];
  if (
    excerpt !== undefined &&
    (!excerpt.trim() || [...excerpt].length > 64 || CONTROL.test(excerpt))
  )
    throw new Error("sent-from-thread tag has invalid root excerpt");
  return [source];
}

type ThreadRef = { root: string; parent: string };

/**
 * Port of `events::build_message` / `build_forum_post` / `build_forum_comment`:
 * returns the signed kind and the exact tag order the native builder emits.
 */
export function buildChannelMessage(
  args: Args,
  thread: ThreadRef | null,
  relayBase: string,
): { kind: number; content: string; tags: Tags } {
  const kind = Number(args.kind ?? 9);
  const content = String(args.content).trim();
  if (bytes(content) > MAX_CONTENT_BYTES)
    throw new Error(
      `content exceeds maximum size of ${MAX_CONTENT_BYTES} bytes (got ${bytes(content)})`,
    );
  const mentions = (args.mentionPubkeys as string[] | null) ?? [];
  if (mentions.length > 50) throw new Error("too many mentions (max 50)");
  const pTags: Tags = [];
  for (const pubkey of mentions) {
    checkPubkey(pubkey);
    if (!hasTag(pTags, "p", pubkey.toLowerCase()))
      pTags.push(["p", pubkey.toLowerCase()]);
  }
  const threadTags: Tags = !thread
    ? []
    : thread.root === thread.parent
      ? [["e", thread.root, "", "reply"]]
      : [
          ["e", thread.root, "", "root"],
          ["e", thread.parent, "", "reply"],
        ];
  const head = [["h", String(args.channelId)]];
  const media = prefixedTags(args.mediaTags as Tags, "imeta");
  const mentionRefs = mentionReferenceTags(args.mentionTags as Tags);
  if (kind === 45001)
    return {
      kind,
      content,
      tags: [...head, ...pTags, ...media, ...mentionRefs],
    };
  if (kind === 45003)
    return {
      kind,
      content,
      tags: [...head, ...threadTags, ...pTags, ...media, ...mentionRefs],
    };
  if (args.sentFromThreadTag && thread)
    throw new Error("sent-from-thread provenance requires a top-level message");
  return {
    kind: 9,
    content,
    tags: [
      ...head,
      ...threadTags,
      ...pTags,
      ...media,
      ...prefixedTags(args.emojiTags as Tags, "emoji"),
      ...mentionRefs,
      ...linkPreviewTags(args.linkPreviewTags as Tags, relayBase),
      ...sentFromThreadTag(args.sentFromThreadTag as string[] | null),
    ],
  };
}

const RELAY_SCOPE_ERROR =
  "active community changed before the message was submitted; not sent";
const SIGNER_SCOPE_ERROR =
  "active identity changed before the message was submitted; not sent";

async function resolveThreadRef(
  parentId: string,
  rootId: string | null,
): Promise<ThreadRef> {
  if (!HEX64.test(parentId)) throw new Error("invalid parent event ID");
  if (rootId !== null) {
    if (!HEX64.test(rootId)) throw new Error("invalid root event ID");
    return { root: rootId, parent: parentId };
  }
  const [parent] = await relayQuery([
    { ids: [parentId], kinds: [9, 40002, 45001, 45003, 48100], limit: 1 },
  ]);
  if (!parent) throw new Error("parent event not found");
  let root: string | undefined;
  let reply: string | undefined;
  for (const candidate of parent.tags) {
    if (candidate.length < 4 || candidate[0] !== "e") continue;
    if (candidate[3] === "root") root = candidate[1];
    if (candidate[3] === "reply") reply = candidate[1];
  }
  const resolved = root ?? reply;
  if (resolved === undefined || resolved === parentId)
    return { root: parentId, parent: parentId };
  if (!HEX64.test(resolved)) throw new Error("invalid root event ID");
  return { root: resolved, parent: parentId };
}

async function sendChannelMessage(args: Args) {
  const channelId = String(args.channelId);
  if (!UUID.test(channelId))
    throw new Error(`invalid channel UUID: ${channelId}`);
  const relayBase = relayHttpUrl();
  const expectedRelay = optionalString(args.expectedRelayUrl)?.trim();
  if (expectedRelay && relayHttpBase(expectedRelay) !== relayBase)
    throw new Error(RELAY_SCOPE_ERROR);
  const key = requireSecretKey();
  const expectedSigner = optionalString(args.expectedSignerPubkey)?.trim();
  if (
    expectedSigner &&
    expectedSigner.toLowerCase() !== getPublicKey(key).toLowerCase()
  )
    throw new Error(SIGNER_SCOPE_ERROR);
  const kind = Number(args.kind ?? 9);
  if (args.sentFromThreadTag && kind !== 9)
    throw new Error("sent-from-thread provenance requires a stream message");
  const parentId = optionalString(args.parentEventId);
  const rootId = optionalString(args.rootEventId);
  if (rootId !== null && parentId === null)
    throw new Error("root_event_id requires parent_event_id");
  if (kind === 45003 && parentId === null)
    throw new Error("forum comment requires parent_event_id");

  const thread =
    parentId !== null && kind !== 45001
      ? await resolveThreadRef(parentId, rootId)
      : null;
  const message = buildChannelMessage(args, thread, relayBase);
  // Native submits through the relay and signer it resolved up front; the
  // browser can only fail closed if either moved during the parent lookup.
  if (relayHttpUrl() !== relayBase) throw new Error(RELAY_SCOPE_ERROR);
  if (getSecretKey() !== key) throw new Error(SIGNER_SCOPE_ERROR);
  const event = finalizeEvent(
    {
      kind: message.kind,
      content: message.content,
      tags: message.tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    key,
  );
  const result = await submitEvent(event);
  return {
    event_id: result.event_id,
    root_event_id: thread?.root ?? null,
    parent_event_id: parentId,
    depth: parentId === null ? 0 : !thread || thread.root === parentId ? 1 : 2,
    created_at: event.created_at,
  };
}

// ── Link-preview suppression (forum posts, feed) ────────────────────────────

export function linkPreviewSuppressionTargets(
  originals: RelayEvent[],
  edits: RelayEvent[],
  ownerByAuthor: Map<string, string>,
): Set<string> {
  const byId = new Map(originals.map((event) => [event.id, event]));
  const targets = new Set<string>();
  for (const edit of edits) {
    if (
      edit.kind !== 40003 ||
      !edit.tags.some(
        (candidate) =>
          candidate.length === 2 &&
          candidate[0] === "link-preview" &&
          candidate[1] === "none",
      )
    )
      continue;
    const targetId = edit.tags.find((candidate) => candidate[0] === "e")?.[1];
    const target = targetId ? byId.get(targetId) : undefined;
    if (
      target &&
      (edit.pubkey === target.pubkey ||
        ownerByAuthor.get(target.pubkey) === edit.pubkey)
    )
      targets.add(target.id);
  }
  return targets;
}

async function suppressedLinkPreviews(events: RelayEvent[]) {
  if (events.length === 0) return new Set<string>();
  const edits = await relayQuery([
    { kinds: [40003], "#e": events.map((event) => event.id) },
  ]).catch(() => []);
  if (edits.length === 0) return new Set<string>();
  const authors = [...new Set(events.map((event) => event.pubkey))];
  const profiles = await relayQuery([{ kinds: [0], authors }]).catch(() => []);
  const owners = new Map<string, string>();
  for (const profile of profiles) {
    const owner = nipOaOwner(profile);
    if (owner) owners.set(profile.pubkey, owner);
  }
  return linkPreviewSuppressionTargets(events, edits, owners);
}

function withSuppression(tags: Tags, id: string, suppressed: Set<string>) {
  return suppressed.has(id) &&
    !tags.some(
      (candidate) =>
        candidate.length === 2 &&
        candidate[0] === "link-preview" &&
        candidate[1] === "none",
    )
    ? [...tags, LINK_PREVIEW_NONE]
    : tags;
}

// ── Presence ────────────────────────────────────────────────────────────────

export function latestPresence(events: RelayEvent[]) {
  const latest = new Map<string, { at: number; status: string }>();
  for (const event of events) {
    const pubkey =
      event.tags.find(
        (candidate) => candidate[0] === "p" && candidate[1] !== undefined,
      )?.[1] ?? event.pubkey;
    const status = event.content.trim();
    if (status !== "online" && status !== "away" && status !== "offline")
      continue;
    const previous = latest.get(pubkey);
    if (!previous || previous.at < event.created_at)
      latest.set(pubkey, { at: event.created_at, status });
  }
  return Object.fromEntries(
    [...latest].map(([pubkey, { status }]) => [pubkey, status]),
  );
}

// ── Identity archive / binding ──────────────────────────────────────────────

async function liveOaOwner(targetPubkey: string) {
  const [profile] = await relayQuery([
    { kinds: [0], authors: [targetPubkey.toLowerCase()], limit: 1 },
  ]);
  const owner = profile ? nipOaOwner(profile) : null;
  if (!profile || !owner) return null;
  const auth = profile.tags.find(
    (candidate) =>
      candidate.length === 4 &&
      candidate[0] === "auth" &&
      candidate[1] === owner,
  );
  return auth ? { owner, auth } : null;
}

async function identityArchiveRequest(kind: 9035 | 9036, req: Args) {
  const target = String(req.targetPubkey);
  const content = String(req.content ?? "");
  const reason = optionalString(req.reason);
  const replacedBy = kind === 9035 ? optionalString(req.replacedBy) : null;
  if (bytes(content) > MAX_CONTENT_BYTES)
    throw new Error(
      `content exceeds maximum size of ${MAX_CONTENT_BYTES} bytes`,
    );
  checkPubkey(target);
  const tags: Tags = [["-"], ["p", target.toLowerCase()]];
  if (reason !== null) {
    if (bytes(reason) > 64)
      throw new Error("reason code exceeds maximum length of 64 chars");
    if (CONTROL.test(reason))
      throw new Error("reason code must not contain control characters");
    tags.push(["reason", reason]);
  }
  if (replacedBy !== null) {
    checkPubkey(replacedBy);
    if (replacedBy.toLowerCase() === target.toLowerCase())
      throw new Error("replaced-by must differ from the target");
    tags.push(["replaced-by", replacedBy.toLowerCase()]);
  }
  // Owner-of-agent path: attach the target's verified NIP-OA tag as intent.
  const me = getPublicKey(requireSecretKey());
  if (me !== target.toLowerCase()) {
    const resolved = await liveOaOwner(target);
    if (resolved && resolved.owner === me) tags.push(resolved.auth);
  }
  return submitEvent(
    finalizeEvent(
      { kind, content, tags, created_at: Math.floor(Date.now() / 1000) },
      requireSecretKey(),
    ),
  );
}

const NONCE = /^[A-Za-z0-9_-]{43}$/;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

export function validateIdentityBinding(args: Args) {
  const challengeId = String(args.challengeId ?? "");
  if (!challengeId) throw new Error("challenge_id is required");
  if (!UUID.test(challengeId)) throw new Error("invalid challenge_id");
  const nonce = String(args.nonce ?? "");
  if (!nonce) throw new Error("nonce is required");
  if (!NONCE.test(nonce)) throw new Error("invalid nonce");
  if (!/^\d{6}$/.test(String(args.verificationCode)))
    throw new Error("verification_code must be exactly 6 digits");
  const origin = String(args.origin);
  if (!URL.canParse(origin)) throw new Error("invalid origin");
  const url = new URL(origin);
  if (url.protocol !== "https:") throw new Error("origin must use https");
  if (!url.hostname) throw new Error("origin missing host");
  if (url.username || url.password)
    throw new Error("origin must not include credentials");
  if (url.pathname !== "/" || origin.includes("?") || origin.includes("#"))
    throw new Error("origin must not include path, query, or fragment");
  const expiresAt = String(args.expiresAt);
  if (!RFC3339.test(expiresAt) || Number.isNaN(Date.parse(expiresAt)))
    throw new Error("invalid expires_at");
  if (Date.parse(expiresAt) <= Date.now())
    throw new Error("expires_at is expired");
}

// ── Relay documents ─────────────────────────────────────────────────────────

async function relayInformation(relayUrl: string) {
  return fetch(relayHttpBase(relayUrl), {
    headers: { Accept: "application/nostr+json" },
  });
}

async function fetchJoinPolicy(relayUrl: string) {
  if (!URL.canParse(relayUrl.trim())) throw new Error("invalid relay URL");
  const url = new URL(relayUrl.trim());
  if (url.protocol !== "ws:" && url.protocol !== "wss:")
    throw new Error("relay URL must use ws:// or wss://");
  if (url.username || url.password)
    throw new Error("relay URL must not contain credentials");
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/join-policy`;
  url.search = "";
  url.hash = "";
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`join policy request failed: ${error}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const limit = 4 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > limit)
    throw new Error("relay returned oversized join policy");
  const text = await response.text();
  if (bytes(text) > limit)
    throw new Error("relay returned oversized join policy");
  try {
    return (JSON.parse(text) as { policy?: unknown }).policy ?? null;
  } catch {
    throw new Error("relay returned malformed join policy");
  }
}

// ── Profile / canvas / forum thread helpers ─────────────────────────────────

const PROFILE_FIELDS = ["about", "display_name", "name", "nip05", "picture"];

/** The kind:0 string fields `build_profile` carries forward. */
function profileFields(event: RelayEvent | undefined) {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (event && JSON.parse(event.content)) || {};
  } catch {}
  return Object.fromEntries(
    PROFILE_FIELDS.filter((name) => typeof parsed[name] === "string").map(
      (name) => [name, parsed[name] as string],
    ),
  ) as Partial<Record<string, string>>;
}

/** `build_profile` content: present fields only, serde_json's sorted key order. */
function profileContent(fields: Partial<Record<string, string>>) {
  return JSON.stringify(
    Object.fromEntries(
      PROFILE_FIELDS.filter((name) => fields[name] !== undefined).map(
        (name) => [name, fields[name]],
      ),
    ),
  );
}

const CANVAS_CHANGED = "conflict: canvas changed since it was loaded";
const CANVAS_REVISION_MISSING = "conflict: canvas revision does not exist";
const CANVAS_SUPERSEDED =
  "conflict: canvas save was superseded by a concurrent write";

/** `check_canvas_precondition`: returns the head `created_at` floor, if any. */
export function canvasPrecondition(
  expected: string | null,
  head: { id: string; created_at: number } | undefined,
): number | null {
  if (expected === null) return null;
  if (expected === "none") {
    if (head) throw new Error(CANVAS_CHANGED);
    return null;
  }
  if (!head) throw new Error(CANVAS_REVISION_MISSING);
  if (head.id.toLowerCase() !== expected.toLowerCase())
    throw new Error(CANVAS_CHANGED);
  return head.created_at;
}

/** `buzz_sdk::canvas_write_survived`: walk `expected-revision` links from the head. */
export function canvasWriteSurvived(
  ourId: string,
  revisions: [string, string | null][],
) {
  const our = ourId.toLowerCase();
  const head = revisions[0]?.[0].toLowerCase();
  if (head === undefined) return false;
  if (head === our) return true;
  const byId = new Map(
    revisions.map(([id, expected]) => [id.toLowerCase(), expected]),
  );
  const seen = new Set<string>();
  let cursor = head;
  for (let step = 0; step < 256; step++) {
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    const expected = byId.get(cursor);
    if (!expected) return false;
    if (expected.toLowerCase() === our) return true;
    cursor = expected.toLowerCase();
  }
  return false;
}

/** `forum_reply_from_event`. */
function forumReply(
  event: RelayEvent,
  channelId: string,
  rootEventId: string,
  suppressed: Set<string>,
) {
  let parent: string | undefined;
  let explicitRoot: string | undefined;
  for (const candidate of event.tags) {
    if (candidate.length < 2 || candidate[0] !== "e") continue;
    if (candidate[3] === "root") explicitRoot = candidate[1];
    else if (candidate[3] === "reply" || parent === undefined)
      parent = candidate[1];
  }
  const parentId = parent ?? rootEventId;
  const rootId = explicitRoot ?? rootEventId;
  return {
    event_id: event.id,
    pubkey: event.pubkey,
    sig: event.sig,
    content: event.content,
    kind: event.kind,
    created_at: event.created_at,
    channel_id: channelId,
    tags: withSuppression(event.tags, event.id, suppressed),
    parent_event_id: parentId,
    root_event_id: rootId,
    depth: parentId === rootId ? 1 : 2,
    broadcast: false,
    reactions: null,
  };
}

// ── Command table ───────────────────────────────────────────────────────────

export const chatCommands: CommandTable = {
  get_channel_reconnect_repair: (args) =>
    relayQuery([channelReconnectRepairFilter(args)]),

  unread_catch_up: (args) => unreadCatchUp(args.request as CatchUpRequest),

  get_channels: async (args) => {
    const channels = await fetchChannels(false);
    const hash = channelsHash(channels);
    return {
      hash,
      channels: args.knownHash === hash ? null : channels,
      last_messages: Object.fromEntries(
        channels
          .filter((channel) => channel.last_message_at !== null)
          .map((channel) => [channel.id, channel.last_message_at]),
      ),
    };
  },

  get_open_channel_directory: () => fetchChannels(true),

  create_channel: createChannel,

  ensure_starter_channels: ensureStarterChannels,

  send_channel_message: sendChannelMessage,

  get_events: async (args) => {
    const ids = [
      ...new Set(
        ((args.eventIds as string[]) ?? [])
          .map((id) => id.trim().toLowerCase())
          .filter((id) => HEX64.test(id)),
      ),
    ];
    const byId = new Map<string, RelayEvent>();
    for (let offset = 0; offset < ids.length; offset += 1_000) {
      const chunk = ids.slice(offset, offset + 1_000);
      for (const event of await relayQuery([
        { ids: chunk, kinds: GET_EVENT_KINDS, limit: chunk.length },
      ]))
        if (!byId.has(event.id)) byId.set(event.id, event);
    }
    return [...byId.values()];
  },

  get_canvas_history: async (args) => {
    const until = args.until == null ? null : Number(args.until);
    const beforeId = optionalString(args.beforeId);
    if (beforeId !== null && until === null)
      throw new Error("before_id requires until");
    const pageSize = args.limit == null ? 100 : Number(args.limit);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000)
      throw new Error("limit must be between 1 and 1000");
    if (beforeId !== null && !HEX64.test(beforeId))
      throw new Error("before_id must be a 64-character hex event id");
    const events = await relayQuery([
      {
        kinds: [40100],
        "#h": [String(args.channelId)],
        limit: pageSize,
        ...(until !== null ? { until } : {}),
        ...(beforeId !== null ? { before_id: beforeId } : {}),
      },
    ]);
    const last = events.at(-1);
    return {
      revisions: events.map((event) => ({
        event_id: event.id,
        content: event.content,
        created_at: event.created_at,
        author: event.pubkey,
      })),
      next_cursor:
        events.length === pageSize && last
          ? { created_at: last.created_at, event_id: last.id }
          : null,
    };
  },

  fetch_join_policy: (args) => fetchJoinPolicy(String(args.relayUrl)),

  fetch_workspace_icon: async (args) => {
    try {
      const response = await relayInformation(String(args.relayUrl));
      if (!response.ok) return null;
      const { icon } = (await response.json()) as { icon?: unknown };
      return typeof icon === "string" && icon ? icon : null;
    } catch {
      return null;
    }
  },

  get_relay_self: async () => {
    const response = await relayInformation(relayWsUrl());
    if (!response.ok) return null;
    let relaySelf: unknown;
    try {
      relaySelf = ((await response.json()) as { self?: unknown }).self;
    } catch {
      throw new Error("relay returned malformed NIP-11 document");
    }
    if (relaySelf == null) return null;
    if (typeof relaySelf !== "string")
      throw new Error("relay returned malformed NIP-11 document");
    return HEX64.test(relaySelf) ? relaySelf.toLowerCase() : null;
  },

  update_profile_at_relay: async (args) => {
    if (relayHttpBase(String(args.relayUrl)) !== relayHttpUrl())
      throw new Error(
        "Buzz Web can only update the profile on the active community.",
      );
    const key = requireSecretKey();
    const pubkey = String(args.expectedPubkey);
    if (getPublicKey(key) !== pubkey)
      throw new Error("profile identity changed before avatar save");
    const filter = { kinds: [0], authors: [pubkey], limit: 1 };
    const [prior] = await relayQuery([filter]);
    const current = profileFields(prior);
    const normalize = (value: unknown) =>
      typeof value === "string" && value.trim() ? value.trim() : null;
    if (normalize(current.picture) !== normalize(args.expectedAvatarUrl))
      throw new Error("profile avatar changed before deferred save");
    const content = profileContent({
      ...current,
      picture: String(args.avatarUrl),
    });
    const now = Math.floor(Date.now() / 1000);
    await submitEvent(
      finalizeEvent(
        {
          kind: 0,
          content,
          tags: [],
          created_at: Math.max(now, prior ? prior.created_at + 1 : 0),
        },
        key,
      ),
    );
    const [event] = await relayQuery([filter]);
    return rawProfile(event, pubkey);
  },

  resolve_oa_owner: async (args) => {
    const resolved = await liveOaOwner(String(args.targetPubkey));
    if (!resolved) return null;
    return {
      owner: resolved.owner,
      is_me: getPublicKey(requireSecretKey()) === resolved.owner,
    };
  },

  archive_identity: (args) => identityArchiveRequest(9035, args.req as Args),

  unarchive_identity: (args) => identityArchiveRequest(9036, args.req as Args),

  sign_nostr_identity_binding: (args) => {
    validateIdentityBinding(args);
    return JSON.stringify(
      finalizeEvent(
        {
          kind: 24243,
          content: "",
          tags: [
            ["challenge_id", String(args.challengeId)],
            ["nonce", String(args.nonce)],
            ["verification_code", String(args.verificationCode)],
            ["audience", "buzz:nostr-identity"],
            ["action", "bind_nostr_identity"],
            ["protocol", "buzz-nostr-identity"],
            ["version", "1"],
            ["origin", String(args.origin)],
            ["expires_at", String(args.expiresAt)],
          ],
          created_at: Math.floor(Date.now() / 1000),
        },
        requireSecretKey(),
      ),
    );
  },

  // The head cache is an optional paint cache; an empty load is a cache miss
  // and callers fall through to the relay window read.
  channel_head_cache_load: () => [],
  channel_head_cache_store: () => undefined,
  channel_head_cache_clear: () => undefined,

  // Rejecting open makes the renderer keep its localStorage observed-unread
  // store, which is the pre-native implementation it still maintains.
  observed_unread_open_scope: () => {
    throw new Error(
      "Native observed-unread storage is unavailable in Buzz Web.",
    );
  },
  observed_unread_ingest: () => {
    throw new Error(
      "Native observed-unread storage is unavailable in Buzz Web.",
    );
  },

  update_profile: async (args) => {
    const pubkey = getPublicKey(requireSecretKey());
    const filter = { kinds: [0], authors: [pubkey], limit: 1 };
    const [prior] = await relayQuery([filter]);
    const current = profileFields(prior);
    const pick = (value: unknown, name: string) =>
      typeof value === "string" ? value : current[name];
    await publish(
      0,
      profileContent({
        display_name: pick(args.displayName, "display_name"),
        name: current.name,
        picture: pick(args.avatarUrl, "picture"),
        about: pick(args.about, "about"),
        nip05: pick(args.nip05Handle, "nip05"),
      }),
      [],
    );
    const [event] = await relayQuery([filter]);
    return rawProfile(event, pubkey);
  },

  set_canvas: async (args) => {
    const channelId = String(args.channelId);
    if (!UUID.test(channelId))
      throw new Error(`invalid channel UUID: ${channelId}`);
    const expected = optionalString(args.expectedRevision);
    const history = {
      kinds: [40100],
      "#h": [channelId],
      consistency: "strong",
    };
    const [head] = await relayQuery([{ ...history, limit: 1 }]);
    const floor = canvasPrecondition(expected, head);
    const content = String(args.content);
    if (bytes(content) > MAX_CONTENT_BYTES)
      throw new Error(
        `content exceeds maximum size of ${MAX_CONTENT_BYTES} bytes (got ${bytes(content)})`,
      );
    const now = Math.floor(Date.now() / 1000);
    if (floor !== null && floor > now + 60)
      throw new Error(
        "canvas head is timestamped too far in the future; refusing to extend it",
      );
    const tags = [["h", channelId]];
    if (expected !== null) tags.push(["expected-revision", expected]);
    const result = await submitEvent(
      finalizeEvent(
        {
          kind: 40100,
          content,
          tags,
          created_at: floor === null ? now : Math.max(now, floor + 1),
        },
        requireSecretKey(),
      ),
    );
    let verified = true;
    if (expected !== null) {
      // The write is durable; a failed verification read only clears `verified`.
      const ancestry = await relayQuery([{ ...history, limit: 256 }]).catch(
        () => null,
      );
      if (ancestry === null) verified = false;
      else if (
        !canvasWriteSurvived(
          result.event_id,
          ancestry.map((event) => [event.id, tag(event, "expected-revision")]),
        )
      )
        throw new Error(CANVAS_SUPERSEDED);
    }
    return { ok: true, event_id: result.event_id, verified };
  },

  get_forum_thread: async (args) => {
    const channelId = String(args.channelId);
    const eventId = String(args.eventId);
    const events = await relayQuery([
      { ids: [eventId], kinds: [9, 40002, 45001, 45003] },
      { kinds: [9, 45003], "#e": [eventId], "#h": [channelId] },
    ]);
    const suppressed = await suppressedLinkPreviews(events);
    let root: ReturnType<typeof rawForumPost> | undefined;
    const replies = [];
    for (const event of events) {
      if (event.id === eventId) {
        const post = rawForumPost(event, channelId);
        root = {
          ...post,
          tags: withSuppression(post.tags, post.event_id, suppressed),
        };
      } else if (event.kind !== 40003)
        replies.push(forumReply(event, channelId, eventId, suppressed));
    }
    if (!root) throw new Error("forum thread root event not found");
    return { root, replies, total_replies: replies.length, next_cursor: null };
  },

  get_forum_posts: async (args) => {
    const channelId = String(args.channelId);
    const events = await relayQuery([
      {
        kinds: [45001],
        "#h": [channelId],
        limit: Math.min(args.limit == null ? 20 : Number(args.limit), 100),
        ...(args.before != null ? { until: Number(args.before) } : {}),
      },
    ]);
    const suppressed = await suppressedLinkPreviews(events);
    return {
      messages: events.map((event) => {
        const post = rawForumPost(event, channelId);
        return {
          ...post,
          tags: withSuppression(post.tags, post.event_id, suppressed),
        };
      }),
      next_cursor: events.at(-1)?.created_at ?? null,
    };
  },

  get_channel_members: async (args) => {
    const [roster] = await relayQuery([
      {
        kinds: [39002],
        "#d": [String(args.channelId)],
        limit: 1,
        ...(args.readYourWrites ? { consistency: "strong" } : {}),
      },
    ]);
    if (!roster) throw new Error("channel members not found");
    if (tag(roster, "d") === null)
      throw new Error("kind:39002 missing required `d` tag");
    const seen = new Set<string>();
    const members = roster.tags
      .filter(
        (candidate) =>
          candidate[0] === "p" &&
          candidate[1] &&
          !seen.has(candidate[1]) &&
          seen.add(candidate[1]),
      )
      .map((candidate) => ({
        pubkey: candidate[1],
        role: candidate[3] || "member",
        is_agent: candidate[3] === "bot",
        joined_at: null,
        display_name: null as string | null,
      }));
    const pubkeys = members.slice(0, 500).map((member) => member.pubkey);
    const profiles = pubkeys.length
      ? await relayQuery([
          { kinds: [0], authors: pubkeys, limit: pubkeys.length },
        ]).catch(() => [])
      : [];
    const byPubkey = new Map<string, ReturnType<typeof rawProfile>>();
    for (const event of profiles) {
      try {
        byPubkey.set(event.pubkey, rawProfile(event, event.pubkey));
      } catch {}
    }
    for (const member of members) {
      const profile = byPubkey.get(member.pubkey);
      if (!profile) continue;
      member.display_name ??= profile.display_name;
      member.is_agent ||= profile.owner_pubkey !== null;
    }
    return { members, next_cursor: null };
  },

  get_feed: async (args) => {
    const pubkey = getPublicKey(requireSecretKey());
    const since = args.since == null ? null : Number(args.since);
    const types = args.types == null ? null : String(args.types).split(",");
    const wants = (name: string) =>
      !types || types.some((type) => type.trim() === name);
    const sinceFilter = since === null ? {} : { since };
    const [mentionEvents, approvalEvents] = await Promise.all([
      wants("mentions")
        ? relayQuery([
            {
              kinds: FEED_MENTION_KINDS,
              "#p": [pubkey],
              limit: Math.min(
                args.limit == null ? 50 : Number(args.limit),
                100,
              ),
              ...sinceFilter,
            },
          ]).catch(() => [])
        : [],
      wants("needs_action")
        ? relayQuery([
            {
              kinds: [46010, 46011, 46012],
              "#p": [pubkey],
              limit: 20,
              ...sinceFilter,
            },
          ]).catch(() => [])
        : [],
    ]);
    const suppressed = await suppressedLinkPreviews(mentionEvents);
    const item = (event: RelayEvent, category: string) => ({
      id: event.id,
      kind: event.kind,
      pubkey: event.pubkey,
      content: event.content,
      created_at: event.created_at,
      channel_id: tag(event, "h"),
      channel_name: "",
      channel_type: null,
      tags: withSuppression(event.tags, event.id, suppressed),
      category,
    });
    const mentions = mentionEvents.map((event) => item(event, "mention"));
    const needsAction = approvalEvents.map((event) =>
      item(event, "needs_action"),
    );
    return {
      feed: {
        mentions,
        needs_action: needsAction,
        activity: [],
        agent_activity: [],
      },
      meta: {
        since: since ?? 0,
        total: mentions.length + needsAction.length,
        generated_at: Math.floor(Date.now() / 1000),
      },
    };
  },

  get_presence: async (args) => {
    const pubkeys = (args.pubkeys as string[]) ?? [];
    if (pubkeys.length === 0) return {};
    return latestPresence(
      await relayQuery([{ kinds: [20001], authors: pubkeys }]),
    );
  },
};
