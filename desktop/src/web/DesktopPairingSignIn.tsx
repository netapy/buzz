import {
  Check,
  LoaderCircle,
  QrCode,
  ScanLine,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import * as React from "react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Textarea } from "@/shared/ui/textarea";

// Sign the browser in with the identity of a signed-in Buzz desktop: the user
// copies (or scans) the code from Settings → Mobile and compares a 6-digit
// code on both screens before the key is transferred.

type Step = "code" | "scan" | "connecting" | "sas" | "receiving" | "error";
type Session = ReturnType<typeof import("./pairing").startDesktopPairingTarget>;
type Detector = {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
};
type DetectorConstructor = new (options: { formats: string[] }) => Detector;

const PAIRING_CODE_PREFIX = "nostrpair://";

function barcodeDetector(): DetectorConstructor | null {
  return (
    (window as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector ??
    null
  );
}

export function DesktopPairingSignIn({
  disabled,
  onSignedIn,
}: {
  disabled?: boolean;
  onSignedIn: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [step, setStep] = React.useState<Step>("code");
  const [code, setCode] = React.useState("");
  const [sas, setSas] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const session = React.useRef<Session | null>(null);
  const video = React.useRef<HTMLVideoElement | null>(null);

  const stopSession = React.useCallback(() => {
    session.current?.cancel();
    session.current = null;
  }, []);

  React.useEffect(() => stopSession, [stopSession]);

  const fail = React.useCallback((message: string) => {
    setError(message);
    setStep("error");
  }, []);

  const connect = React.useCallback(
    (value: string) => {
      stopSession();
      setError(null);
      setSas(null);
      setStep("connecting");
      void import("./pairing").then(
        ({ startDesktopPairingTarget }) => {
          try {
            session.current = startDesktopPairingTarget(value, {
              onSas: (received) => {
                setSas(received);
                setStep("sas");
              },
              onComplete: () => {
                session.current = null;
                setOpen(false);
                onSignedIn();
              },
              onError: fail,
            });
          } catch (cause) {
            fail(cause instanceof Error ? cause.message : String(cause));
          }
        },
        fail.bind(null, "Buzz couldn't load pairing. Reload and try again."),
      );
    },
    [fail, onSignedIn, stopSession],
  );

  React.useEffect(() => {
    const Detector = barcodeDetector();
    if (step !== "scan" || !Detector) return;
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (stopped || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const detector = new Detector({ formats: ["qr_code"] });
        const tick = async () => {
          if (stopped || !video.current) return;
          const found = (await detector.detect(video.current)).find((code) =>
            code.rawValue.startsWith(PAIRING_CODE_PREFIX),
          );
          if (found) connect(found.rawValue);
          else timer = window.setTimeout(() => void tick(), 300);
        };
        void tick();
      } catch {
        if (!stopped)
          fail("Buzz couldn't use the camera. Paste the code instead.");
      }
    })();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
  }, [connect, fail, step]);

  function close(next: boolean) {
    setOpen(next);
    if (next) return;
    stopSession();
    setStep("code");
    setCode("");
  }

  return (
    <>
      <p className="mt-3 text-sm text-foreground/70">
        Signed in on Buzz desktop?{" "}
        <button
          className="rounded-sm font-medium text-foreground underline decoration-foreground/40 underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
          data-testid="desktop-pairing-open"
          disabled={disabled}
          onClick={() => setOpen(true)}
          type="button"
        >
          Connect from desktop
        </button>
      </p>
      <Dialog onOpenChange={close} open={open}>
        <DialogContent
          className="max-w-sm"
          data-testid="desktop-pairing-dialog"
        >
          <DialogHeader>
            <DialogTitle>Connect from Buzz desktop</DialogTitle>
            <DialogDescription>
              In Buzz desktop, open Settings → Mobile, choose Start pairing,
              then Copy pairing code.
            </DialogDescription>
          </DialogHeader>
          {step === "code" ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                connect(code);
              }}
            >
              <Textarea
                aria-label="Pairing code"
                autoFocus
                className="min-h-24 font-mono text-xs"
                data-testid="desktop-pairing-code"
                onChange={(event) => setCode(event.target.value)}
                placeholder={`${PAIRING_CODE_PREFIX}…`}
                value={code}
              />
              <Button
                data-testid="desktop-pairing-connect"
                disabled={!code.trim().startsWith(PAIRING_CODE_PREFIX)}
                type="submit"
              >
                Connect
              </Button>
              {barcodeDetector() ? (
                <Button
                  onClick={() => setStep("scan")}
                  type="button"
                  variant="outline"
                >
                  <ScanLine className="mr-1.5 h-4 w-4" />
                  Scan the QR code instead
                </Button>
              ) : null}
            </form>
          ) : step === "scan" ? (
            <div className="flex flex-col gap-3">
              <video
                className="aspect-square w-full rounded-lg bg-black object-cover"
                muted
                playsInline
                ref={video}
              />
              <Button onClick={() => setStep("code")} variant="outline">
                Paste the code instead
              </Button>
            </div>
          ) : step === "sas" && sas ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <ShieldCheck className="h-10 w-10 text-primary" />
              <p className="text-sm font-medium">
                Does Buzz desktop show this code?
              </p>
              <div className="rounded-xl border-2 border-primary/30 bg-primary/5 px-5 py-3">
                <p
                  className="font-mono text-3xl font-bold tracking-[0.25em]"
                  data-testid="desktop-pairing-sas"
                >
                  {sas.slice(0, 3)} {sas.slice(3)}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Confirm on both screens. Only continue if this browser is yours.
              </p>
              <div className="flex w-full flex-col gap-2">
                <Button
                  data-testid="desktop-pairing-confirm"
                  onClick={() => {
                    session.current?.confirm();
                    setStep("receiving");
                  }}
                >
                  <Check className="mr-1.5 h-4 w-4" />
                  Codes match
                </Button>
                <Button onClick={() => close(false)} variant="outline">
                  <X className="mr-1.5 h-4 w-4" />
                  Cancel
                </Button>
              </div>
            </div>
          ) : step === "error" ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <TriangleAlert className="h-6 w-6 text-destructive" />
              <p className="text-sm text-destructive">{error}</p>
              <Button
                onClick={() => setStep("code")}
                size="sm"
                variant="outline"
              >
                Try again
              </Button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-6">
              <LoaderCircle className="h-6 w-6 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {step === "receiving"
                  ? "Confirm on Buzz desktop to finish…"
                  : "Connecting to Buzz desktop…"}
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function QrSignInButton(props: {
  className: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button {...props} data-testid="qr-sign-in" type="button" variant="ghost">
      <QrCode className="mr-2 h-4 w-4" />
      Sign in with a QR code
    </Button>
  );
}

export function PhoneQrHint() {
  return (
    <p className="mt-3 text-center text-sm text-foreground/70">
      On your phone, open Buzz, then Settings → Send identity to desktop.
    </p>
  );
}
