# CLAUDE.md

This file provides guidance to Claude Code when working with the Claude Orchestrator codebase.

## Critical Context

- **Tech Stack**: Tauri 2.x (Rust backend + React/TypeScript frontend)
- **Purpose**: Native macOS app for managing multiple Claude CLI agents across isolated git worktrees
- **Database**: SQLite (via rusqlite) at `~/Library/Application Support/claude-orchestrator/data.db`
- **WebSocket**: Port 3001 for mobile/web client connectivity
- **Key Integration**: Claude CLI (`~/.claude/local/claude`)

## Project Architecture

```
claude-orchestrator/
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── lib.rs               # Tauri commands, app state (~3,800 lines)
│   │   ├── claude/              # Claude CLI integration (Phase 4)
│   │   │   ├── mod.rs           # Module root + help cache
│   │   │   ├── discovery.rs     # CLI path finding, capability probes
│   │   │   ├── env.rs           # Shell env, AWS auth, build_effective_cli_env
│   │   │   ├── models.rs        # Model/effort/permission normalization, CLI args
│   │   │   ├── stream.rs        # Stream event parsing, message emission
│   │   │   └── runner.rs        # Shared execution loop (run_claude_message)
│   │   ├── git.rs               # Worktree ops, branch detection, orchestrator config
│   │   ├── types.rs             # Shared structs/enums (extracted Phase 1)
│   │   ├── commands/            # Tauri command modules
│   │   │   ├── mod.rs           # Module root
│   │   │   ├── agent.rs         # Agent start/stop/interrupt/messages
│   │   │   ├── workspace.rs     # Workspace CRUD, terminal, scripts
│   │   │   └── god_workspace.rs # God workspace create/remove/list
│   │   ├── helpers.rs           # Shared helpers: now_rfc3339(), new_id(), constants
│   │   ├── database.rs          # SQLite schema & CRUD operations
│   │   ├── http_server.rs       # HTTP server: REST API (port 3002), permission bridge, web client
│   │   └── websocket_server.rs  # WebSocket server for mobile/web clients
│   ├── resources/
│   │   └── god-workspace-skill.md  # Bundled skill (embedded via include_str!)
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── src/                          # React frontend
│   ├── types.ts                 # All shared TypeScript interfaces & type aliases
│   ├── constants.ts             # Storage keys, model options, workspace group defaults
│   ├── utils.ts                 # Pure utility functions (no React state)
│   ├── themes.ts                # Theme system (built-in + custom themes)
│   ├── App.tsx                  # Main orchestrator component (state, effects, layout)
│   ├── main.tsx                 # Entry point
│   ├── hooks/
│   │   ├── usePersistedState.ts # localStorage persistence hook (Phase 2, broadly adopted)
│   │   ├── useTauriListener.ts  # Generic Tauri event subscribe/cleanup
│   │   ├── useAgentEvents.ts    # Agent message, run-state, permission listeners
│   │   └── usePanelResize.ts    # 3-panel resize logic (left, right, terminal)
│   └── components/
│       ├── GroupDropZone.tsx        # Kanban group drop target
│       ├── LinkifiedInlineText.tsx  # Auto-links URLs in plain text
│       ├── MarkdownCodeBlock.tsx    # Code block with copy button
│       ├── MarkdownMessage.tsx      # Full markdown renderer for agent responses
│       ├── PermissionCard.tsx       # Agent permission request UI
│       ├── QuestionCard.tsx         # Agent question UI with option selection
│       ├── SettingsModal.tsx        # App settings dialog
│       ├── SkillsMarketplace.tsx    # Skills browsing & management
│       ├── SortableGroupItem.tsx    # Drag-and-drop group entry
│       ├── SortableWorkspaceItem.tsx # Drag-and-drop workspace sidebar entry
│       ├── ThinkingTimer.tsx        # Agent thinking duration indicator
│       └── ToolbarDropdown.tsx      # Reusable toolbar dropdown menu
│
├── package.json
├── vite.config.ts
└── tailwind.config.js
```

