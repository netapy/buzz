// Notifications go through the service worker: Android and installed iOS
// PWAs reject `new Notification()`, and the worker owns click handling.

const OFFER_SNOOZED_KEY = "buzz-web-notification-offer-snoozed";
const OFFER_SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;
const NOTIFICATION_ACTION_EVENT = "buzz:desktop-notification-action";

type BadgeState =
  | { kind: "none" }
  | { kind: "dot" }
  | { kind: "count"; count: number };

export async function showBrowserNotification(
  title: string,
  body: string | undefined,
  target: { eventId: string | null; channelId: string | null } | undefined,
): Promise<boolean> {
  try {
    const registration = await navigator.serviceWorker?.ready;
    if (!registration) return false;
    await registration.showNotification(title, {
      body,
      data: { target: target ?? null },
      icon: "/app-icon@2x.png",
      silent: true,
      tag: target?.eventId ?? target?.channelId ?? undefined,
    });
    return true;
  } catch (error) {
    console.warn("[web] notification dropped:", error);
    return false;
  }
}

// A notification tapped while Buzz was closed opens it with the target in
// the URL; it is routed once the signed-in app is listening.
let launchTarget: unknown = null;

export function flushLaunchNotificationTarget(): void {
  if (!launchTarget) return;
  window.dispatchEvent(
    new CustomEvent(NOTIFICATION_ACTION_EVENT, { detail: launchTarget }),
  );
  launchTarget = null;
}

export function attachNotificationClickBridge(): void {
  const url = new URL(location.href);
  const target = url.searchParams.get("notification");
  if (target) {
    try {
      launchTarget = JSON.parse(target);
    } catch {}
    url.searchParams.delete("notification");
    history.replaceState(history.state, "", url);
  }
  navigator.serviceWorker?.addEventListener("message", (event) => {
    if (event.data?.type !== "buzz-notification-click" || !event.data.target)
      return;
    window.focus();
    window.dispatchEvent(
      new CustomEvent(NOTIFICATION_ACTION_EVENT, { detail: event.data.target }),
    );
  });
}

export async function setBrowserAppBadge(state: BadgeState): Promise<void> {
  if (!("setAppBadge" in navigator)) return;
  try {
    if (state.kind === "count" && state.count > 0)
      await navigator.setAppBadge(state.count);
    else if (state.kind === "dot") await navigator.setAppBadge();
    else await navigator.clearAppBadge();
  } catch {
    // Badging is best effort (unsupported outside installed PWAs on some OSes).
  }
}

// iPhone Safari has no Notification API until Buzz runs from the Home Screen.
export function needsHomeScreenForNotifications(): boolean {
  const ios =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  return ios && !matchMedia("(display-mode: standalone)").matches;
}

// Browsers only show the permission prompt from a user gesture, so the app
// asks in NotificationPrompt and its button makes that gesture. "Not now"
// holds the ask back for a few days.
let pendingOffer: (() => Promise<void>) | null = null;
const offerListeners = new Set<() => void>();
const emitOffer = () => {
  for (const listener of offerListeners) listener();
};

export function subscribeNotificationOffer(listener: () => void) {
  offerListeners.add(listener);
  return () => void offerListeners.delete(listener);
}

export function currentNotificationOffer() {
  return pendingOffer;
}

export function dismissNotificationOffer(): void {
  localStorage.setItem(OFFER_SNOOZED_KEY, String(Date.now()));
  pendingOffer = null;
  emitOffer();
}

export async function offerBrowserNotifications(
  enable: () => Promise<void>,
): Promise<void> {
  const snoozedAt = Number(localStorage.getItem(OFFER_SNOOZED_KEY));
  if (Date.now() - snoozedAt < OFFER_SNOOZE_MS) return;
  const askable =
    needsHomeScreenForNotifications() ||
    ("Notification" in window && Notification.permission === "default");
  if (!askable || pendingOffer) return;
  pendingOffer = enable;
  emitOffer();
}
