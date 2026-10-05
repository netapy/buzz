import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Every native command the UI can invoke must be either implemented by the
// browser shim or listed in nativeOnly.ts. Upstream merges that add commands
// fail here instead of failing for users.

const web = path.dirname(fileURLToPath(import.meta.url));
const src = path.dirname(web);

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory())
      return file === web || entry.name === "testing" ? [] : sourceFiles(file);
    return /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec|jsdom-test)\./.test(entry.name)
      ? [file]
      : [];
  });
}

const INVOKE =
  /\b[A-Za-z_]*[Ii]nvoke[A-Za-z_]*\s*(?:<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>)?\s*\(\s*["'`]([a-z0-9_:|.-]+)["'`]/g;

const invoked = new Map();
for (const file of sourceFiles(src)) {
  for (const [, command] of readFileSync(file, "utf8").matchAll(INVOKE)) {
    if (!invoked.has(command)) invoked.set(command, path.relative(src, file));
  }
}

const implemented = new Set();
for (const name of readdirSync(web).filter((file) => file.endsWith(".ts"))) {
  const source = readFileSync(path.join(web, name), "utf8");
  for (const [, command] of source.matchAll(/^\s*case "([^"]+)":/gm))
    implemented.add(command);
  for (const [, body] of source.matchAll(
    /CommandTable = \{\n([\s\S]*?)\n\};/g,
  )) {
    for (const [, quoted, bare] of body.matchAll(
      /^ {2}(?:"([^"]+)"|([a-z_][a-z0-9_]*))\s*:/gm,
    ))
      implemented.add(quoted ?? bare);
  }
}

const nativeOnly = new Set(
  readFileSync(path.join(web, "nativeOnly.ts"), "utf8").match(
    /(?<=^\s*")[a-z0-9_:|]+(?=",)/gm,
  ),
);

test("the UI invokes a non-trivial set of native commands", () => {
  assert.ok(invoked.size > 300, `only found ${invoked.size} commands`);
});

test("every invoked command is implemented or declared native-only", () => {
  const unclassified = [...invoked]
    .filter(
      ([command]) => !implemented.has(command) && !nativeOnly.has(command),
    )
    .map(([command, file]) => `${command} (${file})`);
  assert.deepEqual(unclassified, []);
});

test("native-only commands are not also implemented", () => {
  assert.deepEqual(
    [...nativeOnly].filter((command) => implemented.has(command)),
    [],
  );
});

test("every command table is registered with the dispatcher", () => {
  const dispatcher = readFileSync(path.join(web, "tauri.ts"), "utf8");
  const registered = dispatcher.match(
    /commandTables: CommandTable\[\] = \[([^\]]*)\]/,
  )[1];
  const tables = readdirSync(web)
    .filter((file) => file.endsWith(".ts"))
    .flatMap((file) => [
      ...readFileSync(path.join(web, file), "utf8").matchAll(
        /export const (\w+): CommandTable = \{/g,
      ),
    ])
    .map(([, name]) => name);
  assert.deepEqual(
    tables.filter((name) => !new RegExp(`\\b${name}\\b`).test(registered)),
    [],
  );
});

test("native-only list has no stale entries", () => {
  assert.deepEqual(
    [...nativeOnly].filter((command) => !invoked.has(command)),
    [],
  );
});
