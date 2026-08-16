self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

const RELAY_MEDIA_PATH =
  /\/media\/[\da-f]{64}(?:\.thumb)?\.(?:jpg|png|gif|webp|mp4|webm|mov)$/i;

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!RELAY_MEDIA_PATH.test(url.pathname)) return;
  if (event.request.method !== "GET" && event.request.method !== "HEAD") return;
  if (event.request.headers.has("Authorization")) return;
  event.respondWith(authenticatedMedia(event.request));
});

async function authenticatedMedia(request) {
  const authorization = await requestMediaAuth();
  if (!authorization) return fetch(request);
  const headers = new Headers(request.headers);
  headers.set("Authorization", authorization);
  return fetch(new Request(request, { headers, credentials: "omit" }));
}

async function requestMediaAuth() {
  for (const delayMs of [0, 150, 400, 800]) {
    if (delayMs > 0) await wait(delayMs);
    const authorization = await requestMediaAuthOnce();
    if (authorization) return authorization;
  }
  return null;
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function requestMediaAuthOnce() {
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const client = windows[0];
  if (!client) return null;
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      self.removeEventListener("message", onMessage);
      resolve(null);
    }, 2000);
    function onMessage(event) {
      if (event.data?.type !== "buzz-media-auth" || event.data?.id !== id)
        return;
      self.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(
        typeof event.data.authorization === "string"
          ? event.data.authorization
          : null,
      );
    }
    self.addEventListener("message", onMessage);
    client.postMessage({ type: "buzz-media-auth-request", id });
  });
}
