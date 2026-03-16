import { memo, type MouseEvent as ReactMouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import MarkdownCodeBlock from "./MarkdownCodeBlock";
import { openExternalHref } from "../utils";

const MarkdownMessage = memo(function MarkdownMessage({ content }: { content: string }) {
  const normalizedContent = content.replace(/\r\n/g, "\n");
  if (!normalizedContent.trim()) {
    return <p className="whitespace-pre-wrap text-sm md-text-primary">{normalizedContent}</p>;
  }

  return (
    <div className="space-y-3 select-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          p: ({ children }) => (
            <p className="m-0 whitespace-pre-wrap text-sm leading-relaxed md-text-primary">{children}</p>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-white/35 underline-offset-2 hover:decoration-white/70"
              onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
                event.preventDefault();
                void openExternalHref(href);
              }}
            >
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="font-semibold md-text-strong">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ className, children }) => {
            const text = String(children ?? "");
            const isBlock = Boolean(className?.includes("language-")) || text.includes("\n");
            if (isBlock) {
              return <code className={className}>{children}</code>;
            }
            return <code className="rounded-md bg-white/10 px-1.5 py-0.5 font-mono text-[12px]">{children}</code>;
          },
          pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock>,
          h1: ({ children }) => <h1 className="m-0 text-xl font-semibold leading-snug md-text-strong">{children}</h1>,
          h2: ({ children }) => <h2 className="m-0 text-lg font-semibold leading-snug md-text-strong">{children}</h2>,
          h3: ({ children }) => <h3 className="m-0 text-base font-semibold leading-snug md-text-strong">{children}</h3>,
          h4: ({ children }) => <h4 className="m-0 text-sm font-semibold leading-snug md-text-strong">{children}</h4>,
          h5: ({ children }) => <h5 className="m-0 text-sm font-medium leading-snug md-text-strong">{children}</h5>,
          h6: ({ children }) => <h6 className="m-0 text-sm font-medium leading-snug md-text-dim">{children}</h6>,
          ul: ({ children }) => <ul className="m-0 ml-5 list-disc space-y-1.5 text-sm md-text-primary">{children}</ul>,
          ol: ({ children }) => (
            <ol className="m-0 ml-5 list-decimal space-y-1.5 text-sm md-text-primary">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          hr: () => <hr className="border-0 border-t md-outline" />,
          blockquote: ({ children }) => (
            <blockquote className="m-0 border-l-2 border-white/20 pl-3 text-sm leading-relaxed italic md-text-dim">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto rounded-lg border md-outline">
              <table className="w-full border-collapse text-xs md-text-primary">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-white/5">{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => <tr className="border-t md-outline">{children}</tr>,
          th: ({ children }) => (
            <th className="border-r md-outline px-2 py-1 text-left font-semibold md-text-strong last:border-r-0">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-r md-outline px-2 py-1 align-top last:border-r-0">{children}</td>
          ),
        }}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
});

export default MarkdownMessage;
