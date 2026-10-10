// Phone behaviour for the browser build: viewport, on-screen keyboard,
// keyboard-free loads, long-press actions, swipe to reply and haptics. Layout lives in
// mobile.css; both only engage below the app's 768px mobile breakpoint.

// Set on init: node tests import this module without matchMedia.
let phone: MediaQueryList;
let touch: MediaQueryList;
const LONG_PRESS_MS = 420;
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const EDGE = 24; // a swipe from the screen's left edge opens the drawer
const ROW =
  '[data-testid="message-row"], [data-testid^="home-inbox-"][data-testid$="-message"]';
const TEXT_INPUT =
  'textarea, [contenteditable="true"], input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], input[type="number"]';

// A light tick like native controls. Android has the Vibration API; iOS
// Safari has none but ticks when a switch toggles, so click a hidden one.
function haptic() {
  if (!touch.matches) return;
  if (navigator.vibrate) {
    navigator.vibrate(8);
    return;
  }
  const label = document.createElement("label");
  label.ariaHidden = "true";
  label.style.display = "none";
  label.innerHTML = '<input type="checkbox" switch>';
  document.head.append(label);
  label.click();
  label.remove();
}

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
  // The touched element's ancestors, kept at touch time: the tapped button
  // may re-render (send swaps its icon for a spinner) before code refocuses.
  let lastTouch: { path: EventTarget[]; at: number } | null = null;
  document.addEventListener(
    "touchstart",
    (event) => {
      lastTouch = { path: event.composedPath(), at: performance.now() };
    },
    { capture: true, passive: true },
  );
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (options?: FocusOptions) {
    if (phone.matches && this.matches(TEXT_INPUT)) {
      const touched =
        lastTouch && performance.now() - lastTouch.at < 1000
          ? lastTouch.path
          : [];
      const field =
        this.closest('form, [data-testid="message-composer"]') ?? this;
      if (!touched.includes(field)) return;
    }
    focus.call(this, options);
  };
}

// Tapping send would move focus to the button and drop the keyboard after
// every message. Keep focus in the editor and click for the tap instead.
function keepKeyboardOnSend() {
  document.addEventListener(
    "touchend",
    (event) => {
      const send = (event.target as Element).closest<HTMLButtonElement>(
        '[data-testid="send-message"]',
      );
      const point = event.changedTouches[0];
      if (
        !phone.matches ||
        !send ||
        send.disabled ||
        !send.contains(document.elementFromPoint(point.clientX, point.clientY))
      )
        return;
      const composer = send.closest('[data-testid="message-composer"]');
      if (!composer?.contains(document.activeElement)) return;
      event.preventDefault();
      send.click();
    },
    { capture: true },
  );
}

