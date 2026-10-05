import assert from "node:assert/strict";
import test from "node:test";

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  nip44,
} from "nostr-tools";

globalThis.location = new URL("http://localhost:8080/");
globalThis.fetch = async () => ({
  json: async () => ({ pairing_relay_url: "ws://localhost:8080/pair" }),
});

// Minimal IndexedDB for the identity vault.
const vault = new Map();
globalThis.indexedDB = {
  open() {
    const request = {};
    const store = (transaction) => ({
      put(value) {
        const result = {};
        queueMicrotask(() => {
          vault.set(value.id, value);
          result.onsuccess?.();
          transaction.oncomplete?.();
        });
        return result;
      },
    });
    queueMicrotask(() => {
      request.result = {
        close() {},
        transaction() {
          const transaction = {};
          transaction.objectStore = () => store(transaction);
          return transaction;
        },
      };
      request.onsuccess();
    });
    return request;
  },
};

// Scripted relay: answers AUTH/REQ/EVENT like the pair relay.
const sockets = [];
globalThis.WebSocket = class {
  static OPEN = 1;
  readyState = 0;
  frames = [];
  constructor(url) {
    this.url = url;
    sockets.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
      this.receive(["AUTH", "challenge"]);
    });
  }
  receive(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  send(data) {
    const frame = JSON.parse(data);
    this.frames.push(frame);
    if (frame[0] === "AUTH") this.receive(["OK", frame[1].id, true, ""]);
    if (frame[0] === "REQ") this.receive(["EOSE", frame[1]]);
  }
  close() {
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.());
  }
  events() {
    return this.frames.filter((frame) => frame[0] === "EVENT").map((f) => f[1]);
  }
};

const {
  buildPairingUri,
  deriveSas,
  deriveSessionId,
  desktopIdentity,
  ecdh,
  openEvent,
  pairingCommands,
  parsePairingUri,
  startDesktopPairingTarget,
  transcriptHash,
} = await import("./pairing.ts");
const { getSecretKey, setIdentity } = await import("./core.ts");
const { listen } = await import("./events.ts");

const now = () => Math.floor(Date.now() / 1000);
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function pairingEvent(priv, to, message, overrides = {}) {
  return finalizeEvent(
    {
      kind: 24134,
      content: nip44.encrypt(
        JSON.stringify(message),
        nip44.getConversationKey(priv, to),
      ),
      tags: [["p", to]],
      created_at: now(),
      ...overrides,
    },
    priv,
  );
}

function decrypt(priv, event) {
  return JSON.parse(
    nip44.decrypt(event.content, nip44.getConversationKey(priv, event.pubkey)),
  );
}

function recordEvents() {
  const seen = [];
  for (const name of [
    "pairing-sas-received",
    "pairing-complete",
    "pairing-aborted",
    "pairing-error",
  ])
    listen(name, ({ payload }) => seen.push([name, payload]));
  return seen;
}

test("matches the NIP-AB test vectors", () => {
  const secret = hexToBytes(
    "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
  );
  const sourcePriv = hexToBytes(
    "7f4c11a9c9d1e3b5a7f2e4d6c8b0a2f4e6d8c0b2a4f6e8d0c2b4a6f8e0d2c4b5",
  );
  const targetPriv = hexToBytes(
    "3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b",
  );
  const source = getPublicKey(sourcePriv);
  const target = getPublicKey(targetPriv);
  assert.equal(
    source,
    "199e64ca60662cb2d6e91d16cb065be51ad74a6ee5f8c5b0fdc53d246611ed9a",
  );
  assert.equal(
    target,
    "89a9fa762105d0aee2b19678246fe7b823aabbc4f4bf691a1ce8a70fcd36d6e4",
  );
  const id = deriveSessionId(secret);
  assert.equal(
    bytesToHex(id),
    "fb357d0f8e8d5a5ba3b2a91cb18c119e1567b07ffa38cdebb73e68df78f5a380",
  );
  const shared = ecdh(sourcePriv, target);
  assert.equal(
    bytesToHex(shared),
    "9b4b6d6990713d89d6d9982e506ee1bbcde6f05c54d9d2978696e8a7274d4408",
  );
  assert.deepEqual(ecdh(targetPriv, source), shared);
  const { input, sas } = deriveSas(shared, secret);
  assert.equal(
    bytesToHex(input),
    "e8b03a329f3a0ac37fe7fbe929171e14b72812be67e33c5d6e193543c41798d3",
  );
  assert.equal(sas, "863346");
  assert.equal(
    bytesToHex(transcriptHash(id, source, target, input, secret)),
    "d662818ff8911fc60a2d025f8b8b4756107104e85888dd202d28db5ca2cf28d3",
  );
});

