const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { startGui } = require('./gui');

const BROWSER_PATH = process.env.BROWSER_PATH || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const GUI_PORT = Number(process.env.GUI_PORT || 3737);
const ABOUT_DURATION = Number(process.env.ABOUT_DURATION || -1); // seconds until About expires, -1 = never
const MAX_LEN = 139;                  // WhatsApp About limit
const CLEAR = '\u0000clear';          // sentinel: clear the About text

// ---------------------------------------------------------------- settings (saved to settings.json)
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(__dirname, 'settings.json');
const DEFAULT_SETTINGS = {
  idleEnabled: true,
  idleAfterSeconds: Number(process.env.IDLE_AFTER_SECONDS || 30),
  minIntervalSeconds: Number(process.env.MIN_INTERVAL_SECONDS || 20),
  showPlatform: true,
  defaultBrowserPlatform: process.env.DEFAULT_BROWSER_PLATFORM || '',
  statuses: null, // null = never set -> starter list below; managed via the status actions, not the settings form
  automationsEnabled: true,
  automations: [], // [{id, statusId, input, days:[0-6, 0=Sunday], start:'HH:MM', end:'HH:MM', enabled}]
};

// Manual statuses. `template` may contain {} = something you type each time (e.g. "Playing {}" -> a game).
// Without {}, you can add an optional note: "💻 Coding - project X". `recents` remembers past {} answers.
const DEFAULT_STATUSES = [
  { emoji: '💻', template: 'Coding' },
  { emoji: '🎮', template: 'Playing {}' },
  { emoji: '🍿', template: 'Watching {}' },
  { emoji: '😴', template: 'Sleeping' },
  { emoji: '🏫', template: 'School' },
  { emoji: '📚', template: 'Studying' },
  { emoji: '💼', template: 'Working' },
  { emoji: '🍽️', template: 'Eating' },
  { emoji: '🏋️', template: 'At the gym' },
  { emoji: '🚗', template: 'Driving' },
];
const newId = () => crypto.randomBytes(4).toString('hex');
const defaultStatuses = () => DEFAULT_STATUSES.map((s) => ({ id: newId(), ...s, recents: [] }));

function sanitizeStatuses(list) {
  if (!Array.isArray(list)) return defaultStatuses();
  return list
    .filter((s) => s && typeof s.id === 'string' && typeof s.emoji === 'string' && typeof s.template === 'string' && s.template.trim())
    .slice(0, 30)
    .map((s) => ({
      id: s.id.slice(0, 16),
      emoji: [...s.emoji].slice(0, 8).join('') || '🙂',
      template: s.template.trim().slice(0, 40),
      recents: Array.isArray(s.recents) ? s.recents.filter((r) => typeof r === 'string').slice(0, 8) : [],
    }));
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function sanitizeAutomations(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && typeof a.id === 'string' && typeof a.statusId === 'string' && Array.isArray(a.days)
      && TIME_RE.test(a.start) && TIME_RE.test(a.end) && a.start !== a.end)
    .slice(0, 50)
    .map((a) => ({
      id: a.id.slice(0, 16),
      statusId: a.statusId,
      input: String(a.input || '').slice(0, 80),
      days: [...new Set(a.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort(),
      start: a.start,
      end: a.end,
      enabled: a.enabled !== false,
    }))
    .filter((a) => a.days.length);
}

let settings = { ...DEFAULT_SETTINGS };
try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch { /* first run */ }
settings.statuses = sanitizeStatuses(settings.statuses);

function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch { /* not fatal */ }
}

// One-time migrations of the saved status list (never removes anything):
//  v1: an early build saved an empty list, hiding the starter statuses
//  v2: "Watching {}" joined the starter set
// Add any starter statuses that are missing next to the custom ones.
if ((settings.statusesVersion || 0) < 2) {
  const have = new Set(settings.statuses.map((s) => s.template.toLowerCase()));
  settings.statuses = [...settings.statuses, ...defaultStatuses().filter((d) => !have.has(d.template.toLowerCase()))].slice(0, 30);
  settings.statusesVersion = 2;
  saveSettings();
}

// Automations only make sense for statuses that still exist
const pruneAutomations = () => {
  settings.automations = sanitizeAutomations(settings.automations).filter((a) => settings.statuses.some((s) => s.id === a.statusId));
};
pruneAutomations();

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n)) || lo));
function applySettings(patch) {
  if ('idleEnabled' in patch) settings.idleEnabled = !!patch.idleEnabled;
  if ('showPlatform' in patch) settings.showPlatform = !!patch.showPlatform;
  if ('automationsEnabled' in patch) settings.automationsEnabled = !!patch.automationsEnabled;
  if ('idleAfterSeconds' in patch) settings.idleAfterSeconds = clamp(patch.idleAfterSeconds, 5, 3600);
  // floor of 10s protects the account from looking like a bot
  if ('minIntervalSeconds' in patch) settings.minIntervalSeconds = clamp(patch.minIntervalSeconds, 10, 600);
  if ('defaultBrowserPlatform' in patch) settings.defaultBrowserPlatform = String(patch.defaultBrowserPlatform || '').trim().slice(0, 30);
  saveSettings();
}

// ---------------------------------------------------------------- app state
const wa = { status: 'starting', qr: null }; // starting | qr | authenticating | ready | disconnected
let enabled = true;                          // master sync switch
let media = { playing: false };
let idle = { active: false, message: '' };
let cleared = false;                         // idle mode off + grace period over -> About cleared
let activeStatus = null;                     // manual status {id, input, text}; overrides everything below
let autoStatus = null;                       // status from a matching automation {automationId, statusId, text, until}
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
    status: activeStatus,
    autoStatus,
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

