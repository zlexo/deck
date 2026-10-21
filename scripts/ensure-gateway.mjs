// Pre-step for `tauri dev`: guarantee a HEALTHY Deck gateway on :8800.
// Real HTTP request, not just a TCP probe — a port held by a half-dead process
// would otherwise be "reused" and leave the app on a white screen (pantheon
// battle scar, 2026-06). If it serves, reuse it; otherwise start `node server.js`
// and stay attached so Tauri keeps the gateway alive for the life of the window.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT ?? 8800);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // deck root

function isServing(cb) {
  const req = http.get({ host: "127.0.0.1", port: PORT, path: "/", timeout: 1000 }, (res) => {
    res.resume();
    cb(typeof res.statusCode === "number" && res.statusCode > 0);
  });
  req.on("error", () => cb(false));
  req.on("timeout", () => { req.destroy(); cb(false); });
}

function startGateway() {
  const child = spawn("node", ["server.js"], { cwd: ROOT, stdio: "inherit", env: process.env });
  child.on("exit", (code) => process.exit(code ?? 0));
  const stop = () => child.kill(); // SIGTERM → server.js stops its children too
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

isServing((ok) => {
  if (ok) { console.log(`Deck gateway already serving on :${PORT} — reusing it.`); process.exit(0); }
  else startGateway();
});
