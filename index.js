// AI Admin Bot: multi-server, discord.js v14, Node 18+, built to run on Railway.
// Every message, edit, member join and sudden chat spike is judged by an AI model, which picks an
// action (flag / warn / timeout / kick / ban / slowmode / lock). Each server configures it with /aimod.

require('dotenv').config(); // keep first: the modules below read process.env when they load

const {
  Client, GatewayIntentBits, Partials, PermissionFlagsBits, ChannelType, Events,
  MessageFlags, OAuth2Scopes, SlashCommandBuilder,
} = require('discord.js');
const store = require('./store');
const { askAI, decide } = require('./ai');
const { enforce } = require('./actions');
const { runSelfTest } = require('./selftest');

if (!process.env.DISCORD_TOKEN || !process.env.AI_API_KEY) {
  console.error('Missing DISCORD_TOKEN or AI_API_KEY (set them under Variables in Railway, or in .env locally).');
  process.exit(1);
}

const SELFTEST_ON_JOIN = process.env.SELFTEST_ON_JOIN !== 'false';
const CONCURRENCY = Number(process.env.AI_CONCURRENCY) || 4;
const MAX_QUEUE = 300;      // AI jobs waiting in total
const MAX_PER_SERVER = 20;  // AI jobs pending per server, so one busy server can't starve the others
const SPIKE_MESSAGES = 25;  // this many messages in 30 s...
const SPIKE_USERS = 5;      // ...from at least this many people counts as a chat spike

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,   // privileged: enable in the Developer Portal
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: enable in the Developer Portal
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ---------- small helpers ----------
const daysSince = (ts) => (ts ? Math.floor((Date.now() - ts) / 86_400_000) : 0);
const describeChannel = (ch) => ({ name: ch.name, nsfw: Boolean(ch.nsfw), slowmodeSeconds: ch.rateLimitPerUser ?? 0 });

// The owner, admins and anyone with mod permissions are never touched.
const isExempt = (m) =>
  m.id === m.guild.ownerId ||
  m.permissions.has(PermissionFlagsBits.ManageMessages) ||
  m.permissions.has(PermissionFlagsBits.ModerateMembers);

// ---------- AI job queue (fair across servers, protects the API rate limit) ----------
const queue = [];
const pending = new Map(); // serverId -> jobs queued or running
let active = 0;

function enqueue(guildId, job) {
  if (queue.length >= MAX_QUEUE || (pending.get(guildId) ?? 0) >= MAX_PER_SERVER) return; // overloaded: skip
  pending.set(guildId, (pending.get(guildId) ?? 0) + 1);
  queue.push({ guildId, job });
  pump();
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const { guildId, job } = queue.shift();
    active++;
    job()
      .catch((err) => console.error('AI job failed:', err.message))
      .finally(() => {
        active--;
        pending.set(guildId, Math.max(0, (pending.get(guildId) ?? 1) - 1));
        pump();
      });
  }
}

// ---------- per-channel context + activity tracking ----------
const channels = new Map(); // channelId -> { lines, hits, lastSpike, seen }

function chan(channelId) {
  let c = channels.get(channelId);
  if (!c) { c = { lines: [], hits: [], lastSpike: 0, seen: 0 }; channels.set(channelId, c); }
  c.seen = Date.now();
  return c;
}

setInterval(() => { // forget idle channels so memory stays flat across thousands of servers
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, c] of channels) if (c.seen < cutoff) channels.delete(id);
}, 5 * 60_000).unref();

// Records the message (for AI context) and says whether the channel just spiked in activity.
function track(msg) {
  const c = chan(msg.channelId);
  const now = Date.now();
  if (msg.content) {
    c.lines.push(`${msg.author.username}: ${msg.content.slice(0, 300)}`);
    if (c.lines.length > 10) c.lines.shift();
  }
  c.hits = c.hits.filter((h) => now - h.t < 30_000);
  c.hits.push({ t: now, u: msg.author.id });
  const users = new Set(c.hits.map((h) => h.u)).size;
  const spike = c.hits.length >= SPIKE_MESSAGES && users >= SPIKE_USERS && now - c.lastSpike > 120_000;
  if (spike) c.lastSpike = now;
  return { spike, count: c.hits.length, users };
}

// Cheap local flood guard so a spammer can't bury the AI queue: 6 messages in 6 seconds.
const floods = new Map();
setInterval(() => floods.clear(), 60_000).unref();

function isFlooding(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const hits = (floods.get(key) ?? []).filter((t) => now - t < 6000);
  hits.push(now);
  floods.set(key, hits);
  if (hits.length >= 6) { floods.delete(key); return true; }
  return false;
}

