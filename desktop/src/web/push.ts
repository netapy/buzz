// Background notifications for the browser build. The relay keeps a push
// lease (NIP-PL, kind 30350) for this browser and, when a mention, DM or
// reply to the user arrives, wakes it through our Web Push gateway
// (deploy/compose/webpush). The service worker then fetches the message and
// shows it, so no content transits Apple or Google.

import { getPublicKey, nip44 } from "nostr-tools";

import { chatCommands } from "./chat";
import {
  getSecretKey,
  readPushContext,
  relayHttpUrl,
  relayRequest,
  signEvent,
  submitEvent,
  writePushContext,
} from "./core";

const LEASE_KIND = 30350;
const LEASE_TTL_SECONDS = 29 * 24 * 60 * 60;
// Renewing daily keeps the lease far from expiry and its DM list current.
const RESYNC_MS = 24 * 60 * 60 * 1000;
// Same policy as Buzz mobile: skip "hellthreads" tagging many people.
const P_TAGS_MAX = 20;
const H_PER_FILTER = 50;
const MAX_SUBSCRIPTIONS = 16;

type Descriptor = {
  origin: string;
  keys: Array<{ id: string; pubkey: string; current?: boolean }>;
  app_profiles: Array<{ id: string; transport: string }>;
  push_kinds: number[];
};
type LeaseState = {
  installation: string;
  generation: number;
  fingerprint: string;
  syncedAt: number;
  active: boolean;
};
type Channel = { id: string; name: string; channel_type: string };
type Filter = Record<string, unknown>;
type Subscription = {
  filter: Filter;
  class: string;
  ignore: Filter[];
  suppress: { p_tags_max: number };
};

const stateKey = (pubkey: string) => `buzz-web-push:${pubkey}`;

function readState(pubkey: string): LeaseState | null {
  try {
    return JSON.parse(localStorage.getItem(stateKey(pubkey)) ?? "null");
  } catch {
    return null;
  }
}

async function fetchDescriptor(): Promise<Descriptor | null> {
  const response = await fetch(relayHttpUrl(), {
    headers: { Accept: "application/nostr+json" },
  });
  return response.ok ? ((await response.json()).push ?? null) : null;
}

// Mentions (which also reach DMs and replies, since those p-tag the people
// they address) plus every joined DM, never the user's own messages.
export function leaseSubscriptions(
  me: string,
  dmChannelIds: string[],
  kinds: number[],
) {
  const ignore = [{ kinds, authors: [me] }];
  const suppress = { p_tags_max: P_TAGS_MAX };
  const subscriptions: Subscription[] = [
    { filter: { kinds, "#p": [me] }, class: "default", ignore, suppress },
  ];
  for (let index = 0; index < dmChannelIds.length; index += H_PER_FILTER)
    subscriptions.push({
      filter: {
        kinds: [9],
        "#h": dmChannelIds.slice(index, index + H_PER_FILTER),
      },
      class: "default",
      ignore,
      suppress,
    });
  return subscriptions.slice(0, MAX_SUBSCRIPTIONS);
}

async function publishLease(
  key: Uint8Array,
  push: Descriptor,
  installation: string,
  plaintext: Record<string, unknown>,
) {
  const executor = push.keys.find((entry) => entry.current) ?? push.keys[0];
  const content = nip44.v2.encrypt(
    JSON.stringify({ v: 1, origin: push.origin, ...plaintext }),
    nip44.v2.utils.getConversationKey(key, executor.pubkey),
  );
  await submitEvent(
    signEvent(LEASE_KIND, content, [
      ["d", installation],
      ["expiration", String(Math.floor(Date.now() / 1000) + LEASE_TTL_SECONDS)],
      ["exec", executor.id],
      ["alt", "Push lease"],
    ]),
  );
}

function sameKey(subscription: PushSubscription, vapidPublicKey: string) {
  const key = subscription.options.applicationServerKey;
  if (!key) return false;
  const encoded = btoa(String.fromCharCode(...new Uint8Array(key)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return encoded === vapidPublicKey;
}

/**
 * Keep this browser's push lease in step with the notification setting:
 * subscribe and lease while notifications are on and allowed, revoke when
 * they are not. Cheap when nothing changed; safe to call on every start.
 */
export async function syncPushLease(enabled: boolean): Promise<void> {
  const key = getSecretKey();
  if (!key || !("serviceWorker" in navigator) || !("PushManager" in window))
    return;
  const me = getPublicKey(key);
  const state = readState(me);
  const wanted = enabled && Notification.permission === "granted";
  if (!wanted && !state?.active) return;
  const push = await fetchDescriptor();
  if (!push) return;
  const registration = await navigator.serviceWorker.ready;
  const generation = Math.max(Date.now(), (state?.generation ?? 0) + 1);
  const installation =
    state?.installation ??
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  const save = (next: Partial<LeaseState>) =>
    localStorage.setItem(
      stateKey(me),
      JSON.stringify({ ...state, installation, generation, ...next }),
    );

  if (!wanted) {
    await publishLease(key, push, installation, { generation, active: false });
    save({ active: false, fingerprint: "", syncedAt: Date.now() });
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await relayRequest("/webpush/unregister", {
        endpoint: subscription.endpoint,
      }).catch(() => {});
      await subscription.unsubscribe();
    }
    return;
  }

  const { vapidPublicKey } = await (await fetch("/webpush/config")).json();
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription, vapidPublicKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidPublicKey,
  });
  const { channels } = (await chatCommands.get_channels({})) as {
    channels: Channel[];
  };
  const dms = channels
    .filter((channel) => channel.channel_type === "dm")
    .map((channel) => channel.id)
    .sort();
  const subscriptions = leaseSubscriptions(me, dms, push.push_kinds);
  const previous = await readPushContext();
  await writePushContext({
    // Notify only about messages from the moment notifications came on.
    lastSeen: Math.floor(Date.now() / 1000),
    ...previous,
    id: "current",
    pubkey: me,
    relay: relayHttpUrl(),
    filters: subscriptions.map((entry) => entry.filter),
    channels: Object.fromEntries(
      channels.map((channel) => [
        channel.id,
        { name: channel.name, dm: channel.channel_type === "dm" },
      ]),
    ),
  });
  const fingerprint = JSON.stringify([subscription.endpoint, subscriptions]);
  if (
    state?.active &&
    state.fingerprint === fingerprint &&
    Date.now() - state.syncedAt < RESYNC_MS
  )
    return;
  const { endpoint_grant } = await relayRequest<{ endpoint_grant: string }>(
    "/webpush/register",
    { subscription: subscription.toJSON(), generation },
  );
  const [profile] = push.app_profiles;
  await publishLease(key, push, installation, {
    app_profile: profile.id,
    transport: profile.transport,
    endpoint: endpoint_grant,
    generation,
    active: true,
    subscriptions,
  });
  save({ active: true, fingerprint, syncedAt: Date.now() });
}
