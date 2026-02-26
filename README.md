# Claude Orchestrator

A native macOS application for managing multiple Claude Code CLI agents with WebSocket API support for mobile/web clients.

## Features

- **Workspace Management**: Add and manage multiple project directories
- **Agent Spawning**: Start/stop Claude CLI processes per workspace
- **WebSocket API**: Connect mobile apps for remote monitoring and control
- **Real-time Updates**: Stream Claude responses to connected clients
- **SQLite Persistence**: Workspaces and sessions saved locally

## Tech Stack

| Layer | Technology |
|-------|------------|
| App Framework | Tauri 2.x |
| Backend | Rust |
| Frontend | React 19 + TypeScript |
| Styling | Tailwind CSS |
| Database | SQLite (rusqlite) |
| WebSocket | tokio-tungstenite |
| Async Runtime | Tokio |

## Project Structure

```
claude-orchestrator/
├── src-tauri/                # Rust backend
│   └── src/
│       ├── lib.rs           # Tauri commands & state
│       ├── main.rs          # Entry point
│       ├── database.rs      # SQLite operations
│       ├── process_manager.rs  # Claude CLI spawning
│       └── websocket_server.rs # WebSocket server
├── src/                      # React frontend
│   ├── App.tsx              # Main UI
│   ├── main.tsx
│   └── index.css            # Tailwind
├── package.json
└── tauri.conf.json
```

## Development

### Prerequisites

- Node.js 18+
- Rust (via rustup)
- macOS 11+

### Setup

```bash
# Install dependencies
npm install

# Development mode (hot reload)
npm run tauri dev

# Production build
npm run tauri build
```

### Running

The built app will be at:
```
src-tauri/target/debug/bundle/macos/Claude Orchestrator.app
```

## WebSocket Protocol

The app exposes a WebSocket server on port 3001 for mobile/web clients.

### Client → Server

| Message | Description |
|---------|-------------|
| `connect` | Initial handshake |
| `command` | Send command to workspace |
| `subscribe` | Subscribe to workspace updates |

### Server → Client

| Message | Description |
|---------|-------------|
| `connected` | Handshake response with features |
| `response_chunk` | Streaming content from Claude |
| `response_end` | Response complete |

## Roadmap

- [ ] Actual Claude CLI process spawning
- [ ] Full WebSocket API integration  
- [ ] SQLite persistence for workspaces
- [ ] Message history storage
- [ ] Menu bar mode
- [ ] Mobile app companion

## License

MIT
