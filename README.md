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
├── mobile/                   # React Native (Expo) companion app
│   ├── App.tsx              # Mobile UI
│   ├── app.json             # Expo config
│   └── package.json
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

## Desktop Auto Updates

The desktop app is configured to check for updates from GitHub Releases and install updates in-app.

- Update endpoint: `https://github.com/noble1911/claude-orchestrator/releases/latest/download/latest.json`
- Public key: configured in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`

To produce signed updater artifacts on release, add these GitHub repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

`TAURI_SIGNING_PRIVATE_KEY` should be the minisign private key content (starts with `untrusted comment:`). The release workflow also accepts escaped-newline and base64-encoded variants and normalizes them before build.

The release workflow uploads `latest.json` plus updater bundles/signatures to the Release assets.
If updater signing secrets are missing or invalid, the workflow still uploads desktop app zip + dmg, and skips updater tar/signature/latest.json.
If a release run fails, you can re-run artifact generation from Actions using the `Release Artifacts` workflow `Run workflow` button with `release_tag` (for example `v0.0.3`).

## Mobile App

A companion React Native (Expo) app lives in the `mobile/` directory. It connects to the desktop app over WebSocket for remote monitoring and control of workspaces.

Current GitHub Release behavior: the mobile release job builds and uploads an Android APK (`*-android.apk`).

### Prerequisites

- Node.js 18+
- [Expo CLI](https://docs.expo.dev/get-started/installation/) (`npx expo` works out of the box)
- For iOS: Xcode 15+ and an iOS Simulator (or [Expo Go](https://apps.apple.com/app/expo-go/id982107779) on a physical device)
- For Android: Android Studio with an emulator (or [Expo Go](https://play.google.com/store/apps/details?id=host.exp.exponent) on a physical device)

### Quick Start (Expo Go)

The fastest way to run the mobile app during development:

```bash
cd mobile
npm install
npm run start
```

Scan the QR code with Expo Go (iOS Camera app or Android Expo Go app). Your phone must be on the same Wi-Fi network as your desktop.

### Native Builds

For a full native build (required for features not supported by Expo Go):

```bash
cd mobile

# iOS (requires Xcode)
npm run ios

# Android (requires Android Studio)
npm run android
```

### Connecting to the Desktop App

1. Make sure the Claude Orchestrator desktop app is running (it starts the WebSocket server on port 3001).
2. In the mobile app, set the WebSocket URL to your desktop's local IP:
   ```
   ws://192.168.x.x:3001
   ```
3. Find your desktop IP with `ipconfig getifaddr en0` (macOS).

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
