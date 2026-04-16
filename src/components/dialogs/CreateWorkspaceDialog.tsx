import { useState } from "react";
import Modal from "../Modal";
import type { GodWorkspaceTemplate, Workspace } from "../../types";

interface CreateWorkspaceDialogProps {
  initialName: string;
  title?: string;
  placeholder?: string;
  templates?: GodWorkspaceTemplate[];
  continueFromWorkspaces?: Workspace[];
  initialSourceWorkspaceId?: string | null;
  onClose: () => void;
  onSubmit: (name: string, secondaryId?: string) => void;
}

export default function CreateWorkspaceDialog({ initialName, title = "Create New Workspace", placeholder = "Feature name", templates, continueFromWorkspaces, initialSourceWorkspaceId, onClose, onSubmit }: CreateWorkspaceDialogProps) {
  const [name, setName] = useState(initialName);
  const [selectedTemplate, setSelectedTemplate] = useState<string | undefined>(undefined);
  const [sourceWorkspaceId, setSourceWorkspaceId] = useState<string | undefined>(
    initialSourceWorkspaceId ?? undefined
  );

  const hasWorkspaces = continueFromWorkspaces && continueFromWorkspaces.length > 0;
  const secondaryId = templates ? selectedTemplate : sourceWorkspaceId;

  return (
    <Modal onClose={onClose} ariaLabel={title} dismissable={false}>
      <div className="p-4">
        <p className="mb-2 text-sm font-medium md-text-primary">{title}</p>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={placeholder}
          className="md-field"
          onKeyDown={(e) => e.key === "Enter" && name.trim() && onSubmit(name, secondaryId)}
          autoFocus
        />
        {templates && templates.length > 0 && (
          <div className="mt-3">
            <p className="mb-1.5 text-xs font-medium md-text-secondary">Strategy</p>
            <div className="flex flex-col gap-1.5">
              {templates.map((t) => (
                <label
                  key={t.id}
                  className={`flex items-start gap-2 rounded-md border px-2.5 py-2 cursor-pointer text-xs transition-colors ${
                    selectedTemplate === t.id
                      ? "md-border-accent bg-[var(--md-sys-color-surface-container-highest)]"
                      : "md-border hover:bg-[var(--md-sys-color-surface-container)]"
                  }`}
                >
                  <input
                    type="radio"
                    name="template"
                    value={t.id}
                    checked={selectedTemplate === t.id}
                    onChange={() => setSelectedTemplate(t.id)}
                    className="mt-0.5"
                  />
                  <div>
                    <span className="font-medium md-text-primary">{t.name}</span>
                    <span className="ml-1.5 md-text-secondary">{t.description}</span>
                  </div>
                </label>
              ))}
              {selectedTemplate && (
                <button
                  onClick={() => setSelectedTemplate(undefined)}
                  className="text-xs md-text-secondary hover:md-text-primary self-start"
                >
                  Clear selection
                </button>
              )}
            </div>
          </div>
        )}
        {hasWorkspaces && (
          <div className="mt-2">
            <label className="text-xs md-text-secondary block mb-1">Continue conversation from</label>
            <select
              value={sourceWorkspaceId ?? ""}
              onChange={(e) => setSourceWorkspaceId(e.target.value || undefined)}
              className="md-field text-sm"
            >
              <option value="">None (fresh start)</option>
              {continueFromWorkspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>{ws.name}</option>
              ))}
            </select>
          </div>
        )}
        <div className="mt-3 flex gap-2">
          <button onClick={onClose} className="md-btn flex-1">
            Cancel
          </button>
          <button onClick={() => onSubmit(name, secondaryId)} className="md-btn md-btn-tonal flex-1">
            Create
          </button>
        </div>
      </div>
    </Modal>
  );
}
