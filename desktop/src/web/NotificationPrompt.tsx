import { Bell, Share, SquarePlus } from "lucide-react";
import * as React from "react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import {
  currentNotificationOffer,
  dismissNotificationOffer,
  flushLaunchNotificationTarget,
  needsHomeScreenForNotifications,
  offerBrowserNotifications,
  subscribeNotificationOffer,
} from "./notifications";
import { syncPushLease } from "./push";

const syncLease = (enabled: boolean) =>
  syncPushLease(enabled).catch((error) =>
    console.warn("[web] push lease sync failed:", error),
  );

// The startup ask for notifications: browsers only show their permission
// prompt from a tap, so the app asks first and the button makes that tap.
// iPhone Safari only notifies apps added to the Home Screen; explain that
// instead of offering a prompt it cannot show. Mounted in the signed-in app,
// so it asks at startup; the feed also offers it when an alert is due.
export default function NotificationPrompt({
  enabled,
  onEnable,
}: {
  enabled: boolean;
  onEnable: (enabled: boolean) => Promise<unknown>;
}) {
  const enable = React.useSyncExternalStore(
    subscribeNotificationOffer,
    currentNotificationOffer,
  );
  const askedRef = React.useRef(false);
  React.useEffect(() => {
    if (askedRef.current) return;
    askedRef.current = true;
    void offerBrowserNotifications(async () => void (await onEnable(true)));
  }, [onEnable]);
  // After the app shell's own effects have started listening for taps.
  React.useEffect(() => void setTimeout(flushLaunchNotificationTarget), []);
  // Background push follows the notification setting (see web/push.ts).
  React.useEffect(() => void syncLease(enabled), [enabled]);
  const [busy, setBusy] = React.useState(false);
  const homeScreen = needsHomeScreenForNotifications();
  const close = () => dismissNotificationOffer();

  return (
    <Dialog onOpenChange={(open) => !open && close()} open={enable !== null}>
      <DialogContent
        className="max-w-sm"
        data-testid="notification-prompt"
        onOpenAutoFocus={(event) => event.preventDefault()}
        showCloseButton={false}
      >
        <DialogHeader className="items-center text-center">
          <span className="mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Bell className="h-7 w-7" />
          </span>
          <DialogTitle>
            {homeScreen
              ? "Add Buzz to your Home Screen"
              : "Turn on notifications"}
          </DialogTitle>
          <DialogDescription className="text-balance">
            {homeScreen
              ? "iPhone delivers notifications only to apps on the Home Screen."
              : "Know when someone messages you, mentions you or replies to your thread, even when Buzz is closed."}
          </DialogDescription>
        </DialogHeader>
        {homeScreen ? (
          <ol className="space-y-3 text-sm">
            <li className="flex items-center gap-3">
              <Share className="h-5 w-5 shrink-0 text-primary" />
              Tap Share in Safari’s toolbar
            </li>
            <li className="flex items-center gap-3">
              <SquarePlus className="h-5 w-5 shrink-0 text-primary" />
              Choose Add to Home Screen, then open Buzz from there
            </li>
          </ol>
        ) : null}
        <div className="mt-2 flex flex-col gap-2">
          {homeScreen ? (
            <Button onClick={close} size="lg">
              Got it
            </Button>
          ) : (
            <>
              <Button
                data-testid="notification-prompt-enable"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await enable?.().finally(() => setBusy(false));
                  close();
                  void syncLease(true);
                }}
                size="lg"
              >
                Turn on notifications
              </Button>
              <Button onClick={close} size="lg" variant="ghost">
                Not now
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