// "💻 Coding - note" or "🎮 Playing Minecraft"
function statusText(st, input) {
  const hasSlot = st.template.includes('{}');
  const label = hasSlot ? st.template.replace('{}', input) : st.template + (input ? ' - ' + input : '');
  const text = `${st.emoji} ${label}`;
  return text.length > MAX_LEN ? text.slice(0, MAX_LEN - 1) + '…' : text;
}

function computeDesired() {
  if (!enabled) return CLEAR;
  if (activeStatus) return activeStatus.text;     // manual wins over automations
  if (autoStatus) return autoStatus.text;
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
async function handleAction(a) {
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
    case 'setStatus': {
      const st = settings.statuses.find((s) => s.id === a.id);
      if (!st) throw new Error('Unknown status');
      const hasSlot = st.template.includes('{}');
      const input = String(a.input || '').trim().slice(0, 80);
      if (hasSlot && !input) throw new Error(`Fill in the blank for "${st.template}"`);
      if (hasSlot) { // remember recent answers (e.g. games), newest first
        st.recents = [input, ...st.recents.filter((r) => r.toLowerCase() !== input.toLowerCase())].slice(0, 8);
        saveSettings();
      }
      activeStatus = { id: st.id, input, text: statusText(st, input) };
      log(`Status: ${activeStatus.text}`);
      refresh();
      return;
    }
    case 'clearStatus':
      if (activeStatus) { activeStatus = null; log('Status cleared'); }
      refresh();
      return;
    case 'addStatus': {
      const emoji = [...String(a.emoji || '').trim()].slice(0, 8).join('');
      const template = String(a.template || '').trim().slice(0, 40);
      if (!emoji || !template) throw new Error('Give it an emoji and a name');
      if (settings.statuses.length >= 30) throw new Error('Too many statuses (max 30)');
      settings.statuses.push({ id: newId(), emoji, template, recents: [] });
      saveSettings();
      emit();
      return;
    }
    case 'removeStatus': {
      settings.statuses = settings.statuses.filter((s) => s.id !== a.id);
      if (activeStatus && activeStatus.id === a.id) activeStatus = null;
      pruneAutomations();
      saveSettings();
      refresh();
      return;
    }
    case 'resetStatuses':
      settings.statuses = defaultStatuses();
      activeStatus = null;
      pruneAutomations(); // ids changed, so old automations no longer point at anything
      saveSettings();
      refresh();
      return;
    case 'addAutomation': {
      const st = settings.statuses.find((s) => s.id === a.statusId);
      if (!st) throw new Error('Pick a status');
      const input = String(a.input || '').trim().slice(0, 80);
      if (st.template.includes('{}') && !input) throw new Error(`Fill in the blank for "${st.template}"`);
      const days = [...new Set((Array.isArray(a.days) ? a.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
      if (!days.length) throw new Error('Pick at least one day');
      if (!TIME_RE.test(a.start) || !TIME_RE.test(a.end)) throw new Error('Pick a start and end time');
      if (a.start === a.end) throw new Error('Start and end time can\'t be the same');
      if (settings.automations.length >= 50) throw new Error('Too many automations (max 50)');
      settings.automations.push({ id: newId(), statusId: st.id, input, days, start: a.start, end: a.end, enabled: true });
      saveSettings();
      log(`Automation added: ${statusText(st, input)} ${a.start}–${a.end}`);
      emit();
      return;
    }
    case 'removeAutomation':
      settings.automations = settings.automations.filter((x) => x.id !== a.id);
      saveSettings();
      emit();
      return;
    case 'toggleAutomation': {
      const x = settings.automations.find((y) => y.id === a.id);
      if (!x) throw new Error('Unknown automation');
      x.enabled = !!a.enabled;
      saveSettings();
      emit();
      return;
    }
    case 'quit':
      setTimeout(shutdown, 50);
      return;
    default:
      throw new Error('unknown action');
  }
}

// ---------------------------------------------------------------- automations
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

// days use JS numbering (0 = Sunday). An interval that crosses midnight (e.g. 22:00 -> 07:00)
// belongs to the day it STARTS on: Monday 22:00-07:00 runs until Tuesday 07:00.
function automationActive(a, now) {
  const day = now.getDay();
  const m = now.getHours() * 60 + now.getMinutes();
  const s = toMin(a.start);
  const e = toMin(a.end);
  if (s < e) return a.days.includes(day) && m >= s && m < e;
  return (a.days.includes(day) && m >= s) || (a.days.includes((day + 6) % 7) && m < e);
}

// First matching automation (list order = priority) decides the automatic status.
function tickAutomations() {
  let next = null;
  if (settings.automationsEnabled) {
    const now = new Date();
    for (const a of settings.automations) {
      if (!a.enabled || !automationActive(a, now)) continue;
      const st = settings.statuses.find((s) => s.id === a.statusId);
      if (!st) continue;
      next = { automationId: a.id, statusId: st.id, text: statusText(st, a.input), until: a.end };
      break;
    }
  }
  const key = (x) => (x ? `${x.automationId}|${x.text}` : '');
  const changed = key(next) !== key(autoStatus);
  autoStatus = next;
  if (changed) {
    log(next ? `Automation on: ${next.text} (until ${next.until})` : 'Automation ended');
    refresh();
  }
}

// Every GUI action may change what the automations should do, so re-evaluate after each one.
async function onAction(a) {
  await handleAction(a);
  tickAutomations();
  emit();
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
  tickAutomations();
  setInterval(tickAutomations, 15_000);
  openWindow(gui.url);
  client.initialize().catch((e) => { wa.status = 'disconnected'; log(`Failed to start WhatsApp: ${e.message}`, 'error'); });
})();
