// Surfaces the browser build hides because they need the native runtime
// (local agent harnesses, audio pipeline, terminal, git, local archive,
// hosted-community login, relay admin console, app updater).

export const isWebBuild = import.meta.env?.MODE === "web";

const UNAVAILABLE_FEATURES = new Set([
  "agentManagedProfiles",
  "channel-templates",
  "managed-agents",
  "projects",
]);

const HIDDEN_SETTINGS_SECTIONS = new Set([
  "agents",
  "channel-templates",
  "compute",
  "experimental",
  "hosted-communities",
  "local-archive",
  "relay-admin",
  "updates",
  "voice",
]);

export function isUnavailableInBrowser(featureId: string): boolean {
  return isWebBuild && UNAVAILABLE_FEATURES.has(featureId);
}

export function isSettingsSectionHiddenInBrowser(section: string): boolean {
  return isWebBuild && HIDDEN_SETTINGS_SECTIONS.has(section);
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
