import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.location = new URL("http://localhost:8080/");
const {
  buildChannelMessage,
  canvasPrecondition,
  canvasWriteSurvived,
  channelInfo,
  channelsHash,
  fnv1a64,
  channelReconnectRepairFilter,
  classifyCatchUp,
  latestPresence,
  linkPreviewSuppressionTargets,
  linkPreviewTags,
  relayHttpBase,
} = await import("./chat.ts");

const CHANNEL = "270f6caf-0feb-4055-93f3-cdbeb567ff28";
const ID = "ab".repeat(32);
const PUBKEY =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const HASH = "cd".repeat(32);

const event = (id, pubkey, created_at, tags, extra = {}) => ({
  id,
  pubkey,
  created_at,
  kind: 9,
  tags,
  content: id,
  sig: "",
  ...extra,
});

test("reconnect repair filter is fixed and keyset scoped", () => {
  const filter = channelReconnectRepairFilter({
    channelId: CHANNEL,
    since: 100,
    limit: 500,
    until: 200,
    beforeId: ID,
  });
  assert.deepEqual(filter["#h"], [CHANNEL]);
  assert.equal(filter.since, 100);
  assert.equal(filter.until, 200);
  assert.equal(filter.before_id, ID);
  assert.equal(filter.top_level, undefined);
  assert.deepEqual(
    Object.keys(
      channelReconnectRepairFilter({ channelId: CHANNEL, since: 0, limit: 1 }),
    ),
    ["#h", "kinds", "since", "limit"],
  );
  for (const bad of [
    { channelId: "nope", since: 0, limit: 1 },
    { channelId: CHANNEL, since: 0, limit: 0 },
    { channelId: CHANNEL, since: 0, limit: 501 },
    { channelId: CHANNEL, since: 0, limit: 1, beforeId: ID },
    { channelId: CHANNEL, since: 0, limit: 1, until: 1, beforeId: "bad" },
  ])
    assert.throws(() => channelReconnectRepairFilter(bad));
});

const channel = (readAt) => ({ id: "ch", type: "stream", name: "Ch", readAt });
const request = { channels: [], selfPubkey: "self", mutedChannelIds: [] };

test("catch-up pass one history changes later classification", () => {
  const [result] = classifyCatchUp(
    request,
    [
      {
        channel: channel(9),
        events: [
          event("self-reply", "self", 10, [
            ["e", "root", "", "reply"],
            ["h", "ch"],
          ]),
          event("external", "other", 11, [
            ["e", "root", "", "reply"],
            ["h", "ch"],
          ]),
        ],
      },
    ],
    {},
  );
  assert.deepEqual(
    result.observedEvents.map((item) => [
      item.id,
      item.highPriority,
      item.countsTowardAppBadge,
    ]),
    [["external", true, false]],
  );
  assert.deepEqual(result.discovered.participated, ["root"]);
  assert.deepEqual(
    result.activityRows.map((row) => row.id),
    ["external"],
  );
});

test("catch-up honours the read boundary, muted roots and broadcasts", () => {
  const [result] = classifyCatchUp(
    request,
    [
      {
        channel: channel(10),
        events: [
          event("boundary", "other", 10, [["h", "ch"]]),
          event("muted", "other", 11, [
            ["e", "muted", "", "reply"],
            ["h", "ch"],
          ]),
          event("broadcast", "other", 12, [
            ["broadcast", "1"],
            ["h", "ch"],
          ]),
        ],
      },
    ],
    { muted_root: new Set(["muted"]) },
  );
  assert.deepEqual(
    result.observedEvents.map((item) => item.id),
    ["broadcast"],
  );
  assert.equal(result.observedEvents[0].rootId, null);
  assert.equal(result.maxTrigger, 12);
});

test("catch-up keeps only the newest 100 thread replies across the batch", () => {
  const replies = Array.from({ length: 120 }, (_, index) =>
    event(`r${index}`, "other", index + 1, [
      ["e", "root", "", "reply"],
      ["h", "ch"],
    ]),
  );
  const [result] = classifyCatchUp(
    request,
    [{ channel: channel(null), events: replies }],
    {
      followed: new Set(["root"]),
    },
  );
  assert.equal(result.observedEvents.length, 120);
  assert.equal(result.activityRows.length, 100);
  assert.equal(result.activityRows.at(-1).id, "r119");
  assert.ok(!result.activityRows.some((row) => row.id === "r19"));
});

test("send builds native tag order for a nested thread reply", () => {
  const message = buildChannelMessage(
    {
      channelId: CHANNEL,
      content: "  hi  ",
      mentionPubkeys: [PUBKEY.toUpperCase(), PUBKEY],
      mediaTags: [["imeta", "url x"]],
      emojiTags: [["emoji", "party", "https://x/p.png"]],
      mentionTags: [["mention", PUBKEY.toUpperCase(), "agent-address"]],
      linkPreviewTags: [["link-preview", "none"]],
    },
    { root: "11".repeat(32), parent: ID },
    "http://localhost:8080",
  );
  assert.equal(message.kind, 9);
  assert.equal(message.content, "hi");
  assert.deepEqual(message.tags, [
    ["h", CHANNEL],
    ["e", "11".repeat(32), "", "root"],
    ["e", ID, "", "reply"],
    ["p", PUBKEY],
    ["imeta", "url x"],
    ["emoji", "party", "https://x/p.png"],
    ["mention", PUBKEY, "agent-address"],
    ["link-preview", "none"],
  ]);
  assert.throws(() =>
    buildChannelMessage(
      { channelId: CHANNEL, content: "x", mediaTags: [["h", "forged"]] },
      null,
      "http://localhost:8080",
    ),
  );
  assert.throws(() =>
    buildChannelMessage(
      {
        channelId: CHANNEL,
        content: "x",
        sentFromThreadTag: ["buzz:sent-from-thread", ID],
      },
      { root: ID, parent: ID },
      "http://localhost:8080",
    ),
  );
});

