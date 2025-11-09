import { ActivityType } from "discord.js";

export default {
  name: "clientReady",
  async execute(bot) {
    await bot.application.commands.set(bot.arrayOfSlashCommands);

    // Présence
    bot.user.setPresence({
      activities: [{ name: "BAAM", type: ActivityType.Playing }],
      status: "online",
    });
  },
};
