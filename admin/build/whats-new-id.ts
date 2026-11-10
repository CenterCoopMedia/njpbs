import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { sortWhatsNewNotes, type WhatsNewNote } from "../src/data/whats-new-order";

// Only this generated literal reaches the shell. Note bodies stay in the lazy dialog chunk.
export function whatsNewIdPlugin(): Plugin {
  const id = "virtual:whats-new-id";
  const directory = path.resolve(import.meta.dirname, "../src/data/whats-new");
  let videoReplacementEnabled = false;
  return {
    name: "whats-new-id",
    configResolved(config) { videoReplacementEnabled = config.env.VITE_VIDEO_REPLACEMENT_ENABLED === "true"; },
    resolveId(source) { if (source === id) return `\0${id}`; },
    load(source) {
      if (source !== `\0${id}`) return;
      this.addWatchFile(directory);
      const fragments: Record<string, WhatsNewNote> = {};
      for (const file of readdirSync(directory).filter(file => file.endsWith(".json"))) {
        const filename = path.join(directory, file);
        this.addWatchFile(filename);
        fragments[file] = JSON.parse(readFileSync(filename, "utf8"));
      }
      const latest = sortWhatsNewNotes(fragments, videoReplacementEnabled)[0];
      if (!latest) throw new Error("What's new needs at least one note.");
      return `export default ${JSON.stringify(`${latest.date} ${latest.title}`)};`;
    },
    configureServer(server) {
      server.watcher.add(directory);
      const refresh = (file: string) => {
        if (path.dirname(file) !== directory || !file.endsWith(".json")) return;
        const module = server.moduleGraph.getModuleById(`\0${id}`);
        if (module) server.moduleGraph.invalidateModule(module);
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("add", refresh).on("change", refresh).on("unlink", refresh);
      server.httpServer?.once("close", () => {
        server.watcher.off("add", refresh).off("change", refresh).off("unlink", refresh);
      });
    },
  };
}
