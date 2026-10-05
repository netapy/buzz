import { hexToBytes } from "@noble/hashes/utils.js";
import { getPublicKey, nip19 } from "nostr-tools";

import { isPlausibleNcryptsec } from "@/features/onboarding/lib/keyImportInput";
import { truncatePubkey } from "@/shared/lib/pubkey";
import {
  type CommandTable,
  requireSecretKey,
  saveIdentity,
  setIdentity,
} from "./core";
import { saveBlob } from "./media";
import { type Nip49Request, nip49 } from "./nip49.worker";

// Constants and messages mirror desktop/src-tauri/src/key_backup.rs.
export const BACKUP_LOG_N = 18;
const BACKUP_FILE_NAME = "identity.ncryptsec";
const MIN_PASSPHRASE_LEN = 12;
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
let wordlist: Promise<string[]> | null = null;

// Loaded on first use so the shim's module graph stays free of the asset.
function loadWordlist() {
  wordlist ??= import(
    "../../src-tauri/src/assets/eff_short_wordlist_2_0.txt?raw"
  ).then(({ default: text }) => {
    const words = text.split("\n").filter(Boolean);
    if (words.length !== 1296)
      throw new Error(
        `wordlist corrupted: expected 1296 words, found ${words.length}`,
      );
    return words;
  });
  return wordlist;
}

export async function generatePassphrase(
  words = 3,
  separator = " ",
): Promise<string> {
  const WORDS = await loadWordlist();
  const count = Math.min(10, Math.max(3, Math.trunc(words) || 3));
  for (let attempt = 0; attempt < 128; attempt++) {
    const chosen: string[] = [];
    while (chosen.length < count) {
      const [value] = crypto.getRandomValues(new Uint16Array(1));
      // Rejection sampling keeps the draw uniform over 1296 words.
      if (value < 64_800) chosen.push(WORDS[value % 1296]);
    }
    const phrase = chosen.join(separator);
    if ([...phrase].length >= MIN_PASSPHRASE_LEN) return phrase;
  }
  throw new Error("could not generate a passphrase meeting the minimum length");
}

function runNip49<T>(
  request: Nip49Request,
  transfer: Transferable[] = [],
): Promise<T> {
  if (typeof Worker === "undefined")
    return Promise.resolve().then(() => nip49(request) as T);
  const worker = new Worker(new URL("./nip49.worker.ts", import.meta.url), {
    type: "module",
  });
  return new Promise<T>((resolve, reject) => {
    worker.onmessage = ({ data }) =>
      data.error ? reject(new Error(data.error)) : resolve(data.result);
    worker.onerror = (event) => {
      event.preventDefault();
      reject(new Error("Key backup worker failed."));
    };
    worker.postMessage(request, transfer);
  }).finally(() => worker.terminate());
}

/** Byte `index` of a validated bech32 payload (8 bits span at most 3 words). */
function payloadByte(ncryptsec: string, index: number): number {
  const word = Math.floor((index * 8) / 5);
  let bits = 0;
  for (const character of ncryptsec.slice(10 + word, 13 + word))
    bits = (bits << 5) | BECH32_CHARSET.indexOf(character);
  return (bits >> (7 - ((index * 8) % 5))) & 0xff;
}

function parseNcryptsec(input: string) {
  const ncryptsec = input.trim();
  if (!isPlausibleNcryptsec(ncryptsec))
    throw new Error("invalid ncryptsec: not a valid NIP-49 key backup");
  if (payloadByte(ncryptsec.toLowerCase(), 42) > 2)
    throw new Error("invalid ncryptsec: unknown key security byte");
  return ncryptsec;
}

async function decryptBackup(
  input: string,
  password: string,
): Promise<Uint8Array> {
  const ncryptsec = parseNcryptsec(input).toLowerCase();
  // Bound scrypt memory before authenticating the password.
  const logN = payloadByte(ncryptsec, 1);
  if (logN > BACKUP_LOG_N)
    throw new Error(
      `unsupported backup KDF cost: log_n ${logN} exceeds maximum ${BACKUP_LOG_N}`,
    );
  try {
    return await runNip49<Uint8Array>({ op: "decrypt", ncryptsec, password });
  } catch {
    throw new Error("wrong backup password or damaged key backup");
  }
}

export async function createBackup(
  password: string,
  logN = BACKUP_LOG_N,
): Promise<string> {
  if ([...password].length < MIN_PASSPHRASE_LEN)
    throw new Error(
      `passphrase must be at least ${MIN_PASSPHRASE_LEN} characters`,
    );
  const secret = requireSecretKey().slice();
  return runNip49<string>({ op: "encrypt", secret, password, logN }, [
    secret.buffer,
  ]);
}

async function recoverKey(
  input: string,
  password: unknown,
): Promise<Uint8Array> {
  const trimmed = input.trim();
  if (trimmed.slice(0, 10).toLowerCase() === "ncryptsec1") {
    if (typeof password !== "string")
      throw new Error("key backup requires a password");
    return decryptBackup(trimmed, password);
  }
  try {
    const key = /^[\da-f]{64}$/i.test(trimmed)
      ? hexToBytes(trimmed)
      : nip19.decode(trimmed).data;
    if (!(key instanceof Uint8Array)) throw new Error();
    getPublicKey(key);
    return key;
  } catch {
    throw new Error(
      "Invalid private key: expected an nsec1… key or a 64-character hex key.",
    );
  }
}

export const backupCommands: CommandTable = {
  generate_backup_passphrase: ({ words, separator }) =>
    generatePassphrase(
      words == null ? undefined : Number(words),
      separator == null ? undefined : String(separator),
    ),
  create_ncryptsec_backup: ({ password }) =>
    createBackup(String(password ?? "")),
  save_ncryptsec_copy: ({ ncryptsec }) => {
    const content = parseNcryptsec(String(ncryptsec ?? ""));
    saveBlob(
      new Blob([content], { type: "application/octet-stream" }),
      BACKUP_FILE_NAME,
    );
    return BACKUP_FILE_NAME;
  },
  verify_ncryptsec_backup: async ({ ncryptsec, password }) => {
    const current = getPublicKey(requireSecretKey());
    const recovered = await decryptBackup(
      String(ncryptsec ?? ""),
      String(password ?? ""),
    );
    const pubkey = getPublicKey(recovered);
    recovered.fill(0);
    return {
      pubkey,
      npub: nip19.npubEncode(pubkey),
      matchesCurrentIdentity: pubkey === current,
    };
  },
  import_identity: async ({ nsec, password }) => {
    const key = await recoverKey(String(nsec ?? ""), password ?? undefined);
    await saveIdentity(key);
    setIdentity(key);
    const pubkey = getPublicKey(key);
    return {
      pubkey,
      display_name: truncatePubkey(nip19.npubEncode(pubkey)),
      lost: false,
      locked: false,
      reset_failed: false,
    };
  },
};
