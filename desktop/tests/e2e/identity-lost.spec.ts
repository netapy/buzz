import { hexToBytes } from "@noble/hashes/utils.js";
import { expect, type Page, test } from "@playwright/test";
import { nsecEncode } from "nostr-tools/nip19";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

type VaultMetadata = {
  ciphertext: number[];
  extractable: boolean;
  fields: string[];
  ivLength: number;
  keyAlgorithm: string;
  keyUsages: KeyUsage[];
  pubkey: string;
};

async function readVault(page: Page): Promise<VaultMetadata> {
  return page.evaluate(
    () =>
      new Promise<VaultMetadata>((resolve, reject) => {
        const open = indexedDB.open("buzz-desktop-web-vault");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const request = database
            .transaction("identity", "readonly")
            .objectStore("identity")
            .get("current");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const record = request.result;
            database.close();
            resolve({
              ciphertext: [...new Uint8Array(record.ciphertext)],
              extractable: record.wrappingKey.extractable,
              fields: Object.keys(record).sort(),
              ivLength: record.iv.byteLength,
              keyAlgorithm: record.wrappingKey.algorithm.name,
              keyUsages: [...record.wrappingKey.usages].sort(),
              pubkey: record.pubkey,
            });
          };
        };
      }),
  );
}

test("normal first launch uses the already-persisted identity", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");

  const gate = page.getByTestId("machine-onboarding-gate");
  await expect(gate).toBeVisible();
  await expect(gate).toHaveCSS("background-color", "rgb(215, 215, 46)");
  // Landing carries a subtle dot-grid pattern over the chartreuse fill.
  await expect(gate).toHaveCSS("background-image", /radial-gradient/);
  await expect(gate).toHaveCSS("color", "rgb(23, 23, 23)");
  await expect(
    page.getByRole("button", { name: "Create a new identity key" }),
  ).toHaveCSS("background-color", "rgb(23, 23, 23)");
  await page.getByRole("button", { name: "Create a new identity key" }).click();

  await expect(
    page.getByRole("heading", {
      name: "Your unique identity key has been created",
    }),
  ).toBeVisible();
  // Non-landing pages layer the dot grid over the chartreuse→light-blue gradient.
  await expect(gate).toHaveCSS(
    "background-image",
    /radial-gradient\(.*\), linear-gradient\(.*rgb\(215, 215, 46\).*rgb\(215, 231, 246\)\)/s,
  );
  await expect(gate).toHaveCSS("color", "rgb(23, 23, 23)");
  const commands = await page.evaluate(
    () =>
      (
        window as Window & {
          __BUZZ_E2E_COMMAND_PAYLOADS__?: Array<{ command: string }>;
        }
      ).__BUZZ_E2E_COMMAND_PAYLOADS__ ?? [],
  );
  expect(commands.some((entry) => entry.command === "get_identity")).toBe(true);
  expect(
    commands.some((entry) => entry.command === "persist_current_identity"),
  ).toBe(false);
});

test("lost boot opens onboarding gate directly on the key-import page", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Re-import your key" }),
  ).toBeVisible();
});

test("importing a key from lost mode shows the relaunch-required screen", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Re-import your key" }),
  ).toBeVisible();

  const importedNsec = nsecEncode(hexToBytes(TEST_IDENTITIES.alice.privateKey));
  await page.getByTestId("nostr-import-nsec-input").fill(importedNsec);
  await expect(page.getByTestId("nostr-import-npub-preview")).toBeVisible();
  await page.getByTestId("nostr-import-submit").click();

  await expect(page.getByTestId("relaunch-required")).toBeVisible();
});

test("start-new-identity from lost mode persists the ephemeral key after confirmation", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Re-import your key" }),
  ).toBeVisible();

  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Start new identity" }).click();

  await expect(page.getByTestId("relaunch-required")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __BUZZ_E2E_COMMAND_PAYLOADS__?: Array<{ command: string }>;
            }
          ).__BUZZ_E2E_COMMAND_PAYLOADS__?.some(
            (e) => e.command === "persist_current_identity",
          ) ?? false,
      ),
    )
    .toBe(true);
});

