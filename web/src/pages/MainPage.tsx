import { useState, useEffect } from "react";
import { useMobile } from "../hooks/useMediaQuery";
import { useWorkspaceStore } from "../stores/workspaces";
import LeftSidebar from "../panels/LeftSidebar";
import CenterPanel from "../panels/CenterPanel";
import RightPanel from "../panels/RightPanel";

type MobileView = "workspaces" | "chat" | "tools";

function MainPage() {
  const isMobile = useMobile();
  const [showRight, setShowRight] = useState(true);
  const [mobileView, setMobileView] = useState<MobileView>("workspaces");

  const selectedWorkspaceId = useWorkspaceStore((s) => s.selectedWorkspaceId);

  // When workspace is deselected, go back to workspace list on mobile
  useEffect(() => {
    if (isMobile && !selectedWorkspaceId) {
      setMobileView("workspaces");
    }
  }, [isMobile, selectedWorkspaceId]);

  // ── Mobile layout: stacked navigation ──
  if (isMobile) {
    return (
      <div className="h-[100dvh] flex flex-col">
        {mobileView === "workspaces" && (
          <LeftSidebar onSelectWorkspace={() => setMobileView("chat")} />
        )}
        {mobileView === "chat" && (
          <CenterPanel
            onBack={() => setMobileView("workspaces")}
            onOpenTools={() => setMobileView("tools")}
          />
        )}
        {mobileView === "tools" && (
          <RightPanel onBack={() => setMobileView("chat")} />
        )}
      </div>
    );
  }

  // ── Desktop layout: 3-panel side-by-side ──
  return (
    <div className="flex h-screen">
      {/* Left sidebar */}
      <div className="w-64 flex-shrink-0 border-r md-outline overflow-hidden">
        <LeftSidebar />
      </div>

      {/* Center chat panel */}
      <div className="flex-1 min-w-0">
        <CenterPanel />
      </div>

      {/* Right panel toggle */}
      <button
        type="button"
        className="absolute right-2 top-2 z-20 md-btn md-icon-btn"
        onClick={() => setShowRight(!showRight)}
        title={showRight ? "Hide panel" : "Show panel"}
      >
        <span className="material-symbols-rounded !text-[16px]">
          {showRight ? "right_panel_close" : "right_panel_open"}
        </span>
      </button>

      {/* Right panel */}
      {showRight && (
        <div className="w-72 flex-shrink-0 border-l md-outline overflow-hidden">
          <RightPanel />
        </div>
      )}
    </div>
  );
}

export default MainPage;
