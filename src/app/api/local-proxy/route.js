import { NextResponse } from "next/server";
import { getLocalProxyStatus, rebuildLocalProxyConfig, startLocalProxy, stopLocalProxy } from "@/lib/network/localProxyManager.js";

export async function GET() { try { return NextResponse.json(await getLocalProxyStatus()); } catch (error) { return NextResponse.json({ error: error.message }, { status: 500 }); } }
export async function POST(request) {
  try {
    const { action } = await request.json().catch(() => ({}));
    if (action === "start") return NextResponse.json(await startLocalProxy());
    if (action === "stop") return NextResponse.json(await stopLocalProxy());
    if (action === "config") return NextResponse.json(await rebuildLocalProxyConfig());
    return NextResponse.json({ error: "action must be start, stop, or config" }, { status: 400 });
  } catch (error) { return NextResponse.json({ error: error.message }, { status: 400 }); }
}

export async function PUT(request) {
  try {
    const { nodeId } = await request.json();
    const { selectLocalProxyNode, rotateLocalProxyNode } = await import("@/lib/network/localProxyManager.js");
    return NextResponse.json(nodeId ? await selectLocalProxyNode(nodeId) : await rotateLocalProxyNode());
  } catch (error) { return NextResponse.json({ error: error.message }, { status: 400 }); }
}
