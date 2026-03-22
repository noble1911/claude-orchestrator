import { useState, useRef, useEffect } from "react";

interface Option {
  value: string;
  label: string;
}

interface Props {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  icon: string;
  ariaLabel?: string;
  /** Label to show when no option matches the value (for action menus) */
  placeholder?: string;
  /** Direction the popover opens. Defaults to "up" */
  direction?: "up" | "down";
}

export default function ToolbarDropdown({ value, options, onChange, icon, ariaLabel, placeholder, direction = "up" }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);
  const showCheck = selected !== undefined;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const popoverPosition = direction === "up"
    ? "bottom-full mb-1.5"
    : "top-full mt-1.5";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex items-center gap-1.5 px-1.5 h-7 text-[13px] md-text-secondary hover:md-text-primary transition-colors"
      >
        <span className="material-symbols-rounded !text-[18px] opacity-70">{icon}</span>
        <span>{selected?.label ?? placeholder}</span>
        <span className="material-symbols-rounded !text-[14px] opacity-40">expand_more</span>
      </button>

      {open && (
        <div className={`absolute ${popoverPosition} left-0 z-50 min-w-[130px] rounded-xl border border-white/10 bg-[var(--md-sys-color-surface-container)] shadow-2xl py-1 overflow-hidden`}>
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-1.5 text-[13px] flex items-center gap-2 hover:bg-white/10 transition-colors ${
                opt.value === value ? "md-text-primary font-medium" : "md-text-secondary"
              }`}
            >
              {showCheck && (
                <span className={`material-symbols-rounded !text-[14px] text-sky-400 ${opt.value === value ? "" : "opacity-0"}`}>
                  check
                </span>
              )}
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
