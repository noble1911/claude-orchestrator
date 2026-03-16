import { type ReactNode, isValidElement } from "react";

export function extractTextFromNode(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((item) => extractTextFromNode(item)).join("");
  if (isValidElement(node)) return extractTextFromNode((node.props as { children?: ReactNode }).children);
  return "";
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
      return true;
    } catch {
      return false;
    }
  }
}

export function openExternalHref(rawHref?: string | null): void {
  if (!rawHref) return;
  window.open(rawHref, "_blank", "noopener,noreferrer");
}

export function statusLabel(status: string): string {
  switch (status) {
    case "running": return "Running";
    case "idle": return "Idle";
    case "inReview": return "In Review";
    case "merged": return "Merged";
    case "initializing": return "Initializing";
    default: return status;
  }
}

export function statusColor(status: string): string {
  switch (status) {
    case "running": return "#34d399";
    case "idle": return "#71717a";
    case "inReview": return "#fbbf24";
    case "merged": return "#a78bfa";
    case "initializing": return "#fbbf24";
    default: return "#71717a";
  }
}