test("cancelling start-new-identity in lost mode stays on the import screen", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Re-import your key" }),
  ).toBeVisible();

  page.on("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Start new identity" }).click();

  // Still on the import screen — no navigation, no persist
  await expect(
    page.getByRole("heading", { name: "Re-import your key" }),
  ).toBeVisible();
  await expect(page.getByTestId("relaunch-required")).toHaveCount(0);
});

test("locked boot shows the keyring-locked screen without the onboarding gate or key-import UI", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLocked: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await expect(page.getByTestId("keyring-locked")).toBeVisible();
  await expect(page.getByTestId("onboarding-gate")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Re-import your key" }),
  ).toHaveCount(0);
});

test("locked boot can re-import a key and requires relaunch", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLocked: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await expect(page.getByTestId("keyring-locked")).toBeVisible();
  page.on("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Re-import your key instead" })
    .click();

  const importedNsec = nsecEncode(hexToBytes(TEST_IDENTITIES.alice.privateKey));
  await page.getByTestId("nostr-import-nsec-input").fill(importedNsec);
  await expect(page.getByTestId("nostr-import-npub-preview")).toBeVisible();
  await page.getByTestId("nostr-import-submit").click();

  await expect(page.getByTestId("relaunch-required")).toBeVisible();
  await expect(page.getByTestId("keyring-locked")).toHaveCount(0);
});

test("locked screen relaunch button records the process-restart invoke", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLocked: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await expect(page.getByTestId("keyring-locked")).toBeVisible();
  await page.getByTestId("relaunch-app").click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __BUZZ_E2E_COMMAND_PAYLOADS__?: Array<{ command: string }>;
            }
          ).__BUZZ_E2E_COMMAND_PAYLOADS__?.some(
            (e) => e.command === "plugin:process|restart",
          ) ?? false,
      ),
    )
    .toBe(true);
});

test.describe("browser identity vault", () => {
  test.use({ serviceWorkers: "block" });
  test.skip(
    process.env.BUZZ_WEB_BUILD !== "1",
    "requires the real build:web adapter",
  );

  test("encrypts the key, survives reload, and fails closed", async ({
    page,
  }) => {
    await page.goto("/");
    await expect
      .poll(
        () =>
          page.evaluate(async () =>
            (await indexedDB.databases()).some(
              (database) => database.name === "buzz-desktop-web-vault",
            ),
          ),
        { timeout: 15_000 },
      )
      .toBe(true);

    const before = await readVault(page);
    expect(before).toMatchObject({
      extractable: false,
      fields: ["ciphertext", "id", "iv", "pubkey", "wrappingKey"],
      ivLength: 12,
      keyAlgorithm: "AES-GCM",
      keyUsages: ["decrypt", "encrypt"],
      pubkey: /^[0-9a-f]{64}$/,
    });
    expect(before.ciphertext).toHaveLength(48);

    await page.reload();
    const after = await readVault(page);
    expect(after.pubkey).toBe(before.pubkey);
    expect(after.ciphertext).toEqual(before.ciphertext);

    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open("buzz-desktop-web-vault");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const database = open.result;
            const transaction = database.transaction("identity", "readwrite");
            const store = transaction.objectStore("identity");
            const request = store.get("current");
            request.onerror = () => reject(request.error);
            request.onsuccess = () =>
              store.put({ ...request.result, wrappingKey: null });
            transaction.oncomplete = () => {
              database.close();
              resolve();
            };
            transaction.onerror = () => reject(transaction.error);
          };
        }),
    );

    await page.reload();
    await expect(page.getByTestId("keyring-locked")).toBeVisible({
      timeout: 10_000,
    });
  });
});