test("builds and parses pairing URIs", () => {
  const pub = getPublicKey(generateSecretKey());
  const secret = hexToBytes("11".repeat(32));
  const uri = buildPairingUri(pub, secret, "ws://localhost:8080/pair");
  assert.equal(
    uri,
    `nostrpair://${pub}?secret=${"11".repeat(32)}&relay=ws%3A%2F%2Flocalhost%3A8080%2Fpair&v=1`,
  );
  const parsed = parsePairingUri(uri);
  assert.equal(parsed.pubkey, pub);
  assert.deepEqual(parsed.secret, secret);
  assert.deepEqual(parsed.relays, ["ws://localhost:8080/pair"]);
  assert.equal(parsed.recover, false);
  assert.equal(
    parsePairingUri(buildPairingUri(pub, secret, "wss://x.test/pair", true))
      .recover,
    true,
  );
  assert.equal(parsePairingUri(uri.replace("&v=1", "&foo=bar")).recover, false);

  const relay = "&relay=wss%3A%2F%2Fx.test";
  for (const bad of [
    uri.replace(pub, pub.toUpperCase()),
    uri.replace(pub, "ff".repeat(32)),
    `nostrpair://${pub}?secret=${"11".repeat(31)}${relay}`,
    `nostrpair://${pub}?secret=${"00".repeat(32)}${relay}`,
    `nostrpair://${pub}?secret=${"11".repeat(32)}`,
    `nostrpair://${pub}?secret=${"11".repeat(32)}&relay=https%3A%2F%2Fx.test`,
    `nostrpair://${pub}?secret=${"11".repeat(32)}&relay=%E0%A4%A`,
    `${uri}&pad=${"x".repeat(2048)}`,
    `nostr://${pub}?secret=${"11".repeat(32)}${relay}`,
  ])
    assert.throws(() => parsePairingUri(bad), /Invalid pairing code/);
  assert.throws(
    () => parsePairingUri(uri.replace("v=1", "v=2")),
    /newer version/,
  );
});

test("drops events that fail NIP-AB validation", () => {
  const priv = generateSecretKey();
  const peerPriv = generateSecretKey();
  const session = {
    priv,
    pub: getPublicKey(priv),
    peer: getPublicKey(peerPriv),
    seen: new Set(),
  };
  const message = { type: "sas-confirm", transcript_hash: "00".repeat(32) };
  const good = pairingEvent(peerPriv, session.pub, message);
  assert.deepEqual(openEvent(session, structuredClone(good)).message, message);

  const badSig = { ...good, sig: `${good.sig.slice(0, -2)}00` };
  const badId = { ...good, content: good.content.replace(/^A/, "B") };
  const stranger = generateSecretKey();
  const cases = [
    badSig,
    badId,
    pairingEvent(peerPriv, getPublicKey(stranger), message),
    pairingEvent(stranger, session.pub, message),
    pairingEvent(peerPriv, session.pub, message, { kind: 24133 }),
    pairingEvent(peerPriv, session.pub, message, { created_at: now() - 600 }),
    pairingEvent(peerPriv, session.pub, message, { content: "AgAA" }),
    "not an event",
  ];
  for (const event of cases) assert.equal(openEvent(session, event), null);

  session.seen.add(good.id);
  assert.equal(openEvent(session, structuredClone(good)), null);
});

test("only accepts a desktop identity for this server", () => {
  const key = generateSecretKey();
  const payload = (fields) => ({
    type: "payload",
    payload_type: "custom",
    payload: JSON.stringify({
      relayUrl: "http://localhost:8080",
      pubkey: getPublicKey(key),
      nsec: nip19.nsecEncode(key),
      ...fields,
    }),
  });
  assert.deepEqual(desktopIdentity(payload({})), key);
  assert.throws(
    () => desktopIdentity(payload({ relayUrl: "https://evil.test" })),
    /different Buzz server/,
  );
  assert.throws(
    () => desktopIdentity(payload({ relayUrl: "http://localhost:8081" })),
    /different Buzz server/,
  );
  assert.throws(
    () => desktopIdentity(payload({ pubkey: "00".repeat(32) })),
    /invalid identity/,
  );
  assert.throws(
    () => desktopIdentity({ ...payload({}), payload_type: "nsec" }),
    /unsupported/,
  );
});

