import { useDroppable } from "@dnd-kit/core";

export default function GroupDropZone({ groupKey }: { groupKey: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `group:${groupKey}` });
  return (
    <div
      ref={setNodeRef}
      className={`rounded border border-dashed px-3 py-2 text-center text-[10px] transition-colors ${
        isOver ? "border-sky-500/60 bg-sky-500/10 md-text-secondary" : "border-white/10 md-text-dim"
      }`}
    >
      Drop here
    </div>
  );
}
