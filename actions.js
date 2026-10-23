// Everything the AI can actually DO. To give it a new power, add an entry to ACTIONS here and
// list the action's name in ALLOWED (ai.js) for the event types that may use it.

const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { addStrike, addTask } = require('./store');

const clamp = (n, lo, hi, fallback) => Math.min(Math.max(Number(n) || fallback, lo), hi);
const need = (ok, message) => { if (!ok) throw new Error(message); };
const dm = (user, text) => user.send(text).catch(() => {});

// scope: 'member' = the message author / new member, 'channel' = the event's channel, 'none' = nobody
const ACTIONS = {
  flag: {
    scope: 'none',
    run: async () => 'sent to the mod log for human review',
  },

  warn: {
    scope: 'member',
    run: async ({ channel, member, d }) => {
      await channel?.send({
        content: `⚠️ <@${member.id}> your message was removed: ${d.reason}`,
        allowedMentions: { parse: [], users: [member.id] }, // AI text can never ping @everyone or roles
      }).catch(() => {});
      return 'message removed and user warned';
    },
  },

  timeout: {
    scope: 'member',
    run: async ({ member, d, reason }) => {
      need(member.moderatable, 'I can’t mute them (they are an admin/owner, my role is below theirs, or I lack Moderate Members)');
      const mins = clamp(d.minutes, 1, 1440, 10);
      await dm(member.user, `You were muted for ${mins} minutes in **${member.guild.name}**. Reason: ${d.reason}`);
      await member.timeout(mins * 60_000, reason);
      return `muted for ${mins} min`;
    },
  },

  kick: {
    scope: 'member',
    run: async ({ member, d, reason }) => {
      need(member.kickable, 'I can’t kick them (my role is below theirs, or I lack Kick Members)');
      await dm(member.user, `You were kicked from **${member.guild.name}**. Reason: ${d.reason}`); // DM first: no shared server afterwards
      await member.kick(reason);
      return 'kicked';
    },
  },

  ban: {
    scope: 'member',
    run: async ({ member, d, reason }) => {
      need(member.bannable, 'I can’t ban them (my role is below theirs, or I lack Ban Members)');
      await dm(member.user, `You were banned from **${member.guild.name}**. Reason: ${d.reason}`);
      await member.ban({ reason, deleteMessageSeconds: 3600 });
      return 'banned';
    },
  },

  slowmode: {
    scope: 'channel',
    run: async ({ guild, channel, d, reason }) => {
      need(typeof channel?.setRateLimitPerUser === 'function', 'this channel type has no slowmode');
      const secs = clamp(d.slowmodeSeconds, 1, 600, 10);
      const mins = clamp(d.minutes, 1, 240, 15);
      const prev = channel.rateLimitPerUser ?? 0;
      if (prev >= secs) return `slowmode is already ${prev}s, left unchanged`;
      await channel.setRateLimitPerUser(secs, reason);
      addTask({ at: Date.now() + mins * 60_000, type: 'slowmode_reset', guildId: guild.id, channelId: channel.id, prev });
      return `slowmode ${secs}s for ${mins} min`;
    },
  },

  lock: {
    scope: 'channel',
    run: async ({ guild, channel, d, reason }) => {
      need(channel?.permissionOverwrites, 'this channel type can’t be locked');
      const everyone = guild.roles.everyone;
      const existing = channel.permissionOverwrites.cache.get(everyone.id);
      if (existing?.deny.has(PermissionFlagsBits.SendMessages)) return 'channel is already locked, left unchanged';
      const prev = existing?.allow.has(PermissionFlagsBits.SendMessages) ? true : null;
      const mins = clamp(d.minutes, 1, 120, 10);
      // announce first: once @everyone is denied, the bot itself may no longer be able to write here
      await channel.send({
        content: `🔒 This channel is locked for ${mins} minutes: ${d.reason}`,
        allowedMentions: { parse: [] },
      }).catch(() => {});
      await channel.permissionOverwrites.edit(everyone, { SendMessages: false }, { reason });
      addTask({ at: Date.now() + mins * 60_000, type: 'unlock', guildId: guild.id, channelId: channel.id, prev });
      return `locked for ${mins} min`;
    },
  },
};

// ---------- enforcement ----------
// ctx: { guild, settings, event, channel, member, msg, action, d }
async function enforce(ctx) {
  const { guild, settings, action, d, member, msg } = ctx;
  const spec = ACTIONS[action];
  let result = 'dry run: nothing was done';

  if (settings.mode === 'live') {
    try {
      ctx.reason = `[AI Mod] ${d.category}: ${d.reason}`.slice(0, 450); // shows up in the audit log
      if (spec.scope === 'member' && msg) await msg.delete().catch(() => {});
      result = await spec.run(ctx);
      if (spec.scope === 'member') addStrike(guild.id, member.id);
    } catch (err) {
      result = `failed: ${err.message}`;
    }
  }

  console.log(`[${guild.name}] ${action} -> ${member?.user.username ?? ctx.channel?.name ?? '-'}: ${d.reason} (${result})`);
  await sendLog(ctx, result);
}

// ---------- mod log ----------
const COLORS = { flag: 0x3498db, warn: 0xf1c40f, timeout: 0xe67e22, slowmode: 0x9b59b6, lock: 0x9b59b6 };

async function sendLog(ctx, result) {
  const { guild, settings, action, d, member, msg, channel, event } = ctx;
  if (!settings.logChannelId) return;
  const logChannel = await guild.channels.fetch(settings.logChannelId).catch(() => null);
  if (!logChannel?.isTextBased()) return;

  const showChannel = ACTIONS[action].scope === 'channel' || !member;
  const target = showChannel
    ? (channel ? `<#${channel.id}>` : '-')
    : `<@${member.id}> (${member.user.username})`;

  const embed = new EmbedBuilder()
    .setColor(COLORS[action] ?? 0xe74c3c)
    .setTitle(`🤖 ${action.toUpperCase()}${settings.mode === 'live' ? '' : ' (dry run)'}`)
    .addFields(
      { name: 'Target', value: target, inline: true },
      { name: 'Event', value: String(event), inline: true },
      { name: 'Verdict', value: `${d.category} · severity ${d.severity} · confidence ${d.confidence}`, inline: true },
      { name: 'Reason', value: d.reason || '-' },
      { name: 'Result', value: String(result).slice(0, 1000) },
    )
    .setTimestamp();
  if (msg?.content) embed.addFields({ name: 'Message', value: msg.content.slice(0, 1000) });

  await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

module.exports = { enforce, ACTIONS };
