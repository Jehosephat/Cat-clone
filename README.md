# Settlers – a web-based Catan clone

A mobile-friendly browser implementation of the classic island-building board game, with the full base-game rule set and real-time online multiplayer.

```sh
npm install
npm start          # http://localhost:8080 (or $PORT)
```

Open the page, enter a name and **Create a game**. Share the 4-letter room code or the invite link; friends open it on their own phones or computers and **Join**. The host can add bots to fill seats, choose the options, and start. **Play on this device** offers the original pass-and-play / bots mode, which needs no server connection.

## Deploying to Railway

The repository is ready for [Railway](https://railway.com): `railway.json` sets the start command and a health check on `/healthz`, and the server listens on the `PORT` Railway provides.

1. In Railway, create a project with **Deploy from GitHub repo** and pick this repository and branch.
2. Under the service's **Settings → Networking**, click **Generate Domain** to get a public `https://…up.railway.app` URL.
3. Share that URL. WebSockets work over the same domain (`wss://…/ws`) with no extra configuration.

Notes:
- Keep the service at **one replica**. Rooms live in the server's memory, so multiple replicas would split players across processes.
- A redeploy or restart ends games in progress; clients return to the home screen with a message. Rooms with nobody connected are cleaned up after three hours.

## Multiplayer design

- **Server-authoritative.** The server runs the same rules engine as the client (`src/game.js`). Clients send intended actions; the server validates the sender's seat, applies the action, and broadcasts the result. A client can only act for its own seat, and only on its turn (except discarding and answering trade offers).
- **Hidden information stays hidden.** Each player receives a redacted copy of the state (`server/redact.js`): opponents' resource and development cards are reduced to counts, the development deck order is hidden, and the RNG seed and state are never sent, so dice and steals cannot be predicted. Everything is revealed when the game ends.
- **Reconnects.** Each seat has a secret token stored in the browser. Refreshing the page or losing the connection reconnects to the same seat automatically. If a player is gone, anyone at the table can let a bot play for them from the menu; the player takes the seat back when they return.
- **Bots** run on the server, so a host can play against bots online, or mix friends and bots.
- **Chat.** A room chat in the lobby, the roll-off and the game, kept for the room's lifetime (200 messages) and replayed on reconnect. Messages are sanitized and limited to 280 characters.
- **Hardening.** Messages are size-limited and rate-limited, action payloads are sanitized to known fields, and the HTTP server only serves the page, stylesheet and client modules.

## Features

**Rules (base game)**
- 3 or 4 players, any mix of humans and bots
- Variable setup (shuffled terrain, rulebook number spiral, shuffled harbors) or the rulebook beginner layout
- Roll-off for the first player: everyone rolls a die in the lobby, highest goes first and play follows the dice; ties re-roll
- Snake-order setup placement; the second settlement yields its starting resources
- Dice production, cities producing double, robber blocking a hex
- Bank shortage rule: if the bank cannot pay everyone for a resource, nobody receives it
- Rolling a 7: discard half when holding more than 7 cards, move the robber, steal a random card
- Building roads, settlements (distance rule, must connect to your roads) and cities, with piece limits (15 / 5 / 4)
- Development cards: 14 Knights, 5 Victory Points, 2 Road Building, 2 Year of Plenty, 2 Monopoly; one card per turn, not the one bought this turn, playable before rolling
- Longest Road (5+, ties keep the holder, broken by opponents’ settlements) and Largest Army (3+ knights)
- Domestic trading with accept / decline per player, maritime trading at 4:1, 3:1 (generic harbor) and 2:1 (resource harbor)
- Victory on reaching the target on your own turn, hidden VP cards included

**Options**
- Victory point target (8 / 10 / 12 / 15)
- Discard limit (7 or 9 cards)
- Balanced numbers (never place 6 and 8 next to each other)
- Shuffle harbors
- Friendly robber (cannot be placed next to players with 2 or fewer points)
- Undo window: after most actions the player who acted gets a 4-second undo. Trades with other players, dice rolls, card purchases and steals cannot be undone, and an undo is only possible while nobody else has acted since (bots wait out the window)
- Local mode only: pass-and-play privacy screen, and a seed for a reproducible board and dice
- Sound effects (synthesized, no audio files): a "ding" whenever it becomes your move, a "ka-ching" when another player offers you a trade and a soft blip for chat, with an on/off toggle in the in-game menu
- Online chat with quick phrases, an unread badge and tap-to-open message toasts
- End-of-game statistics: every dice total rolled against what the odds predicted, sevens per player, and resources produced per player and type (with what the robber blocked), each with a table view

## Project layout

```
index.html          entry point
styles.css          all styling (mobile-first, with a wide-screen layout)
railway.json        Railway deploy settings
server/index.js     HTTP static server + WebSocket endpoint (/ws)
server/rooms.js     rooms, lobby, seat/turn enforcement, server-side bots
server/redact.js    per-player view of the game state
src/constants.js    costs, card counts, layouts, labels
src/board.js        hex geometry, topology (vertices/edges), board generation, harbors
src/rules.js        placement validity, longest road, victory points, trade ratios
src/game.js         game state and all actions (pure, serializable state)
src/rolloff.js      the opening die roll that decides the turn order
src/undo.js         undo offers after actions (what can be undone, and restoring the previous state)
src/ai.js           bot decision making
src/ui/app.js       screens: home, lobby, game; local and online modes
src/ui/net.js       WebSocket client with automatic reconnect
src/ui/sound.js     Web Audio sound effects (turn ding, trade ka-ching)
src/ui/stats-charts.js end-of-game dice and production charts with table views
src/ui/             board SVG rendering, dialogs, DOM helper
test/               node:test suites for the board, rules, engine, bots and multiplayer rooms
```

The engine is pure: `newGame(options)` creates a state object and `act(state, action)` returns a new state or throws `GameError` for illegal moves. Both the server and the local mode use it unchanged.

## Development

```sh
npm test           # Node's built-in test runner (Node 20+)
```

The only runtime dependency is [`ws`](https://github.com/websockets/ws) for the WebSocket server.
