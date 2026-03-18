import { useState } from "react";
import {
  isBuiltInTheme,
  normalizeThemeId,
  type ThemeMap,
} from "../themes";
import {
  SIDEBAR_FONT_SIZE_OPTIONS,
  CHAT_FONT_SIZE_OPTIONS,
} from "../constants";

interface SettingsModalProps {
  onClose: () => void;

  // Theme
  selectedTheme: string;
  onThemeChange: (themeId: string) => void;
  themeOptions: Array<{ value: string; label: string; description?: string }>;
  availableThemes: ThemeMap;
  onCreateTheme: () => void;
  onEditTheme: () => void;
  onDeleteTheme: () => void;

  // Font sizes
  sidebarFontSize: number;
  onSidebarFontSizeChange: (size: number) => void;
  chatFontSize: number;
  onChatFontSizeChange: (size: number) => void;

  // Environment
  envOverridesText: string;
  onEnvOverridesChange: (text: string) => void;
  bedrockEnabled: boolean;
  onBedrockToggle: (enabled: boolean) => void;
}

type SettingsTab = "appearance" | "environment";

export default function SettingsModal({
  onClose,
  selectedTheme,
  onThemeChange,
  themeOptions,
  availableThemes,
  onCreateTheme,
  onEditTheme,
  onDeleteTheme,
  sidebarFontSize,
  onSidebarFontSizeChange,
  chatFontSize,
  onChatFontSizeChange,
  envOverridesText,
  onEnvOverridesChange,
  bedrockEnabled,
  onBedrockToggle,
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("appearance");

  function handleBackdropKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }

  return (
    <div
      className="md-dialog-scrim fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
      onKeyDown={handleBackdropKeyDown}
      role="presentation"
    >
      <div
        className="md-dialog mx-4 flex w-full max-w-2xl flex-col"
        style={{ maxHeight: "80vh" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b md-outline p-4">
          <h3 className="text-lg font-semibold md-text-strong">Settings</h3>
          <button
            type="button"
            onClick={onClose}
            className="md-icon-plain !h-8 !w-8 rounded-full hover:md-surface-subtle"
            aria-label="Close settings"
          >
            <span className="material-symbols-rounded !text-[18px]">close</span>
          </button>
        </div>

        {/* Tab strip */}
        <div className="border-b md-outline md-px-4 pt-2">
          <div className="md-segmented text-xs">
            <button
              className={`md-segmented-btn ${activeTab === "appearance" ? "md-segmented-btn-active" : ""}`}
              onClick={() => setActiveTab("appearance")}
            >
              Appearance
            </button>
            <button
              className={`md-segmented-btn ${activeTab === "environment" ? "md-segmented-btn-active" : ""}`}
              onClick={() => setActiveTab("environment")}
            >
              Environment
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-5">
          {activeTab === "appearance" && (
            <>
              {/* Theme */}
              <section>
                <p className="mb-2 text-sm font-medium md-text-secondary">Theme</p>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <select
                      value={selectedTheme}
                      onChange={(e) =>
                        onThemeChange(normalizeThemeId(e.target.value, availableThemes))
                      }
                      className="md-select flex-1 !min-h-0"
                      aria-label="Theme selection"
                    >
                      {themeOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={onCreateTheme}
                      className="md-icon-plain !h-8 !w-8 rounded-full border md-outline hover:md-surface-subtle"
                      title="Create theme"
                      aria-label="Create theme"
                    >
                      <span className="material-symbols-rounded !text-[18px]">add</span>
                    </button>
                    <button
                      type="button"
                      onClick={onEditTheme}
                      disabled={isBuiltInTheme(selectedTheme)}
                      className="md-icon-plain !h-8 !w-8 rounded-full border md-outline hover:md-surface-subtle disabled:cursor-not-allowed disabled:opacity-40"
                      title={isBuiltInTheme(selectedTheme) ? "Only custom themes are editable" : "Edit theme"}
                      aria-label="Edit theme"
                    >
                      <span className="material-symbols-rounded !text-[16px]">edit</span>
                    </button>
                    <button
                      type="button"
                      onClick={onDeleteTheme}
                      disabled={isBuiltInTheme(selectedTheme)}
                      className="md-icon-plain md-icon-plain-danger !h-8 !w-8 rounded-full border md-outline hover:md-surface-subtle disabled:cursor-not-allowed disabled:opacity-40"
                      title={isBuiltInTheme(selectedTheme) ? "Built-in themes cannot be deleted" : "Delete custom theme"}
                      aria-label="Delete custom theme"
                    >
                      <span className="material-symbols-rounded !text-[16px]">delete</span>
                    </button>
                  </div>
                  <p className="text-[11px] md-text-muted">
                    {themeOptions.find((o) => o.value === selectedTheme)?.description}
                  </p>
                  <p className="text-[11px] md-text-muted">
                    Use + to create themes from the app. Built-ins stay unchanged.
                  </p>
                </div>
              </section>

              {/* Font sizes */}
              <section className="border-t md-outline pt-4">
                <p className="mb-3 text-sm font-medium md-text-secondary">Font Sizes</p>
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm md-text-strong">Sidebar &amp; panels</p>
                      <p className="text-[11px] md-text-muted">Left and right panel text size</p>
                    </div>
                    <select
                      value={sidebarFontSize}
                      onChange={(e) => onSidebarFontSizeChange(Number(e.target.value))}
                      className="md-select !min-h-0 !w-auto"
                      aria-label="Sidebar font size"
                    >
                      {SIDEBAR_FONT_SIZE_OPTIONS.map((size) => (
                        <option key={size} value={size}>
                          {size}px{size === 12 ? " (default)" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm md-text-strong">Chat window</p>
                      <p className="text-[11px] md-text-muted">Messages and agent responses</p>
                    </div>
                    <select
                      value={chatFontSize}
                      onChange={(e) => onChatFontSizeChange(Number(e.target.value))}
                      className="md-select !min-h-0 !w-auto"
                      aria-label="Chat font size"
                    >
                      {CHAT_FONT_SIZE_OPTIONS.map((size) => (
                        <option key={size} value={size}>
                          {size}px{size === 14 ? " (default)" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </section>
            </>
          )}

          {activeTab === "environment" && (
            <section>
              <p className="mb-1 text-sm font-medium md-text-secondary">Environment overrides</p>
              <p className="mb-3 text-[11px] md-text-muted">
                Supports <code className="font-mono">export KEY=VALUE</code> or <code className="font-mono">KEY=VALUE</code>.
                Applied to agents, chat and terminal commands.
              </p>
              <label className="mb-3 flex items-center gap-2 rounded-md border px-2 py-1.5 md-outline cursor-pointer">
                <input
                  type="checkbox"
                  checked={bedrockEnabled}
                  onChange={(e) => onBedrockToggle(e.target.checked)}
                  className="h-4 w-4 accent-sky-500"
                />
                <span className="text-sm md-text-strong">
                  Use AWS Bedrock (<code className="font-mono text-[11px]">CLAUDE_CODE_USE_BEDROCK=1</code>)
                </span>
              </label>
              <textarea
                value={envOverridesText}
                onChange={(e) => onEnvOverridesChange(e.target.value)}
                rows={10}
                className="md-field font-mono text-xs"
                placeholder={"export CLAUDE_CODE_USE_BEDROCK=1\n# optional if not using default profile\nexport AWS_PROFILE=your-profile"}
              />
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end border-t md-outline p-4">
          <button type="button" onClick={onClose} className="md-btn md-btn-tonal">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
