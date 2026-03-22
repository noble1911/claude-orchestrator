import { useState } from "react";
import Modal from "../Modal";
import type { SkillShortcut, SkillScope } from "../../types";
import { sanitizeSkillDirName } from "../../utils";

interface SkillDialogProps {
  editingSkill: SkillShortcut | null;
  initialScope: SkillScope;
  projectSkillsRoot: string | null;
  userSkillsRoot: string | null;
  onClose: () => void;
  onSave: (draft: {
    scope: SkillScope;
    relativePath: string | null;
    name: string;
    content: string;
  }) => void;
}

export default function SkillDialog({
  editingSkill,
  initialScope,
  projectSkillsRoot,
  userSkillsRoot,
  onClose,
  onSave,
}: SkillDialogProps) {
  const [scope, setScope] = useState<SkillScope>(editingSkill?.scope ?? initialScope);
  const [relativePath] = useState<string | null>(editingSkill?.relativePath ?? null);
  const [name, setName] = useState(editingSkill?.name ?? "");
  const [body, setBody] = useState(editingSkill?.content ?? "");

  function handleSave() {
    const trimmedName = name.trim();
    const trimmedBody = body.trim();
    if (!trimmedName || !trimmedBody) return;
    onSave({ scope, relativePath, name: trimmedName, content: trimmedBody });
  }

  return (
    <Modal onClose={onClose} maxWidth="max-w-2xl" ariaLabel={editingSkill ? "Edit skill" : "Add skill"}>
      <div className="border-b md-outline p-4">
        <h3 className="text-lg font-semibold md-text-strong">
          {editingSkill ? "Edit Skill" : "Add Skill"}
        </h3>
        <p className="mt-1 text-sm md-text-muted">
          {editingSkill
            ? "Update this skill's instructions."
            : "Create a reusable project or user skill."}
        </p>
      </div>
      <div className="space-y-4 p-4">
        <div>
          <label className="mb-1 block text-sm font-medium md-text-secondary">Scope</label>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as SkillScope)}
            className="md-select"
            disabled={editingSkill !== null}
          >
            <option value="project">Project</option>
            <option value="user">User</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium md-text-secondary">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="md-field"
            placeholder="e.g. release-engineer"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium md-text-secondary">Skill Content (SKILL.md)</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={14}
            className="md-field font-mono"
            placeholder={"# Skill name\n\nWrite the skill instructions here."}
          />
        </div>
        <div className="space-y-1 rounded-lg border md-outline p-3 text-xs md-text-muted">
          {relativePath && (
            <p>
              Path: <span className="font-mono md-text-secondary">{relativePath}/SKILL.md</span>
            </p>
          )}
          <p>
            Command preview:{" "}
            <span className="font-mono md-text-secondary">
              /{scope}:{relativePath || sanitizeSkillDirName(name.trim() || "skill")}
            </span>
          </p>
          {scope === "project" && projectSkillsRoot && (
            <p>
              Project root: <span className="font-mono md-text-secondary">{projectSkillsRoot}</span>
            </p>
          )}
          {scope === "user" && userSkillsRoot && (
            <p>
              User root: <span className="font-mono md-text-secondary">{userSkillsRoot}</span>
            </p>
          )}
        </div>
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
          {editingSkill ? "Save Skill" : "Add Skill"}
        </button>
      </div>
    </Modal>
  );
}
