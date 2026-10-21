// Post-step for `tauri build`: move the built Deck.app into /Applications.
// Moved, not copied: a second Deck.app left under src-tauri/target is a full app
// bundle, so Spotlight lists it next to the installed one and opening it runs
// whatever build happens to be lying there (three "Deck" hits, 2026-09-30).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // deck root
const BUILT = path.join(ROOT, "src-tauri/target/release/bundle/macos/Deck.app");
const DEST = process.env.DECK_APP_DEST ?? "/Applications/Deck.app";

if (!fs.existsSync(BUILT)) {
  console.error(`no built app at ${BUILT} (run: npm run app:build)`);
  process.exit(1);
}
// Replacing the bundle under a running Deck leaves it half old, half new.
const running = spawnSync("pgrep", ["-f", path.join(DEST, "Contents/MacOS/")]).status === 0;
if (running) {
  console.error(`Deck is running from ${DEST}: quit it, then run this again`);
  process.exit(1);
}
fs.rmSync(DEST, { recursive: true, force: true });
execFileSync("ditto", [BUILT, DEST]); // ditto keeps the bundle's signature and attributes
fs.rmSync(BUILT, { recursive: true });
console.log(`installed ${DEST}`);
