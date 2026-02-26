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
│   │   ├── lib.rs               # Main Tauri commands & app state
│   │   ├── database.rs          # SQLite CRUD operations
│   │   ├── websocket_server.rs  # WebSocket server for mobile clients
│   │   └── process_manager.rs   # (Legacy) Claude CLI process management
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── src/                          # React frontend
│   ├── App.tsx                  # Main UI component
│   └── main.tsx                 # Entry point
│
├── package.json                  # Frontend dependencies
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

### Agents
Claude CLI instances running in a workspace. Agents:
- Use `--session-id` for new sessions
- Use `--resume` for continuing existing sessions
- Run in background threads to avoid blocking the UI

### Sessions
Persist Claude conversation state across app restarts using stored session IDs.

## Key Files

| File | Purpose |
|------|---------|
| `src-tauri/src/lib.rs:1-1034` | All Tauri commands, state management, Claude CLI execution |
| `src-tauri/src/database.rs:1-300` | SQLite schema and CRUD operations |
| `src-tauri/src/websocket_server.rs:1-253` | WebSocket server for remote clients |
| `src/App.tsx:1-586` | React UI with workspace/agent management |

## Development Commands

```bash
# Development mode (hot reload)
npm run tauri dev

# Build for production
npm run tauri build

# Run Rust tests
cargo test --manifest-path src-tauri/Cargo.toml
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
-- workspaces: Isolated worktrees per repo
-- sessions: Claude conversation sessions
-- messages: Full conversation history
```

## Common Tasks

### Adding a new Tauri command
1. Add function in `lib.rs` with `#[tauri::command]` attribute
2. Register in `invoke_handler` at end of `run()`
3. Call from frontend with `invoke<ReturnType>("command_name", { params })`

### Modifying the database schema
1. Update `init_schema()` in `database.rs`
2. Add corresponding CRUD methods
3. Delete `~/Library/Application Support/claude-orchestrator/data.db` to recreate

### Adding WebSocket message types
1. Add variant to `WsMessage` enum in `websocket_server.rs`
2. Add handler in `handle_connection()` match statement
3. Add corresponding `WsResponse` if needed

## Anti-Patterns

- ❌ Don't use tokio::spawn for Claude CLI - use std::thread::spawn (avoids runtime conflicts)
- ❌ Don't hold RwLock guards across await points
- ❌ Don't block the main thread with synchronous operations

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
