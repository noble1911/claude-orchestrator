import { useState } from "react";
import LeftSidebar from "../panels/LeftSidebar";
import CenterPanel from "../panels/CenterPanel";
import RightPanel from "../panels/RightPanel";

function MainPage() {
  const [showRight, setShowRight] = useState(true);

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
