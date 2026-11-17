const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const DEFAULT_ABOUT = process.env.DEFAULT_ABOUT || 'Hey there! I am using WhatsApp.';
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_SECONDS || 20) * 1000; // throttle between About updates
const MAX_LEN = 139;            // WhatsApp About limit

let ready = false;
let desired = null;               // what About should currently say (null = nothing to push yet)
let applied = null;             // what we last actually set
let lastSet = 0;
let timer = null;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox'],
    // Use an installed Chromium-based browser (override with BROWSER_PATH)
    executablePath: process.env.BROWSER_PATH || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  },
});

client.on('qr', (qr) => {
  console.log('Scan this QR with WhatsApp > Linked devices:');
  qrcode.generate(qr, { small: true });
});
client.on('ready', () => { ready = true; console.log('WhatsApp ready.'); schedule(); });
client.on('auth_failure', (m) => console.error('Auth failure:', m));
client.on('disconnected', (r) => { ready = false; console.error('Disconnected:', r); });

// WhatsApp replaced the old About setter (setMyStatus) with "text status".
// setTextStatus(text, emoji, durationSeconds): duration -1 = never expires, all null = clear.
const ABOUT_DURATION = Number(process.env.ABOUT_DURATION || -1);

async function setAbout(text) {
  const isDefault = text === DEFAULT_ABOUT;
  const res = await client.pupPage.evaluate(async (text, clear, duration) => {
    const bridge = window.require('WAWebContactTextStatusBridge');
    if (bridge && typeof bridge.setTextStatus === 'function') {
      const r = clear
        ? await bridge.setTextStatus(null, null, null)
        : await bridge.setTextStatus(text, null, duration);
      return { via: 'textStatus', result: r && r.result };
    }
    return { via: 'none' };
  }, text, isDefault, ABOUT_DURATION);

  if (res.via === 'none') return client.setStatus(text); // old WhatsApp Web versions
  if (res.result !== 'SUCCESS') throw new Error(`text status update returned ${res.result}`);
}

function format({ playing, title, artist, platform }) {
  const song = `🎵 ${artist ? artist + ' - ' : ''}${title}`;
  const suffix = platform ? ` - ${platform}` : '';
  // Truncate the song part so the platform is always kept
  const room = MAX_LEN - suffix.length;
  return (song.length > room ? song.slice(0, room - 1) + '…' : song) + suffix;
}

function schedule() {
  if (!ready || desired === null || desired === applied || timer) return;
  const wait = Math.max(0, lastSet + MIN_INTERVAL_MS - Date.now());
  timer = setTimeout(async () => {
    timer = null;
    const text = desired; // always apply the latest value, skipping intermediate tracks
    try {
      await setAbout(text);
      applied = text;
      lastSet = Date.now();
      console.log('About ->', text);
    } catch (e) {
      console.error('setStatus failed:', e.message);
      lastSet = Date.now();
    }
    schedule();
  }, wait);
}

// Media watcher: PowerShell helper emits a JSON line on every change.
const ps = spawn('powershell.exe', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'smtc.ps1'),
]);
let buf = '';
ps.stdout.setEncoding('utf8');
ps.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let state;
    try { state = JSON.parse(line); } catch { continue; } // ignore partial/garbled line
    onMedia(state);
  }
});

// --- Idle mode: nothing playing for IDLE_AFTER_MS -> "🌙 Idle - <message you type>" ---
const IDLE_AFTER_MS = Number(process.env.IDLE_AFTER_SECONDS || 30) * 1000;
let idleActive = false;
let idleTimer = null;
let idleAbort = null;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('SIGINT', shutdown); // readline swallows Ctrl+C otherwise

function idleText(msg) {
  const text = `🌙 Idle${msg ? ' - ' + msg : ''}`;
  return text.length > MAX_LEN ? text.slice(0, MAX_LEN - 1) + '…' : text;
}

function startIdle() {
  idleTimer = null;
  idleActive = true;
  desired = idleText('');
  console.log('Idle:', desired);
  schedule();

  // Ask for the message. If you're away it just stays "🌙 Idle" until you answer.
  try {
    idleAbort = new AbortController();
    rl.question('\n🌙 You\'re idle - message to show? (Enter to skip): ', { signal: idleAbort.signal }, (answer) => {
      idleAbort = null;
      const msg = answer.trim();
      if (!idleActive || !msg) return;
      desired = idleText(msg);
      console.log('Idle:', desired);
      schedule();
    });
  } catch (e) {
    // stdin closed / no terminal: still go idle, just without a custom message
    idleAbort = null;
    console.error('Cannot ask for an idle message:', e.message);
  }
}

function endIdle() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (idleAbort) { idleAbort.abort(); idleAbort = null; console.log(); } // drop an unanswered prompt
  idleActive = false;
}

// Never show a browser name as the platform. If the site can't be read from the window title
// (music tab in the background), reuse the last site seen, else DEFAULT_BROWSER_PLATFORM, else omit it.
const BROWSER_NAMES = new Set(['Brave', 'Chrome', 'Edge', 'Firefox', 'Opera', 'Vivaldi']);
let lastSite = process.env.DEFAULT_BROWSER_PLATFORM || null;

function resolvePlatform(platform) {
  if (!platform) return null;
  if (!BROWSER_NAMES.has(platform)) { if (platform !== 'YouTube') lastSite = platform; return platform; }
  return lastSite;
}

function onMedia(state) {
  if (state.playing && state.title) {
    endIdle();
    state.platform = resolvePlatform(state.platform);
    desired = format(state);
    console.log('Detected:', desired);
    schedule();
  } else if (!idleActive && !idleTimer) {
    // keep showing the last song briefly (e.g. between tracks) before going idle
    idleTimer = setTimeout(startIdle, IDLE_AFTER_MS);
  }
}
ps.stderr.on('data', (d) => console.error('[smtc]', d.toString().trim()));

async function shutdown() {
  ps.kill();
  try { if (ready) await setAbout(DEFAULT_ABOUT); } catch {}
  try { await client.destroy(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Never die silently: a crash would leave the last song on your About forever.
process.on('uncaughtException', (e) => console.error('Uncaught:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled:', e));

client.initialize();
