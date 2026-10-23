// One-time check when the bot is added to a server: mute whoever invited it for 60 seconds.
// If that can't be done, post an error message that says why.

const { AuditLogEvent, ChannelType, PermissionFlagsBits } = require('discord.js');
const { getGuild } = require('./store');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Who added the bot? Discord only tells us through the audit log (needs "View Audit Log").
async function findInviter(guild, botId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 10 });
    const entry = logs.entries.find((e) => e.targetId === botId && Date.now() - e.createdTimestamp < 120_000);
    if (entry?.executor) return entry.executor;
    await sleep(2000); // the entry can take a moment to show up
  }
  return null;
}

// Why can't I mute this member? (null = nothing in the way)
function whyNot(guild, me, member) {
  if (!me.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    return 'I’m missing the **Moderate Members** permission.';
  }
  const note = ' This is a Discord rule, not a bug. I do have **Moderate Members**, so muting regular members should work.';
  if (member.id === guild.ownerId) return `Discord never lets bots mute the server owner.${note}`;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return `Discord never lets bots mute administrators.${note}`;
  if (me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
    return `my top role (**${me.roles.highest.name}**) must be above theirs (**${member.roles.highest.name}**). Move my role up in Server Settings → Roles.`;
  }
  return null;
}

// Post somewhere the bot can write: system channel, else any channel it can talk in, else DM the owner.
async function notify(guild, content) {
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const canSend = (ch) => ch?.isTextBased()
    && ch.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
  const channel = canSend(guild.systemChannel)
    ? guild.systemChannel
    : guild.channels.cache.find((c) => c.type === ChannelType.GuildText && canSend(c));
  if (channel) return channel.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
  const owner = await guild.fetchOwner().catch(() => null);
  return owner?.send(content).catch(() => {});
}

async function runSelfTest(guild, client) {
  const fail = (why) => {
    console.warn(`[self-test] ${guild.name} (${guild.id}): FAILED: ${why}`);
    return notify(guild, `❌ **Self-test failed.** ${why}`);
  };

  let inviter;
  try {
    inviter = await findInviter(guild, client.user.id);
  } catch (err) {
    return fail(`I couldn’t read the audit log to see who invited me (${err.message}). Please give me the **View Audit Log** permission.`);
  }
  if (!inviter) return fail('I couldn’t find who invited me in the audit log, so I can’t run the mute test.');

  const member = await guild.members.fetch(inviter.id).catch(() => null);
  if (!member) return fail(`I found who invited me (${inviter.username}), but they’re no longer in the server.`);

  const me = guild.members.me ?? (await guild.members.fetchMe());
  const blocker = whyNot(guild, me, member);
  if (blocker) return fail(`I couldn’t mute <@${member.id}> for 60 seconds: ${blocker}`);

  try {
    await member.user
      .send(`Hi! I was just added to **${guild.name}**. As a one-time self-test I’m muting you for 60 seconds to check that I can moderate. Nothing is wrong.`)
      .catch(() => {});
    await member.timeout(60_000, 'Self-test: checking that I can mute members');
  } catch (err) {
    return fail(`I tried to mute <@${member.id}> for 60 seconds, but Discord refused: ${err.message}`);
  }

  console.log(`[self-test] ${guild.name} (${guild.id}): passed`);
  return notify(
    guild,
    `✅ **Self-test passed.** I muted <@${member.id}> for 60 seconds to confirm I can moderate. Use \`/aimod\` to set my mode, mod-log channel and rules (current mode: **${getGuild(guild.id).mode}**).`,
  );
}

module.exports = { runSelfTest };
