import { type ReactNode, isValidElement } from "react";
import type { ActivityLine, AskUserQuestionPayload, QuestionItem, QuestionOption } from "../types";

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

export const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

function normalizeExternalHref(rawHref?: string | null): string | null {
  if (!rawHref) return null;
  const trimmed = rawHref.trim();
  if (!trimmed) return null;
  const candidate = /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function splitTextWithUrls(text: string): Array<{ text: string; href?: string }> {
  const output: Array<{ text: string; href?: string }> = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const raw = match[0];
    if (index > lastIndex) output.push({ text: text.slice(lastIndex, index) });

    let candidate = raw;
    let trailing = "";
    while (candidate.length > 0 && /[),.;!?]$/.test(candidate)) {
      trailing = candidate.slice(-1) + trailing;
      candidate = candidate.slice(0, -1);
    }

    const href = normalizeExternalHref(candidate);
    if (href) {
      output.push({ text: candidate, href });
    } else {
      output.push({ text: raw });
      trailing = "";
    }

    if (trailing) output.push({ text: trailing });
    lastIndex = index + raw.length;
  }

  if (lastIndex < text.length) output.push({ text: text.slice(lastIndex) });
  return output.length > 0 ? output : [{ text }];
}

export function compactActivityLines(messages: { content: string }[]): ActivityLine[] {
  const lines: ActivityLine[] = [];
  for (const message of messages) {
    const text = message.content.trim();
    if (!text) continue;
    const last = lines[lines.length - 1];
    if (last && last.text === text) {
      last.count += 1;
      continue;
    }
    lines.push({ text, count: 1 });
  }
  return lines;
}

export function parseAskUserQuestionPayload(raw: string): AskUserQuestionPayload | null {
  try {
    const parsed = JSON.parse(raw) as { questions?: unknown };
    if (!parsed || !Array.isArray(parsed.questions)) return null;

    const questions: QuestionItem[] = parsed.questions
      .map((item: unknown) => {
        const source = item as {
          question?: unknown;
          header?: unknown;
          multiSelect?: unknown;
          options?: unknown;
        };
        const question = typeof source.question === "string" ? source.question.trim() : "";
        const header = typeof source.header === "string" ? source.header.trim() : undefined;
        const multiSelect = typeof source.multiSelect === "boolean" ? source.multiSelect : undefined;
        const options: QuestionOption[] = [];
        if (Array.isArray(source.options)) {
          for (const opt of source.options) {
            const optSource = opt as { label?: unknown; description?: unknown };
            const label = typeof optSource.label === "string" ? optSource.label.trim() : "";
            if (!label) continue;
            const description =
              typeof optSource.description === "string" ? optSource.description.trim() : undefined;
            const normalized: QuestionOption = { label };
            if (description) normalized.description = description;
            options.push(normalized);
          }
        }
        return { question, header, multiSelect, options };
      })
      .filter((item: QuestionItem) => item.question.length > 0 || (item.options?.length ?? 0) > 0);

    if (questions.length === 0) return null;
    return { questions };
  } catch {
    return null;
  }
}

export function buildBundledQuestionAnswerText(
  payload: AskUserQuestionPayload,
  selectedAnswersByQuestion: Record<number, string[]>,
): string {
  return payload.questions
    .map((question, questionIdx) => {
      const promptText = question.question || question.header || `Question ${questionIdx + 1}`;
      const selectedValues = selectedAnswersByQuestion[questionIdx] || [];
      return `${questionIdx + 1}. ${promptText}: ${selectedValues.join(", ")}`;
    })
    .join("\n");
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