test("target refuses recovery codes and insecure relays", () => {
  const pub = getPublicKey(generateSecretKey());
  const secret = hexToBytes("22".repeat(32));
  const callbacks = { onSas() {}, onComplete() {}, onError() {} };
  assert.throws(
    () =>
      startDesktopPairingTarget(
        buildPairingUri(pub, secret, "wss://x.test/pair", true),
        callbacks,
      ),
    /requests an identity/,
  );
  const page = globalThis.location;
  globalThis.location = new URL("https://chat.example/");
  try {
    assert.throws(
      () =>
        startDesktopPairingTarget(
          buildPairingUri(pub, secret, "ws://evil.test/pair"),
          callbacks,
        ),
      /insecure relay/,
    );
  } finally {
    globalThis.location = page;
  }
});

test("source recovery flow imports the phone's identity", async () => {
  const events = recordEvents();
  const uri = await pairingCommands.start_identity_recovery_pairing({});
  const qr = parsePairingUri(uri);
  assert.equal(qr.recover, true);
  assert.deepEqual(qr.relays, ["ws://localhost:8080/pair"]);
  const socket = sockets.at(-1);
  assert.equal(socket.url, "ws://localhost:8080/pair");
  const auth = socket.frames.find((frame) => frame[0] === "AUTH")[1];
  assert.deepEqual(auth.tags, [
    ["relay", "ws://localhost:8080/pair"],
    ["challenge", "challenge"],
  ]);

  const phone = generateSecretKey();
  const deliver = (event) => socket.receive(["EVENT", "pair", event]);
  const offer = (sessionId) =>
    pairingEvent(phone, qr.pubkey, {
      type: "offer",
      version: 1,
      session_id: bytesToHex(sessionId),
    });
  deliver(offer(deriveSessionId(hexToBytes("33".repeat(32)))));
  await tick();
  assert.deepEqual(events, []);

  deliver(offer(deriveSessionId(qr.secret)));
  await tick();
  const { input, sas } = deriveSas(ecdh(phone, qr.pubkey), qr.secret);
  assert.deepEqual(events, [["pairing-sas-received", { sas }]]);

  await pairingCommands.confirm_pairing_sas({});
  const [confirm] = socket.events();
  assert.deepEqual(decrypt(phone, confirm), {
    type: "sas-confirm",
    transcript_hash: bytesToHex(
      transcriptHash(
        deriveSessionId(qr.secret),
        qr.pubkey,
        getPublicKey(phone),
        input,
        qr.secret,
      ),
    ),
  });

  const identity = generateSecretKey();
  deliver(
    pairingEvent(phone, qr.pubkey, {
      type: "payload",
      payload_type: "nsec",
      payload: nip19.nsecEncode(identity),
    }),
  );
  await tick();
  assert.deepEqual(events.at(-1), ["pairing-complete", {}]);
  assert.deepEqual(getSecretKey(), identity);
  assert.equal(vault.get("current").pubkey, getPublicKey(identity));
  assert.deepEqual(decrypt(phone, socket.events().at(-1)), {
    type: "complete",
    success: true,
  });
  assert.equal(socket.readyState, 3);
  await pairingCommands.cancel_pairing({});
});

test("source send flow delivers the identity and handles aborts", async () => {
  const key = generateSecretKey();
  setIdentity(key);
  const events = recordEvents();
  const qr = parsePairingUri(await pairingCommands.start_pairing({}));
  assert.equal(qr.recover, false);
  const socket = sockets.at(-1);
  const phone = generateSecretKey();
  socket.receive([
    "EVENT",
    "pair",
    pairingEvent(phone, qr.pubkey, {
      type: "offer",
      session_id: bytesToHex(deriveSessionId(qr.secret)),
    }),
  ]);
  await pairingCommands.confirm_pairing_sas({});
  const [, payload] = socket.events().map((event) => decrypt(phone, event));
  assert.equal(payload.payload_type, "custom");
  assert.deepEqual(JSON.parse(payload.payload), {
    relayUrl: "http://localhost:8080",
    pubkey: getPublicKey(key),
    nsec: nip19.nsecEncode(key),
  });
  socket.receive([
    "EVENT",
    "pair",
    pairingEvent(phone, qr.pubkey, { type: "abort", reason: "user_denied" }),
  ]);
  await tick();
  assert.deepEqual(events.at(-1), [
    "pairing-aborted",
    { reason: "UserDenied" },
  ]);
  await pairingCommands.cancel_pairing({});
  await assert.rejects(
    async () => pairingCommands.confirm_pairing_sas({}),
    /no active pairing session/,
  );
});

