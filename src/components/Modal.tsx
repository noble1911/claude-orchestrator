import { useEffect, useRef, type ReactNode } from "react";

interface ModalProps {
  onClose: () => void;
  maxWidth?: string;
  children: ReactNode;
  ariaLabel?: string;
}

export default function Modal({ onClose, maxWidth = "max-w-md", children, ariaLabel }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="md-dialog-scrim fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className={`md-dialog mx-4 w-full ${maxWidth}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
      >
        {children}
      </div>
    </div>
  );
}
