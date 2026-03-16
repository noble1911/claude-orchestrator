import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { WorkspaceGroup } from "../types";
import type { Workspace } from "../types";

interface SortableGroupItemProps {
  group: WorkspaceGroup;
  idx: number;
  workspaceGroupConfig: WorkspaceGroup[];
  setWorkspaceGroupConfig: React.Dispatch<React.SetStateAction<WorkspaceGroup[]>>;
}

function SortableGroupItem({ group, idx, workspaceGroupConfig, setWorkspaceGroupConfig }: SortableGroupItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: group.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const usedStatuses = new Set(
    workspaceGroupConfig.filter((_, i) => i !== idx).flatMap((g) => g.statuses),
  );

  return (
    <div ref={setNodeRef} style={style} className="rounded border md-outline p-3 space-y-2">
      <div className="flex items-center gap-2">
        <div
          {...attributes}
          {...listeners}
          className="flex shrink-0 cursor-grab items-center md-text-dim active:cursor-grabbing"
          title="Drag to reorder"
        >
          <span className="material-symbols-rounded !text-[14px]">drag_indicator</span>
        </div>
        <input
          type="text"
          className="md-field flex-1 text-sm"
          value={group.label}
          placeholder="Group name"
          onChange={(e) => {
            const updated = [...workspaceGroupConfig];
            updated[idx] = { ...group, label: e.target.value };
            setWorkspaceGroupConfig(updated);
          }}
        />
      </div>
      <div className="flex items-center gap-2">
        <label className="text-[11px] md-text-muted">Status</label>
        <select
          className="md-select !min-h-0 h-7 flex-1 py-0 pl-2 pr-6 text-[11px]"
          value={group.statuses[0] || ""}
          onChange={(e) => {
            const updated = [...workspaceGroupConfig];
            updated[idx] = {
              ...group,
              statuses: e.target.value ? [e.target.value as Workspace["status"]] : [],
            };
            setWorkspaceGroupConfig(updated);
          }}
        >
          <option value="">None</option>
          <option value="idle" disabled={usedStatuses.has("idle")}>
            Idle{usedStatuses.has("idle") ? " (used)" : ""}
          </option>
          <option value="running" disabled={usedStatuses.has("running")}>
            Running{usedStatuses.has("running") ? " (used)" : ""}
          </option>
          <option value="inReview" disabled={usedStatuses.has("inReview")}>
            In Review{usedStatuses.has("inReview") ? " (used)" : ""}
          </option>
          <option value="merged" disabled={usedStatuses.has("merged")}>
            Merged{usedStatuses.has("merged") ? " (used)" : ""}
          </option>
        </select>
        <button
          type="button"
          onClick={() => {
            if (workspaceGroupConfig.length <= 1) return;
            setWorkspaceGroupConfig((prev) => prev.filter((_, i) => i !== idx));
          }}
          className="md-icon-plain md-icon-plain-danger !h-7 !w-7"
          title="Remove group"
          disabled={workspaceGroupConfig.length <= 1}
        >
          <span className="material-symbols-rounded !text-[16px]">close</span>
        </button>
      </div>
    </div>
  );
}

export default SortableGroupItem;
