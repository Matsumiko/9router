import { getSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";

let initialized = false;

export async function ensureOutboundProxyInitialized() {
  if (initialized) return true;
  try {
    const settings = await getSettings();
    if (settings.localProxyEnabled && settings.localProxyAutoStart) {
      const { startLocalProxy } = await import("@/lib/network/localProxyManager.js");
      await startLocalProxy();
    } else {
      applyOutboundProxyEnv(settings);
    }
    initialized = true;
  } catch (error) {
    console.error("[ServerInit] Error initializing outbound proxy:", error);
  }
  return initialized;
}

// Defer init so HTTP server accepts connections first
setImmediate(() => {
  ensureOutboundProxyInitialized().catch(console.log);
});

export default ensureOutboundProxyInitialized;
