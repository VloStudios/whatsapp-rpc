const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { startGui } = require('./gui');

const BROWSER_PATH = process.env.BROWSER_PATH || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const GUI_PORT = Number(process.env.GUI_PORT || 3737);
const ABOUT_DURATION = Number(process.env.ABOUT_DURATION || -1); // seconds until About expires, -1 = never
const MAX_LEN = 139;                  // WhatsApp About limit
const CLEAR = '\u0000clear';          // sentinel: clear the About text

// ---------------------------------------------------------------- settings (saved to settings.json)
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const DEFAULT_SETTINGS = {
  idleEnabled: true,
  idleAfterSeconds: Number(process.env.IDLE_AFTER_SECONDS || 30),
  minIntervalSeconds: Number(process.env.MIN_INTERVAL_SECONDS || 20),
  showPlatform: true,
  defaultBrowserPlatform: process.env.DEFAULT_BROWSER_PLATFORM || '',
};
let settings = { ...DEFAULT_SETTINGS };
try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch { /* first run */ }

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n)) || lo));
function applySettings(patch) {
  if ('idleEnabled' in patch) settings.idleEnabled = !!patch.idleEnabled;
  if ('showPlatform' in patch) settings.showPlatform = !!patch.showPlatform;
  if ('idleAfterSeconds' in patch) settings.idleAfterSeconds = clamp(patch.idleAfterSeconds, 5, 3600);
  // floor of 10s protects the account from looking like a bot
  if ('minIntervalSeconds' in patch) settings.minIntervalSeconds = clamp(patch.minIntervalSeconds, 10, 600);
  if ('defaultBrowserPlatform' in patch) settings.defaultBrowserPlatform = String(patch.defaultBrowserPlatform || '').trim().slice(0, 30);
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch { /* not fatal */ }
}

// ---------------------------------------------------------------- app state
const wa = { status: 'starting', qr: null }; // starting | qr | authenticating | ready | disconnected
let enabled = true;                          // master sync switch
let media = { playing: false };
let idle = { active: false, message: '' };
let cleared = false;                         // idle mode off + grace period over -> About cleared
let desired = null;                          // what About should say (null = nothing to push yet)
let applied = null;                          // what we last actually set
let lastSet = 0;
let timer = null;                            // pending About update
let nextUpdateAt = null;
let idleTimer = null;
let shuttingDown = false;
let gui = null;
const logs = [];

const show = (t) => (t === CLEAR || t == null ? null : t);
const emit = () => { if (gui) gui.broadcast(); };

function log(msg, level = 'info') {
  logs.push({ t: Date.now(), msg, level });
  if (logs.length > 60) logs.shift();
  (level === 'error' ? console.error : console.log)(msg);
  emit();
}

function getState() {
  return {
    wa: { status: wa.status, qr: wa.qr },
    enabled,
    media: { playing: !!media.playing, title: media.title || null, artist: media.artist || null, platform: media.platform || null },
    idle,
    about: {
      desired: show(desired), applied: show(applied), hasDesired: desired !== null,
      pending: desired !== null && desired !== applied, nextUpdateAt,
    },
    settings,
    logs,
  };
}

// ---------------------------------------------------------------- WhatsApp
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: { headless: true, args: ['--no-sandbox'], executablePath: BROWSER_PATH },
});

client.on('qr', async (qr) => {
  wa.status = 'qr';
  try { wa.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 }); } catch (e) { log(`QR error: ${e.message}`, 'error'); }
  emit();
});
client.on('authenticated', () => { wa.status = 'authenticating'; wa.qr = null; emit(); });
client.on('ready', () => { wa.status = 'ready'; wa.qr = null; log('WhatsApp connected'); schedule(); emit(); });
client.on('auth_failure', (m) => { wa.status = 'disconnected'; log(`Auth failure: ${m}`, 'error'); });
client.on('disconnected', (r) => { wa.status = 'disconnected'; log(`Disconnected: ${r}`, 'error'); });

// WhatsApp replaced the old About setter (setMyStatus) with "text status":
// setTextStatus(text, emoji, durationSeconds): duration -1 = never expires, all null = clear.
async function setAbout(text) {
  const clear = text === CLEAR;
  const res = await client.pupPage.evaluate(async (text, clear, duration) => {
    const bridge = window.require('WAWebContactTextStatusBridge');
    if (bridge && typeof bridge.setTextStatus === 'function') {
      const r = clear ? await bridge.setTextStatus(null, null, null) : await bridge.setTextStatus(text, null, duration);
      return { via: 'textStatus', result: r && r.result };
    }
    return { via: 'none' };
  }, text, clear, ABOUT_DURATION);

  if (res.via === 'none') return clear ? client.setStatus('') : client.setStatus(text); // old WhatsApp Web versions
  if (res.result !== 'SUCCESS') throw new Error(`text status update returned ${res.result}`);
}

function schedule() {
  if (wa.status !== 'ready' || desired === null || desired === applied || timer) return;
  const wait = Math.max(0, lastSet + settings.minIntervalSeconds * 1000 - Date.now());
  nextUpdateAt = Date.now() + wait;
  timer = setTimeout(async () => {
    timer = null; nextUpdateAt = null;
    const text = desired; // always apply the latest value, skipping intermediate tracks
    try {
      await setAbout(text);
      applied = text;
      log(text === CLEAR ? 'About cleared' : `About → ${text}`);
    } catch (e) {
      log(`Update failed: ${e.message}`, 'error');
    }
    lastSet = Date.now();
    schedule();
    emit();
  }, wait);
  emit();
}

