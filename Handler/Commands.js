import fs from "fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async (bot) => {
  if (!bot.commands) bot.commands = new Map();

  const baseDir = path.join(__dirname, "../Commands");

  async function loadOne(absPath, relLabel) {
    try {
      const mod = await import(pathToFileURL(absPath).href);

      const candidate =
        mod.command || // export const command = {...}
        mod.default?.command || // export default { command: {...} }
        mod.default || // export default { name: '...' }
        null;

      if (!candidate?.name) {
        console.warn(
          `[COMMAND][IGNORÉ] ${relLabel} : export "command" valide introuvable.`
        );
        return;
      }

      bot.commands.set(candidate.name, candidate);
      if (Array.isArray(candidate.aliases)) {
        candidate.aliases.forEach((a) => bot.commands.set(a, candidate));
      }
      console.log(`[COMMAND] > ${candidate.name} (${relLabel})`);
    } catch (e) {
      console.error(`[COMMAND][ERREUR] ${relLabel} :`, e);
    }
  }

  function walk(dirRel = "") {
    const dirAbs = path.join(baseDir, dirRel);
    if (!fs.existsSync(dirAbs)) return;

    const entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name.startsWith("_")) continue; // optionnel

      const rel = path.join(dirRel, ent.name);
      const abs = path.join(dirAbs, ent.name);

      if (ent.isDirectory()) {
        walk(rel);
      } else if (ent.isFile() && ent.name.endsWith(".js")) {
        loadOne(abs, path.join("Commands", rel));
      }
    }
  }

  walk("");
};
