import { useState } from "react";
import Modal from "../Modal";

interface CreateWorkspaceDialogProps {
  initialName: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}

export default function CreateWorkspaceDialog({ initialName, onClose, onSubmit }: CreateWorkspaceDialogProps) {
  const [name, setName] = useState(initialName);

  return (
    <Modal onClose={onClose} ariaLabel="Create new workspace">
      <div className="p-4">
        <p className="mb-2 text-sm font-medium md-text-primary">Create New Workspace</p>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Feature name"
          className="md-field"
          onKeyDown={(e) => e.key === "Enter" && onSubmit(name)}
          autoFocus
        />
        <div className="mt-3 flex gap-2">
          <button onClick={onClose} className="md-btn flex-1">
            Cancel
          </button>
          <button onClick={() => onSubmit(name)} className="md-btn md-btn-tonal flex-1">
            Create
          </button>
        </div>
      </div>
    </Modal>
  );
}
