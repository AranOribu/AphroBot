import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionsBitField,
} from "discord.js";
import dbSingleton from "../../Events/loadDatabase.js";

const TABLES = {
  settings: "purge_settings",
  channels: "purge_channels",
  leavers: "purge_leavers",
};

const LIMITS = {
  MAX_FILES_PER_RUN: 500, // sécurité anti-ban
  FETCH_PAGE_SIZE: 100,
  PAUSE_EVERY_N_DELETES: 10,
  PAUSE_MS: 800,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getDb(bot) {
  return bot?.db || dbSingleton;
}

async function fetchSettings(db, guildId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM ${TABLES.settings} WHERE guildId = ?`,
      [guildId],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || { guildId, auto: 0, logChannelId: null });
      }
    );
  });
}
async function fetchAllowedChannels(db, guildId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT channelId FROM ${TABLES.channels} WHERE guildId = ?`,
      [guildId],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows.map((r) => r.channelId));
      }
    );
  });
}
async function listLeavers(db, guildId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT userId, username FROM ${TABLES.leavers} WHERE guildId = ?`,
      [guildId],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}
async function removeLeaver(db, guildId, userId) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM ${TABLES.leavers} WHERE guildId = ? AND userId = ?`,
      [guildId, userId],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

async function getMemberOrNull(guild, userId) {
  try {
    const m = await guild.members.fetch(userId);
    return m ?? null;
  } catch {
    return null;
  }
}

async function getUserNameSafe(client, userId) {
  try {
    const u = await client.users.fetch(userId);
    return u?.tag || u?.username || userId;
  } catch {
    return userId;
  }
}

/**
 * Coeur de purge pour un utilisateur
 * @returns { total: number, perChannel: Record<string, number> }
 */
export async function runPurgeForUser(
  bot,
  guild,
  userId,
  opts = { announceIn: null, autoMode: false }
) {
  const db = getDb(bot);
  const allowed = await fetchAllowedChannels(db, guild.id);
  if (allowed.length === 0) {
    if (opts.announceIn)
      await opts.announceIn.send("⚠️ Aucun salon autorisé via `.setpurge`.");
    return { total: 0, perChannel: {} };
  }

  let totalDeleted = 0;
  const perChannel = {};

  for (const channelId of allowed) {
    if (totalDeleted >= LIMITS.MAX_FILES_PER_RUN) break;

    const ch = guild.channels.cache.get(channelId);
    if (!ch) continue;
    if (
      ![
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ].includes(ch.type)
    ) {
      continue;
    }

    // Permissions
    const me = guild.members.me;
    if (!me) continue;
    const perms = ch.permissionsFor(me);
    if (
      !perms?.has(PermissionsBitField.Flags.ReadMessageHistory) ||
      !perms?.has(PermissionsBitField.Flags.ManageMessages)
    ) {
      continue; // pas de droits suffisants
    }

    let lastId = undefined;
    let safetyBreak = false;

    while (!safetyBreak) {
      const messages = await ch.messages
        .fetch({ limit: LIMITS.FETCH_PAGE_SIZE, before: lastId })
        .catch(() => null);
      if (!messages || messages.size === 0) break;

      const toDelete = [];
      for (const msg of messages.values()) {
        if (msg.author?.id === userId && msg.attachments?.size > 0) {
          toDelete.push(msg);
        }
      }

      for (const m of toDelete) {
        // stop si limite globale
        if (totalDeleted >= LIMITS.MAX_FILES_PER_RUN) {
          safetyBreak = true;
          break;
        }
        await m.delete().catch(() => {});
        totalDeleted++;
        perChannel[channelId] =
          (perChannel[channelId] || 0) + m.attachments.size;

        if (totalDeleted % LIMITS.PAUSE_EVERY_N_DELETES === 0) {
          await sleep(LIMITS.PAUSE_MS);
        }
      }

      // suite pagination
      lastId = messages.last()?.id;
      if (!lastId || messages.size < LIMITS.FETCH_PAGE_SIZE) break;
    }
  }

  return { total: totalDeleted, perChannel };
}

export const command = {
  name: "purge",
  aliases: [],
  description:
    "Supprime uniquement les fichiers d'une personne (ou de tous les leavers) dans les salons autorisés par `.setpurge`.",
  /**
   * @param {import('discord.js').Client} bot
   * @param {import('discord.js').Message} message
   * @param {string[]} args
   */
  run: async (bot, message, args) => {
    if (!message.guild) return;

    const mePerms = message.channel.permissionsFor(message.guild.members.me);
    if (!mePerms?.has(PermissionsBitField.Flags.SendMessages)) return;

    const memberPerms = message.member.permissions;
    if (
      !memberPerms.has(PermissionsBitField.Flags.ManageMessages) &&
      !memberPerms.has(PermissionsBitField.Flags.Administrator)
    ) {
      return message.reply(
        "❌ Tu n'as pas la permission (Manage Messages ou Admin)."
      );
    }

    const db = getDb(bot);
    const guild = message.guild;
    const guildId = guild.id;
    const settings = await fetchSettings(db, guildId);
    const allowed = await fetchAllowedChannels(db, guildId);
    if (allowed.length === 0) {
      return message.reply("⚠️ Aucun salon autorisé via `.setpurge`.");
    }

    // Parse cible
    let targetId = null;
    if (args[0]) {
      const mention = args[0];
      const idMatch = mention.match(/\d{16,20}/);
      targetId = idMatch ? idMatch[0] : null;
    } else if (message.mentions?.users?.size) {
      targetId = message.mentions.users.first().id;
    }

    // Helper reporting
    const sendReport = async (targetName, result, modeAuto) => {
      const lines = [];
      if (result.total > 0) {
        lines.push(`Purge terminée pour **${targetName}**`);
        Object.entries(result.perChannel).forEach(([cid, count]) => {
          if (count > 0) lines.push(`<#${cid}> : ${count} fichiers`);
        });
        lines.push(`**Total : ${result.total}**`);
        const content = lines.join("\n");

        if (modeAuto && settings.logChannelId) {
          const logCh = guild.channels.cache.get(settings.logChannelId);
          if (logCh && logCh.isTextBased()) await logCh.send(content);
        } else {
          await message.channel.send(content);
        }
      } else {
        const txt = `**Total : 0** — Aucun fichier n’a été publié par cette personne.`;
        if (modeAuto && settings.logChannelId) {
          const logCh = guild.channels.cache.get(settings.logChannelId);
          if (logCh && logCh.isTextBased()) await logCh.send(txt);
        } else {
          await message.channel.send(txt);
        }
      }
    };

    // Cas 1 : cible fournie
    if (targetId) {
      const member = await getMemberOrNull(guild, targetId);
      const targetName =
        member?.displayName || (await getUserNameSafe(bot, targetId));

      if (member) {
        // Confirmation obligatoire si la personne est encore là
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`purge:confirm:${targetId}`)
            .setLabel("Oui")
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`purge:cancel:${targetId}`)
            .setLabel("Non")
            .setStyle(ButtonStyle.Secondary)
        );
        const prompt = await message.channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xed4245)
              .setDescription(
                `Confirmer la purge des **fichiers** de **${targetName}** ?`
              ),
          ],
          components: [row],
        });

        const collector = prompt.createMessageComponentCollector({
          time: 30_000,
        });
        let proceeded = false;

        collector.on("collect", async (i) => {
          if (i.user.id !== message.author.id)
            return i.reply({
              content: "Action réservée à l’auteur.",
              ephemeral: true,
            });
          if (i.customId === `purge:confirm:${targetId}`) {
            proceeded = true;
            await i.deferUpdate();
            collector.stop("confirmed");
            const res = await runPurgeForUser(bot, guild, targetId, {
              announceIn: message.channel,
              autoMode: false,
            });
            await sendReport(targetName, res, false);
          } else if (i.customId === `purge:cancel:${targetId}`) {
            await i.update({
              content: "❎ Annulé.",
              components: [],
              embeds: [],
            });
            collector.stop("cancelled");
          }
        });

        collector.on("end", async (_, reason) => {
          if (reason === "time" && !proceeded) {
            await prompt
              .edit({ content: "⌛ Expiré.", components: [], embeds: [] })
              .catch(() => {});
          }
        });
      } else {
        // Plus sur le serveur => purge directe
        const res = await runPurgeForUser(bot, guild, targetId, {
          announceIn: message.channel,
          autoMode: false,
        });
        await sendReport(targetName, res, false);
        // Nettoyage éventuel du registre des leavers
        await removeLeaver(db, guildId, targetId).catch(() => {});
      }
      return;
    }

    // Cas 2 : aucune cible => tous les leavers
    const leavers = await listLeavers(db, guildId);
    if (leavers.length === 0) {
      return message.reply("Aucun membre parti à traiter.");
    }

    let global = 0;
    for (const l of leavers) {
      if (global >= LIMITS.MAX_FILES_PER_RUN) break; // cap global
      const res = await runPurgeForUser(bot, guild, l.userId, {
        announceIn: message.channel,
        autoMode: false,
      });
      global += res.total;
      const name = l.username || (await getUserNameSafe(bot, l.userId));
      await sendReport(name, res, false);
      await removeLeaver(db, guildId, l.userId).catch(() => {});
      if (global >= LIMITS.MAX_FILES_PER_RUN) {
        await message.channel.send(
          "⛔ Limite de sécurité atteinte pour cette exécution."
        );
        break;
      }
      // mini pause entre utilisateurs
      await sleep(1000);
    }
  },
};
