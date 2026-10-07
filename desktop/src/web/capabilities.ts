// What the browser build can't offer because it needs the native runtime
// (local agent harnesses, audio pipeline, terminal, git, local archive, relay
// admin console), and how it shows that: greyed and explained, not hidden.

export const isWebBuild = import.meta.env?.MODE === "web";

const UNAVAILABLE_FEATURES = new Set([
  "agentManagedProfiles",
  "channel-templates",
  "managed-agents",
  "projects",
]);

// Meaningless in a browser: the page updates itself, and hosted-community
// login belongs to Block's own deployments.
const HIDDEN_SETTINGS_SECTIONS = new Set(["hosted-communities", "updates"]);

// Need the native runtime: listed, greyed, and explained instead of hidden, so
// people know the capability exists (see DesktopOnlyPanel).
export const DESKTOP_ONLY_SETTINGS: Record<string, string> = {
  agents: "Running agents on your own machine needs their local harnesses.",
  "channel-templates": "Templates are stored by the desktop app.",
  compute: "Sharing compute runs a local node next to the app.",
  "local-archive": "The archive is kept on your computer's disk.",
  "relay-admin":
    "The admin console talks to the relay's operator API, which the web never exposes.",
  voice: "Voice and Huddles use the desktop audio pipeline.",
};

// Preview features the organisation turns on for everyone on the web: they
// run entirely in the browser. Settings → Experiments still lets people opt out.
const BROWSER_DEFAULT_ON = new Set(["forum", "pulse", "workflows"]);

export function isUnavailableInBrowser(featureId: string): boolean {
  return isWebBuild && UNAVAILABLE_FEATURES.has(featureId);
}

export function isSettingsSectionHiddenInBrowser(section: string): boolean {
  return isWebBuild && HIDDEN_SETTINGS_SECTIONS.has(section);
}

export function isSettingsSectionDesktopOnly(section: string): boolean {
  return isWebBuild && section in DESKTOP_ONLY_SETTINGS;
}

export function withBrowserDefaults<
  T extends { id: string; defaultEnabled?: boolean },
>(features: T[]): T[] {
  if (!isWebBuild) return features;
  return features.map((f) =>
    BROWSER_DEFAULT_ON.has(f.id) ? { ...f, defaultEnabled: true } : f,
  );
}

// The organisation's look for anyone who hasn't picked a theme: Slack, light
// or dark with the system. Settings → Appearance still overrides it.
export const defaultThemeName = isWebBuild ? "slack-ochin" : "buzz";

// The PWA serves one organisation from its own domain: name the community
// after it (chat.ordalie.com → "Ordalie") rather than the first host label.
export function browserCommunityName(hostname: string): string | null {
  if (!isWebBuild || hostname !== location.hostname) return null;
  const label = hostname.split(".").at(-2) ?? hostname;
  return label.charAt(0).toUpperCase() + label.slice(1);
}
