const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build"
  || process.env.NEXT_PHASE === "phase-export"
  || process.env.NEXT_PHASE === "phase-static";

export async function register() {
  if (isBuildPhase || process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { configureLocalProxyAutoHealthCheck } = await import("@/lib/network/localProxyHealthScheduler.js");
    await configureLocalProxyAutoHealthCheck();
  } catch (error) {
    console.error("[LocalProxyAutoHealth] startup scheduler failed:", error.message);
  }
}
