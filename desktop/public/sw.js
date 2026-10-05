self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

// Any content-addressed relay blob: `/media/<sha256>`, optionally `.thumb`,
// optionally one extension.
const RELAY_MEDIA_PATH =
  /^\/media\/[\da-f]{64}(?:\.thumb)?(?:\.[\da-z]{1,10})?$/i;

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!RELAY_MEDIA_PATH.test(url.pathname)) return;
  if (event.request.method !== "GET" && event.request.method !== "HEAD") return;
  if (event.request.headers.has("Authorization")) return;
  event.respondWith(authenticatedMedia(event.request, event.clientId));
});

async function authenticatedMedia(request, clientId) {
  const authorization = await requestMediaAuth(clientId);
  if (!authorization) return fetch(request);
  // Copying headers keeps Range (media seeking). A fresh cors-mode request is
  // required: <img>/<video> requests are no-cors, which silently drops
  // Authorization, and navigations cannot be re-wrapped with an init.
  const headers = new Headers(request.headers);
  headers.set("Authorization", authorization);
  return fetch(request.url, {
    method: request.method,
    headers,
    credentials: "omit",
    redirect: "error",
    signal: request.signal,
  });
}

async function requestMediaAuth(clientId) {
  for (const delayMs of [0, 150, 400, 800]) {
    if (delayMs > 0) await wait(delayMs);
    const authorization = await requestMediaAuthOnce(clientId);
    if (authorization) return authorization;
  }
  return null;
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function requestMediaAuthOnce(clientId) {
  // Prefer the page that made the request; navigations (no clientId yet) and
  // worker-initiated requests fall back to any open window.
  const requester = clientId ? await self.clients.get(clientId) : undefined;
  const client =
    requester?.type === "window"
      ? requester
      : (
          await self.clients.matchAll({
            type: "window",
            includeUncontrolled: true,
          })
        )[0];
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

// Focus (or open) the app and route it to the notified message.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.target ?? null;
  event.waitUntil(
    (async () => {
      const [client] = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const window = client
        ? await client.focus()
        : await self.clients.openWindow("/");
      if (window && target)
        window.postMessage({ type: "buzz-notification-click", target });
    })(),
  );
});