const FLOOD = {
  action: 'timeout', category: 'spam', severity: 3, confidence: 1,
  minutes: 10, slowmodeSeconds: 0, reason: 'Sending messages too fast (flooding).',
};

// ---------- monitoring: messages ----------
async function handleMessage(msg, edited = false) {
  if (!msg.guild || !msg.author || msg.author.bot || msg.system) return;
  if (store.getGuild(msg.guildId).mode === 'off') return;

  const before = chan(msg.channelId).lines.slice(-6); // conversation so far, without this message
  const { spike, count, users } = edited ? { spike: false, count: 0, users: 0 } : track(msg);
  if (spike) enqueue(msg.guildId, () => handleSpike(msg, count, users));

  const member = msg.member ?? (await msg.guild.members.fetch(msg.author.id).catch(() => null));
  if (!member || isExempt(member)) return;

  if (!edited && isFlooding(msg.guildId, member.id)) {
    const settings = store.getGuild(msg.guildId);
    return enforce({ guild: msg.guild, settings, event: 'message', channel: msg.channel, member, msg, action: 'timeout', d: FLOOD });
  }

  const text = msg.content ?? '';
  if (text.trim().length < 3 && msg.attachments.size === 0) return;

  const prior = store.getStrikes(msg.guildId, member.id).length;
  enqueue(msg.guildId, async () => {
    const settings = store.getGuild(msg.guildId);
    const d = await askAI(settings, 'message', {
      channel: describeChannel(msg.channel),
      author: {
        username: msg.author.username,
        accountAgeDays: daysSince(msg.author.createdTimestamp),
        daysInServer: daysSince(member.joinedTimestamp),
        priorStrikes: prior,
      },
      edited,
      attachments: msg.attachments.size,
      context: before,
      message: text.slice(0, 1500),
    });
    const action = decide(d, 'message', settings, prior);
    if (action !== 'none') {
      await enforce({ guild: msg.guild, settings, event: 'message', channel: msg.channel, member, msg, action, d });
    }
  });
}

client.on(Events.MessageCreate, (msg) => handleMessage(msg));

// Edits are checked too, so nobody can post something clean and edit it afterwards.
client.on(Events.MessageUpdate, async (oldMsg, newMsg) => {
  if (newMsg.partial) newMsg = await newMsg.fetch().catch(() => null);
  if (!newMsg?.editedTimestamp || oldMsg.content === newMsg.content) return;
  handleMessage(newMsg, true);
});

// ---------- monitoring: chat spikes (raids, spam waves, brigading) ----------
async function handleSpike(msg, count, users) {
  const settings = store.getGuild(msg.guildId);
  const d = await askAI(settings, 'activity_spike', {
    channel: describeChannel(msg.channel),
    messagesLast30s: count,
    distinctUsers: users,
    recentMessages: [...chan(msg.channelId).lines],
  });
  const action = decide(d, 'activity_spike', settings);
  if (action !== 'none') {
    await enforce({ guild: msg.guild, settings, event: 'activity_spike', channel: msg.channel, member: null, msg: null, action, d });
  }
}

// ---------- monitoring: new members ----------
const joins = new Map(); // serverId -> recent join timestamps

client.on(Events.GuildMemberAdd, (member) => {
  if (member.user.bot) return;
  const guildId = member.guild.id;
  if (store.getGuild(guildId).mode === 'off') return;

  const now = Date.now();
  const recent = (joins.get(guildId) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  joins.set(guildId, recent);
  const joinsInLastMinute = recent.length;

  enqueue(guildId, async () => {
    const settings = store.getGuild(guildId);
    const d = await askAI(settings, 'member_join', {
      username: member.user.username,
      displayName: member.displayName,
      accountAgeDays: daysSince(member.user.createdTimestamp),
      hasCustomAvatar: Boolean(member.user.avatar),
      joinsInLastMinute,
    });
    const action = decide(d, 'member_join', settings);
    if (action !== 'none') {
      await enforce({ guild: member.guild, settings, event: 'member_join', channel: null, member, msg: null, action, d });
    }
  });
});

// ---------- scheduled reverts (unlock channels, reset slowmode) ----------
async function runDueTasks() {
  for (const t of store.takeDueTasks()) {
    try {
      const guild = client.guilds.cache.get(t.guildId);
      const channel = await guild?.channels.fetch(t.channelId);
      if (!channel) continue;
      if (t.type === 'unlock') await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: t.prev ?? null });
      if (t.type === 'slowmode_reset') await channel.setRateLimitPerUser(t.prev ?? 0);
    } catch (err) {
      console.error('Scheduled revert failed:', err.message);
    }
  }
}

