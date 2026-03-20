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
}

export default function ToolbarDropdown({ value, options, onChange, icon, ariaLabel }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex items-center gap-1 rounded-full border border-white/10 bg-black/20 px-2 h-7 text-[11px] md-text-secondary hover:bg-black/30 hover:md-text-primary transition-colors"
      >
        <span className="material-symbols-rounded !text-[14px]">{icon}</span>
        <span>{selected?.label}</span>
        <span className="material-symbols-rounded !text-[12px] opacity-50">expand_more</span>
      </button>

      {open && (
        <div className="absolute bottom-full mb-1.5 left-0 z-50 min-w-[110px] rounded-xl border border-white/10 bg-[var(--md-sys-color-surface-container)] shadow-2xl py-1 overflow-hidden">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 hover:bg-white/10 transition-colors ${
                opt.value === value ? "md-text-primary font-medium" : "md-text-secondary"
              }`}
            >
              <span className={`material-symbols-rounded !text-[13px] text-sky-400 ${opt.value === value ? "" : "opacity-0"}`}>
                check
              </span>
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