test("forum posts drop stream-only tags", () => {
  const message = buildChannelMessage(
    {
      channelId: CHANNEL,
      content: "x",
      kind: 45001,
      emojiTags: [["emoji", "a", "b"]],
    },
    null,
    "http://localhost:8080",
  );
  assert.deepEqual(message, {
    kind: 45001,
    content: "x",
    tags: [["h", CHANNEL]],
  });
});

test("link preview snapshots must reference relay media", () => {
  const snapshot = (image) => [
    "link-preview",
    "snapshot",
    "1",
    "https://example.com/a",
    "Title",
    "Site",
    "line\nbreak",
    image,
    image ? HASH : "",
    "",
    "",
  ];
  const ok = snapshot(`http://localhost:8080/media/${HASH}.png`);
  assert.deepEqual(linkPreviewTags([ok], "http://localhost:8080"), [ok]);
  assert.throws(() =>
    linkPreviewTags(
      [snapshot(`https://evil.test/media/${HASH}.png`)],
      "http://localhost:8080",
    ),
  );
  assert.throws(() => linkPreviewTags([ok, ok], "http://localhost:8080"));
  assert.throws(() =>
    linkPreviewTags([["link-preview", "none"], ok], "http://localhost:8080"),
  );
});

test("link preview suppression accepts only the author or verified owner", () => {
  const original = event("orig", "author", 1, []);
  const edit = (pubkey) =>
    event(
      `edit-${pubkey}`,
      pubkey,
      2,
      [
        ["e", "orig"],
        ["link-preview", "none"],
      ],
      {
        kind: 40003,
      },
    );
  const owners = new Map([["author", "owner"]]);
  for (const signer of ["author", "owner"])
    assert.deepEqual(
      [...linkPreviewSuppressionTargets([original], [edit(signer)], owners)],
      ["orig"],
    );
  assert.equal(
    linkPreviewSuppressionTargets([original], [edit("attacker")], owners).size,
    0,
  );
});

test("presence keeps the latest known status per subject", () => {
  assert.deepEqual(
    latestPresence([
      event("a", "relay", 5, [["p", "alice"]], { content: "away" }),
      event("b", "relay", 4, [["p", "alice"]], { content: "online" }),
      event("c", "bob", 3, [], { content: " online " }),
      event("d", "carol", 3, [], { content: "busy" }),
    ]),
    { alice: "away", bob: "online" },
  );
});

test("relay http base mirrors the native string rewrite", () => {
  assert.equal(
    relayHttpBase(" wss://relay.example/ "),
    "https://relay.example",
  );
  assert.equal(relayHttpBase("ws://localhost:8080"), "http://localhost:8080");
});

test("fnv1a64 matches the reference vectors", () => {
  assert.equal(fnv1a64(""), "cbf29ce484222325");
  assert.equal(fnv1a64("a"), "af63dc4c8601ec8c");
  assert.equal(fnv1a64("foobar"), "85944171f73967e8");
});

test("channel info mirrors channel_info_from_event", () => {
  const info = channelInfo(
    event("x", "pk", 1609459200, [
      ["d", CHANNEL],
      ["name", "general"],
      ["private"],
      ["visibility", "open"],
      ["archived", "true"],
      ["ttl", "abc"],
      ["p", PUBKEY],
    ]),
    false,
  );
  assert.equal(info.visibility, "open");
  assert.equal(info.archived_at, "2021-01-01T00:00:00Z");
  assert.equal(info.ttl_seconds, null);
  assert.equal(info.is_member, false);
  assert.deepEqual(info.participant_pubkeys, [PUBKEY]);
  assert.throws(() => channelInfo(event("x", "pk", 1, [])));
});

test("channel hash is order independent and ignores last_message_at", () => {
  const a = channelInfo(event("a", "pk", 1, [["d", "a"]]));
  const b = channelInfo(event("b", "pk", 1, [["d", "b"]]));
  const hash = channelsHash([a, b]);
  assert.equal(
    channelsHash([b, { ...a, last_message_at: "2021-01-01T00:00:00Z" }]),
    hash,
  );
  assert.notEqual(channelsHash([b, { ...a, member_count: 1 }]), hash);
});

test("canvas precondition and post-write survival match the SDK", () => {
  const head = { id: ID, created_at: 7 };
  assert.equal(canvasPrecondition(null, head), null);
  assert.equal(canvasPrecondition(ID.toUpperCase(), head), 7);
  assert.throws(() => canvasPrecondition("none", head), /changed since/);
  assert.throws(() => canvasPrecondition(ID, undefined), /does not exist/);
  assert.throws(
    () => canvasPrecondition("11".repeat(32), head),
    /changed since/,
  );
  assert.equal(canvasWriteSurvived("a", [["a", null]]), true);
  assert.equal(
    canvasWriteSurvived("a", [
      ["c", "b"],
      ["b", "a"],
      ["a", null],
    ]),
    true,
  );
  assert.equal(
    canvasWriteSurvived("a", [
      ["c", "x"],
      ["a", null],
    ]),
    false,
  );
  assert.equal(
    canvasWriteSurvived("a", [
      ["c", "b"],
      ["b", "c"],
    ]),
    false,
  );
  assert.equal(canvasWriteSurvived("a", []), false);
});
