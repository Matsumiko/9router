import { DatabaseSync } from "node:sqlite";
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const projectRoot = resolve(import.meta.dirname, "..");
const standaloneDir = join(projectRoot, process.env.NEXT_DIST_DIR || ".next", "standalone");
const standaloneServer = join(standaloneDir, "custom-server.js");
if (!existsSync(standaloneServer)) {
  throw new Error("Missing .next/standalone/custom-server.js; run npm run build first");
}

const dataDir = mkdtempSync(join(tmpdir(), "9router-startup-scheduler-"));
mkdirSync(join(dataDir, "db"), { recursive: true });
const db = new DatabaseSync(join(dataDir, "db", "data.sqlite"));
db.exec("CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)");
db.prepare("INSERT INTO settings(id, data) VALUES(1, ?)").run(JSON.stringify({
  requireLogin: false,
  localProxyAutoTestEnabled: true,
  localProxyAutoTestIntervalMinutes: 5,
}));
db.close();

function stop(child) {
  if (!child.killed) child.kill("SIGTERM");
}

async function bootAndRead(port) {
  const child = spawn(process.execPath, ["custom-server.js"], {
    cwd: standaloneDir,
    env: { ...process.env, DATA_DIR: dataDir, HOSTNAME: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    const deadline = Date.now() + 20_000;
    let response;
    while (Date.now() < deadline) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/api/local-proxy`);
        if (response.ok) break;
      } catch {
        // The standalone server is still binding; retry within the deadline.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!response?.ok) throw new Error(`server did not become ready on port ${port}`);
    const body = await response.json();
    if (!body.autoHealth?.nextRunAt && !body.autoHealth?.running) {
      throw new Error(`scheduler was not scheduled after boot on port ${port}: ${JSON.stringify(body.autoHealth)}`);
    }
    return { nextRunAt: body.autoHealth.nextRunAt, running: body.autoHealth.running, stderr };
  } finally {
    stop(child);
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

try {
  const first = await bootAndRead(20427);
  const second = await bootAndRead(20428);
  console.log(JSON.stringify({
    ok: true,
    firstBoot: { nextRunAt: first.nextRunAt, running: first.running },
    secondBoot: { nextRunAt: second.nextRunAt, running: second.running },
  }));
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