## Core Concepts

### Repositories
Git repositories added by the user. Each repository can have multiple workspaces.

### Workspaces
Isolated git worktrees created from a repository. Each workspace:
- Has its own branch (`workspace/<name>`)
- Lives in `<repo>/.worktrees/<name>/`
- Can have one Claude agent running
- Has a status: `idle`, `running`, `inReview`, `merged`, or `initializing`
- Supports drag-and-drop reordering between Kanban-style groups

### Agents
Claude CLI instances running in a workspace. Agents:
- Use `--session-id` for new sessions
- Use `--resume` for continuing existing sessions
- Run in background threads to avoid blocking the UI
- Support configurable model selection (Opus/Sonnet/Haiku) per workspace
- Support plan mode vs normal mode per workspace

### God Workspaces
A meta-workspace (`is_god = true`) that orchestrates child workspaces via an HTTP REST API on port 3002.
- Lives in `<repo>/.worktrees/god-<name>/` with branch `god/<name>`
- Has its own Claude agent that uses `curl` to control child workspace agents
- Bearer token auth (UUID stored in `app_settings` DB table, injected as `ORCHESTRATOR_API_TOKEN` env var)
- Bundled skill file installed to `~/.claude/skills/god-workspace/SKILL.md` (user-level, not worktree)
- **Three workspace arrays in React state**: `workspaces`, `godChildWorkspaces`, `godWorkspaces`
- **HTTP server**: `src-tauri/src/http_server.rs` — REST API + MCP permission bridge + optional web client

### Sessions
Persist Claude conversation state across app restarts using stored session IDs.

## Frontend Module Guide

### `src/types.ts`
All shared TypeScript interfaces. When adding a new data structure, define it here and import where needed. Key types: `Repository`, `Workspace`, `Agent`, `AgentMessage`, `CenterTab`, `PromptShortcut`, `SkillShortcut`, `WorkspaceGroup`.

### `src/constants.ts`
All localStorage keys, model options, name generators, and default workspace group configuration. Import from here when adding new persisted settings.

### `src/utils.ts`
Pure functions with no React dependencies (except `ReactNode` for `extractTextFromNode`). Includes message deduplication logic, URL parsing, clipboard helpers, theme utilities, and env override parsing. All functions are independently testable.

### `src/themes.ts`
Complete theme system: built-in theme definitions, custom theme CRUD, CSS variable application. Themes are stored in localStorage.

### `src/App.tsx` (main orchestrator)
Still the largest file (~4,950 lines). Contains:
- **State management**: ~36 useState hooks for app state (reduced from ~47 via hook extractions)
- **Event listeners**: Tauri event subscriptions (agent-message, agent-run-state, remote-clients)
- **Effect hooks**: localStorage persistence, polling, keyboard shortcuts, panel resizing
- **Handler functions**: CRUD for workspaces/repos, agent control, file browsing, terminal, checks
- **JSX layout**: Three-panel layout (left sidebar, center chat/file viewer, right tools panel)

### `src/hooks/`
Custom React hooks extracted from App.tsx:
- **usePersistedState**: Generic localStorage persistence hook (broadly adopted — 11 of ~15 pairs migrated)
- **useTauriListener**: Generic Tauri event subscribe/cleanup wrapper
- **useAgentEvents**: Agent message, run-state, and permission-request event handlers
- **usePanelResize**: 3-panel resize logic with configurable min/max constraints

### `src/components/`
Extracted UI components that are self-contained (no dependency on App state):
- **GroupDropZone**: Kanban group drop target for workspace drag-and-drop
- **LinkifiedInlineText**: Auto-detects and linkifies URLs in plain text
- **MarkdownCodeBlock**: Code block with copy-to-clipboard button
- **MarkdownMessage**: Renders agent responses with full GFM support, code highlighting, link handling
- **PermissionCard**: Agent permission request UI with approve/deny actions
- **QuestionCard**: Handles agent questions with single/multi-select options and bundled answers
- **SettingsModal**: App-wide settings dialog (497 lines)
- **SkillsMarketplace**: Skills browsing, installation, and management
- **SortableGroupItem**: DnD-enabled Kanban group entry
- **SortableWorkspaceItem**: DnD-enabled workspace sidebar entry with status indicator, pin, rename, delete
- **ThinkingTimer**: Agent thinking duration indicator
- **ToolbarDropdown**: Reusable dropdown menu for toolbar actions

