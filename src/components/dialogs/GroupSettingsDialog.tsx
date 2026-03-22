import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import type { SetStateAction } from "react";
import Modal from "../Modal";
import SortableGroupItem from "../SortableGroupItem";
import type { WorkspaceGroup } from "../../types";
import { DEFAULT_WORKSPACE_GROUPS } from "../../constants";

interface GroupSettingsDialogProps {
  groupConfig: WorkspaceGroup[];
  onConfigChange: React.Dispatch<SetStateAction<WorkspaceGroup[]>>;
  onClose: () => void;
}

export default function GroupSettingsDialog({ groupConfig, onConfigChange, onClose }: GroupSettingsDialogProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  return (
    <Modal onClose={onClose} ariaLabel="Workspace groups">
      <div className="border-b md-outline p-4">
        <h3 className="text-lg font-semibold md-text-strong">Workspace Groups</h3>
        <p className="mt-1 text-sm md-text-muted">
          Customize sidebar columns. Drag workspaces between groups to change their status.
        </p>
      </div>
      <div className="max-h-[60vh] overflow-y-auto p-4 space-y-3">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={(e) => {
            const { active, over } = e;
            if (over && active.id !== over.id) {
              const oldIdx = groupConfig.findIndex((g) => g.id === active.id);
              const newIdx = groupConfig.findIndex((g) => g.id === over.id);
              onConfigChange(arrayMove(groupConfig, oldIdx, newIdx));
            }
          }}
        >
          <SortableContext
            items={groupConfig.map((g) => g.id)}
            strategy={verticalListSortingStrategy}
          >
            {groupConfig.map((group, idx) => (
              <SortableGroupItem
                key={group.id}
                group={group}
                idx={idx}
                workspaceGroupConfig={groupConfig}
                setWorkspaceGroupConfig={onConfigChange}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
      <div className="flex items-center justify-between border-t md-outline p-4">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              const id = `custom-${Date.now()}`;
              onConfigChange([...groupConfig, { id, label: "New group", statuses: [] }]);
            }}
            className="md-btn md-btn-tonal text-sm"
          >
            Add group
          </button>
          <button
            type="button"
            onClick={() => onConfigChange(DEFAULT_WORKSPACE_GROUPS)}
            className="md-btn text-sm"
          >
            Reset defaults
          </button>
        </div>
        <button onClick={onClose} className="md-btn md-btn-tonal">
          Done
        </button>
      </div>
    </Modal>
  );
}
