# Working notes for this repository

## Priorities

- **Online multiplayer is the primary play mode.** Design features for the server-hosted rooms first; local pass-and-play is secondary.
- **Verify every change in online mode first**: run the server (`PORT=8090 node server/index.js`) and drive a host plus a guest (and a bot) in headless Chromium through the real WebSocket protocol before checking local mode. Watch for behavior that differs between the two, such as redacted state, sequence numbers and timers.

## Layout

- `src/game.js` is the pure rules engine; `server/rooms.js` runs it for online rooms and `src/ui/app.js` for local games. A feature usually needs both paths.
- `server/redact.js` decides what each seat may see; anything hidden from a player must be hidden there, not only in the UI.
- Tests: `npm test` (Node's built-in runner). Room tests use a fake clock and scheduler (`test/rooms.test.js`), with injectable dice for the roll-off.
- `window.__catan` exposes debugging hooks in the browser: `state`, `room`, `dispatch`, `load(saved)` for local games and `inject(msg)` to feed a server message to the online handler.

## Conventions

- Keep the zero-dependency setup (only `ws` at runtime); no build step.
- Push to `claude/catan-web-clone-u05m9b`, then fast-forward `main` (what Railway deploys).
