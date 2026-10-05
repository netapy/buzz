import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  nip44,
} from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";

import {
  type CommandTable,
  type RelayEvent,
  encoder,
  relayHttpUrl,
  relayWsUrl,
  requireSecretKey,
  saveIdentity,
  setIdentity,
} from "./core";
import { emitWebEvent } from "./events";

const KIND = 24134;
const SUB = "pair";
// The pair relay closes every connection after 120 s; expire just before it.
const SESSION_MS = 115_000;
const MAX_SKEW_S = 180;
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const ABORT_REASONS: Record<string, string> = {
  sas_mismatch: "SasMismatch",
  user_denied: "UserDenied",
  timeout: "Timeout",
  protocol_error: "ProtocolError",
};

type Message = Record<string, unknown> & { type: string };

type Session = {
  priv: Uint8Array;
  pub: string;
  secret: Uint8Array;
  id: Uint8Array;
  peer: string | null;
  sasInput: Uint8Array | null;
  state: "waiting" | "confirming" | "awaiting" | "transferring" | "exchanged";
  seen: Set<string>;
  sent: Set<string>;
  socket: WebSocket | null;
  timer: ReturnType<typeof setTimeout>;
  stopped: boolean;
  payload: string | null;
  fail: (message: string) => void;
};

const now = () => Math.floor(Date.now() / 1000);

const hkdf32 = (ikm: Uint8Array, salt: Uint8Array, info: string) =>
  hkdf(sha256, ikm, salt, encoder.encode(info), 32);

export const deriveSessionId = (secret: Uint8Array) =>
  hkdf32(secret, new Uint8Array(), "nostr-pair-session-id");

// NIP-AB uses the raw x-coordinate, not the SHA-256-hashed ECDH output.
export const ecdh = (priv: Uint8Array, pub: string) =>
  secp256k1.getSharedSecret(priv, hexToBytes(`02${pub}`)).slice(1, 33);

export function deriveSas(shared: Uint8Array, secret: Uint8Array) {
  const input = hkdf32(shared, secret, "nostr-pair-sas-v1");
  const code = new DataView(input.buffer, input.byteOffset).getUint32(0);
  return { input, sas: String(code % 1_000_000).padStart(6, "0") };
}

export const transcriptHash = (
  id: Uint8Array,
  source: string,
  target: string,
  sasInput: Uint8Array,
  secret: Uint8Array,
) =>
  hkdf32(
    concatBytes(id, hexToBytes(source), hexToBytes(target), sasInput),
    secret,
    "nostr-pair-transcript-v1",
  );

function hexEqual(value: unknown, expected: Uint8Array) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) return false;
  const bytes = hexToBytes(value);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= bytes[i] ^ expected[i];
  return diff === 0;
}

export function buildPairingUri(
  pub: string,
  secret: Uint8Array,
  relay: string,
  recover = false,
) {
  return `nostrpair://${pub}?secret=${bytesToHex(secret)}&relay=${encodeURIComponent(relay)}&v=1${recover ? "&mode=recover" : ""}`;
}

export function parsePairingUri(uri: string) {
  const match = /^nostrpair:\/\/([0-9a-f]{64})\?(.*)$/s.exec(uri);
  if (uri.length > 2048 || !match) throw new Error("Invalid pairing code.");
  let secret = "";
  let version = "1";
  let mode = "";
  const relays: string[] = [];
  try {
    for (const pair of match[2].split("&")) {
      const split = pair.indexOf("=");
      if (split < 0) continue;
      const value = pair.slice(split + 1);
      const key = pair.slice(0, split);
      if (key === "secret") secret = value;
      else if (key === "relay") relays.push(decodeURIComponent(value));
      else if (key === "v") version = value;
      else if (key === "mode") mode = value;
    }
    secp256k1.Point.fromHex(`02${match[1]}`);
    if (
      !/^[0-9a-f]{64}$/.test(secret) ||
      /^0+$/.test(secret) ||
      relays.length === 0 ||
      relays.some((relay) => {
        const url = new URL(relay);
        return !["ws:", "wss:"].includes(url.protocol) || !url.hostname;
      })
    )
      throw new Error();
  } catch {
    throw new Error("Invalid pairing code.");
  }
  if (version !== "1")
    throw new Error(
      "This pairing code requires a newer version of Buzz. Please update.",
    );
  return {
    pubkey: match[1],
    secret: hexToBytes(secret),
    relays,
    recover: mode === "recover",
  };
}

