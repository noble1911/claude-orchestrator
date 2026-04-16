import { useMemo, useState, useEffect } from "react";
import { useOrchestrationEvents } from "../hooks/useOrchestrationEvents";
import type { OrchestrationChildStatus, OrchestrationEvent } from "../types";

interface Props {
  godWorkspaceId: string;
  godWorkspaceName: string;
  onSelectWorkspace: (workspaceId: string) => void;
}

const GOD_RADIUS = 28;
const CHILD_RADIUS = 20;
const VIEWBOX_W = 560;
const VIEWBOX_H = 400;
const CX = VIEWBOX_W / 2;
const CY = 180;

function orbitRadius(n: number): number {
  if (n <= 4) return 120;
  if (n <= 8) return 150;
  return 180;
}

function nodeColor(child: OrchestrationChildStatus): string {
  if (child.processing) return "#10b981";
  if (child.agentStatus === "running") return "#60a5fa";
  if (child.agentStatus === "error") return "#f87171";
  if (child.agentStatus === "stopped") return "#6b7280";
  return "#4b5563";
}

function nodeGlow(child: OrchestrationChildStatus): string {
  if (child.processing) return "0 0 12px #10b981";
  if (child.agentStatus === "running") return "0 0 8px rgba(96,165,250,0.4)";
  return "none";
}

