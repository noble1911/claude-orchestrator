import { useState } from "react";
import Modal from "../Modal";
import {
  COLOR_TOKEN_KEYS,
  THEME_COLOR_FIELDS,
  type ThemeColorTokenKey,
  type ThemeDefinition,
  type ThemeMap,
  createThemeId,
  isHexColor,
} from "../../themes";
import { cloneThemeColors } from "../../utils";
import type { ThemeDraft } from "../../types";

interface ThemeDialogProps {
  editingThemeId: string | null;
  initialDraft: ThemeDraft;
  availableThemes: ThemeMap;
  onClose: () => void;
  onSave: (theme: ThemeDefinition) => void;
  onError: (msg: string) => void;
}

export default function ThemeDialog({
  editingThemeId,
  initialDraft,
  availableThemes,
  onClose,
  onSave,
  onError,
}: ThemeDialogProps) {
  const [draft, setDraft] = useState<ThemeDraft>(initialDraft);

  function updateColor(token: ThemeColorTokenKey, value: string) {
    setDraft((prev) => ({
      ...prev,
      colors: { ...prev.colors, [token]: value },
    }));
  }

  function handleSave() {
    const label = draft.label.trim();
    if (!label) {
      onError("Theme name is required.");
      return;
    }
    if (!isHexColor(draft.rootText) || !isHexColor(draft.rootBackground)) {
      onError("Root colors must be valid hex values like #1a2b3c.");
      return;
    }
    for (const token of COLOR_TOKEN_KEYS) {
      if (!isHexColor(draft.colors[token])) {
        onError(`Invalid color for ${token}. Use hex format like #1a2b3c.`);
        return;
      }
    }

    const id = editingThemeId ?? createThemeId(label, availableThemes);
    onSave({
      id,
      label,
      description: draft.description.trim() || `Custom theme: ${label}`,
      rootText: draft.rootText,
      rootBackground: draft.rootBackground,
      colors: cloneThemeColors(draft.colors),
    });
  }

  return (
    <Modal onClose={onClose} maxWidth="max-w-2xl" ariaLabel={editingThemeId ? "Edit theme" : "Create theme"}>
      <div className="border-b md-outline p-4">
        <h3 className="text-lg font-semibold md-text-strong">
          {editingThemeId ? "Edit Theme" : "Create Theme"}
        </h3>
        <p className="mt-1 text-sm md-text-muted">
          Configure palette colors and save as a reusable custom theme.
        </p>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium md-text-secondary">Theme name</label>
            <input
              type="text"
              value={draft.label}
              onChange={(e) => setDraft((prev) => ({ ...prev, label: e.target.value }))}
              className="md-field"
              placeholder="e.g. Solarized Dark"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium md-text-secondary">Description</label>
            <input
              type="text"
              value={draft.description}
              onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))}
              className="md-field"
              placeholder="Short note shown in theme picker"
            />
          </div>
        </div>

        <div className="rounded-lg border md-outline p-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide md-text-muted">Root Colors</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-xs md-text-muted">
              <span className="w-28">Root text</span>
              <input
                type="color"
                value={draft.rootText}
                onChange={(e) => setDraft((prev) => ({ ...prev, rootText: e.target.value }))}
                className="h-8 w-10 rounded border md-outline bg-transparent p-0"
              />
              <input
                type="text"
                value={draft.rootText}
                onChange={(e) => setDraft((prev) => ({ ...prev, rootText: e.target.value }))}
                className="md-field !min-h-0 h-8 font-mono text-xs"
              />
            </label>
            <label className="flex items-center gap-2 text-xs md-text-muted">
              <span className="w-28">Root background</span>
              <input
                type="color"
                value={draft.rootBackground}
                onChange={(e) => setDraft((prev) => ({ ...prev, rootBackground: e.target.value }))}
                className="h-8 w-10 rounded border md-outline bg-transparent p-0"
              />
              <input
                type="text"
                value={draft.rootBackground}
                onChange={(e) => setDraft((prev) => ({ ...prev, rootBackground: e.target.value }))}
                className="md-field !min-h-0 h-8 font-mono text-xs"
              />
            </label>
          </div>
        </div>

        <div className="rounded-lg border md-outline p-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide md-text-muted">Material Tokens</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {THEME_COLOR_FIELDS.map((field) => (
              <label key={field.key} className="flex items-center gap-2 text-xs md-text-muted">
                <span className="w-36 truncate">{field.label}</span>
                <input
                  type="color"
                  value={draft.colors[field.key]}
                  onChange={(e) => updateColor(field.key, e.target.value)}
                  className="h-8 w-10 rounded border md-outline bg-transparent p-0"
                />
                <input
                  type="text"
                  value={draft.colors[field.key]}
                  onChange={(e) => updateColor(field.key, e.target.value)}
                  className="md-field !min-h-0 h-8 font-mono text-xs"
                />
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2 border-t md-outline p-4">
        <button onClick={onClose} className="md-btn">
          Cancel
        </button>
        <button onClick={handleSave} className="md-btn md-btn-tonal">
          {editingThemeId ? "Save Theme" : "Create Theme"}
        </button>
      </div>
    </Modal>
  );
}