// Validates an inbound kind:24134 event per NIP-AB §Event Validation and
// returns its decrypted message, or null when it must be silently dropped.
export function openEvent(
  session: Pick<Session, "priv" | "pub" | "peer" | "seen">,
  raw: unknown,
): { event: RelayEvent; message: Message } | null {
  const event = raw as RelayEvent;
  try {
    if (
      !verifyEvent(event) ||
      event.kind !== KIND ||
      session.seen.has(event.id) ||
      !event.tags.some(
        ([name, value]) => name === "p" && value === session.pub,
      ) ||
      (session.peer !== null && event.pubkey !== session.peer) ||
      Math.abs(now() - event.created_at) > MAX_SKEW_S ||
      event.content.length < 132 ||
      event.content.length > 87_472
    )
      return null;
    const message = JSON.parse(
      nip44.decrypt(
        event.content,
        nip44.getConversationKey(session.priv, event.pubkey),
      ),
    );
    return typeof message?.type === "string" ? { event, message } : null;
  } catch {
    return null;
  }
}

function newSession(secret: Uint8Array, fail: (message: string) => void) {
  const priv = generateSecretKey();
  const session: Session = {
    priv,
    pub: getPublicKey(priv),
    secret,
    id: deriveSessionId(secret),
    peer: null,
    sasInput: null,
    state: "waiting",
    seen: new Set(),
    sent: new Set(),
    socket: null,
    timer: setTimeout(() => {
      abort(session, "timeout");
      session.fail("Session timed out");
    }, SESSION_MS),
    stopped: false,
    payload: null,
    fail,
  };
  return session;
}

function stop(session: Session) {
  session.stopped = true;
  clearTimeout(session.timer);
  session.socket?.close();
  session.priv.fill(0);
  session.secret.fill(0);
  session.sasInput?.fill(0);
  session.payload = null;
  if (active === session) active = null;
}

function send(session: Session, message: Message) {
  if (session.stopped || session.socket?.readyState !== WebSocket.OPEN)
    throw new Error("Pairing code expired. Create a new code and try again.");
  const peer = session.peer as string;
  const jitter = crypto.getRandomValues(new Uint8Array(1))[0] % 31;
  const event = finalizeEvent(
    {
      kind: KIND,
      content: nip44.encrypt(
        JSON.stringify(message),
        nip44.getConversationKey(session.priv, peer),
      ),
      tags: [["p", peer]],
      created_at: now() - jitter,
    },
    session.priv,
  );
  session.sent.add(event.id);
  session.socket.send(JSON.stringify(["EVENT", event]));
}

function abort(session: Session, reason: string) {
  if (session.state === "waiting") return;
  try {
    send(session, { type: "abort", reason });
  } catch {
    // Best effort: the session ends either way.
  }
}

function complete(session: Session, success: boolean) {
  try {
    send(session, { type: "complete", success });
  } catch {
    // `complete` is advisory (NIP-AB §Step 5).
  }
}

function connect(
  session: Session,
  url: string,
  onEvent: (raw: unknown) => Promise<void>,
) {
  return new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    session.socket = socket;
    let ready = false;
    let subscribed = false;
    let authId: string | null = null;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => fail("timeout waiting for EOSE"), 15_000);
    const fail = (message: string) => {
      clearTimeout(grace);
      clearTimeout(deadline);
      if (ready) {
        if (!session.stopped) session.fail(message);
        return;
      }
      const cancelled = session.stopped;
      stop(session);
      reject(new Error(cancelled ? "Pairing was cancelled." : message));
    };
    const subscribe = () => {
      clearTimeout(grace);
      if (subscribed || session.stopped) return;
      subscribed = true;
      socket.send(
        JSON.stringify(["REQ", SUB, { kinds: [KIND], "#p": [session.pub] }]),
      );
    };
    // Like the native client, give NIP-42 relays 3 s to challenge before REQ.
    socket.onopen = () => {
      grace = setTimeout(subscribe, 3_000);
    };
    socket.onclose = () => fail("relay connection closed");
    socket.onmessage = ({ data }) => {
      if (session.stopped) return;
      let frame: unknown[];
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!Array.isArray(frame)) return;
      const [type, a, b, c] = frame;
      if (type === "AUTH" && typeof a === "string" && !subscribed && !authId) {
        const auth = finalizeEvent(
          {
            kind: 22242,
            content: "",
            tags: [
              ["relay", url],
              ["challenge", a],
            ],
            created_at: now(),
          },
          session.priv,
        );
        authId = auth.id;
        clearTimeout(grace);
        grace = setTimeout(subscribe, 5_000);
        socket.send(JSON.stringify(["AUTH", auth]));
      } else if (type === "OK" && a === authId) {
        subscribe();
      } else if (type === "OK" && b === false && session.sent.has(String(a))) {
        fail(`Pairing relay rejected the message: ${c}`);
      } else if (type === "CLOSED" && a === SUB) {
        fail(`Pairing relay closed the subscription: ${b}`);
      } else if (type === "EOSE" && a === SUB && !ready) {
        ready = true;
        clearTimeout(deadline);
        resolve();
      } else if (type === "EVENT" && a === SUB && ready) {
        onEvent(b).catch((error) =>
          session.fail(error instanceof Error ? error.message : String(error)),
        );
      }
    };
  });
}

