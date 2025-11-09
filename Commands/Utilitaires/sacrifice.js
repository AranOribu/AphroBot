import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_ROOT = path.resolve(__dirname, "../../Data");
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function loadSacrifice() {
  try {
    const raw = fs.readFileSync(path.join(DATA_ROOT, "sacrifice.json"), "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.dieux) || !Array.isArray(data?.offrandes)) {
      throw new Error('Clés "dieux" et/ou "offrandes" manquantes');
    }
    return data;
  } catch (e) {
    console.error(`[sacrifice] Erreur sacrifice.json : ${e.message}`);
    return null;
  }
}

export const command = {
  name: "sacrifice",
  aliases: ["offrande"],
  category: "Utilitaires",
  description: "Fait une offrande aléatoire à un dieu",
  usage: ".sacrifice",
  run: async (bot, message) => {
    const data = loadSacrifice();
    if (!data)
      return message.reply("Impossible de charger les données de sacrifice.");
    await message.reply(
      `⚱️ Vous offrez ${pick(data.offrandes)} à **${pick(
        data.dieux
      )}**. Que les dieux vous soient favorables !`
    );
  },
};
