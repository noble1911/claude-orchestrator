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
