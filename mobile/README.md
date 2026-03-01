# Claude Orchestrator Mobile

## Run

1. Install deps:
   npm install
2. Start dev server:
   npm run start
3. Open in Expo Go (same Wi-Fi as desktop app).

If Metro shows `Cannot find expo/AppEntry` or `Cannot find babel-preset-expo`,
run from the `mobile/` folder and clear Metro cache:

`npm install && npm run start`

## WebSocket URL

Set URL in app header, e.g.

`ws://192.168.1.42:3001`

Desktop app must be running.
