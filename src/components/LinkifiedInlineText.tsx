import type { MouseEvent as ReactMouseEvent } from "react";
import { splitTextWithUrls, openExternalHref } from "../utils";

function LinkifiedInlineText({ text, className = "" }: { text: string; className?: string }) {
  const segments = splitTextWithUrls(text);
  return (
    <>
      {segments.map((segment, index) => {
        if (!segment.href) {
          return <span key={`plain-${index}`}>{segment.text}</span>;
        }
        return (
          <a
            key={`link-${index}`}
            href={segment.href}
            target="_blank"
            rel="noreferrer"
            className={className}
            onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
              event.preventDefault();
              void openExternalHref(segment.href);
            }}
          >
            {segment.text}
          </a>
        );
      })}
    </>
  );
}

export default LinkifiedInlineText;