## Key Features

### Prompt Library & Skills
- **Prompt shortcuts**: User-defined prompt templates, can auto-run on workspace creation
- **Skills**: File-based prompt templates scoped to project or user (`/.claude/skills/`)
- **Slash commands**: Type `/prompt-name` or `/skill-name` in chat to execute

### Conductor Pattern (orchestrator.json)
- `setupScript`: Runs on workspace setup (e.g., `npm install`)
- `runScript`: Runs the dev server (e.g., `npm run dev`)
- `checks`: Array of `{name, command, description}` for workspace health checks

### Message Queue
When an agent is busy (thinking), new messages are queued and sent automatically when the agent becomes idle. Queue is visible in the UI.

### Workspace Features
- **Kanban groups**: Configurable status-based groups (In Progress, In Review, Ready, Done)
- **Drag-and-drop**: Reorder within groups or move between groups (changes status)
- **Pinning**: Pin workspaces to top of their group
- **Notes**: Per-workspace notes saved on blur
- **Unread tracking**: Badge counts for messages received while viewing another workspace
- **PR detection**: Auto-detects PR URLs in agent output, marks workspace as "In Review"

### Environment & Configuration
- **Environment overrides**: Key-value pairs applied to all agent/terminal commands
- **AWS Bedrock toggle**: One-click `CLAUDE_CODE_USE_BEDROCK=1` support
- **Thinking mode**: Off/Low/Medium/High effort levels
- **Custom themes**: Create, edit, delete themes with per-token color control

### Integrated Terminal
- Run shell commands in workspace context
- Command history with arrow key navigation
- Output colored by stream (stdout=green, stderr=red, commands=blue)

## Key Files (with line ranges)

| File | Purpose |
|------|---------|
| `src-tauri/src/lib.rs` | Tauri commands, state management, WS handler (~3,800 lines) |
| `src-tauri/src/claude/` | Claude CLI integration: discovery, env, models, stream, runner (~1,900 lines) |
| `src-tauri/src/git.rs` | Git worktree ops, branch detection, orchestrator config (~170 lines) |
| `src-tauri/src/types.rs` | Shared structs/enums (extracted Phase 1) |
| `src-tauri/src/commands/god_workspace.rs` | God workspace create/remove/list, skill installation |
| `src-tauri/src/commands/agent.rs` | Agent start/stop/interrupt, permission handling |
| `src-tauri/src/commands/workspace.rs` | Workspace CRUD, terminal, orchestrator scripts |
| `src-tauri/src/helpers.rs` | Shared helpers: `now_rfc3339()`, `new_id()`, `fixed_length_constant_time_eq` |
| `src-tauri/src/database.rs` | SQLite schema, CRUD operations, `app_settings` key-value store |
| `src-tauri/src/http_server.rs` | HTTP REST API (port 3002), MCP permission bridge, web client |
| `src-tauri/src/websocket_server.rs` | WebSocket server for remote clients |
| `src/types.ts` | All shared TypeScript interfaces & type aliases |
| `src/constants.ts` | Storage keys, defaults, model options |
| `src/utils.ts` | Pure utility functions (message handling, URL parsing, etc.) |
| `src/themes.ts` | Theme definitions & management |
| `src/App.tsx` | Main React component (state, effects, handlers, layout) (~4,343 lines) |
| `src/hooks/*.ts` | Custom React hooks (usePersistedState, useTauriListener, useAgentEvents, usePanelResize) |
| `src/components/*.tsx` | 12 extracted UI components |

## Development Commands

