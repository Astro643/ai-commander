// Persistent state: per-server settings, strikes and scheduled reverts, kept in one JSON file.
// On Railway, attach a Volume to the service: RAILWAY_VOLUME_MOUNT_PATH is set automatically and
// picked up here (or set DATA_DIR yourself). Without a volume everything resets on every redeploy.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, 'state.json');

if (!process.env.DATA_DIR && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  console.warn('No volume or DATA_DIR configured: settings, strikes and scheduled unlocks are lost on every redeploy.');
}

let state = { guilds: {}, strikes: {}, tasks: [] };
try { state = { ...state, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* first run */ }

// ---------- saving (debounced + atomic) ----------
let timer = null;
let writing = false;
let again = false;

function save() {
  if (writing) { again = true; return; }
  if (!timer) timer = setTimeout(flush, 500);
}

function flush() {
  timer = null;
  writing = true;
  const tmp = `${FILE}.tmp`;
  const finish = (err) => {
    if (err) console.error('State save failed:', err.message);
    writing = false;
    if (again) { again = false; save(); }
  };
  fs.writeFile(tmp, JSON.stringify(state), (err) => (err ? finish(err) : fs.rename(tmp, FILE, finish)));
}

function flushSync() { // used on shutdown (Railway sends SIGTERM on every redeploy)
  try { fs.writeFileSync(FILE, JSON.stringify(state)); } catch (err) { console.error('Final save failed:', err.message); }
}

// ---------- per-server settings ----------
const MODES = ['live', 'dryrun', 'off'];
const DEFAULT_MODE = MODES.includes(process.env.DEFAULT_MODE) ? process.env.DEFAULT_MODE : 'dryrun';
const DEFAULT_RULES = process.env.DEFAULT_RULES
  || 'No hate speech, harassment, threats, scams or phishing links, NSFW outside NSFW channels, spam, or unsolicited advertising.';

const getGuild = (id) => ({
  mode: DEFAULT_MODE, rules: DEFAULT_RULES, logChannelId: null, allowBan: false, ...state.guilds[id],
});

function setGuild(id, patch) {
  state.guilds[id] = { ...state.guilds[id], ...patch };
  save();
}

// ---------- strikes (expire after 7 days) ----------
const STRIKE_TTL = 7 * 24 * 60 * 60 * 1000;

function getStrikes(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const live = (state.strikes[key] ?? []).filter((t) => Date.now() - t < STRIKE_TTL);
  if (live.length) state.strikes[key] = live; else delete state.strikes[key];
  return live;
}

function addStrike(guildId, userId) {
  const live = getStrikes(guildId, userId);
  live.push(Date.now());
  state.strikes[`${guildId}:${userId}`] = live;
  save();
}

// ---------- scheduled reverts (unlock a channel, reset slowmode) ----------
function addTask(task) {
  const same = state.tasks.find((t) => t.type === task.type && t.channelId === task.channelId);
  if (same) same.at = task.at; // keep the original "prev" value so the revert restores the real original
  else state.tasks.push(task);
  save();
}

function takeDueTasks() {
  const now = Date.now();
  const due = state.tasks.filter((t) => t.at <= now);
  if (due.length) { state.tasks = state.tasks.filter((t) => t.at > now); save(); }
  return due;
}

// Forget everything about a server once the bot has been removed from it.
function purgeGuild(guildId) {
  delete state.guilds[guildId];
  for (const key of Object.keys(state.strikes)) if (key.startsWith(`${guildId}:`)) delete state.strikes[key];
  state.tasks = state.tasks.filter((t) => t.guildId !== guildId);
  save();
}

module.exports = {
  DEFAULT_MODE, getGuild, setGuild, getStrikes, addStrike, addTask, takeDueTasks, purgeGuild, flushSync,
};
