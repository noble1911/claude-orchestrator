import { memo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { SortableWorkspaceItemProps } from "../types";

const SortableWorkspaceItem = memo(function SortableWorkspaceItem({
  workspace,
  isSelected,
  unreadCount,
  onSelect,
  onTogglePin,
  onRename,
  onRemove,
  getStatusColor,
}: SortableWorkspaceItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: workspace.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`md-list-item flex items-center gap-2 md-px-3 md-py-2 ${
        isSelected ? "md-list-item-active" : ""
      }`}
    >
      <div
        {...attributes}
        {...listeners}
        className="flex shrink-0 cursor-grab items-center md-text-dim active:cursor-grabbing"
        title="Drag to reorder or move between groups"
      >
        <span className="material-symbols-rounded !text-[14px]">drag_indicator</span>
      </div>
      <button
        type="button"
        onClick={() => onSelect(workspace.id)}
        className="min-w-0 flex-1 text-left"
      >
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${getStatusColor(workspace.status)}`} />
          {workspace.pinnedAt && (
            <span className="material-symbols-rounded !text-[12px] md-text-dim" title="Pinned">keep</span>
          )}
          <span className="truncate md-body-small md-text-primary">{workspace.name}</span>
          {workspace.status === "initializing" && (
            <span className="text-[10px] md-text-dim animate-pulse">Setting up...</span>
          )}
          {unreadCount > 0 && (
            <span
              className="inline-flex min-h-[18px] min-w-[18px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold leading-none text-white"
              title={`${unreadCount} unread AI ${unreadCount === 1 ? "response" : "responses"}`}
            >
              {unreadCount}
            </span>
          )}
        </div>
        <p className="mt-1 truncate md-body-small md-text-muted">{workspace.branch}</p>
      </button>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onTogglePin(workspace.id)}
          className="md-icon-plain disabled:opacity-30 disabled:cursor-not-allowed"
          title={workspace.pinnedAt ? "Unpin workspace" : "Pin workspace"}
          aria-label={workspace.pinnedAt ? `Unpin ${workspace.name}` : `Pin ${workspace.name}`}
          disabled={workspace.status === "initializing"}
        >
          <span className="material-symbols-rounded !text-[16px]">{workspace.pinnedAt ? "keep_off" : "keep"}</span>
        </button>
        <button
          type="button"
          onClick={() => onRename(workspace)}
          className="md-icon-plain disabled:opacity-30 disabled:cursor-not-allowed"
          title={workspace.status === "initializing" ? "Wait for setup to complete" : "Rename workspace"}
          aria-label={`Rename ${workspace.name}`}
          disabled={workspace.status === "initializing"}
        >
          <span className="material-symbols-rounded !text-[16px]">edit</span>
        </button>
        <button
          type="button"
          onClick={() => onRemove(workspace.id)}
          className="md-icon-plain md-icon-plain-danger disabled:opacity-30 disabled:cursor-not-allowed"
          title={workspace.status === "initializing" ? "Wait for setup to complete" : "Delete workspace"}
          aria-label={`Delete ${workspace.name}`}
          disabled={workspace.status === "initializing"}
        >
          <span className="material-symbols-rounded !text-[16px]">delete</span>
        </button>
      </div>
    </div>
  );
});

export default SortableWorkspaceItem;
