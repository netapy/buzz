import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

import { hexToBytes } from "@noble/hashes/utils.js";
import { getPublicKey, nip19 } from "nostr-tools";

// Vite serves `?raw` imports as strings; give node the same behavior.
register(
  `data:text/javascript,${encodeURIComponent(`
    import { readFileSync } from "node:fs";
    export async function load(url, context, next) {
      if (!url.endsWith("?raw")) return next(url, context);
      const text = readFileSync(new URL(url.slice(0, -4)), "utf8");
      return { format: "module", shortCircuit: true, source: "export default " + JSON.stringify(text) };
    }`)}`,
);

globalThis.location = new URL("https://buzz.test/");
const { getSecretKey, setIdentity } = await import("./core.ts");
const { backupCommands, createBackup, generatePassphrase } = await import(
  "./backup.ts"
);

const WORDS = new Set(
  readFileSync(
    new URL(
      "../../src-tauri/src/assets/eff_short_wordlist_2_0.txt",
      import.meta.url,
    ),
    "utf8",
  )
    .split("\n")
    .filter(Boolean),
);

// NIP-49 spec vector (log_n 16, key security 0x00).
const SPEC_NCRYPTSEC =
  "ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p";
const SPEC_SECRET =
  "3501454135014541350145413501453fefb02227e449e57cf4d3a3ce05378683";
const SPEC_PUBKEY = getPublicKey(hexToBytes(SPEC_SECRET));

function craftNcryptsec({ logN = 16, keySecurity = 2 } = {}) {
  const payload = new Uint8Array(91);
  payload.set([2, logN]);
  payload[42] = keySecurity;
  return nip19.encodeBytes("ncryptsec", payload);
}

// Minimal IndexedDB for saveIdentity.
let vault = null;
globalThis.indexedDB = {
  open() {
    const request = {};
    const database = {
      close() {},
      createObjectStore() {},
      transaction() {
        const transaction = {
          objectStore: () => ({
            put(value) {
              vault = value;
              const put = {};
              queueMicrotask(() => {
                put.onsuccess?.();
                transaction.oncomplete();
              });
              return put;
            },
          }),
        };
        return transaction;
      },
    };
    queueMicrotask(() => {
      request.result = database;
      request.onsuccess();
    });
    return request;
  },
};

test("passphrases follow key_backup::generate_passphrase", async () => {
  for (let index = 0; index < 50; index++) {
    const phrase = await generatePassphrase();
    const words = phrase.split(" ");
    assert.equal(words.length, 3);
    assert.ok(words.every((word) => WORDS.has(word)));
    assert.ok([...phrase].length >= 12);
  }
  assert.equal(WORDS.size, 1296);
  assert.equal((await generatePassphrase(1)).split(" ").length, 3);
  assert.equal((await generatePassphrase(99, "-")).split("-").length, 10);
  assert.equal(
    (
      await backupCommands.generate_backup_passphrase({
        words: 5,
        separator: ".",
      })
    ).split(".").length,
    5,
  );
});

test("spec vector verifies against the current identity", async () => {
  setIdentity(hexToBytes(SPEC_SECRET));
  const result = await backupCommands.verify_ncryptsec_backup({
    ncryptsec: `  ${SPEC_NCRYPTSEC}\n`,
    password: "nostr",
  });
  assert.deepEqual(result, {
    pubkey: SPEC_PUBKEY,
    npub: nip19.npubEncode(SPEC_PUBKEY),
    matchesCurrentIdentity: true,
  });
  await assert.rejects(
    backupCommands.verify_ncryptsec_backup({
      ncryptsec: SPEC_NCRYPTSEC,
      password: "wrong",
    }),
    /^Error: wrong backup password or damaged key backup$/,
  );
});

