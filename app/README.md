# Translator Overlay · app

The Electron app. Install, use and development notes are in the [project README](../README.md).

| Where | What |
|---|---|
| `main.js` | Windows, hotkeys, IPC, and the game-window poll |
| `engine/` | Hidden window that captures the game, finds changed regions and crops them |
| `overlay/` | The click-through layer that paints the translations |
| `ui/` | The control panel |
| `src/config.js` | Paths, default settings, prompts and the Gemini key |
| `src/session.js` | One overlay session: requests, memory, profile calls |
| `src/requests.js` | Builds the Gemini request bodies |
| `src/gemini.js` | Minimal streaming Gemini REST client |
| `src/blockstream.js` | Emits each translated block as soon as it closes in the stream |
| `src/store.js` | Per-game files under `data/games/` |
| `src/win32.js` | Window lookup and process details through koffi |
| `test/` | Unit tests, the overlay fit test, the live API probe and the end-to-end script with its test game |
