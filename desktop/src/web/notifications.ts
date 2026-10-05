// Notifications go through the service worker: Android and installed iOS
// PWAs reject `new Notification()`, and the worker owns click handling.

const OFFER_DISMISSED_KEY = "buzz-web-notification-offer-dismissed";
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

export function attachNotificationClickBridge(): void {
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

// Browsers only show the permission prompt from a user gesture, so offer it
// once instead of requesting it from an effect.
export async function offerBrowserNotifications(
  enable: () => Promise<void>,
): Promise<void> {
  if (localStorage.getItem(OFFER_DISMISSED_KEY)) return;
  const { toast } = await import("sonner");
  toast("Get notified about mentions and direct messages", {
    action: { label: "Enable", onClick: () => void enable() },
    duration: Number.POSITIVE_INFINITY,
    onDismiss: () => localStorage.setItem(OFFER_DISMISSED_KEY, "1"),
  });
}
