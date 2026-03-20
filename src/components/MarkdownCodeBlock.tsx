import { useState, useMemo, type ReactNode } from "react";
import { extractTextFromNode, copyToClipboard } from "../utils";

function MarkdownCodeBlock({ children, v2 = false }: { children: ReactNode; v2?: boolean }) {
  const [copied, setCopied] = useState(false);
  const codeText = useMemo(() => extractTextFromNode(children).replace(/\n$/, ""), [children]);

  const handleCopy = () => {
    void copyToClipboard(codeText).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={handleCopy}
        className={`absolute right-2 top-2 z-10 inline-flex h-6 w-6 items-center justify-center rounded-md border border-white/20 bg-black/35 md-text-muted transition-opacity duration-150 hover:border-white/35 hover:md-text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-white/40 ${
          copied
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none group-hover:opacity-75 group-hover:pointer-events-auto group-focus-within:opacity-75 group-focus-within:pointer-events-auto"
        }`}
        title={copied ? "Copied" : "Copy code"}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        <span className="material-symbols-rounded !text-[14px]">
          {copied ? "check" : "content_copy"}
        </span>
      </button>
      <pre className={v2
        ? "m-0 max-h-[50vh] overflow-auto rounded-[5px] border-[0.5px] border-white/[0.08] bg-black/60 px-3 py-2 whitespace-pre font-mono text-[11.5px] leading-[1.6] md-text-primary"
        : "m-0 max-h-[50vh] overflow-auto rounded-xl border md-outline bg-black/45 px-3 py-2 whitespace-pre font-mono text-[12px] md-text-primary"
      }>
        {children}
      </pre>
    </div>
  );
}

export default MarkdownCodeBlock;
