import { useState, useEffect } from "react";

interface ThinkingTimerProps {
  thinkingSince: number;
  latestSystemMessage: string | null;
}

function ThinkingTimer({ thinkingSince, latestSystemMessage }: ThinkingTimerProps) {
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    const tick = () => setElapsedSec(Math.max(0, Math.floor((Date.now() - thinkingSince) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [thinkingSince]);

  return (
    <div className="md-px-1 md-py-2 text-xs md-text-muted">
      <span className="inline-flex items-center gap-2">
        <span className="h-2 w-2 animate-pulse rounded-full bg-amber-300" />
        Agent running... {elapsedSec}s
      </span>
      {latestSystemMessage && (
        <span className="ml-2 md-text-faint">Last step: {latestSystemMessage}</span>
      )}
    </div>
  );
}

export default ThinkingTimer;
