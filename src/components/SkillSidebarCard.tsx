import type { SkillShortcut } from "../types";

interface SkillSidebarCardProps {
  skill: SkillShortcut;
  icon: "code_blocks" | "person";
  onRun: (skill: SkillShortcut) => void;
  onEdit: (skill: SkillShortcut) => void;
  onDelete: (skill: SkillShortcut) => void;
}

export default function SkillSidebarCard({ skill, icon, onRun, onEdit, onDelete }: SkillSidebarCardProps) {
  return (
    <div
      className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md md-px-2 md-py-1.5 text-left text-xs transition hover:md-surface-subtle"
      onClick={() => onRun(skill)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onRun(skill);
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`Run skill ${skill.name}`}
      title={skill.filePath}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="material-symbols-rounded !text-base md-text-muted">{icon}</span>
        <div className="min-w-0">
          <p className="truncate md-text-primary">{skill.name}</p>
          <p className="truncate text-[11px] md-text-muted">/{skill.commandName}</p>
        </div>
      </div>
      <div className="flex items-center">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(skill);
          }}
          className="md-icon-plain !h-6 !w-6"
          title="Edit skill"
          aria-label={`Edit ${skill.name}`}
        >
          <span className="material-symbols-rounded !text-[14px]">edit</span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(skill);
          }}
          className="md-icon-plain md-icon-plain-danger !h-6 !w-6"
          title="Delete skill"
          aria-label={`Delete ${skill.name}`}
        >
          <span className="material-symbols-rounded !text-[14px]">delete</span>
        </button>
      </div>
    </div>
  );
}