```bash
# Development mode (hot reload)
npm run tauri dev

# Build for production
npm run tauri build

# Run Rust tests
cargo test --manifest-path src-tauri/Cargo.toml

# TypeScript check (no emit)
npx tsc --noEmit
```

## WebSocket API

Mobile clients connect to `ws://localhost:3001` and can send:

```json
{"type": "list_workspaces"}
{"type": "subscribe", "workspace_id": "<uuid>"}
{"type": "send_message", "workspace_id": "<uuid>", "message": "..."}
{"type": "stop_agent", "workspace_id": "<uuid>"}
```

## HTTP REST API (God Workspace)

God workspace agents interact with the orchestrator via `http://localhost:3002`. All orchestrator endpoints require bearer token auth (`Authorization: Bearer <token>`). Body size limit: 512 KB.

```
GET  /api/workspaces?god_workspace_id=<id>   # List child workspaces (god_workspace_id required)
POST /api/workspaces/create                   # Create child workspace
POST /api/workspace/start-agent               # Start agent in workspace
POST /api/workspace/send                      # Send message to agent (409 if busy)
POST /api/workspace/stop-agent                # Stop agent
GET  /api/workspace/messages?workspace_id=<id># Get message history
GET  /api/workspace/status?workspace_id=<id>  # Get workspace status
POST /api/permission                          # MCP permission bridge (no token required)
```

## Database Schema

```sql
-- repositories: Added git repos
-- workspaces: Isolated worktrees per repo (with status, displayOrder, pinnedAt, notes, prUrl, isGod, parentGodWorkspaceId)
-- sessions: Claude conversation sessions
-- messages: Full conversation history
-- app_settings: Key-value store (e.g., api_token for HTTP bearer auth)
```

## Common Tasks

### Adding a new Tauri command
1. Add function with `#[tauri::command]` in the appropriate `commands/*.rs` module (or `lib.rs` until modules are extracted)
2. Register in `invoke_handler` at end of `run()` in `lib.rs`
3. Call from frontend with `invoke<ReturnType>("command_name", { params })`
4. If the command also needs WebSocket support, have the WS handler call the same function — do NOT duplicate the logic

### Adding a new TypeScript type
1. Define in `src/types.ts` with `export`
2. Import where needed: `import type { MyType } from "./types"`

### Adding a new utility function
1. Add to `src/utils.ts` (must be a pure function, no React hooks)
2. Import in App.tsx or components as needed

### Adding a new constant/storage key
1. Add to `src/constants.ts` with `export`
2. Import in App.tsx

### Adding a new component
1. Create file in `src/components/`
2. Import types from `../types`, utils from `../utils`
3. Use default export
4. Import in App.tsx

### Modifying the database schema
1. Update `init_schema()` in `database.rs`
2. Add corresponding CRUD methods
3. Delete `~/Library/Application Support/claude-orchestrator/data.db` to recreate

### Adding WebSocket message types
1. Add variant to `WsMessage` enum in `websocket_server.rs`
2. Add handler in `handle_connection()` match statement
3. Add corresponding `WsResponse` if needed

## Anti-Patterns

### General
- Don't use `tokio::spawn` for Claude CLI - use `std::thread::spawn` (avoids runtime conflicts)
- Don't hold RwLock guards across await points
- Don't block the main thread with synchronous operations
- Don't define new types inline in `App.tsx` - put them in `types.ts`
- Don't add pure utility functions to `App.tsx` - put them in `utils.ts`
- Don't add new components inline in `App.tsx` - create files in `components/`
- Don't duplicate logic between Tauri commands and WebSocket handlers — have WS handlers call the shared function
- Don't add new `useEffect` pairs for localStorage — use `usePersistedState` hook in `src/hooks/usePersistedState.ts`
- Don't add new modal dialogs inline in `App.tsx` — use `<Modal>` component in `components/dialogs/`
- Don't hardcode magic numbers — define named constants (e.g., `MAX_FILE_READ_BYTES`, `WORKTREES_DIR`)
- Don't add new `setError(String(err))` catch blocks — use `wrapCommand()` helper (once extracted)

