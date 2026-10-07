import { SettingsSectionHeader } from "@/features/settings/ui/SettingsSectionHeader";
import { DESKTOP_ONLY_SETTINGS } from "./capabilities";

// A settings section the browser can't run: say what it is and where it lives,
// rather than hiding it.
export function DesktopOnlyPanel({
  label,
  section,
}: {
  label: string;
  section: string;
}) {
  return (
    <section
      className="min-w-0"
      data-testid={`settings-desktop-only-${section}`}
    >
      <SettingsSectionHeader
        title={label}
        description={
          <>
            {DESKTOP_ONLY_SETTINGS[section]} This section is available in the{" "}
            <a
              className="underline underline-offset-2"
              href="https://github.com/block/buzz/releases"
              rel="noreferrer"
              target="_blank"
            >
              Buzz desktop app
            </a>
            , connected to this same workspace.
          </>
        }
      />
    </section>
  );
}
