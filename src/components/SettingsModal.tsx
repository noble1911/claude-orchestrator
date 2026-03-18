import { useEffect, useRef, useState } from "react";
import {
  isBuiltInTheme,
  normalizeThemeId,
  type ThemeMap,
} from "../themes";
import {
  SIDEBAR_FONT_SIZE_OPTIONS,
  CHAT_FONT_SIZE_OPTIONS,
  MODEL_OPTIONS,
  DEFAULT_MODEL_ID,
} from "../constants";
import type { ShortcutBinding, ShortcutKeys } from "../types";
import {
  activeKeys,
  formatKeyCombination,
  recordKeysFromEvent,
  detectShortcutConflict,
} from "../utils";

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

  // Default model
  defaultModel: string;
  onDefaultModelChange: (model: string) => void;

  // Environment
  envOverridesText: string;
  onEnvOverridesChange: (text: string) => void;
  bedrockEnabled: boolean;
  onBedrockToggle: (enabled: boolean) => void;

  // Shortcuts
  shortcuts: ShortcutBinding[];
  onShortcutChange: (id: string, newKeys: ShortcutKeys) => void;
  onShortcutReset: (id: string) => void;
  onShortcutResetAll: () => void;

  // Tab control
  initialTab?: SettingsTab;
}

type SettingsTab = "appearance" | "environment" | "shortcuts";

export type { SettingsTab };

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
  defaultModel,
  onDefaultModelChange,
  envOverridesText,
  onEnvOverridesChange,
  bedrockEnabled,
  onBedrockToggle,
  shortcuts,
  onShortcutChange,
  onShortcutReset,
  onShortcutResetAll,
  initialTab,
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? "appearance");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [conflictWarning, setConflictWarning] = useState<{ id: string; keys: ShortcutKeys; conflictLabel: string } | null>(null);
  const recordingRef = useRef<string | null>(null);

  // Keep ref in sync so the keydown listener always reads latest value
  useEffect(() => {
    recordingRef.current = recordingId;
  }, [recordingId]);

  // Global keydown listener for recording shortcut bindings
  useEffect(() => {
    if (!recordingId) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setRecordingId(null);
        return;
      }

      const keys = recordKeysFromEvent(e);
      if (!keys) return; // bare modifier press

      const currentId = recordingRef.current;
      if (!currentId) return;

      // Check for conflicts
      const conflict = detectShortcutConflict(shortcuts, currentId, keys);
      if (conflict) {
        setConflictWarning({ id: currentId, keys, conflictLabel: conflict });
        setRecordingId(null);
        return;
      }

      onShortcutChange(currentId, keys);
      setRecordingId(null);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [recordingId, shortcuts, onShortcutChange]);

  function handleBackdropKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape" && !recordingId) onClose();
  }

  function confirmConflictOverride() {
    if (!conflictWarning) return;
    onShortcutChange(conflictWarning.id, conflictWarning.keys);
    setConflictWarning(null);
  }

  const hasCustomShortcuts = shortcuts.some((s) => s.customKeys && !s.readonly);

  return (
    <div
      className="md-dialog-scrim fixed inset-0 z-50 flex items-center justify-center"
      onClick={() => { if (!recordingId) onClose(); }}
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
            <button
              className={`md-segmented-btn ${activeTab === "shortcuts" ? "md-segmented-btn-active" : ""}`}
              onClick={() => setActiveTab("shortcuts")}
            >
              Shortcuts
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

              {/* Default model */}
              <section className="border-t md-outline pt-4">
                <p className="mb-3 text-sm font-medium md-text-secondary">Default Model</p>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm md-text-strong">Workspace model</p>
                    <p className="text-[11px] md-text-muted">Model used for newly created workspaces</p>
                  </div>
                  <select
                    value={defaultModel}
                    onChange={(e) => onDefaultModelChange(e.target.value)}
                    className="md-select !min-h-0 !w-auto"
                    aria-label="Default model"
                  >
                    {MODEL_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}{option.value === DEFAULT_MODEL_ID ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
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

          {activeTab === "shortcuts" && (
            <section>
              <p className="mb-1 text-sm font-medium md-text-secondary">Keyboard Shortcuts</p>
              <p className="mb-3 text-[11px] md-text-muted">
                Click a shortcut key to rebind it. Press Escape to cancel recording.
              </p>

              <div className="space-y-1">
                {shortcuts.map((binding) => {
                  const keys = activeKeys(binding);
                  const isModified = !!binding.customKeys && !binding.readonly;
                  const isRecording = recordingId === binding.id;

                  return (
                    <div
                      key={binding.id}
                      className={`flex items-center justify-between rounded-md px-2 py-2 ${isRecording ? "md-surface ring-1 ring-sky-500" : ""}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm md-text-secondary">{binding.label}</span>
                        {isModified && (
                          <span className="h-1.5 w-1.5 rounded-full bg-sky-500" title="Customized" />
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {isRecording ? (
                          <span className="px-2 py-1 rounded md-surface text-xs font-mono animate-pulse md-text-muted">
                            Press keys...
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              if (!binding.readonly) setRecordingId(binding.id);
                            }}
                            disabled={binding.readonly}
                            className={`px-2 py-1 rounded md-surface text-xs font-mono ${
                              binding.readonly
                                ? "opacity-60 cursor-not-allowed"
                                : "hover:ring-1 hover:ring-sky-500 cursor-pointer"
                            }`}
                            title={binding.readonly ? "System-managed shortcut" : "Click to rebind"}
                          >
                            {keys.displayLabel || formatKeyCombination(keys)}
                          </button>
                        )}
                        {binding.readonly && (
                          <span
                            className="material-symbols-rounded !text-[14px] md-text-muted"
                            title="System-managed shortcut"
                          >
                            lock
                          </span>
                        )}
                        {isModified && !isRecording && (
                          <button
                            type="button"
                            onClick={() => onShortcutReset(binding.id)}
                            className="md-icon-plain !h-6 !w-6 rounded-full hover:md-surface-subtle"
                            title={`Reset to ${binding.defaultKeys.displayLabel || formatKeyCombination(binding.defaultKeys)}`}
                          >
                            <span className="material-symbols-rounded !text-[14px]">undo</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {hasCustomShortcuts && (
                <div className="mt-4 border-t md-outline pt-3">
                  <button
                    type="button"
                    onClick={onShortcutResetAll}
                    className="text-xs md-text-muted hover:md-text-secondary underline"
                  >
                    Reset all to defaults
                  </button>
                </div>
              )}
            </section>
          )}
        </div>

        {/* Conflict warning dialog */}
        {conflictWarning && (
          <div className="border-t md-outline px-4 py-3 flex items-center gap-3 md-surface">
            <span className="material-symbols-rounded !text-[18px] text-amber-500">warning</span>
            <p className="flex-1 text-xs md-text-secondary">
              <strong>{formatKeyCombination(conflictWarning.keys)}</strong> is already used by{" "}
              <strong>{conflictWarning.conflictLabel}</strong>. Override?
            </p>
            <button
              type="button"
              onClick={() => setConflictWarning(null)}
              className="md-btn md-btn-text text-xs"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmConflictOverride}
              className="md-btn md-btn-tonal text-xs"
            >
              Override
            </button>
          </div>
        )}

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
