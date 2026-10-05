import assert from "node:assert/strict";
import { test } from "node:test";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";

globalThis.location = new URL("http://localhost:8080/");
const core = await import("./core.ts");
const { invoke } = await import("./tauri.ts");

const key = () => {
  const secret = generateSecretKey();
  return { secret, pub: getPublicKey(secret) };
};
const me = key();
const other = key();
const owned = key();
const bot = key();
const spoofer = key();

const authTag = (owner, agent) => [
  "auth",
  owner.pub,
  "",
  bytesToHex(
    schnorr.sign(
      sha256(new TextEncoder().encode(`nostr:agent-auth:${agent.pub}:`)),
      owner.secret,
    ),
  ),
];
const sign = (who, kind, content, tags = []) =>
  finalizeEvent(
    { kind, content: JSON.stringify(content), tags, created_at: 1_700_000_000 },
    who.secret,
  );
const roster = sign(other, 39002, {}, [
  ["d", "270f6caf-0feb-4055-93f3-cdbeb567ff28"],
  ["p", me.pub, "", "member"],
  ["p", bot.pub, "", "bot"],
  ["p", spoofer.pub, "", "bot"],
]);
const relay = [
  roster,
  sign(me, 30177, { respond_to: "anyone" }, [["d", owned.pub]]),
  sign(owned, 0, { display_name: "Mine" }, [authTag(me, owned)]),
  sign(bot, 0, { display_name: "Their bot" }, [authTag(other, bot)]),
  sign(other, 30177, { respond_to: "owner-only" }, [["d", bot.pub]]),
  // Forged claims: a policy from a non-owner and a self-declared directory.
  sign(spoofer, 30177, { respond_to: "anyone" }, [["d", bot.pub]]),
  sign(spoofer, 0, { display_name: "Spoof" }),
  sign(spoofer, 10100, { owner_pubkey: me.pub, respond_to: "anyone" }),
];

globalThis.fetch = async (_url, init) => {
  const filters = JSON.parse(init.body);
  const hits = relay.filter((event) =>
    filters.some(
      (f) =>
        f.kinds.includes(event.kind) &&
        (!f.authors || f.authors.includes(event.pubkey)) &&
        (!f["#d"] ||
          event.tags.some((t) => t[0] === "d" && f["#d"].includes(t[1]))) &&
        (!f["#p"] ||
          event.tags.some((t) => t[0] === "p" && f["#p"].includes(t[1]))),
    ),
  );
  return new Response(JSON.stringify(hits));
};

test("the agent directory trusts NIP-OA profiles and owner-signed policy only", async () => {
  core.setIdentity(me.secret);
  const agents = await invoke("list_relay_agents");
  const byName = Object.fromEntries(agents.map((agent) => [agent.name, agent]));
  assert.deepEqual(Object.keys(byName).sort(), ["Mine", "Their bot"]);
  assert.equal(byName.Mine.owner_pubkey, me.pub);
  assert.equal(byName.Mine.respond_to, "anyone");
  assert.equal(byName["Their bot"].owner_pubkey, other.pub);
  assert.equal(byName["Their bot"].respond_to, "owner-only");
  assert.deepEqual(byName["Their bot"].channel_ids, [
    "270f6caf-0feb-4055-93f3-cdbeb567ff28",
  ]);
});
