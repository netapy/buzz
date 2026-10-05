import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { createGateway } from "./server.mjs";

const relayKey = generateSecretKey();
const userKey = generateSecretKey();
const DELIVERY_URL = "http://webpush:8080/v1/deliveries/apns";
const ORIGIN = "https://chat.example.com";
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) },
};

function auth(key, url, body) {
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [
        ["u", url],
        ["method", "POST"],
        ["payload", createHash("sha256").update(body).digest("hex")],
      ],
    },
    key,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

async function start(send) {
  const sent = [];
  const gateway = createGateway({
    relayPubkey: getPublicKey(relayKey),
    deliveryUrl: DELIVERY_URL,
    publicOrigin: ORIGIN,
    storePath: join(await mkdtemp(join(tmpdir(), "webpush-")), "store.json"),
    vapidPublicKey: "vapid-public",
    send: async (...args) => {
      sent.push(args);
      return send?.(...args);
    },
  });
  await gateway.load();
  const server = createServer(gateway.handler).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, payload, key, signedUrl) => {
    const body = JSON.stringify(payload);
    const response = await fetch(base + path, {
      method: "POST",
      body,
      headers: key ? { Authorization: auth(key, signedUrl, body) } : {},
    });
    return [response.status, await response.json()];
  };
  const register = (generation = 7) =>
    post(
      "/webpush/register",
      { subscription, generation },
      userKey,
      `${ORIGIN}/webpush/register`,
    );
  const deliver = (grant, requestId = crypto.randomUUID(), key = relayKey) =>
    post(
      "/v1/deliveries/apns",
      {
        v: 1,
        endpoint_grant: grant,
        request_id: requestId,
        expires_at: Math.floor(Date.now() / 1000) + 600,
      },
      key,
      DELIVERY_URL,
    );
  return { base, post, register, deliver, sent, gateway, close: () => server.close() };
}

test("serves the VAPID key", async () => {
  const gw = await start();
  const response = await fetch(`${gw.base}/webpush/config`);
  assert.deepEqual(await response.json(), { vapidPublicKey: "vapid-public" });
  gw.close();
});

test("registers a browser subscription for the signed-in user", async () => {
  const gw = await start();
  const [status, body] = await gw.register(42);
  assert.equal(status, 200);
  assert.match(body.endpoint_grant, /^[\w-]{32}\.42$/);
  assert.equal(gw.gateway.grants()[body.endpoint_grant].pubkey, getPublicKey(userKey));
  gw.close();
});

test("rejects unsigned registrations and unknown push services", async () => {
  const gw = await start();
  assert.equal((await gw.post("/webpush/register", { subscription, generation: 1 }))[0], 401);
  const [status] = await gw.post(
    "/webpush/register",
    { subscription: { ...subscription, endpoint: "https://evil.example/push" }, generation: 1 },
    userKey,
    `${ORIGIN}/webpush/register`,
  );
  assert.equal(status, 400);
  gw.close();
});

test("delivers a relay wake as a content-free web push", async () => {
  const gw = await start();
  const [, { endpoint_grant }] = await gw.register();
  const [status, body] = await gw.deliver(endpoint_grant);
  assert.equal(status, 200);
  assert.deepEqual(body, { status: "accepted" });
  const [target, payload, options] = gw.sent[0];
  assert.equal(target.endpoint, subscription.endpoint);
  assert.equal(payload, '{"v":1}');
  assert.equal(options.topic, "buzz-wake");
  assert.ok(options.TTL > 0 && options.TTL <= 600);
  gw.close();
});

test("only the relay key may deliver, and a retried request is sent once", async () => {
  const gw = await start();
  const [, { endpoint_grant }] = await gw.register();
  assert.equal((await gw.deliver(endpoint_grant, undefined, userKey))[0], 401);
  const id = crypto.randomUUID();
  await gw.deliver(endpoint_grant, id);
  await gw.deliver(endpoint_grant, id);
  assert.equal(gw.sent.length, 1);
  gw.close();
});

test("a gone subscription tells the relay to disable that lease generation", async () => {
  const gw = await start(() => {
    throw Object.assign(new Error("gone"), { statusCode: 410 });
  });
  const [, { endpoint_grant }] = await gw.register(9);
  const [status, body] = await gw.deliver(endpoint_grant);
  assert.equal(status, 410);
  assert.equal(body.status, "invalid_endpoint");
  assert.equal(body.generation, 9);
  assert.equal(gw.gateway.grants()[endpoint_grant], undefined);
  const [againStatus, again] = await gw.deliver(endpoint_grant);
  assert.equal(againStatus, 410);
  assert.equal(again.generation, 9);
  gw.close();
});

test("a throttled push service asks the relay to retry", async () => {
  const gw = await start(() => {
    throw Object.assign(new Error("slow down"), {
      statusCode: 429,
      headers: { "retry-after": "12" },
    });
  });
  const [, { endpoint_grant }] = await gw.register();
  assert.deepEqual(await gw.deliver(endpoint_grant), [
    503,
    { status: "retry", retry_after_seconds: 12 },
  ]);
  gw.close();
});
