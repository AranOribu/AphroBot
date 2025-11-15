// Utils/purge.js
import { ChannelType, PermissionFlagsBits } from "discord.js";

// --- BDD: tables et accès ---
export async function ensurePurgeTables(db) {
  await run(
    db,
    `CREATE TABLE IF NOT EXISTS purge_settings(
    guildId TEXT PRIMARY KEY,
    auto INTEGER DEFAULT 0,
    logChannelId TEXT
  )`
  );
  await run(
    db,
    `CREATE TABLE IF NOT EXISTS purge_channels(
    guildId TEXT,
    channelId TEXT,
    PRIMARY KEY(guildId, channelId)
  )`
  );
}

export async function getPurgeSettings(db, guildId) {
  const row = await get(
    db,
    `SELECT auto, logChannelId FROM purge_settings WHERE guildId = ?`,
    [guildId]
  );
  return { auto: row?.auto === 1, logChannelId: row?.logChannelId ?? null };
}

export async function setAuto(db, guildId, value) {
  await run(
    db,
    `INSERT INTO purge_settings(guildId, auto) VALUES (?,?)
    ON CONFLICT(guildId) DO UPDATE SET auto=excluded.auto`,
    [guildId, value ? 1 : 0]
  );
}

export async function setLogChannel(db, guildId, channelId) {
  await run(
    db,
    `INSERT INTO purge_settings(guildId, logChannelId) VALUES (?,?)
    ON CONFLICT(guildId) DO UPDATE SET logChannelId=excluded.logChannelId`,
    [guildId, channelId ?? null]
  );
}

export async function getAllowedChannels(db, guildId) {
  const rows = await all(
    db,
    `SELECT channelId FROM purge_channels WHERE guildId = ?`,
    [guildId]
  );
  return rows.map((r) => r.channelId);
}

export async function setAllowedChannels(db, guildId, channelIds) {
  await run(db, `DELETE FROM purge_channels WHERE guildId = ?`, [guildId]);
  if (channelIds?.length) {
    const stmt = `INSERT INTO purge_channels(guildId, channelId) VALUES ${channelIds
      .map(() => "(?, ?)")
      .join(",")}`;
    const params = channelIds.flatMap((id) => [guildId, id]);
    await run(db, stmt, params);
  }
}

// --- Helpers ---
export function humanListChannels(guild, ids) {
  if (!ids?.length) return "—";
  return ids
    .map((id) => guild.channels.cache.get(id))
    .filter(Boolean)
    .map((ch) => `#${ch.name}`)
    .join(", ");
}

export function hasBotPermsInChannel(guild, channel) {
  if (!channel || channel.type !== ChannelType.GuildText) return false;
  const me = guild.members.me;
  if (!me) return false;
  const perms = channel.permissionsFor(me);
  return (
    perms?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageMessages,
    ]) ?? false
  );
}

// Purge ciblée (fichiers uniquement) pour un userId
export async function purgeFilesForUser(guild, channelIds, userId, opts = {}) {
  const {
    maxFilesTotal = 500,
    maxMessagesPerChannel = 2500,
    perDeleteDelayMs = 150,
  } = opts;
  const perChannel = new Map();
  let total = 0;

  for (const id of channelIds) {
    if (total >= maxFilesTotal) break;
    const channel = guild.channels.cache.get(id);
    if (!hasBotPermsInChannel(guild, channel)) continue;

    let deletedHere = 0;
    let fetched = 0;
    let before;

    while (fetched < maxMessagesPerChannel && total < maxFilesTotal) {
      const batch = await channel.messages
        .fetch({ limit: 100, ...(before ? { before } : {}) })
        .catch(() => null);
      if (!batch || batch.size === 0) break;
      fetched += batch.size;
      before = batch.last()?.id;

      for (const msg of batch.values()) {
        if (total >= maxFilesTotal) break;
        if (!msg.author || msg.author.id !== userId) continue;
        if (!msg.attachments || msg.attachments.size === 0) continue;

        await msg.delete().catch(() => null);
        total += msg.attachments.size; // on compte les fichiers
        deletedHere += msg.attachments.size;
        if (perDeleteDelayMs) await delay(perDeleteDelayMs);
      }
    }
    if (deletedHere > 0) perChannel.set(id, deletedHere);
  }
  return { perChannel, total };
}

// Purge “tous les leavers”
export async function purgeFilesForAllLeavers(guild, channelIds, opts = {}) {
  const {
    maxFilesTotal = 500,
    maxMessagesPerChannel = 2500,
    perDeleteDelayMs = 150,
  } = opts;

  const membershipCache = new Map();
  const perChannel = new Map();
  let total = 0;

  async function isStillMember(userId) {
    if (membershipCache.has(userId)) return membershipCache.get(userId);
    const ok = await guild.members
      .fetch(userId)
      .then(() => true)
      .catch(() => false);
    membershipCache.set(userId, ok);
    return ok;
  }

  for (const id of channelIds) {
    if (total >= maxFilesTotal) break;
    const channel = guild.channels.cache.get(id);
    if (!hasBotPermsInChannel(guild, channel)) continue;

    let deletedHere = 0;
    let fetched = 0;
    let before;

    while (fetched < maxMessagesPerChannel && total < maxFilesTotal) {
      const batch = await channel.messages
        .fetch({ limit: 100, ...(before ? { before } : {}) })
        .catch(() => null);
      if (!batch || batch.size === 0) break;
      fetched += batch.size;
      before = batch.last()?.id;

      for (const msg of batch.values()) {
        if (total >= maxFilesTotal) break;
        if (!msg.author || !msg.attachments?.size) continue;

        const present = await isStillMember(msg.author.id);
        if (present) continue;

        await msg.delete().catch(() => null);
        total += msg.attachments.size;
        deletedHere += msg.attachments.size;
        if (perDeleteDelayMs) await delay(perDeleteDelayMs);
      }
    }
    if (deletedHere > 0) perChannel.set(id, deletedHere);
  }
  return { perChannel, total };
}

// --- Promisify sqlite3 ---
function run(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    })
  );
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    })
  );
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    })
  );
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
