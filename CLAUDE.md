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
│   │   ├── lib.rs               # Tauri commands, app state, Claude CLI execution
│   │   ├── database.rs          # SQLite schema & CRUD operations
│   │   ├── websocket_server.rs  # WebSocket server for mobile/web clients
│   │   └── process_manager.rs   # (Legacy) Claude CLI process management
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
│   └── components/
│       ├── LinkifiedInlineText.tsx  # Auto-links URLs in plain text
│       ├── MarkdownCodeBlock.tsx    # Code block with copy button
│       ├── MarkdownMessage.tsx      # Full markdown renderer for agent responses
│       ├── QuestionCard.tsx         # Agent question UI with option selection
│       └── SortableWorkspaceItem.tsx # Drag-and-drop workspace sidebar entry
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
Still the largest file (~4,500 lines). Contains:
- **State management**: ~120 useState hooks for all app state
- **Event listeners**: Tauri event subscriptions (agent-message, agent-run-state, remote-clients)
- **Effect hooks**: localStorage persistence, polling, keyboard shortcuts, panel resizing
- **Handler functions**: CRUD for workspaces/repos, agent control, file browsing, terminal, checks
- **JSX layout**: Three-panel layout (left sidebar, center chat/file viewer, right tools panel)

### `src/components/`
Extracted UI components that are self-contained (no dependency on App state):
- **MarkdownMessage**: Renders agent responses with full GFM support, code highlighting, link handling
- **QuestionCard**: Handles agent questions with single/multi-select options and bundled answers
- **SortableWorkspaceItem**: DnD-enabled workspace entry with status indicator, pin, rename, delete
- **LinkifiedInlineText**: Auto-detects and linkifies URLs in plain text
- **MarkdownCodeBlock**: Code block with copy-to-clipboard button

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
| `src-tauri/src/lib.rs` | All Tauri commands, state management, Claude CLI execution |
| `src-tauri/src/database.rs` | SQLite schema and CRUD operations |
| `src-tauri/src/websocket_server.rs` | WebSocket server for remote clients |
| `src/types.ts` | All shared TypeScript interfaces & type aliases |
| `src/constants.ts` | Storage keys, defaults, model options |
| `src/utils.ts` | Pure utility functions (message handling, URL parsing, etc.) |
| `src/themes.ts` | Theme definitions & management |
| `src/App.tsx` | Main React component (state, effects, handlers, layout) |
| `src/components/*.tsx` | Extracted UI components (Markdown, QuestionCard, etc.) |

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

## Database Schema

```sql
-- repositories: Added git repos
-- workspaces: Isolated worktrees per repo (with status, displayOrder, pinnedAt, notes, prUrl)
-- sessions: Claude conversation sessions
-- messages: Full conversation history
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

- Don't use `tokio::spawn` for Claude CLI - use `std::thread::spawn` (avoids runtime conflicts)
- Don't hold RwLock guards across await points
- Don't block the main thread with synchronous operations
- Don't define new types inline in `App.tsx` - put them in `types.ts`
- Don't add pure utility functions to `App.tsx` - put them in `utils.ts`
- Don't add new components inline in `App.tsx` - create files in `components/`
- Don't duplicate logic between Tauri commands and WebSocket handlers — have WS handlers call the shared function
- Don't add new `useEffect` pairs for localStorage — use `usePersistedState` hook (once extracted)
- Don't add new modal dialogs inline in `App.tsx` — use `<Modal>` component in `components/dialogs/`
- Don't hardcode magic numbers — define named constants (e.g., `MAX_FILE_READ_BYTES`, `WORKTREES_DIR`)
- Don't add new `setError(String(err))` catch blocks — use `wrapCommand()` helper (once extracted)

## Refactoring Roadmap

### Current State
- `src-tauri/src/lib.rs` is ~6,300 lines — all Tauri commands, Claude CLI execution, stream parsing, env management live in one file
- `src-tauri/src/types.rs` — all shared structs/enums extracted (Phase 1 complete)
- `src/App.tsx` is ~4,700 lines — all state (~120 useState hooks), effects, handlers, and JSX layout in one component
- `src-tauri/src/process_manager.rs` — deleted (confirmed unused, Phase 1 complete)
- The Claude execution loop (~700 lines) is **duplicated verbatim** between `send_message_to_agent` and `handle_ws_commands::SendMessage`
- Multiple WS command handlers duplicate their corresponding Tauri commands (remove_workspace, remove_repository, run_checks, list_files, etc.)

### Known DRY Violations

**Rust (`lib.rs`)**
- ~~`chrono::Utc::now().to_rfc3339()` — 25 occurrences~~ → resolved: `fn now_rfc3339()` (Phase 1)
- ~~`Uuid::new_v4().to_string()` — 8 occurrences~~ → resolved: `fn new_id()` (Phase 1)
- `response_tx.send(serde_json::to_string(&resp).unwrap())` — 66 occurrences, needs helper/macro
- ~~`"Workspace not found"` error string — 10+ occurrences~~ → resolved: `ERR_WORKSPACE_NOT_FOUND` (Phase 1)
- ~~`200_000` file read limit — 3 occurrences~~ → resolved: `const MAX_FILE_READ_BYTES` (Phase 1)
- `WorkspaceCheckResult` and `CheckInfo` are identical structs — unify
- String-to-`WorkspaceStatus` parsing duplicated — needs `impl FromStr`

**TypeScript (`App.tsx`)**
- localStorage load/persist effect pairs — 10 pairs (~160 lines), needs `usePersistedState<T>` hook
- `setError(String(err))` catch blocks — 24 occurrences, needs `wrapCommand()` helper
- Modal dialog scaffolding — 5 identical wrappers, needs `<Modal>` component
- Skill card JSX duplicated verbatim — needs `<SkillCard>` component
- `delete next[workspaceId]` record cleanup — 16 occurrences, needs `deleteFromRecord()` updater
- `prev.map(w => w.id === updated.id ? updated : w)` — 4 occurrences, needs `replaceById()` utility
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
│   ├── usePersistedState.ts    # Replaces localStorage effect pairs
│   ├── useAgentEvents.ts       # Tauri event listeners
│   ├── usePanelResize.ts       # 3-panel resize logic
│   ├── useKeyboardShortcuts.ts # Global hotkeys
│   └── useTauriListener.ts     # Generic Tauri listen/unlisten
├── components/
│   ├── Modal.tsx               # Shared modal shell
│   ├── SkillCard.tsx           # Skill card (deduplicated)
│   ├── FileTree.tsx            # Recursive file browser
│   ├── ChatComposer.tsx        # Input area + toolbar
│   ├── (existing components)
│   └── dialogs/                # All modal dialogs extracted from App.tsx
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

**Phase 2 — Custom hooks (big line-count wins)**
5. `usePersistedState` hook (~160 lines eliminated)
6. `useTauriListener` wrapper
7. `useAgentEvents` hook (splits the mega-effect)
8. `usePanelResize` hook

**Phase 3 — Component extraction**
9. `<Modal>` component (prerequisite for dialog extraction)
10. Extract 7 dialog components from App.tsx
11. `<SkillCard>`, `<FileTree>` components

**Phase 4 — Rust module extraction (highest impact)**
12. Extract `claude/runner.rs` — shared execution loop
13. Extract `commands/` modules
14. Slim `handle_ws_commands` to delegate to `commands/*`

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
