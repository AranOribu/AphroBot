// Commands/setpurge.js
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ComponentType,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import {
  ensurePurgeTables,
  getPurgeSettings,
  setAuto,
  setLogChannel,
  getAllowedChannels,
  setAllowedChannels,
  humanListChannels,
} from "../Utils/purge.js";

export const command = {
  name: "setpurge",
  aliases: [],
  description: "Configure la purge des fichiers (salons, logs, auto on/off).",
  run: async (bot, message) => {
    // Permissions de base
    if (
      !message.member.permissions.has(PermissionFlagsBits.ManageGuild) &&
      !message.member.permissions.has(PermissionFlagsBits.ManageMessages)
    ) {
      return message.reply(
        "⛔ Tu n'as pas la permission d’utiliser cette commande (Manage Guild / Manage Messages)."
      );
    }
    const me = message.guild.members.me;
    if (!me.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return message.reply(
        "⛔ Il me manque la permission **Manage Messages**."
      );
    }

    const db = bot.db;
    await ensurePurgeTables(db);

    const guildId = message.guild.id;
    const settings = await getPurgeSettings(db, guildId);
    const allowed = await getAllowedChannels(db, guildId);

    const embed = () =>
      new EmbedBuilder()
        .setTitle("Configuration de purge des fichiers")
        .setColor(settings.auto ? 0x00b894 : 0x0984e3)
        .addFields(
          {
            name: "Mode auto",
            value: settings.auto ? "✅ ON" : "❌ OFF",
            inline: true,
          },
          {
            name: "Salon de logs",
            value: settings.logChannelId ? `<#${settings.logChannelId}>` : "—",
            inline: true,
          },
          {
            name: "Salons autorisés",
            value: humanListChannels(message.guild, allowed),
            inline: false,
          }
        )
        .setFooter({
          text: "Sélectionne des salons, choisis le salon de logs, puis valide. Le bouton ON/OFF change le mode auto.",
        });

    const components = () => [
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId("purge_config:channels")
          .setPlaceholder("Sélectionner les salons autorisés (multi)")
          .setMinValues(0)
          .setMaxValues(25)
          .addChannelTypes(ChannelType.GuildText)
      ),
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId("purge_config:log")
          .setPlaceholder("Choisir le salon de logs")
          .setMinValues(0)
          .setMaxValues(1)
          .addChannelTypes(ChannelType.GuildText)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("purge_config:auto_toggle")
          .setStyle(settings.auto ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setLabel(settings.auto ? "Auto: ON" : "Auto: OFF"),
        new ButtonBuilder()
          .setCustomId("purge_config:close")
          .setStyle(ButtonStyle.Danger)
          .setLabel("Fermer")
      ),
    ];

    const ui = await message.reply({
      embeds: [embed()],
      components: components(),
    });

    const collector = ui.createMessageComponentCollector({
      componentType: ComponentType.ActionRow, // accepte tous types dans les rows
      time: 5 * 60 * 1000,
    });

    collector.on("collect", async (i) => {
      if (i.user.id !== message.author.id) {
        return i.reply({
          content:
            "Seul l'auteur de la commande peut modifier cette configuration.",
          ephemeral: true,
        });
      }

      try {
        if (i.isChannelSelectMenu()) {
          if (i.customId === "purge_config:channels") {
            // Empêche d’ajouter le salon de logs aux salons autorisés
            const selected = i.values.filter(
              (v) => v !== settings.logChannelId
            );
            await setAllowedChannels(db, guildId, selected);
          }
          if (i.customId === "purge_config:log") {
            const logId = i.values[0] ?? null;
            // Empêche d’utiliser un salon autorisé comme logs
            const allowedNow = await getAllowedChannels(db, guildId);
            if (logId && allowedNow.includes(logId)) {
              return i.reply({
                content:
                  "❌ Le salon de logs ne peut pas faire partie des salons autorisés.",
                ephemeral: true,
              });
            }
            await setLogChannel(db, guildId, logId || null);
          }
        } else if (i.isButton()) {
          if (i.customId === "purge_config:auto_toggle") {
            const current = (await getPurgeSettings(db, guildId)).auto;
            await setAuto(db, guildId, !current);
          } else if (i.customId === "purge_config:close") {
            collector.stop("closed");
            return i.update({ components: [] });
          }
        }

        // Rafraîchit l’embed après chaque action
        const fresh = await getPurgeSettings(db, guildId);
        const allowedFresh = await getAllowedChannels(db, guildId);
        Object.assign(settings, fresh);
        const newRows = components();
        await i.update({ embeds: [embed()], components: newRows });
      } catch (err) {
        console.error("[setpurge]", err);
        if (!i.replied)
          await i.reply({
            content: "❌ Erreur lors de la mise à jour.",
            ephemeral: true,
          });
      }
    });

    collector.on("end", async (_c, reason) => {
      if (reason !== "closed") {
        await ui.edit({ components: [] }).catch(() => null);
      }
    });
  },
};
