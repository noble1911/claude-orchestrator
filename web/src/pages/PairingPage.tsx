import { useState, useRef, useEffect, type KeyboardEvent } from "react";

interface PairingPageProps {
  onConnect: (wsUrl: string, pairingCode: string) => void;
  error: string | null;
}

function PairingPage({ onConnect, error }: PairingPageProps) {
  const [code, setCode] = useState(["", "", "", "", "", ""]);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  const handleDigit = (index: number, value: string) => {
    if (!/^\d?$/.test(value)) return;
    const next = [...code];
    next[index] = value;
    setCode(next);

    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all 6 digits entered
    if (value && index === 5 && next.every((d) => d !== "")) {
      const fullCode = next.join("");
      // Derive WS URL from current page URL
      const host = window.location.hostname;
      const wsUrl = `ws://${host}:3001`;
      onConnect(wsUrl, fullCode);
    }
  };

  const handleKeyDown = (index: number, e: KeyboardEvent) => {
    if (e.key === "Backspace" && !code[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (pasted.length === 0) return;
    const next = [...code];
    for (let i = 0; i < pasted.length; i++) {
      next[i] = pasted[i];
    }
    setCode(next);
    if (pasted.length === 6) {
      const host = window.location.hostname;
      const wsUrl = `ws://${host}:3001`;
      onConnect(wsUrl, pasted);
    } else {
      inputRefs.current[pasted.length]?.focus();
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center md-surface">
      <div className="md-card w-full max-w-md space-y-8 p-8">
        <div className="text-center space-y-3">
          <h1 className="text-2xl font-semibold md-text-strong">Claude Orchestrator</h1>
          <p className="text-sm md-text-muted">
            Enter the 6-digit pairing code shown in the desktop app
          </p>
        </div>

        <div className="flex justify-center gap-3" onPaste={handlePaste}>
          {code.map((digit, i) => (
            <input
              key={i}
              ref={(el) => { inputRefs.current[i] = el; }}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={digit}
              onChange={(e) => handleDigit(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              className="md-field !w-11 !min-h-[56px] !p-0 text-center text-2xl font-mono md-text-strong"
            />
          ))}
        </div>

        {error && (
          <div className="md-card !bg-red-500/10 !border-red-500/25 p-3 text-center text-sm text-rose-300">
            {error}
          </div>
        )}

        <div className="text-center text-xs md-text-faint">
          The pairing code is displayed in the desktop app under Remote Access settings.
        </div>
      </div>
    </div>
  );
}

export default PairingPage;