async function startTarget() {
  const desktop = generateSecretKey();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const result = { errors: [], sas: null, done: null };
  const target = startDesktopPairingTarget(
    buildPairingUri(getPublicKey(desktop), secret, "ws://localhost:8080/pair"),
    {
      onSas: (sas) => (result.sas = sas),
      onComplete: (pubkey) => (result.done = pubkey),
      onError: (message) => result.errors.push(message),
    },
  );
  await tick();
  const socket = sockets.at(-1);
  const [offer] = socket.events();
  assert.deepEqual(decrypt(desktop, offer), {
    type: "offer",
    version: 1,
    session_id: bytesToHex(deriveSessionId(secret)),
  });
  const browser = offer.pubkey;
  const { input, sas } = deriveSas(ecdh(desktop, browser), secret);
  assert.equal(result.sas, sas);
  const transcript = transcriptHash(
    deriveSessionId(secret),
    getPublicKey(desktop),
    browser,
    input,
    secret,
  );
  const deliver = (message) =>
    socket.receive(["EVENT", "pair", pairingEvent(desktop, browser, message)]);
  return { target, socket, desktop, result, transcript, deliver };
}

test("target aborts on a transcript mismatch", async () => {
  const { socket, desktop, result, deliver } = await startTarget();
  deliver({ type: "sas-confirm", transcript_hash: "ab".repeat(32) });
  await tick();
  assert.deepEqual(result.errors, [
    "Security verification failed. Pairing was canceled.",
  ]);
  assert.deepEqual(decrypt(desktop, socket.events().at(-1)), {
    type: "abort",
    reason: "sas_mismatch",
  });
});

test("target waits for local confirmation, then rejects a foreign server", async () => {
  const before = getSecretKey();
  const { target, socket, desktop, result, transcript, deliver } =
    await startTarget();
  const key = generateSecretKey();
  deliver({ type: "sas-confirm", transcript_hash: bytesToHex(transcript) });
  deliver({
    type: "payload",
    payload_type: "custom",
    payload: JSON.stringify({
      relayUrl: "https://evil.test",
      pubkey: getPublicKey(key),
      nsec: nip19.nsecEncode(key),
    }),
  });
  await tick();
  assert.equal(socket.events().length, 1);
  assert.deepEqual(result.errors, []);
  target.confirm();
  await tick();
  assert.deepEqual(result.errors, [
    "This pairing code belongs to a different Buzz server.",
  ]);
  assert.deepEqual(decrypt(desktop, socket.events().at(-1)), {
    type: "complete",
    success: false,
  });
  assert.equal(getSecretKey(), before);
});

test("target imports a same-origin identity and cancel is quiet", async () => {
  const { socket, desktop, result, transcript, deliver, target } =
    await startTarget();
  target.confirm();
  const key = generateSecretKey();
  deliver({ type: "sas-confirm", transcript_hash: bytesToHex(transcript) });
  deliver({
    type: "payload",
    payload_type: "custom",
    payload: JSON.stringify({
      relayUrl: "http://localhost:8080",
      pubkey: getPublicKey(key),
      nsec: nip19.nsecEncode(key),
    }),
  });
  await tick();
  assert.equal(result.done, getPublicKey(key));
  assert.deepEqual(getSecretKey(), key);
  assert.deepEqual(decrypt(desktop, socket.events().at(-1)), {
    type: "complete",
    success: true,
  });

  const other = await startTarget();
  other.target.cancel();
  other.target.cancel();
  await tick();
  assert.deepEqual(other.result.errors, []);
  assert.deepEqual(decrypt(other.desktop, other.socket.events().at(-1)), {
    type: "abort",
    reason: "user_denied",
  });
});