async function pairingRelayUrl() {
  const main = relayWsUrl();
  try {
    const response = await fetch(main.replace(/^ws/, "http"), {
      headers: { Accept: "application/nostr+json" },
      signal: AbortSignal.timeout(5_000),
    });
    const info = await response.json();
    const configured = info.pairing_relay_url;
    if (typeof configured === "string" && URL.canParse(configured)) {
      const url = new URL(configured);
      if (["ws:", "wss:"].includes(url.protocol) && url.hostname)
        return configured;
    }
    if (info.supported_nips?.includes?.(43)) {
      const url = new URL(main);
      url.pathname = `${url.pathname.replace(/\/$/, "")}/pair`;
      return url.toString();
    }
  } catch {
    // Fall back to the main relay like the native client.
  }
  return main;
}

function decodeNsec(value: unknown) {
  try {
    const decoded = nip19.decode(String(value).trim());
    if (decoded.type === "nsec") return decoded.data;
  } catch {
    // Reported by the caller.
  }
  return null;
}

// The pasted code chooses the relay, so only accept an identity for the
// server this page is bound to.
export function desktopIdentity(message: Record<string, unknown>) {
  let data: Record<string, unknown> | null = null;
  try {
    if (message.payload_type === "custom")
      data = JSON.parse(String(message.payload));
  } catch {
    // Reported below.
  }
  if (typeof data?.relayUrl !== "string")
    throw new Error("Buzz desktop sent an unsupported pairing payload.");
  if (
    !URL.canParse(data.relayUrl) ||
    new URL(data.relayUrl).origin !== new URL(relayHttpUrl()).origin
  )
    throw new Error("This pairing code belongs to a different Buzz server.");
  const key = decodeNsec(data.nsec);
  if (!key || getPublicKey(key) !== data.pubkey)
    throw new Error("Buzz desktop sent an invalid identity.");
  return key;
}

let active: Session | null = null;

function finish(session: Session, event: string, payload: unknown) {
  if (active === session) emitWebEvent(event, payload);
  stop(session);
}