function kindBadge(kind: OrchestrationEvent["kind"]): { label: string; color: string } {
  switch (kind) {
    case "workspaceCreated": return { label: "NEW", color: "#a78bfa" };
    case "agentStarted": return { label: "START", color: "#10b981" };
    case "messageSent": return { label: "MSG", color: "#60a5fa" };
    case "agentStopped": return { label: "STOP", color: "#6b7280" };
    case "statusPolled": return { label: "POLL", color: "#4b5563" };
    case "waitStarted": return { label: "WAIT", color: "#f59e0b" };
    case "waitCompleted": return { label: "DONE", color: "#10b981" };
    case "artifactWritten": return { label: "ART+", color: "#f472b6" };
    case "artifactRead": return { label: "ART", color: "#818cf8" };
    case "artifactDeleted": return { label: "ART-", color: "#6b7280" };
    default: return { label: "EVT", color: "#4b5563" };
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

interface CollapsedFeedItem {
  event: OrchestrationEvent;
  count: number;
}

function collapseFeed(events: OrchestrationEvent[]): CollapsedFeedItem[] {
  const items: CollapsedFeedItem[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (
      e.kind === "statusPolled" &&
      items.length > 0 &&
      items[items.length - 1].event.kind === "statusPolled" &&
      items[items.length - 1].event.childWorkspaceId === e.childWorkspaceId
    ) {
      items[items.length - 1].count++;
    } else {
      items.push({ event: e, count: 1 });
    }
  }
  return items;
}

export default function OrchestrationGraph({ godWorkspaceId, godWorkspaceName, onSelectWorkspace }: Props) {
  const { events, children, artifacts, isLoading } = useOrchestrationEvents(godWorkspaceId);
  const childArray = useMemo(() => Array.from(children.values()), [children]);
  const N = childArray.length;
  const R = orbitRadius(N);

  // Tick forces re-render so "recently active" edges clear after 3s
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (events.length === 0) return;
    const timer = setTimeout(() => setTick((t) => t + 1), 3100);
    return () => clearTimeout(timer);
  }, [events]);

  const recentEventByChild = useMemo(() => {
    void tick;
    const map = new Map<string, number>();
    const now = Date.now();
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (!e.childWorkspaceId || map.has(e.childWorkspaceId)) continue;
      const age = now - new Date(e.timestamp).getTime();
      if (age < 3000) map.set(e.childWorkspaceId, age);
    }
    return map;
  }, [events, tick]);

  const feedItems = useMemo(() => collapseFeed(events).slice(0, 50), [events]);

  const childPositions = useMemo(() => {
    return childArray.map((_, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(N, 1);
      return {
        x: CX + R * Math.cos(angle),
        y: CY + R * Math.sin(angle),
      };
    });
  }, [N, R, childArray]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ color: "var(--root-text)", opacity: 0.5 }}>
        Loading orchestration state…
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ color: "var(--root-text)" }}>
      {/* SVG Graph */}
      <div className="flex-shrink-0 flex items-center justify-center" style={{ minHeight: N === 0 ? 200 : 380 }}>
        <svg
          viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ width: "100%", maxWidth: 600, height: "auto" }}
        >
          {/* Edges */}
          {childArray.map((child, i) => {
            const pos = childPositions[i];
            const isActive = child.processing || recentEventByChild.has(child.workspaceId);
            return (
              <line
                key={`edge-${child.workspaceId}`}
                x1={CX}
                y1={CY}
                x2={pos.x}
                y2={pos.y}
                stroke={isActive ? "#10b981" : "#374151"}
                strokeWidth={isActive ? 1.5 : 1}
                strokeDasharray={isActive ? "6 4" : undefined}
                opacity={isActive ? 1 : 0.4}
              >
                {isActive && (
                  <animate
                    attributeName="stroke-dashoffset"
                    values="20;0"
                    dur="0.8s"
                    repeatCount="indefinite"
                  />
                )}
              </line>
            );
          })}

          {/* God node */}
          <g style={{ cursor: "pointer" }} onClick={() => onSelectWorkspace(godWorkspaceId)}>
            <circle
              cx={CX}
              cy={CY}
              r={GOD_RADIUS}
              fill="#065f46"
              stroke="#10b981"
              strokeWidth={2}
              style={{ filter: "drop-shadow(0 0 8px rgba(16,185,129,0.5))" }}
            />
            <text
              x={CX}
              y={CY + 1}
              textAnchor="middle"
              dominantBaseline="central"
              fill="white"
              fontSize={10}
              fontWeight={600}
            >
              GOD
            </text>
            <title>{godWorkspaceName}</title>
          </g>

          {/* Child nodes */}
          {childArray.map((child, i) => {
            const pos = childPositions[i];
            const color = nodeColor(child);
            const glow = nodeGlow(child);
            return (
              <g
                key={child.workspaceId}
                style={{ cursor: "pointer" }}
                onClick={() => onSelectWorkspace(child.workspaceId)}
              >
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={CHILD_RADIUS}
                  fill={color}
                  stroke={child.processing ? "#10b981" : "transparent"}
                  strokeWidth={child.processing ? 2 : 0}
                  opacity={0.9}
                  style={{ filter: glow !== "none" ? `drop-shadow(${glow})` : undefined }}
                >
                  {child.processing && (
                    <animate
                      attributeName="r"
                      values={`${CHILD_RADIUS};${CHILD_RADIUS + 2};${CHILD_RADIUS}`}
                      dur="1.5s"
                      repeatCount="indefinite"
                    />
                  )}
                </circle>
                <text
                  x={pos.x}
                  y={pos.y + 1}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="white"
                  fontSize={8}
                  fontWeight={500}
                >
                  {truncate(child.name, 8)}
                </text>
                <text
                  x={pos.x}
                  y={pos.y + CHILD_RADIUS + 12}
                  textAnchor="middle"
                  fill="var(--root-text)"
                  fontSize={7}
                  opacity={0.6}
                >
                  {child.workspaceStatus} · {child.messageCount} msgs
                </text>
                <title>
                  {`${child.name}\nStatus: ${child.workspaceStatus}\nAgent: ${child.agentStatus ?? "none"}\nMessages: ${child.messageCount}${child.processing ? "\nProcessing..." : ""}`}
                </title>
              </g>
            );
          })}

          {/* Empty state */}
          {N === 0 && (
            <text
              x={CX}
              y={CY + GOD_RADIUS + 40}
              textAnchor="middle"
              fill="var(--root-text)"
              fontSize={11}
              opacity={0.4}
            >
              No child workspaces yet
            </text>
          )}
        </svg>
      </div>

      {/* Stats bar */}
      <div
        className="flex gap-4 px-4 py-1.5 text-xs"
        style={{ borderTop: "1px solid rgba(255,255,255,0.08)", opacity: 0.7 }}
      >
        <span>Children: {N}</span>
        <span>Active: {childArray.filter((c) => c.processing).length}</span>
        <span>Running: {childArray.filter((c) => c.agentStatus === "running").length}</span>
        {artifacts.length > 0 && <span>Artifacts: {artifacts.length}</span>}
        <span>Events: {events.length}</span>
      </div>

      {/* Activity Feed */}
      <div
        className="flex-1 overflow-y-auto px-3 py-2"
        style={{
          borderTop: "1px solid rgba(255,255,255,0.08)",
          fontSize: 11,
          fontFamily: "monospace",
          minHeight: 0,
        }}
      >
        {feedItems.length === 0 ? (
          <div style={{ opacity: 0.4, textAlign: "center", paddingTop: 12 }}>
            Activity will appear here as the orchestrator runs…
          </div>
        ) : (
          feedItems.map((item) => {
            const badge = kindBadge(item.event.kind);
            const childName = item.event.childWorkspaceName ?? item.event.childWorkspaceId;
            return (
              <div
                key={item.event.id}
                className="flex gap-2 py-0.5"
                style={{ opacity: item.event.kind === "statusPolled" ? 0.4 : 0.8 }}
              >
                <span style={{ color: "rgba(255,255,255,0.3)", flexShrink: 0 }}>
                  {formatTime(item.event.timestamp)}
                </span>
                <span
                  style={{
                    color: badge.color,
                    fontWeight: 600,
                    width: 40,
                    flexShrink: 0,
                    textAlign: "right",
                  }}
                >
                  {badge.label}
                </span>
                <span style={{ color: "var(--root-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {childName && <span style={{ opacity: 0.6 }}>{childName} → </span>}
                  {item.count > 1
                    ? `${item.event.summary} (×${item.count})`
                    : item.event.summary}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