test("backup round trip recovers the live identity without zeroing it", async () => {
  const secret = hexToBytes(SPEC_SECRET);
  setIdentity(secret);
  await assert.rejects(
    createBackup("short"),
    /passphrase must be at least 12 characters/,
  );
  const ncryptsec = await createBackup("correct horse battery", 4);
  assert.deepEqual(secret, hexToBytes(SPEC_SECRET), "live key not zeroed");
  const verified = await backupCommands.verify_ncryptsec_backup({
    ncryptsec,
    password: "correct horse battery",
  });
  assert.equal(verified.matchesCurrentIdentity, true);
  // Uppercase bech32 is valid and accepted, like the Rust parser.
  const upper = await backupCommands.verify_ncryptsec_backup({
    ncryptsec: ncryptsec.toUpperCase(),
    password: "correct horse battery",
  });
  assert.equal(upper.pubkey, SPEC_PUBKEY);
});

test("malformed or over-cost backups are rejected before scrypt", async () => {
  const reject = (ncryptsec, pattern) =>
    assert.rejects(
      backupCommands.import_identity({ nsec: ncryptsec, password: "x" }),
      pattern,
    );
  await reject(
    craftNcryptsec({ logN: 19 }),
    /unsupported backup KDF cost: log_n 19 exceeds maximum 18/,
  );
  await reject(
    craftNcryptsec({ logN: 255 }),
    /unsupported backup KDF cost: log_n 255/,
  );
  await reject(craftNcryptsec({ keySecurity: 3 }), /invalid ncryptsec/);
  await reject(`${SPEC_NCRYPTSEC.slice(0, -1)}q`, /invalid ncryptsec/);
  await assert.rejects(
    backupCommands.import_identity({ nsec: SPEC_NCRYPTSEC }),
    /key backup requires a password/,
  );
  assert.throws(
    () => backupCommands.save_ncryptsec_copy({ ncryptsec: "nsec1abc" }),
    /invalid ncryptsec/,
  );
});

test("import accepts nsec, hex and ncryptsec, and rejects other input", async () => {
  const secret = hexToBytes(SPEC_SECRET);
  const nsec = nip19.nsecEncode(secret);
  for (const [nsecInput, password] of [
    [nsec, undefined],
    [` ${nsec.toUpperCase()} `, undefined],
    [SPEC_SECRET.toUpperCase(), undefined],
    [SPEC_NCRYPTSEC, "nostr"],
  ]) {
    setIdentity(null, "locked");
    vault = null;
    const identity = await backupCommands.import_identity({
      nsec: nsecInput,
      password,
    });
    assert.equal(identity.pubkey, SPEC_PUBKEY);
    assert.equal(identity.locked, false);
    assert.match(identity.display_name, /^npub1/);
    assert.deepEqual(getSecretKey(), secret);
    assert.equal(vault.pubkey, SPEC_PUBKEY);
  }
  for (const bad of [
    "",
    "nsec1invalid",
    nip19.npubEncode(SPEC_PUBKEY),
    "0".repeat(64),
    "f".repeat(64),
  ])
    await assert.rejects(
      backupCommands.import_identity({ nsec: bad }),
      /^Error: Invalid private key/,
    );
});

test("save_ncryptsec_copy downloads identity.ncryptsec", async () => {
  const clicks = [];
  globalThis.document = {
    createElement: () => ({
      click() {
        clicks.push({ ...this });
      },
    }),
  };
  const blobs = new Map();
  URL.createObjectURL = (blob) => {
    blobs.set("blob:1", blob);
    return "blob:1";
  };
  URL.revokeObjectURL = () => {};
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  const name = backupCommands.save_ncryptsec_copy({
    ncryptsec: `\n${SPEC_NCRYPTSEC}  `,
  });
  globalThis.setTimeout = originalTimeout;
  assert.equal(name, "identity.ncryptsec");
  assert.equal(clicks[0].download, "identity.ncryptsec");
  assert.equal(await blobs.get(clicks[0].href).text(), SPEC_NCRYPTSEC);
});