### Three-Array Rule (God Workspaces)
Every `setWorkspaces(prev => prev.map(...))` or `prev.filter(...)` call **must also call `setGodChildWorkspaces` and `setGodWorkspaces`** with the same updater. The updater is a harmless no-op on arrays that don't contain a matching ID (React skips re-render when the reference is unchanged). Forgetting one of the three causes ghost entries that persist in the UI after deletion, or stale data after renames/pins/status changes.

**Affected handlers** (non-exhaustive): `handleTogglePin`, `handleDragEnd`, `saveWorkspaceNotes`, `handleRenameWorkspace`, `removeWorkspaceImplRef`, `removeRepository`, PR URL detection in `useAgentEvents`.

### Rust Lock Ordering
- Never hold two `RwLock` guards (`workspaces` + `agents`, `workspaces` + `repos`) simultaneously — collect data, drop the first lock, then acquire the second
- If you must read from two maps, clone the data from the first into a `Vec`/`HashMap`, drop the guard, then acquire the second

### Agent Status vs Processing
- `Agent.status` (`Running`/`Stopped`/`Starting`/`Error`) tracks **lifecycle** — whether the agent process exists. It does NOT track per-message busy state.
- `Agent.processing` (`bool`, `#[serde(skip)]`) tracks whether the agent is **currently processing a message** from the HTTP API. Only the HTTP handler sets it `true`; the `ProcessingGuard` drop resets it.
- Don't use `Agent.status` to detect if an agent is busy between messages — it stays `Running` from creation until `stop_agent`.

### Optimistic State Preservation
When loading workspace lists from the backend (`loadWorkspaces`, `loadGodChildWorkspaces`), use `setX(prev => ...)` and preserve any entries with `status === "initializing"` that aren't in the fresh DB result. Without this, a concurrent load wipes optimistic entries before `create_workspace` returns.

