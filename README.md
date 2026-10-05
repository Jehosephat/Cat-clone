# Settlers – a web-based Catan clone

A mobile-friendly, zero-dependency browser implementation of the classic island-building board game, with the full base-game rule set.

Play it by serving the repository root as a static site (no build step):

```sh
npm start          # zero-dependency Node static server on port 8080
# then open http://localhost:8080
```

Any static host works (GitHub Pages from the repository root, Netlify, `npx serve`, …).

## Features

**Rules (base game)**
- 3 or 4 players, any mix of humans (pass-and-play on one device) and bots
- Variable setup (shuffled terrain, rulebook number spiral, shuffled harbors) or the rulebook beginner layout
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
- Pass-and-play privacy screen between human players
- Seed for a reproducible board and dice

**App**
- Responsive layout: portrait phones, landscape tablets and desktops
- Large tap targets on the board for placing pieces
- Game auto-saves to the browser, resume from the start screen
- Bot opponents with simple heuristics (placement, building priorities, robber targeting, bank trades, trade responses)

## Project layout

```
index.html          entry point
styles.css          all styling (mobile-first, with a wide-screen layout)
src/constants.js    costs, card counts, layouts, labels
src/board.js        hex geometry, topology (vertices/edges), board generation, harbors
src/rules.js        placement validity, longest road, victory points, trade ratios
src/game.js         game state and all actions (pure, serializable state)
src/ai.js           bot decision making
src/ui/             DOM/SVG rendering and the app controller
test/               node:test suites for the board, rules, engine and bot games
```

The engine is pure: `newGame(options)` creates a state object and `act(state, action)` returns a new state or throws `GameError` for illegal moves. The UI is a thin layer that renders the state and dispatches actions, so the rules are fully unit-testable without a browser.

## Development

```sh
npm test           # runs the test suites with Node's built-in test runner (Node 18+)
```

No dependencies are required for running or testing.
