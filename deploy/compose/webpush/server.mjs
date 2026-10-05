// Web Push gateway for the Buzz PWA.
//
// The relay's push runtime (NIP-PL push leases) wakes installations through a
// gateway it signs requests to with NIP-98. Block's gateway only knows APNs;
// this one stands in at the same contract and holds browser push
// subscriptions instead. Browsers register a subscription here (NIP-98 by
// the user) and get an opaque endpoint grant, which they put in their push
// lease. When the relay matches an event it posts the grant back; we send a
// content-free wake and the service worker fetches the message itself.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { verifyEvent } from "nostr-tools/pure";
import webpush from "web-push";

const MAX_BODY = 16 * 1024;
const MAX_PER_PUBKEY = 10;
const MAX_GRANTS = 10_000;
const MAX_WAKE_TTL = 3600;
const AUTH_WINDOW_SECONDS = 60;
// Browser push services (Chrome, Chromium builds, Safari, Firefox, Edge).
const PUSH_HOSTS = [
  "fcm.googleapis.com",
  "jmt17.google.com",
  "push.apple.com",
  "push.services.mozilla.com",
  "notify.windows.com",
];

export function createGateway({
  relayPubkey,
  deliveryUrl,
  publicOrigin,
  storePath,
  vapidPublicKey,
  allowedHosts = PUSH_HOSTS,
  send = (subscription, payload, options) =>
    webpush.sendNotification(subscription, payload, options),
  now = () => Math.floor(Date.now() / 1000),
}) {
  let grants = {};
  let saving = Promise.resolve();
  const seenAuth = new Map();
  const deliveries = new Map();

  const load = async () => {
    try {
      grants = JSON.parse(await readFile(storePath, "utf8")).grants ?? {};
    } catch {
      grants = {};
    }
  };
  // Writes are serialized; one failed write must not wedge later ones.
  const save = () => {
    saving = saving.catch(() => {}).then(async () => {
      await mkdir(dirname(storePath), { recursive: true });
      await writeFile(`${storePath}.tmp`, JSON.stringify({ grants }));
      await rename(`${storePath}.tmp`, storePath);
    });
    return saving;
  };

  // NIP-98: a fresh kind-27235 event over this exact URL, method and body.
  const authenticate = (header, url, body) => {
    if (!header?.startsWith("Nostr ")) return null;
    let event;
    try {
      event = JSON.parse(Buffer.from(header.slice(6), "base64").toString());
    } catch {
      return null;
    }
    const value = (name) => event?.tags?.find((tag) => tag[0] === name)?.[1];
    if (
      event?.kind !== 27235 ||
      Math.abs(now() - event.created_at) > AUTH_WINDOW_SECONDS ||
      value("u") !== url ||
      value("method")?.toUpperCase() !== "POST" ||
      value("payload") !== createHash("sha256").update(body).digest("hex") ||
      seenAuth.has(event.id) ||
      !verifyEvent(event)
    )
      return null;
    seenAuth.set(event.id, event.created_at);
    for (const [id, at] of seenAuth)
      if (now() - at > 2 * AUTH_WINDOW_SECONDS) seenAuth.delete(id);
    return event.pubkey;
  };

  const validSubscription = (subscription) => {
    try {
      const url = new URL(subscription.endpoint);
      return (
        url.protocol === "https:" &&
        allowedHosts.some(
          (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
        ) &&
        subscription.endpoint.length <= 1024 &&
        /^[\w-]{80,100}$/.test(subscription.keys?.p256dh ?? "") &&
        /^[\w-]{16,32}$/.test(subscription.keys?.auth ?? "")
      );
    } catch {
      return false;
    }
  };

  // Grants carry the lease generation they were minted for, so a wake for a
  // forgotten grant can still tell the relay which lease to disable.
  const register = async (pubkey, { subscription, generation }) => {
    if (!validSubscription(subscription) || !Number.isSafeInteger(generation))
      return [400, { error: "invalid subscription" }];
    for (const [grant, record] of Object.entries(grants))
      if (
        record.endpoint === subscription.endpoint &&
        record.pubkey === pubkey
      )
        delete grants[grant];
    const mine = Object.entries(grants)
      .filter(([, record]) => record.pubkey === pubkey)
      .sort(([, a], [, b]) => a.created_at - b.created_at);
    for (const [grant] of mine.slice(0, mine.length - MAX_PER_PUBKEY + 1))
      delete grants[grant];
    if (Object.keys(grants).length >= MAX_GRANTS)
      return [503, { error: "gateway full" }];
    const grant = `${randomBytes(24).toString("base64url")}.${generation}`;
    grants[grant] = {
      pubkey,
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      created_at: now(),
    };
    await save();
    return [200, { endpoint_grant: grant }];
  };

  const unregister = async (pubkey, { endpoint }) => {
    for (const [grant, record] of Object.entries(grants))
      if (record.pubkey === pubkey && record.endpoint === endpoint)
        delete grants[grant];
    await save();
    return [200, {}];
  };

  const invalid = (grant) => [
    410,
    {
      status: "invalid_endpoint",
      generation: Number(grant.split(".").at(-1)) || 0,
      invalid_at: now(),
    },
  ];

  const deliver = async ({ endpoint_grant: grant, request_id, expires_at }) => {
    if (typeof grant !== "string" || typeof request_id !== "string")
      return [400, { error: "invalid delivery" }];
    const record = grants[grant];
    if (!record) return invalid(grant);
    const ttl = Math.min(MAX_WAKE_TTL, Number(expires_at) - now());
    if (!(ttl > 0)) return [200, { status: "accepted" }];
    try {
      // One collapsible topic: a phone back online gets one wake, not a burst.
      await send(
        { endpoint: record.endpoint, keys: record.keys },
        JSON.stringify({ v: 1 }),
        { TTL: ttl, urgency: "high", topic: "buzz-wake", timeout: 5000 },
      );
      return [200, { status: "accepted" }];
    } catch (error) {
      const status = error?.statusCode ?? 0;
      if ([400, 404, 410, 413].includes(status)) {
        delete grants[grant];
        await save();
        return invalid(grant);
      }
      console.warn(`push service ${status || "error"}: ${error?.message}`);
      const retryAfter = Number(error?.headers?.["retry-after"]);
      return [
        503,
        {
          status: "retry",
          retry_after_seconds: retryAfter > 0 ? retryAfter : 30,
        },
      ];
    }
  };

  const route = async (request, body) => {
    const { pathname } = new URL(request.url, "http://gateway");
    if (request.method === "GET" && pathname === "/healthz") return [200, {}];
    if (request.method === "GET" && pathname === "/webpush/config")
      return [200, { vapidPublicKey }];
    if (request.method !== "POST") return [404, {}];
    let json;
    try {
      json = JSON.parse(body.toString() || "{}");
    } catch {
      return [400, { error: "invalid json" }];
    }
    const auth = request.headers.authorization;
    if (pathname === "/v1/deliveries/apns") {
      if (authenticate(auth, deliveryUrl, body) !== relayPubkey)
        return [401, { error: "unauthorized" }];
      // The relay may retry a request; answer it the same way once.
      const cached = deliveries.get(json.request_id);
      if (cached) return cached;
      const response = await deliver(json);
      deliveries.set(json.request_id, response);
      if (deliveries.size > 5000)
        deliveries.delete(deliveries.keys().next().value);
      return response;
    }
    if (pathname === "/webpush/register" || pathname === "/webpush/unregister") {
      const pubkey = authenticate(auth, `${publicOrigin}${pathname}`, body);
      if (!pubkey) return [401, { error: "unauthorized" }];
      return pathname === "/webpush/register"
        ? register(pubkey, json)
        : unregister(pubkey, json);
    }
    return [404, {}];
  };

  const handler = (request, response) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) request.destroy();
      else chunks.push(chunk);
    });
    request.on("end", async () => {
      let status = 500;
      let payload = { error: "internal error" };
      try {
        [status, payload] = await route(request, Buffer.concat(chunks));
      } catch (error) {
        console.error(error);
      }
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  };

  return { load, handler, grants: () => grants };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = (name) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  // BUZZ_DOMAIN is a bare host in production and a full origin in staging.
  const domain = env("WEBPUSH_PUBLIC_ORIGIN");
  const publicOrigin = /^https?:\/\//.test(domain) ? domain : `https://${domain}`;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ||
      (publicOrigin.startsWith("https:") ? publicOrigin : "mailto:push@localhost"),
    env("VAPID_PUBLIC_KEY"),
    env("VAPID_PRIVATE_KEY"),
  );
  const gateway = createGateway({
    relayPubkey: env("BUZZ_RELAY_PUBKEY"),
    deliveryUrl: env("WEBPUSH_DELIVERY_URL"),
    publicOrigin,
    storePath: process.env.WEBPUSH_STORE || "/data/subscriptions.json",
    vapidPublicKey: env("VAPID_PUBLIC_KEY"),
    allowedHosts: process.env.WEBPUSH_ALLOWED_HOSTS
      ? process.env.WEBPUSH_ALLOWED_HOSTS.split(",")
      : PUSH_HOSTS,
  });
  await gateway.load();
  createServer(gateway.handler).listen(Number(process.env.PORT || 8080));
  console.log("buzz-webpush listening");
}
