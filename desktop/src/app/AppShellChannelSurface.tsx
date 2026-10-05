import { useLocation } from "@tanstack/react-router";
import * as React from "react";
import * as BuzzTheme from "@/app/BuzzThemeSurfaces";
import { HuddleRoomHeader, HuddleStartingView } from "@/features/huddle";
import { MainInsetProvider } from "@/shared/layout/MainInsetContext";
import { chromeCssVarDefaults } from "@/shared/layout/chromeLayout";
import { cn } from "@/shared/lib/cn";
import { SidebarInset, useSidebar } from "@/shared/ui/sidebar";
import { isWebBuild } from "@/web/capabilities";

type AppShellChannelSurfaceProps = {
  children: React.ReactNode;
  hasCommunityRail: boolean;
  isHuddleRoom: boolean;
  isHuddleRoomStarting: boolean;
  mainInsetRef: React.RefObject<HTMLElement | null>;
  terminal?: React.ReactNode;
};

export function AppShellChannelSurface({
  children,
  hasCommunityRail,
  isHuddleRoom,
  isHuddleRoomStarting,
  mainInsetRef,
  terminal,
}: AppShellChannelSurfaceProps) {
  const {
    isMobile,
    openMobile,
    setOpenMobile,
    state: sidebarState,
  } = useSidebar();
  const { pathname } = useLocation();
  // The mobile drawer is a navigator: picking a destination dismisses it.
  React.useEffect(() => {
    if (pathname) setOpenMobile(false);
  }, [pathname, setOpenMobile]);
  // Phones get an edge-to-edge screen instead of an inset card.
  const unframed = isHuddleRoom || (isWebBuild && isMobile);
  const hasCollapsedSidebarGutter =
    !unframed &&
    !hasCommunityRail &&
    (isMobile ? !openMobile : sidebarState === "collapsed");

  return (
    <MainInsetProvider mainInsetRef={mainInsetRef}>
      <SidebarInset
        ref={mainInsetRef}
        className={cn(
          "isolate z-0 min-h-0 min-w-0 overflow-hidden",
          isHuddleRoom ? "bg-background" : "bg-sidebar",
          hasCollapsedSidebarGutter && "pl-2",
        )}
        data-buzz-content-surface={isHuddleRoom ? true : undefined}
        data-buzz-content-unframed={isHuddleRoom ? true : undefined}
        data-buzz-glass-inset
        data-buzz-shadow-viewport
        style={chromeCssVarDefaults as React.CSSProperties}
      >
        {hasCollapsedSidebarGutter ? (
          <div
            className="absolute inset-y-0 left-0 w-2 bg-sidebar"
            data-collapsed-content-gutter
          />
        ) : null}
        {isHuddleRoom && !isHuddleRoomStarting ? <HuddleRoomHeader /> : null}
        <BuzzTheme.ContentSurface terminal={terminal} unframed={unframed}>
          {isHuddleRoomStarting ? <HuddleStartingView /> : children}
        </BuzzTheme.ContentSurface>
      </SidebarInset>
    </MainInsetProvider>
  );
}
