import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  PermissionsBitField,
} from "discord.js";
import dbSingleton from "../../Events/loadDatabase.js";

const TABLES = {
  settings: "purge_settings",
  channels: "purge_channels",
};

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

async function upsertSettings(db, guildId, patch) {
  const current = await fetchSettings(db, guildId);
  const auto = patch.auto ?? current.auto ?? 0;
  const logChannelId = patch.logChannelId ?? current.logChannelId ?? null;

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO ${TABLES.settings}(guildId, auto, logChannelId)
       VALUES(?,?,?)
       ON CONFLICT(guildId) DO UPDATE SET auto = excluded.auto, logChannelId = excluded.logChannelId`,
      [guildId, auto, logChannelId],
      (err) => (err ? reject(err) : resolve({ guildId, auto, logChannelId }))
    );
  });
}

async function addChannels(db, guildId, channelIds) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO ${TABLES.channels}(guildId, channelId) VALUES (?, ?)`
    );
    for (const c of channelIds) stmt.run([guildId, c]);
    stmt.finalize((err) => (err ? reject(err) : resolve()));
  });
}

async function listChannels(db, guildId) {
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

function buildEmbed(guild, { auto, logChannelId }, allowedChannels) {
  const logChannelTxt = logChannelId ? `<#${logChannelId}>` : "`Non défini`";
  const allowedTxt =
    allowedChannels.length > 0
      ? allowedChannels.map((id) => `<#${id}>`).join(" ")
      : "`Aucun (ajoute des salons)`";

  return new EmbedBuilder()
    .setTitle("Configuration — Purge des fichiers")
    .setColor(auto ? 0x3ba55c : 0xed4245)
    .addFields(
      { name: "Mode auto", value: auto ? "✅ ON" : "❌ OFF", inline: true },
      { name: "Salon de logs", value: logChannelTxt, inline: true },
      { name: "Salons autorisés", value: allowedTxt }
    )
    .setFooter({
      text: "Utilise les sélecteurs et boutons ci-dessous pour configurer.",
    });
}

function buildComponents({ auto }) {
  const rows = [];

  // Sélecteur multi — salons autorisés
  rows.push(
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId("setpurge:add-channels")
        .setPlaceholder("Ajouter des salons autorisés…")
        .setMinValues(1)
        .setMaxValues(25)
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.GuildForum,
          ChannelType.PublicThread,
          ChannelType.PrivateThread,
          ChannelType.AnnouncementThread
        )
    )
  );

  // Sélecteur single — salon de logs
  rows.push(
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId("setpurge:set-log")
        .setPlaceholder("Sélectionner le salon de logs…")
        .setMinValues(1)
        .setMaxValues(1)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    )
  );

  // Boutons — toggle auto
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("setpurge:toggle-auto")
        .setStyle(auto ? ButtonStyle.Success : ButtonStyle.Danger)
        .setLabel(`Auto : ${auto ? "ON" : "OFF"}`)
    )
  );

  return rows;
}

export const command = {
  name: "setpurge",
  aliases: ["spurge", "purgeset"],
  description:
    "Configurer la purge des fichiers (salons autorisés, mode auto, logs).",
  /**
   * @param {import('discord.js').Client} bot
   * @param {import('discord.js').Message} message
   * @param {string[]} args
   */
  run: async (bot, message) => {
    if (!message.guild) return;
    if (
      !message.member.permissions.has(PermissionsBitField.Flags.ManageGuild) &&
      !message.member.permissions.has(PermissionsBitField.Flags.Administrator)
    ) {
      return message.reply(
        "❌ Tu n'as pas la permission (Manage Guild ou Admin)."
      );
    }

    const db = getDb(bot);
    const guildId = message.guild.id;

    const settings = await fetchSettings(db, guildId);
    const allowedChannels = await listChannels(db, guildId);

    const embed = buildEmbed(message.guild, settings, allowedChannels);
    const components = buildComponents(settings);

    const msg = await message.channel.send({ embeds: [embed], components });

    // Petit helper pour rafraîchir l’embed/les boutons après une interaction
    const refresh = async () => {
      const s = await fetchSettings(db, guildId);
      const channels = await listChannels(db, guildId);
      await msg.edit({
        embeds: [buildEmbed(message.guild, s, channels)],
        components: buildComponents(s),
      });
    };

    // Collecteur local (les interactions globales sont aussi gérées dans Events/interactionCreate, mais on le fait ici pour un UX immédiat)
    const filter = (i) =>
      i.message.id === msg.id &&
      i.user.id === message.author.id &&
      i.guild?.id === guildId;
    const collector = msg.createMessageComponentCollector({
      filter,
      time: 10 * 60 * 1000,
    });

    collector.on("collect", async (interaction) => {
      try {
        if (interaction.customId === "setpurge:add-channels") {
          const values = interaction.values || [];
          await addChannels(db, guildId, values);
          await interaction.reply({
            content: `✅ Ajouté : ${values.map((v) => `<#${v}>`).join(" ")}`,
            ephemeral: true,
          });
          await refresh();
        } else if (interaction.customId === "setpurge:set-log") {
          const logId = interaction.values?.[0];
          // Empêcher le salon log d’être un salon autorisé
          const allowed = await listChannels(db, guildId);
          if (allowed.includes(logId)) {
            await interaction.reply({
              content:
                "⚠️ Choisis un salon de logs différent des salons autorisés.",
              ephemeral: true,
            });
          } else {
            await upsertSettings(db, guildId, { logChannelId: logId });
            await interaction.reply({
              content: `✅ Salon de logs : <#${logId}>`,
              ephemeral: true,
            });
            await refresh();
          }
        } else if (interaction.customId === "setpurge:toggle-auto") {
          const current = await fetchSettings(db, guildId);
          const next = current.auto ? 0 : 1;
          await upsertSettings(db, guildId, { auto: next });
          await interaction.reply({
            content: `✅ Mode auto : ${next ? "ON" : "OFF"}`,
            ephemeral: true,
          });
          await refresh();
        }
      } catch (e) {
        console.error(e);
        if (!interaction.replied) {
          await interaction.reply({
            content: "❌ Erreur pendant la mise à jour.",
            ephemeral: true,
          });
        }
      }
    });
  },
};
