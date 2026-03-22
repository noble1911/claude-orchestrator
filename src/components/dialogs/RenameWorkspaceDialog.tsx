import { useState } from "react";
import Modal from "../Modal";

interface RenameWorkspaceDialogProps {
  initialName: string;
  onClose: () => void;
  onSubmit: (newName: string) => void;
}

export default function RenameWorkspaceDialog({ initialName, onClose, onSubmit }: RenameWorkspaceDialogProps) {
  const [name, setName] = useState(initialName);

  return (
    <Modal onClose={onClose} ariaLabel="Rename workspace">
      <div className="p-4">
        <p className="mb-2 text-sm font-medium md-text-primary">Rename Workspace</p>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Workspace name"
          className="md-field"
          onKeyDown={(e) => e.key === "Enter" && onSubmit(name)}
          autoFocus
        />
        <div className="mt-3 flex gap-2">
          <button onClick={onClose} className="md-btn flex-1">
            Cancel
          </button>
          <button
            onClick={() => onSubmit(name)}
            disabled={!name.trim()}
            className="md-btn md-btn-tonal flex-1 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
