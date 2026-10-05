// NIP-49 scrypt (log_n 18, ~256 MiB) runs here so the UI thread stays live.
// backup.ts spawns one worker per operation and terminates it afterwards, so
// neither keys nor passwords outlive the request in this context.
import { decrypt, encrypt } from "nostr-tools/nip49";
import { getPublicKey } from "nostr-tools/pure";

export type Nip49Request =
  | { op: "encrypt"; secret: Uint8Array; password: string; logN: number }
  | { op: "decrypt"; ncryptsec: string; password: string };

export function nip49(request: Nip49Request): string | Uint8Array {
  if (request.op === "decrypt")
    return decrypt(request.ncryptsec, request.password);
  try {
    // 0x02 = KeySecurity::Unknown, as in key_backup.rs.
    const ncryptsec = encrypt(
      request.secret,
      request.password,
      request.logN,
      2,
    );
    // Like create_backup_blob: never hand out a blob that fails to recover.
    const recovered = decrypt(ncryptsec, request.password);
    const matches = getPublicKey(recovered) === getPublicKey(request.secret);
    recovered.fill(0);
    if (!matches)
      throw new Error(
        "verify key backup: decrypted key does not match identity",
      );
    return ncryptsec;
  } finally {
    request.secret.fill(0);
  }
}

if ("WorkerGlobalScope" in globalThis)
  addEventListener("message", (event: MessageEvent<Nip49Request>) => {
    try {
      const result = nip49(event.data);
      postMessage(
        { result },
        { transfer: result instanceof Uint8Array ? [result.buffer] : [] },
      );
    } catch (error) {
      postMessage({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
