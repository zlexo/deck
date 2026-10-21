// Pre-step for `tauri build`: compile server.js into the sidecar binary that
// gets bundled into Deck.app.
//
// Why this exists: src-tauri/binaries/ is gitignored and tauri.conf.json used to
// declare only a beforeDevCommand, so `tauri build` shipped whatever binary
// happened to be lying on disk. public/*.html is read live off the checkout and
// is always current; the gateway is frozen at compile time. They drifted twice
// in production — 2026-08-12 (sidecar predated /chrome.html) and 2026-09-01
// (a 2026-08-11 sidecar predated /api/projects, so the home page rendered an
// empty PROJECTS grid). Compiling here makes that drift impossible by
// construction.
//
// Paths resolve from this file, not from cwd, so it does not matter which
// directory Tauri invokes the beforeBuildCommand in.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codeHash } from "../lib/core/build-hash.mjs";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // deck root
const SERVER = path.join(ROOT, "server.js");
const OUT_DIR = path.join(ROOT, "src-tauri", "binaries");

// Tauri's externalBin strips the target triple off the filename, so the binary
// on disk has to carry it.
const ARCH = { arm64: "aarch64", x64: "x86_64" }[process.arch] || process.arch;
const TRIPLE = process.platform === "darwin" ? `${ARCH}-apple-darwin`
             : process.platform === "linux"  ? `${ARCH}-unknown-linux-gnu`
             : `${ARCH}-pc-windows-msvc`;
const OUT = path.join(OUT_DIR, `deck-server-${TRIPLE}`);

const git = (...args) => {
  try { return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim(); }
  catch { return ""; }
};

// The identity stamped into the binary. serverHash is the load-bearing field:
// the gateway compares it against the hash of its code on disk at runtime
// (server.js, lib/, the lockfile: lib/core/build-hash.mjs) and reports itself
// stale when they differ (see /api/version).
const serverHash = codeHash(ROOT);
const dirty = git("status", "--porcelain", "--", "server.js", "lib", "package-lock.json") ? "-dirty" : "";
const BUILD = {
  sha: (git("rev-parse", "--short", "HEAD") || "unknown") + dirty,
  builtAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  serverHash,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const args = ["build", "--compile", SERVER, "--outfile", OUT,
              "--define", `DECK_BUILD=${JSON.stringify(BUILD)}`];
console.log(`build-gateway: cwd=${process.cwd()}`);
console.log(`build-gateway: code ${serverHash} @ ${BUILD.sha} → ${path.relative(ROOT, OUT)}`);
// bun --compile leaves a 63 MB .<hash>.bun-build file in its working directory
// on every run (four had piled up in the checkout by 2026-10-12), so it runs in
// a temp folder that is removed afterwards. Entry and output paths are absolute.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "deck-gateway-build-"));
const r = spawnSync("bun", args, { cwd: scratch, stdio: "inherit" });
fs.rmSync(scratch, { recursive: true, force: true });
if (r.error) { console.error(`build-gateway: could not run bun — ${r.error.message}`); process.exit(1); }
if (r.status !== 0) process.exit(r.status ?? 1);
if (!fs.existsSync(OUT)) { console.error(`build-gateway: bun reported success but ${OUT} is missing`); process.exit(1); }
