import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_ROOT = path.resolve(__dirname, "../../Data");
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function loadCitations() {
  try {
    const raw = fs.readFileSync(path.join(DATA_ROOT, "citations.json"), "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.citations)) return data.citations;
    if (Array.isArray(data?.CITATIONS)) return data.CITATIONS;
    throw new Error("Format inattendu");
  } catch (e) {
    console.error(`[oracle] Erreur citations.json : ${e.message}`);
    return null;
  }
}

export const command = {
  name: "oracle",
  aliases: [],
  category: "Utilitaires",
  description: "Affiche une citation grecque aléatoire",
  usage: ".oracle",
  run: async (bot, message) => {
    const list = loadCitations();
    if (!list || !list.length)
      return message.reply("Impossible de charger les citations.");
    await message.reply(`🔮 **Oracle** : ${pick(list)}`);
  },
};