// The drawer follows the finger: swipe right on a screen to pull it open,
// swipe it left to put it away, and release to settle by position or flick.
function dragDrawer() {
  const DRAWER = '[data-sidebar="sidebar"][data-mobile="true"]';
  let pan: {
    x: number;
    y: number;
    axis: "x" | "y" | null;
    opening: boolean;
    trigger: HTMLElement | null;
    drawer: HTMLElement | null;
    offset: number;
    velocity: number;
    lastX: number;
    lastT: number;
  } | null = null;

  const scrollsSideways = (el: Element | null) => {
    for (; el && el !== document.body; el = el.parentElement)
      if (
        el.scrollWidth > el.clientWidth &&
        /auto|scroll/.test(getComputedStyle(el).overflowX)
      )
        return true;
    return false;
  };
  // Inline styles drive the drag. Cancelling the CSS slide keeps it from
  // fighting the finger; Radix's exit slide still runs from wherever the
  // drawer is when it closes.
  const place = (drawer: HTMLElement, offset: number | null, ms = 0) => {
    const scrim = drawer.previousElementSibling as HTMLElement | null;
    const transition = ms ? `${ms}ms ${EASE}` : "none";
    for (const el of [drawer, scrim])
      for (const animation of el?.getAnimations() ?? []) animation.cancel();
    drawer.style.transition = offset == null ? "" : `transform ${transition}`;
    drawer.style.transform = offset == null ? "" : `translateX(${offset}px)`;
    if (scrim) {
      scrim.style.transition = offset == null ? "" : `opacity ${transition}`;
      scrim.style.opacity =
        offset == null ? "" : String(1 + offset / drawer.offsetWidth);
    }
  };

  document.addEventListener(
    "touchstart",
    (event) => {
      pan = null;
      if (!phone.matches || event.touches.length > 1) return;
      const target = event.target as Element;
      const drawer = document.querySelector<HTMLElement>(
        `${DRAWER}[data-state="open"]`,
      );
      const trigger = document.querySelector<HTMLElement>(
        '[data-testid="app-top-chrome"] [data-sidebar="trigger"]',
      );
      const opening = !drawer;
      if (drawer ? !drawer.contains(target) : !trigger?.offsetParent) return;
      if (
        opening &&
        (document.querySelector('[role="dialog"], [role="menu"]') ||
          target.closest(`${TEXT_INPUT}, [data-testid="message-composer"]`) ||
          (target.closest(ROW) && event.touches[0].clientX > EDGE) ||
          scrollsSideways(target))
      )
        return;
      const point = event.touches[0];
      pan = {
        x: point.clientX,
        y: point.clientY,
        axis: null,
        opening,
        trigger,
        drawer,
        offset: 0,
        velocity: 0,
        lastX: point.clientX,
        lastT: event.timeStamp,
      };
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    "touchmove",
    (event) => {
      if (!pan) return;
      const point = event.touches[0];
      const dx = point.clientX - pan.x;
      const dy = point.clientY - pan.y;
      if (!pan.axis) {
        if (Math.hypot(dx, dy) < 10) return;
        pan.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (pan.axis === "y" || (pan.opening && dx < 0)) {
          pan = null;
          return;
        }
        if (pan.opening) pan.trigger?.click();
      }
      pan.drawer ??= document.querySelector<HTMLElement>(DRAWER);
      pan.velocity =
        (point.clientX - pan.lastX) / (event.timeStamp - pan.lastT || 1);
      pan.lastX = point.clientX;
      pan.lastT = event.timeStamp;
      if (!pan.drawer) return;
      const width = pan.drawer.offsetWidth;
      pan.offset = Math.max(-width, Math.min(0, pan.opening ? dx - width : dx));
      place(pan.drawer, pan.offset);
    },
    { capture: true, passive: true },
  );

  const release = () => {
    const done = pan;
    pan = null;
    if (done?.axis !== "x" || !done.drawer) return;
    const { drawer, offset, velocity } = done;
    const width = drawer.offsetWidth;
    const open = Math.abs(velocity) > 0.3 ? velocity > 0 : offset > -width / 2;
    if (!open) return done.trigger?.click();
    place(drawer, 0, 220);
    window.setTimeout(() => place(drawer, null), 240);
  };
  document.addEventListener("touchend", release, {
    capture: true,
    passive: true,
  });
  document.addEventListener("touchcancel", release, {
    capture: true,
    passive: true,
  });
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
  // A long press is not a tap: drop the click some browsers still send.
  let swallowClick = false;
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
      swallowClick = false;
      const target = event.target as Element;
      if (
        target.closest(
          '[data-testid^="message-action-bar-"], [role="menu"], [role="dialog"]',
        )
      )
        return;
      const row = target.closest(ROW);
      activate(null);
      if (!row || !phone.matches) return;
      const point = event.touches[0];
      origin = { x: point.clientX, y: point.clientY };
      timer = window.setTimeout(() => {
        activate(row);
        haptic();
        origin = null;
        swallowClick = true;
      }, LONG_PRESS_MS);
    },
    { passive: true },
  );
  document.addEventListener(
    "click",
    (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
    },
    { capture: true },
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

// Swipe a message right to reply, like native chat apps: the row follows the
// finger, ticks once past the threshold and springs back on release.
function swipeToReply() {
  const THRESHOLD = 56;
  let swipe: {
    row: HTMLElement;
    x: number;
    y: number;
    dx: number;
    axis: "x" | "y" | null;
  } | null = null;
  const settle = (row: HTMLElement) => {
    row.style.transition = `transform 220ms ${EASE}`;
    row.style.transform = "";
    window.setTimeout(() => (row.style.transition = ""), 240);
  };
  document.addEventListener(
    "touchstart",
    (event) => {
      const point = event.touches[0];
      const row = (event.target as Element).closest<HTMLElement>(ROW);
      swipe =
        phone.matches &&
        row &&
        event.touches.length === 1 &&
        point.clientX > EDGE
          ? { row, x: point.clientX, y: point.clientY, dx: 0, axis: null }
          : null;
    },
    { passive: true },
  );
  document.addEventListener(
    "touchmove",
    (event) => {
      if (!swipe) return;
      const point = event.touches[0];
      const dx = point.clientX - swipe.x;
      if (!swipe.axis) {
        if (Math.hypot(dx, point.clientY - swipe.y) < 10) return;
        swipe.axis =
          Math.abs(dx) > Math.abs(point.clientY - swipe.y) && dx > 0
            ? "x"
            : "y";
      }
      if (swipe.axis === "y") return;
      // Past the threshold the row resists, as native swipe actions do.
      const offset =
        dx < THRESHOLD ? Math.max(0, dx) : THRESHOLD + (dx - THRESHOLD) / 4;
      if (swipe.dx < THRESHOLD !== offset < THRESHOLD) haptic();
      swipe.dx = offset;
      swipe.row.style.transform = `translateX(${offset}px)`;
    },
    { passive: true },
  );
  const release = () => {
    const done = swipe;
    swipe = null;
    if (done?.axis !== "x") return;
    settle(done.row);
    if (done.dx >= THRESHOLD)
      done.row
        .querySelector<HTMLElement>('[data-testid^="reply-message-"]')
        ?.click();
  };
  document.addEventListener("touchend", release, { passive: true });
  document.addEventListener(
    "touchcancel",
    () => {
      if (swipe) settle(swipe.row);
      swipe = null;
    },
    { passive: true },
  );
}

// Switches tick under the finger, as native toggles do.
function tickOnToggle() {
  document.addEventListener(
    "click",
    (event) => {
      if ((event.target as Element).closest?.('[role="switch"]')) haptic();
    },
    { capture: true, passive: true },
  );
}

export function initializeMobileShell(): void {
  phone = matchMedia("(max-width: 767px)");
  touch = matchMedia("(pointer: coarse)");
  configureViewport();
  followVisualViewport();
  keepKeyboardClosedUntilFieldTap();
  keepKeyboardOnSend();
  dragDrawer();
  ignoreTapHover();
  revealMessageActionsOnLongPress();
  swipeToReply();
  tickOnToggle();
}
