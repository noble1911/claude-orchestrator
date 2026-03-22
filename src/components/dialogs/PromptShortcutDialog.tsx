import { useState } from "react";
import Modal from "../Modal";
import type { PromptShortcut } from "../../types";
import { normalizePromptName } from "../../utils";

interface PromptShortcutDialogProps {
  editingPrompt: PromptShortcut | null;
  existingPrompts: PromptShortcut[];
  onClose: () => void;
  onSave: (prompt: { id: string; name: string; prompt: string; autoRunOnCreate: boolean }) => void;
  onError: (msg: string) => void;
}

export default function PromptShortcutDialog({
  editingPrompt,
  existingPrompts,
  onClose,
  onSave,
  onError,
}: PromptShortcutDialogProps) {
  const [name, setName] = useState(editingPrompt?.name ?? "");
  const [body, setBody] = useState(editingPrompt?.prompt ?? "");
  const [autoRunOnCreate, setAutoRunOnCreate] = useState(editingPrompt?.autoRunOnCreate === true);

  function handleSave() {
    const trimmedName = name.trim();
    const trimmedBody = body.trim();
    if (!trimmedName || !trimmedBody) return;

    const normalized = normalizePromptName(trimmedName);
    const hasDuplicate = existingPrompts.some(
      (s) => s.id !== editingPrompt?.id && normalizePromptName(s.name) === normalized,
    );
    if (hasDuplicate) {
      onError(`Prompt name already exists: ${trimmedName}`);
      return;
    }

    onSave({
      id: editingPrompt?.id ?? `${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      name: trimmedName,
      prompt: trimmedBody,
      autoRunOnCreate,
    });
  }

  return (
    <Modal onClose={onClose} maxWidth="max-w-lg" ariaLabel={editingPrompt ? "Edit prompt shortcut" : "Add prompt shortcut"}>
      <div className="border-b md-outline p-4">
        <h3 className="text-lg font-semibold md-text-strong">
          {editingPrompt ? "Edit Prompt Shortcut" : "Add Prompt Shortcut"}
        </h3>
        <p className="mt-1 text-sm md-text-muted">
          {editingPrompt
            ? "Update a reusable prompt button and slash command."
            : "Create a reusable prompt button and slash command."}
        </p>
      </div>

      <div className="space-y-4 p-4">
        <div>
          <label className="mb-1 block text-sm font-medium md-text-secondary">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="md-field"
            placeholder="e.g. Code review"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium md-text-secondary">Prompt</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            className="md-field font-mono"
            placeholder="Write the full prompt to execute"
          />
        </div>
        <label className="flex items-start gap-2 rounded-lg border md-outline p-3 text-sm">
          <input
            type="checkbox"
            checked={autoRunOnCreate}
            onChange={(e) => setAutoRunOnCreate(e.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <span>
            <span className="block md-text-secondary">Auto-run on workspace creation</span>
            <span className="block text-xs md-text-muted">
              Execute this prompt automatically after a new workspace is created and its agent is ready.
            </span>
          </span>
        </label>
      </div>

      <div className="flex justify-end gap-2 border-t md-outline p-4">
        <button onClick={onClose} className="md-btn">
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!name.trim() || !body.trim()}
          className="md-btn md-btn-tonal disabled:opacity-50"
        >
          {editingPrompt ? "Save Prompt" : "Add Prompt"}
        </button>
      </div>
    </Modal>
  );
}