// ---------- /aimod: per-server settings ----------
const command = new SlashCommandBuilder()
  .setName('aimod')
  .setDescription('Configure the AI admin for this server')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s.setName('status').setDescription('Show the current settings'))
  .addSubcommand((s) => s
    .setName('mode')
    .setDescription('live = acts, dry run = only logs what it would do, off = disabled')
    .addStringOption((o) => o
      .setName('value').setDescription('Mode').setRequired(true)
      .addChoices({ name: 'live', value: 'live' }, { name: 'dry run', value: 'dryrun' }, { name: 'off', value: 'off' })))
  .addSubcommand((s) => s
    .setName('log')
    .setDescription('Channel where AI decisions are posted')
    .addChannelOption((o) => o
      .setName('channel').setDescription('Mod-log channel').setRequired(true).addChannelTypes(ChannelType.GuildText)))
  .addSubcommand((s) => s
    .setName('rules')
    .setDescription('The rules the AI enforces on this server')
    .addStringOption((o) => o.setName('text').setDescription('Your rules').setRequired(true).setMaxLength(1000)))
  .addSubcommand((s) => s
    .setName('bans')
    .setDescription('Let the AI ban members (otherwise it can only kick)')
    .addBooleanOption((o) => o.setName('allow').setDescription('Allow AI bans').setRequired(true)));

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'aimod') return;
  const reply = (content) => i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

  if (!i.inGuild()) return reply('Use this command inside a server.');
  if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
    return reply('You need the **Manage Server** permission to change my settings.');
  }

  const sub = i.options.getSubcommand();
  if (sub === 'mode') {
    const mode = i.options.getString('value', true);
    store.setGuild(i.guildId, { mode });
    return reply(`Mode set to **${mode}**.`);
  }
  if (sub === 'log') {
    const ch = i.options.getChannel('channel', true);
    store.setGuild(i.guildId, { logChannelId: ch.id });
    return reply(`AI decisions will be posted in <#${ch.id}>. Make sure I can view and send messages there.`);
  }
  if (sub === 'rules') {
    store.setGuild(i.guildId, { rules: i.options.getString('text', true) });
    return reply('Rules updated.');
  }
  if (sub === 'bans') {
    const allowBan = i.options.getBoolean('allow', true);
    store.setGuild(i.guildId, { allowBan });
    return reply(allowBan ? 'The AI may now ban members.' : 'The AI can no longer ban; it will kick instead.');
  }

  const s = store.getGuild(i.guildId);
  return reply([
    `**Mode:** ${s.mode}`,
    `**Log channel:** ${s.logChannelId ? `<#${s.logChannelId}>` : 'not set (use /aimod log)'}`,
    `**AI bans:** ${s.allowBan ? 'allowed' : 'off (it kicks instead)'}`,
    `**Rules:** ${s.rules.slice(0, 500)}`,
  ].join('\n'));
});

// ---------- servers joining / leaving ----------
client.on(Events.GuildCreate, async (guild) => {
  console.log(`Joined ${guild.name} (${guild.id}). Now in ${client.guilds.cache.size} servers.`);
  if (SELFTEST_ON_JOIN) await runSelfTest(guild, client).catch((err) => console.error('Self-test crashed:', err));
});

client.on(Events.GuildDelete, (guild) => {
  console.log(`Removed from ${guild.name} (${guild.id}); deleting its data.`);
  store.purgeGuild(guild.id);
});

// ---------- start ----------
const INVITE_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageMessages,  // delete rule-breaking messages
  PermissionFlagsBits.ModerateMembers, // mute
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ViewAuditLog,    // find out who invited the bot (self-test)
  PermissionFlagsBits.ManageChannels,  // slowmode
  PermissionFlagsBits.ManageRoles,     // lock channels
];

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.username} in ${c.guilds.cache.size} servers (default mode: ${store.DEFAULT_MODE}).`);
  console.log('Invite link:', c.generateInvite({
    scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
    permissions: INVITE_PERMISSIONS,
  }));
  await c.application.commands.set([command.toJSON()]).catch((err) => console.error('Command registration failed:', err.message));
  runDueTasks(); // catch up on reverts that came due while the bot was down
  setInterval(runDueTasks, 15_000);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { store.flushSync(); process.exit(0); }); // Railway sends SIGTERM on redeploy
}
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

client.login(process.env.DISCORD_TOKEN);
