import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/;
const SOURCE_ENV_KEYS = ["NINE_ROUTER_SOURCE_ID", "GIT_COMMIT_SHA", "GITHUB_SHA"];

function readText(filePath) {
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function safeId(value) {
  const candidate = String(value || "").trim();
  return SAFE_ID.test(candidate) ? candidate : null;
}

function buildMetadata() {
  const bundlePath = process.env.NINE_ROUTER_BUNDLE_PATH || process.cwd();
  const buildIdPath = process.env.NINE_ROUTER_BUILD_ID_PATH || [
    path.join(bundlePath, ".next", "BUILD_ID"),
    path.join(bundlePath, "BUILD_ID"),
  ].find((candidate) => fs.existsSync(candidate));
  const buildId = safeId(process.env.NINE_ROUTER_BUILD_ID || (buildIdPath && readText(buildIdPath)));
  let buildTimestamp = process.env.NINE_ROUTER_BUILD_TIMESTAMP || null;
  if (!buildTimestamp && buildIdPath) {
    try { buildTimestamp = new Date(fs.statSync(buildIdPath).mtimeMs).toISOString(); } catch { /* optional metadata */ }
  }
  let packageVersion = safeId(process.env.NINE_ROUTER_PACKAGE_VERSION);
  if (!packageVersion) {
    const packagePath = path.join(bundlePath, "package.json");
    try { packageVersion = safeId(JSON.parse(fs.readFileSync(packagePath, "utf8")).version); } catch { /* optional metadata */ }
  }
  const sourceIdentity = SOURCE_ENV_KEYS.map((key) => safeId(process.env[key])).find(Boolean) || (packageVersion ? `version-${packageVersion}` : null);
  const sourceBuildMaterial = [buildId, sourceIdentity, packageVersion].filter(Boolean).join(":") || "unknown";
  const buildIdentity = crypto.createHash("sha256").update(sourceBuildMaterial).digest("hex").slice(0, 16);
  return { buildId, buildTimestamp, buildIdentity, packageVersion, sourceIdentity, bundlePath };
}

let cachedFingerprint;

export function getRuntimeFingerprint() {
  if (!cachedFingerprint) {
    cachedFingerprint = {
      ...buildMetadata(),
      serverPid: process.pid,
    };
  }
  return cachedFingerprint;
}
