import { useState, useCallback } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { useConnectionStore } from "./stores/connection";
import PairingPage from "./pages/PairingPage";
import MainPage from "./pages/MainPage";

function App() {
  const [wsUrl, setWsUrl] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const connState = useConnectionStore((s) => s.state);
  const error = useConnectionStore((s) => s.error);

  // Only activate WebSocket when we have both URL and code
  useWebSocket(wsUrl, pairingCode);

  const handleConnect = useCallback((url: string, code: string) => {
    setWsUrl(url);
    setPairingCode(code);
  }, []);

  if (connState === "connected") {
    return <MainPage />;
  }

  // Show reconnecting banner if we had a connection (wsUrl set) but lost it
  if (wsUrl && pairingCode && (connState === "connecting" || connState === "authenticating")) {
    return (
      <div className="h-[100dvh] flex flex-col">
        <div className="flex items-center justify-center gap-2 bg-amber-500/15 border-b border-amber-500/30 px-4 py-2.5">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />
          <span className="text-xs text-amber-300">Reconnecting...</span>
        </div>
        <div className="flex-1">
          <MainPage />
        </div>
      </div>
    );
  }

  return (
    <PairingPage
      onConnect={handleConnect}
      error={
        connState === "authenticating"
          ? "Authenticating..."
          : connState === "connecting"
            ? "Connecting..."
            : error
      }
    />
  );
}

export default App;
