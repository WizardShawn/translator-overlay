# Translator Overlay config

| File | What it is |
|---|---|
| `Set Gemini Key.cmd` | Double-click to paste or replace the Gemini API key. |
| `gemini-key.dpapi.json` | The key, encrypted with your Windows account. Created by the window above. |
| `gemini-key.ps1` | `Get-GeminiKey` and the encryption helpers. |
| `available-models.txt` | Models the saved key can call. Written when the key is checked. |
| `settings.json` | Models, languages, timing, and when the profile calls run. Written by the Settings page; anything missing falls back to the defaults in `app/src/config.js`. |
| `translator-prompt.md` | System prompt for every translation call. |
| `profile-identify-prompt.md` | System prompt for the one-time call on a new game. |
| `profile-update-prompt.md` | System prompt for the background profile updates. |

`{{source_language}}` and `{{target_language}}` in the prompts are filled from `settings.json`.

## The key

The key is encrypted with Windows DPAPI for your account, so only you, on this PC, can decrypt it. The file can sit in a synced folder, but another PC cannot read it. Run `Set Gemini Key.cmd` once on each PC. The key file is never committed: `.gitignore` keeps it out of the repository.

## The three calls

**Translate**, on every new screen of text. The request has the translator prompt as the system instruction. Then come the profile, glossary and recent dialogue, which change rarely and sit first so the cache can reuse them. Last come the numbered region crops. It waits for nothing else.

**Identify**, once per game, on first play. It starts after the first few lines of text are read, so the title screen and opening text are available. It sends the window title and the executable's product name and company, the same details Task Manager shows. It also sends that screen text and one picture of the game window, with web search on. Translation starts at once with an empty profile and picks up the draft when this call returns, usually within half a minute.

**Update**, in the background. It runs when a new speaker name appears, or every 60 lines, and never more than once every 5 minutes. It adds characters and terms from what you have actually seen and never touches entries you edited.
