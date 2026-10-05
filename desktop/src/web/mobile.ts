// Phone behaviour for the browser build: viewport, on-screen keyboard,
// keyboard-free loads and long-press message actions. Layout lives in
// mobile.css; both only engage below the app's 768px mobile breakpoint.

// Set on init: node tests import this module without matchMedia.
let phone: MediaQueryList;
let touch: MediaQueryList;
const LONG_PRESS_MS = 420;
const TEXT_INPUT =
  'textarea, [contenteditable="true"], input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], input[type="number"]';

// Android resizes the layout for the keyboard only when asked; iOS ignores
// this and is handled by following the visual viewport below.
function configureViewport() {
  document
    .querySelector('meta[name="viewport"]')
    ?.setAttribute(
      "content",
      "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
    );
}

// Pin the app to the visible area so the keyboard raises the composer
// instead of scrolling the whole page (and the header) out of view.
function followVisualViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const root = document.documentElement;
  // Tallest height seen per width: the keyboard is whatever eats into it
  // (iOS shrinks only the visual viewport, Android the whole layout).
  const fullHeight = new Map<number, number>();
  const sync = () => {
    if (viewport.scale > 1.01) return; // pinch zoom: keep the last layout
    const width = Math.round(viewport.width);
    const full = Math.max(fullHeight.get(width) ?? 0, viewport.height);
    fullHeight.set(width, full);
    root.style.setProperty("--buzz-viewport-height", `${viewport.height}px`);
    root.style.setProperty("--buzz-viewport-top", `${viewport.offsetTop}px`);
    // How far the keyboard reaches into the layout viewport, for portaled
    // sheets that are positioned against it (iOS keeps it full height).
    root.style.setProperty(
      "--buzz-keyboard-inset",
      `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`,
    );
    root.toggleAttribute("data-keyboard-open", full - viewport.height > 150);
  };
  viewport.addEventListener("resize", sync);
  viewport.addEventListener("scroll", sync);
  sync();
}

// Opening a screen must not pop the keyboard. Like native chat apps, a text
// field only takes focus from code when the user just touched that field or
// its form (wrapper taps); opening a screen, thread or dialog leaves the
// keyboard closed until the field itself is tapped.
function keepKeyboardClosedUntilFieldTap() {
  if (!touch.matches) return;
  let lastTouch: { target: Element; at: number } | null = null;
  document.addEventListener(
    "touchstart",
    (event) => {
      lastTouch = { target: event.target as Element, at: performance.now() };
    },
    { capture: true, passive: true },
  );
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (options?: FocusOptions) {
    if (phone.matches && this.matches(TEXT_INPUT)) {
      const touched =
        lastTouch && performance.now() - lastTouch.at < 1000
          ? lastTouch.target
          : null;
      const field =
        this.closest('form, [data-testid="message-composer"]') ?? this;
      if (!touched || !field.contains(touched)) return;
    }
    focus.call(this, options);
  };
}

// Taps also fire compatibility mouse events, which open hover cards and
// popovers that then stick on screen. Touch never hovers: only a real mouse
// that just moved gets hover events through.
function ignoreTapHover() {
  if (!touch.matches) return;
  let mouseMovedAt = Number.NEGATIVE_INFINITY;
  window.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType === "mouse") mouseMovedAt = event.timeStamp;
    },
    { capture: true, passive: true },
  );
  for (const type of ["mouseover", "mouseout", "mouseenter", "mouseleave"])
    window.addEventListener(
      type,
      (event) => {
        if (phone.matches && event.timeStamp - mouseMovedAt > 100)
          event.stopPropagation();
      },
      { capture: true },
    );
}

// Message actions stay out of the way on phones and appear on long press,
// like a native chat app.
function revealMessageActionsOnLongPress() {
  let timer = 0;
  let origin: { x: number; y: number } | null = null;
  const clear = () => {
    window.clearTimeout(timer);
    origin = null;
  };
  const activate = (row: Element | null) => {
    for (const active of document.querySelectorAll("[data-touch-actions]"))
      if (active !== row) active.removeAttribute("data-touch-actions");
    row?.setAttribute("data-touch-actions", "");
  };
  document.addEventListener(
    "touchstart",
    (event) => {
      const target = event.target as Element;
      if (
        target.closest(
          '[data-testid^="message-action-bar-"], [role="menu"], [role="dialog"]',
        )
      )
        return;
      const row = target.closest('[data-testid="message-row"]');
      activate(null);
      if (!row || !phone.matches) return;
      const point = event.touches[0];
      origin = { x: point.clientX, y: point.clientY };
      timer = window.setTimeout(() => {
        activate(row);
        navigator.vibrate?.(8);
        origin = null;
      }, LONG_PRESS_MS);
    },
    { passive: true },
  );
  document.addEventListener(
    "touchmove",
    (event) => {
      const point = event.touches[0];
      if (
        origin &&
        Math.hypot(point.clientX - origin.x, point.clientY - origin.y) > 10
      )
        clear();
    },
    { passive: true },
  );
  document.addEventListener("touchend", () => window.clearTimeout(timer), {
    passive: true,
  });
  document.addEventListener("touchcancel", clear, { passive: true });
}

export function initializeMobileShell(): void {
  phone = matchMedia("(max-width: 767px)");
  touch = matchMedia("(pointer: coarse)");
  configureViewport();
  followVisualViewport();
  keepKeyboardClosedUntilFieldTap();
  ignoreTapHover();
  revealMessageActionsOnLongPress();
}
