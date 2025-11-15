import { AuditLogEvent, EmbedBuilder } from 'discord.js';
import config from "../config.json" with { type: 'json' };
import sendLog from "./sendlog.js";
import db from "./loadDatabase.js";

// Helpers BDD
function fetchPurgeSettings(guildId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT auto, logChannelId FROM purge_settings WHERE guildId = ?`,
      [guildId],
      (err, row) => (err ? reject(err) : resolve(row || { auto: 0, logChannelId: null }))
    );
  });
}

function upsertLeaver(guildId, userId, username) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO purge_leavers(guildId, userId, username, leftAt)
       VALUES (?,?,?,?)
       ON CONFLICT(guildId, userId) DO UPDATE SET username = excluded.username, leftAt = excluded.leftAt`,
      [guildId, userId, username, Date.now()],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function removeLeaver(guildId, userId) {
  return new Promise((resolve) => {
    db.run(`DELETE FROM purge_leavers WHERE guildId = ? AND userId = ?`, [guildId, userId], () => resolve());
  });
}

export default {
  name: 'guildMemberRemove',
  async execute(member) {
    // 1) Log kick si applicable (comportement existant conservé)
    try {
      const fetchedLogs = await member.guild.fetchAuditLogs({
        limit: 1,
        type: AuditLogEvent.MemberKick,
      });
      const kickLog = fetchedLogs.entries.first();
      if (kickLog && kickLog.target.id === member.id && Date.now() - kickLog.createdTimestamp < 5000) {
        const embed = new EmbedBuilder()
          .setColor(config.color)
          .setDescription(`<@${member.id}> a été kick par <@${kickLog.executor.id}>`)
          .setTimestamp();
        sendLog(member.guild, embed, 'modlog');
      }
    } catch (e) {
      // on ignore les erreurs d’audit log pour ne pas bloquer la suite
      console.error('guildMemberRemove audit log error:', e);
    }

    // 2) Enregistrer le membre sorti (leaver)
    const username = member.user?.tag || member.user?.username || member.id;
    try {
      await upsertLeaver(member.guild.id, member.id, username);
    } catch (e) {
      console.error('purge_leavers upsert error:', e);
    }

    // 3) Purge auto si activée
    try {
      const settings = await fetchPurgeSettings(member.guild.id);
      if (!settings?.auto) return; // mode auto OFF

      // Import dynamique du cœur de purge fourni par la commande .purge
      const mod = await import('../Commands/Modérations/purge.js');
      const runPurgeForUser = mod?.runPurgeForUser;
      if (typeof runPurgeForUser !== 'function') return;

      // Lancer la purge auto (réponses dans salon de logs)
      const res = await runPurgeForUser(member.client, member.guild, member.id, {
        announceIn: null,
        autoMode: true,
      });

      // Préparer le rapport (affiche le total de FICHIERS)
      const filesTotal = Object.values(res?.perChannel || {}).reduce((a, b) => a + b, 0);
      const lines = [];
      if (filesTotal > 0) {
        lines.push(`Purge auto pour **${username}**`);
        for (const [cid, count] of Object.entries(res.perChannel)) {
          if (count > 0) lines.push(`<#${cid}> : ${count} fichiers`);
        }
        lines.push(`**Total : ${filesTotal}**`);
      } else {
        lines.push(`Purge auto pour **${username}** — **Total : 0** (aucun fichier).`);
      }

      // Envoi dans le salon de logs (si défini)
      if (settings.logChannelId) {
        const logCh = member.guild.channels.cache.get(settings.logChannelId);
        if (logCh?.isTextBased()) {
          await logCh.send(lines.join('\n')).catch(() => {});
        }
      }

      // Nettoyer l’entrée leaver après purge auto
      await removeLeaver(member.guild.id, member.id);
    } catch (e) {
      console.error('guildMemberRemove auto purge error:', e);
    }
  }
};