// ---------------------------------------------------------------- what About should say
function format({ title, artist, platform }) {
  const song = `🎵 ${artist ? artist + ' - ' : ''}${title}`;
  const suffix = settings.showPlatform && platform ? ` - ${platform}` : '';
  const room = MAX_LEN - suffix.length; // truncate the song so the platform is always kept
  return (song.length > room ? song.slice(0, room - 1) + '…' : song) + suffix;
}

function idleText(msg) {
  const text = `🌙 Idle${msg ? ' - ' + msg : ''}`;
  return text.length > MAX_LEN ? text.slice(0, MAX_LEN - 1) + '…' : text;
}

function computeDesired() {
  if (!enabled) return CLEAR;
  if (idle.active) return idleText(idle.message);
  if (media.playing && media.title) return format(media);
  if (cleared) return CLEAR;
  return null; // grace period: keep whatever is showing
}

function refresh() {
  const d = computeDesired();
  if (d !== null) desired = d;
  schedule();
  emit();
}

// Never show a browser name as the platform. If the site can't be read from the tab titles,
// reuse the last site seen, else the "default browser platform" setting, else omit it.
const BROWSER_NAMES = new Set(['Brave', 'Chrome', 'Edge', 'Firefox', 'Opera', 'Vivaldi']);
let lastSite = null;
function resolvePlatform(platform) {
  if (!platform) return null;
  if (!BROWSER_NAMES.has(platform)) { if (platform !== 'YouTube') lastSite = platform; return platform; }
  return lastSite || settings.defaultBrowserPlatform || null;
}

// ---------------------------------------------------------------- media + idle
function onGraceOver() {
  idleTimer = null;
  if (settings.idleEnabled) { idle = { active: true, message: '' }; log('You\'re idle'); }
  else cleared = true;
  refresh();
}

function onMedia(state) {
  if (state.playing && state.title) {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    idle = { active: false, message: '' };
    cleared = false;
    const isNew = !media.playing || media.title !== state.title || media.artist !== state.artist;
    media = { ...state, platform: resolvePlatform(state.platform) };
    if (isNew) log(`Now playing: ${state.artist ? state.artist + ' - ' : ''}${state.title}`);
  } else {
    media = { playing: false };
    // keep showing the last song briefly (e.g. between tracks) before going idle
    if (!idle.active && !cleared && !idleTimer) idleTimer = setTimeout(onGraceOver, settings.idleAfterSeconds * 1000);
  }
  refresh();
}

// Media watcher: PowerShell helper emits a JSON line on every change.
const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'smtc.ps1')], { windowsHide: true });
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
ps.stderr.on('data', (d) => log(`[media] ${d.toString().trim()}`, 'error'));

// ---------------------------------------------------------------- actions from the GUI
async function onAction(a) {
  switch (a && a.type) {
    case 'setIdleMessage': {
      if (!idle.active) throw new Error('You\'re not idle right now');
      idle.message = String(a.message || '').trim().slice(0, 100);
      refresh();
      return;
    }
    case 'setEnabled':
      enabled = !!a.value;
      log(enabled ? 'Sync on' : 'Sync paused (About cleared)');
      refresh();
      return;
    case 'updateSettings': {
      applySettings(a.settings || {});
      if (!settings.idleEnabled && idle.active) { idle = { active: false, message: '' }; cleared = true; }
      else if (settings.idleEnabled && cleared && !media.playing) { cleared = false; idle = { active: true, message: '' }; }
      refresh();
      return;
    }
    case 'quit':
      setTimeout(shutdown, 50);
      return;
    default:
      throw new Error('unknown action');
  }
}

// ---------------------------------------------------------------- window + lifecycle
let win = null;
function openWindow(url) {
  if (process.env.NO_WINDOW) { log(`GUI at ${url}`); return; }
  const started = Date.now();
  try {
    win = spawn(BROWSER_PATH, [
      `--app=${url}`,
      `--user-data-dir=${path.join(os.tmpdir(), 'whatsapp-rpc-window')}`,
      '--window-size=480,860', '--no-first-run', '--no-default-browser-check',
    ], { stdio: 'ignore' });
    win.on('error', (e) => log(`Couldn't open window (${e.message}). Open ${url} in a browser.`, 'error'));
    win.on('exit', () => {
      if (shuttingDown) return;
      if (Date.now() - started > 3000) shutdown(); // window closed -> quit (and clear About)
      else log(`Window launcher exited early. Open ${url} in a browser.`, 'error');
    });
  } catch (e) { log(`Couldn't open window: ${e.message}`, 'error'); }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  ps.kill();
  try {
    if (wa.status === 'ready') await Promise.race([setAbout(CLEAR), new Promise((r) => setTimeout(r, 8000))]);
  } catch { /* best effort */ }
  try { await client.destroy(); } catch { /* ignore */ }
  if (win && win.pid) { try { spawn('taskkill', ['/PID', String(win.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
  if (gui) gui.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Never die silently: a crash would leave the last song on your About forever.
process.on('uncaughtException', (e) => log(`Uncaught: ${e && e.stack || e}`, 'error'));
process.on('unhandledRejection', (e) => log(`Unhandled: ${e && e.stack || e}`, 'error'));

(async () => {
  gui = await startGui({ port: GUI_PORT, getState, onAction });
  openWindow(gui.url);
  client.initialize().catch((e) => { wa.status = 'disconnected'; log(`Failed to start WhatsApp: ${e.message}`, 'error'); });
})();
