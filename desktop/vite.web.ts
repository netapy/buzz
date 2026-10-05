import { createHash } from "node:crypto";
import path from "node:path";
import type { Plugin } from "vite";

// Browser (PWA) build: route every Tauri import to the shim and give the
// shell its installable-app metadata and a CSP pinned to the inline scripts
// of this exact build (frame-ancestors is sent by the reverse proxy).

const TAURI_MODULE = /^@tauri-apps\/(?:api|plugin-[^/]+)(?:\/.*)?$/;
const shim = path.resolve(__dirname, "src/web/tauri.ts");

const head = `
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta name="description" content="Ordalie team chat" />
    <meta name="theme-color" content="#000000" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="Buzz" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black" />`;

function contentSecurityPolicy(html: string) {
  const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    ([, source]) =>
      `'sha256-${createHash("sha256").update(source).digest("base64")}'`,
  );
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'none'",
    "object-src 'none'",
    `script-src 'self' 'wasm-unsafe-eval' ${inlineScripts.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "connect-src 'self' https: wss:",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");
}

export function buzzWeb(): Plugin {
  return {
    name: "buzz-web",
    enforce: "pre",
    resolveId: (source) => (TAURI_MODULE.test(source) ? shim : null),
    transformIndexHtml: {
      order: "post",
      handler: (html) =>
        html
          .replace(/<title>.*<\/title>/, "<title>Buzz | Ordalie</title>")
          .replace(/href="\/buzz\.svg[^"]*"/, 'href="/favicon.svg"')
          .replace(
            "<head>",
            `<head>\n    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(html)}" />${head}`,
          ),
    },
  };
}