### Security
- Never log or `eprintln!` environment variables that may contain secrets (`ANTHROPIC_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `ORCHESTRATOR_API_TOKEN`, etc.)
- Use `fixed_length_constant_time_eq` for token comparison — do NOT use `==` on secret strings
- HTTP API endpoints that accept POST bodies must have an explicit `DefaultBodyLimit`
- Skill files go to user-level `~/.claude/skills/`, not worktree-level `.claude/skills/` — worktree placement pollutes `git status` and risks accidental commits
- HTTP API endpoints must scope results by `god_workspace_id` — all god workspaces share a single bearer token, so unscoped endpoints leak data across god workspace boundaries

## Refactoring Roadmap

### Current State
- `src-tauri/src/lib.rs` is ~3,800 lines — Tauri commands, app state, WS handler (reduced from ~6,840 in Phase 4)
- `src-tauri/src/claude/` — Claude CLI integration extracted to 6 submodules (~1,900 lines, Phase 4 complete)
- `src-tauri/src/git.rs` — worktree ops, branch detection, orchestrator config (~170 lines, Phase 4 complete)
- `src-tauri/src/types.rs` — all shared structs/enums extracted (Phase 1 complete)
- `src-tauri/src/helpers.rs` — shared helpers (`now_rfc3339`, `new_id`, constants) extracted to public module (Phase 1 complete)
- `src/App.tsx` is ~4,343 lines — ~36 useState hooks, effects, handlers, and JSX layout in one component (reduced from ~4,950 in Phase 3)
- `src/hooks/` — 4 hooks extracted (Phase 2 complete): `usePersistedState` (broadly adopted, 11 pairs), `useTauriListener`, `useAgentEvents`, `usePanelResize`
- `src-tauri/src/process_manager.rs` — deleted (confirmed unused, Phase 1 complete)
- 7 components extracted outside roadmap: `SettingsModal`, `SkillsMarketplace`, `ToolbarDropdown`, `ThinkingTimer`, `PermissionCard`, `GroupDropZone`, `SortableGroupItem`
- ~~The Claude execution loop (~700 lines) is duplicated verbatim~~ → resolved: unified `run_claude_message` in `claude/runner.rs` (Phase 4)
- Multiple WS command handlers still duplicate their corresponding Tauri commands (remove_workspace, remove_repository, run_checks, list_files, etc.)

### Known DRY Violations

**Rust (`lib.rs`)**
- ~~`chrono::Utc::now().to_rfc3339()` — 25 occurrences~~ → resolved: `fn now_rfc3339()` (Phase 1)
- ~~`Uuid::new_v4().to_string()` — 8 occurrences~~ → resolved: `fn new_id()` (Phase 1)
- `response_tx.send(serde_json::to_string(&resp).unwrap())` — 69 occurrences, needs helper/macro
- ~~`"Workspace not found"` error string — 10+ occurrences~~ → resolved: `ERR_WORKSPACE_NOT_FOUND` (Phase 1)
- ~~`200_000` file read limit — 3 occurrences~~ → resolved: `const MAX_FILE_READ_BYTES` (Phase 1)
- `WorkspaceCheckResult` and `CheckInfo` are identical structs — unify
- String-to-`WorkspaceStatus` parsing duplicated — needs `impl FromStr`

**TypeScript (`App.tsx`)**
- ~~localStorage load/persist effect pairs — ~15 raw pairs~~ → resolved: 11 pairs migrated to `usePersistedState` (Phase 2); 4 remain (left/right panel with `isBelowLg` guard, theme with `applyTheme` side-effect, shortcuts with utility fns)
- `setError(String(err))` catch blocks — 28 occurrences, needs `wrapCommand()` helper
- Modal dialog scaffolding — 8 `show*` boolean state vars, needs `<Modal>` component
- Skill card JSX duplicated verbatim — needs `<SkillCard>` component
- `delete next[workspaceId]` record cleanup — 20 occurrences, needs `deleteFromRecord()` updater
- `prev.map(w => w.id === updated.id ? updated : w)` — 2 occurrences, needs `replaceById()` utility
- ~~Pure functions defined inside component~~ → resolved: moved to `utils.ts` (Phase 1)

### Target Architecture — Rust Backend

```
src-tauri/src/
├── lib.rs                  # ~300 lines: AppState, run(), invoke_handler registration
├── types.rs                # All pub structs/enums
├── git.rs                  # Worktree ops, branch detection
├── claude/
│   ├── runner.rs           # Shared Claude execution loop (eliminates duplication)
│   ├── env.rs              # CLI env building, AWS auth, shell env
│   ├── stream.rs           # Stream event parsing, text extraction
│   ├── discovery.rs        # CLI path finding, capability detection
│   └── models.rs           # Model/effort/permission normalization
├── commands/
│   ├── repository.rs       # add/remove/list repositories
│   ├── workspace.rs        # CRUD, terminal, orchestrator scripts
│   ├── agent.rs            # start/stop/interrupt/send_message
│   ├── files.rs            # File browser, changes, diff
│   ├── checks.rs           # Workspace health checks
│   ├── pr.rs               # PR creation, sync, editor launch
│   ├── skills.rs           # Skill listing, saving, path helpers
│   └── server.rs           # Remote server, app status
├── database.rs             # (unchanged)
├── websocket_server.rs     # Slimmed: dispatch delegates to commands/*
└── http_server.rs          # (unchanged)
```

### Target Architecture — TypeScript Frontend

```
src/
├── hooks/
│   ├── usePersistedState.ts    # ✓ Replaces localStorage effect pairs (11 adopted)
│   ├── useAgentEvents.ts       # ✓ Agent event listeners (message, run-state, permission)
│   ├── usePanelResize.ts       # ✓ 3-panel resize logic
│   ├── useKeyboardShortcuts.ts # Global hotkeys (not yet created)
│   └── useTauriListener.ts     # ✓ Generic Tauri listen/unlisten
├── components/
│   ├── Modal.tsx               # Shared modal shell (not yet created)
│   ├── SkillCard.tsx           # Skill card (not yet created)
│   ├── FileTree.tsx            # Recursive file browser (not yet created)
│   ├── ChatComposer.tsx        # Input area + toolbar (not yet created)
│   ├── GroupDropZone.tsx        # ✓ Already extracted
│   ├── LinkifiedInlineText.tsx  # ✓ Already extracted
│   ├── MarkdownCodeBlock.tsx    # ✓ Already extracted
│   ├── MarkdownMessage.tsx      # ✓ Already extracted
│   ├── PermissionCard.tsx       # ✓ Already extracted
│   ├── QuestionCard.tsx         # ✓ Already extracted
│   ├── SettingsModal.tsx        # ✓ Already extracted
│   ├── SkillsMarketplace.tsx    # ✓ Already extracted
│   ├── SortableGroupItem.tsx    # ✓ Already extracted
│   ├── SortableWorkspaceItem.tsx # ✓ Already extracted
│   ├── ThinkingTimer.tsx        # ✓ Already extracted
│   ├── ToolbarDropdown.tsx      # ✓ Already extracted
│   └── dialogs/                # All modal dialogs extracted from App.tsx (not yet created)
├── utils/
│   ├── workspace.ts            # replaceById, deleteFromRecord, statusForGroup
│   └── commands.ts             # wrapCommand (error-handling invoke wrapper)
├── App.tsx                     # Slimmed to ~1,500 lines
├── types.ts, constants.ts, themes.ts, utils.ts  # (unchanged)
```

### Phased Execution Order

**Phase 1 — Zero-risk extractions (no dependency changes)**
1. Move pure functions from `App.tsx` to `utils.ts`
2. Add Rust helper functions (`now_rfc3339`, `new_id`, constants)
3. Extract Rust `types.rs` module
4. Delete `process_manager.rs` if confirmed unused

**Phase 2 — Custom hooks (big line-count wins)** ✓ Complete
5. ~~`usePersistedState` hook~~ → created and broadly adopted (11 of 15 pairs migrated; 4 intentionally skipped)
6. ~~`useTauriListener` wrapper~~ → created at `src/hooks/useTauriListener.ts`
7. ~~`useAgentEvents` hook~~ → created at `src/hooks/useAgentEvents.ts` (agent-message, agent-run-state, permission-request)
8. ~~`usePanelResize` hook~~ → created at `src/hooks/usePanelResize.ts` (6 state vars + resize effect extracted)

**Phase 3 — Component extraction**
9. `<Modal>` component (prerequisite for dialog extraction)
10. Extract 7 dialog components from App.tsx
11. `<SkillCard>`, `<FileTree>` components

**Phase 4 — Rust module extraction (highest impact)** ✓ Partial
12. ~~Extract `claude/runner.rs` — shared execution loop~~ → complete: `claude/` with 6 submodules (discovery, env, models, stream, runner)
12b. ~~Extract `git.rs`~~ → complete: worktree ops, branch detection, orchestrator config
12c. ~~Unify WS `SendMessage` handler~~ → complete: delegates to `run_claude_message`
13. Extract `commands/` modules (not yet started)
14. Slim remaining `handle_ws_commands` arms to delegate to `commands/*` (not yet started)

**Phase 5 — State management (enables panel extraction)**
15. Introduce zustand or React Context
16. Extract LeftSidebar, CenterPanel, RightPanel as components

## Dependencies

### Rust (Cargo.toml)
- `tauri` - App framework
- `rusqlite` - SQLite database
- `tokio-tungstenite` - WebSocket server
- `parking_lot` - Fast RwLock implementation
- `serde` / `serde_json` - Serialization

### Frontend (package.json)
- `react` - UI framework
- `@tauri-apps/api` - Tauri IPC
- `tailwindcss` - Styling
- `@dnd-kit/core` + `@dnd-kit/sortable` - Drag and drop
- `react-markdown` + `remark-gfm` + `remark-breaks` - Markdown rendering