async function onSourceEvent(session: Session, recover: boolean, raw: unknown) {
  const opened = openEvent(session, raw);
  if (!opened) return;
  const { event, message } = opened;
  if (message.type === "abort") {
    if (session.peer === null || typeof message.reason !== "string") return;
    session.seen.add(event.id);
    finish(session, "pairing-aborted", {
      reason: Object.hasOwn(ABORT_REASONS, message.reason)
        ? ABORT_REASONS[message.reason]
        : "Unknown",
    });
  } else if (message.type === "offer" && session.state === "waiting") {
    if (
      (message.version ?? 1) !== 1 ||
      !hexEqual(message.session_id, session.id)
    )
      return;
    session.peer = event.pubkey;
    const shared = ecdh(session.priv, event.pubkey);
    const { input, sas } = deriveSas(shared, session.secret);
    shared.fill(0);
    session.sasInput = input;
    session.state = "confirming";
    session.seen.add(event.id);
    emitWebEvent("pairing-sas-received", { sas });
  } else if (
    message.type === "complete" &&
    !recover &&
    session.state === "exchanged" &&
    typeof message.success === "boolean"
  ) {
    if (!message.success)
      return finish(session, "pairing-error", {
        message: "Mobile device reported failure importing credentials",
      });
    session.seen.add(event.id);
    finish(session, "pairing-complete", {});
  } else if (
    message.type === "payload" &&
    recover &&
    session.state === "transferring" &&
    typeof message.payload_type === "string" &&
    typeof message.payload === "string"
  ) {
    session.state = "exchanged";
    session.seen.add(event.id);
    const nsec = message.payload_type === "nsec";
    const key = nsec ? decodeNsec(message.payload) : null;
    try {
      if (!key)
        throw new Error(
          nsec
            ? "Phone sent an invalid identity."
            : "Mobile device sent an unsupported recovery payload",
        );
      await saveIdentity(key);
    } catch (error) {
      complete(session, false);
      return finish(session, "pairing-error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    setIdentity(key);
    complete(session, true);
    finish(session, "pairing-complete", {});
  }
}

async function startSource(recover: boolean) {
  if (active) stop(active);
  const key = recover ? null : requireSecretKey();
  const session = newSession(
    crypto.getRandomValues(new Uint8Array(32)),
    (message) => finish(session, "pairing-error", { message }),
  );
  if (key)
    session.payload = JSON.stringify({
      relayUrl: relayHttpUrl(),
      pubkey: getPublicKey(key),
      nsec: nip19.nsecEncode(key),
    });
  active = session;
  const relay = await pairingRelayUrl();
  if (session.stopped) throw new Error("Pairing was cancelled.");
  const uri = buildPairingUri(session.pub, session.secret, relay, recover);
  await connect(session, relay, (raw) => onSourceEvent(session, recover, raw));
  return uri;
}

export const pairingCommands: CommandTable = {
  start_pairing: () => startSource(false),
  start_identity_recovery_pairing: () => startSource(true),
  confirm_pairing_sas: () => {
    const session = active;
    if (session?.state !== "confirming" || !session.peer)
      throw new Error("no active pairing session");
    send(session, {
      type: "sas-confirm",
      transcript_hash: bytesToHex(
        transcriptHash(
          session.id,
          session.pub,
          session.peer,
          session.sasInput as Uint8Array,
          session.secret,
        ),
      ),
    });
    session.state = "transferring";
    if (session.payload) {
      send(session, {
        type: "payload",
        payload_type: "custom",
        payload: session.payload,
      });
      session.payload = null;
      session.state = "exchanged";
    }
  },
  cancel_pairing: () => {
    if (!active) return;
    abort(active, "user_denied");
    stop(active);
  },
};

// Target role: receive this desktop's identity from a pairing code copied in
// Buzz desktop (Settings → Mobile). The code is user-pasted, so its relay and
// payload are untrusted until the SAS is confirmed and the payload checked.
export function startDesktopPairingTarget(
  code: string,
  callbacks: {
    onSas: (sas: string) => void;
    onComplete: (pubkey: string) => void;
    onError: (message: string) => void;
  },
) {
  const qr = parsePairingUri(code.trim());
  if (qr.recover)
    throw new Error(
      "This code requests an identity instead of sending one. Copy the pairing code from Settings → Mobile in Buzz desktop.",
    );
  const relay = new URL(qr.relays[0]);
  if (
    relay.protocol !== "wss:" &&
    !(
      relay.protocol === "ws:" &&
      (LOCAL_HOSTS.includes(relay.hostname) || location.protocol === "http:")
    )
  )
    throw new Error("This pairing code uses an insecure relay.");

  let confirmed = false;
  let cancelled = false;
  let pending: unknown = null;
  const session = newSession(qr.secret, (message) => {
    if (session.stopped) return;
    stop(session);
    callbacks.onError(message);
  });
  session.peer = qr.pubkey;
  const shared = ecdh(session.priv, qr.pubkey);
  const { input, sas } = deriveSas(shared, qr.secret);
  shared.fill(0);
  session.sasInput = input;

  const importPayload = async (message: Message) => {
    let key: Uint8Array;
    try {
      key = desktopIdentity(message);
      await saveIdentity(key);
    } catch (error) {
      complete(session, false);
      return session.fail(
        error instanceof Error ? error.message : String(error),
      );
    }
    setIdentity(key);
    complete(session, true);
    stop(session);
    callbacks.onComplete(getPublicKey(key));
  };

  const onEvent = async (raw: unknown): Promise<void> => {
    const opened = openEvent(session, raw);
    if (!opened) return;
    const { event, message } = opened;
    if (message.type === "abort" && typeof message.reason === "string") {
      session.seen.add(event.id);
      session.fail(`Pairing stopped: ${message.reason}`);
    } else if (
      message.type === "sas-confirm" &&
      session.state === "confirming"
    ) {
      if (
        !hexEqual(
          message.transcript_hash,
          transcriptHash(
            session.id,
            qr.pubkey,
            session.pub,
            input,
            session.secret,
          ),
        )
      ) {
        abort(session, "sas_mismatch");
        return session.fail(
          "Security verification failed. Pairing was canceled.",
        );
      }
      session.seen.add(event.id);
      session.state = confirmed ? "transferring" : "awaiting";
    } else if (message.type === "payload" && session.state === "awaiting") {
      // Dual consent: keep the event opaque until the user confirms the SAS.
      pending = raw;
    } else if (message.type === "payload" && session.state === "transferring") {
      session.seen.add(event.id);
      session.state = "exchanged";
      await importPayload(message);
    }
  };

  connect(session, qr.relays[0], onEvent)
    .then(() => {
      send(session, {
        type: "offer",
        version: 1,
        session_id: bytesToHex(session.id),
      });
      session.state = "confirming";
      callbacks.onSas(sas);
    })
    .catch((error: Error) => {
      stop(session);
      if (!cancelled) callbacks.onError(error.message);
    });

  return {
    confirm() {
      if (session.stopped || confirmed) return;
      confirmed = true;
      if (session.state !== "awaiting") return;
      session.state = "transferring";
      if (pending) {
        const event = pending;
        pending = null;
        onEvent(event).catch((error) => session.fail(String(error)));
      }
    },
    cancel() {
      cancelled = true;
      if (session.stopped) return;
      abort(session, "user_denied");
      stop(session);
    },
  };
}
