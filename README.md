# whatsapp-rpc

Discord-style "Rich Presence" for WhatsApp. It watches what you're playing on your PC and mirrors it into your WhatsApp **About** text:

```
🎵 Maroon 5 - Memories - YT Music
🌙 Idle - brb, dinner
```

Works with anything that shows up in the Windows media overlay: **Spotify, YouTube Music, SoundCloud, Apple Music, Deezer, Tidal**, and others.

> **Unofficial.** This uses [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js), which automates WhatsApp Web. WhatsApp doesn't allow unofficial clients, so there is a risk your number gets restricted. Use at your own risk, ideally on a number you can afford to lose. It also depends on WhatsApp Web internals, so it can break whenever WhatsApp updates.

## How it works

1. `smtc.ps1` reads the Windows media session (SMTC) and prints a JSON line whenever the track or play state changes. For browser players it reads open tab titles to tell YT Music, SoundCloud, etc. apart.
2. `index.js` turns that into text and sets your About through WhatsApp Web (headless Chromium).
3. When nothing has played for a while, it switches to `🌙 Idle` and asks you in the terminal for an optional message.

Updates are throttled and the text is capped at 139 characters (the platform is always kept; the song gets shortened first).

## Requirements

- Windows 10/11 (uses the Windows media session API)
- Node.js 18+
- A Chromium-based browser (Brave, Chrome, Edge). Puppeteer's own Chromium download is skipped.

## Setup

```powershell
git clone https://github.com/VloStudios/whatsapp-rpc.git
cd whatsapp-rpc
npm install
npm start
```

On first run scan the QR code in WhatsApp under **Linked devices**. The session is saved in `.wwebjs_auth/` (git-ignored), so you only scan once.

If your browser isn't Brave, point to it:

```powershell
$env:BROWSER_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
npm start
```

## Configuration

Set these as environment variables before `npm start`:

| Variable | Default | What it does |
| --- | --- | --- |
| `BROWSER_PATH` | Brave in `Program Files` | Chromium-based browser to drive |
| `MIN_INTERVAL_SECONDS` | `20` | Minimum time between About updates (don't set this too low) |
| `IDLE_AFTER_SECONDS` | `30` | Nothing playing for this long → idle |
| `ABOUT_DURATION` | `-1` | Seconds until the About expires (`-1` = never) |
| `DEFAULT_BROWSER_PLATFORM` | none | Platform to show if the site can't be read from browser tabs, e.g. `YT Music` |

Press **Ctrl+C** to quit. It clears your About on the way out.

## Notes

- **Browser players:** Windows only reports "Brave" or "Chrome", so the site is guessed from open tab titles. A browser name is never shown as the platform. If the site can't be found it reuses the last one seen, then `DEFAULT_BROWSER_PLATFORM`, then omits it.
- **Idle:** if the terminal has no input (closed stdin) it still goes idle, just without asking for a message.
- **Privacy:** the login session lives in `.wwebjs_auth/`. Never commit or share it; it's already in `.gitignore`.
- **`npm audit`:** reports vulnerabilities in transitive dependencies of whatsapp-web.js (Puppeteer's download and archive tooling). They aren't reachable here since no browser is downloaded and no FTP or zip handling is used.
