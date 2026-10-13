import { NextResponse } from "next/server";
import { createLocalProxyNode, deleteLocalProxyNodesByHealthStatus, getLocalProxyNodes } from "@/lib/db/index.js";
import { parseSubscriptionText } from "@/lib/db/repos/proxySubscriptionsRepo.js";
import { checkLocalProxyNode } from "@/lib/network/localProxyManager.js";

export async function GET(request) { const { searchParams } = new URL(request.url); return NextResponse.json({ nodes: await getLocalProxyNodes({ subscriptionId: searchParams.get("subscriptionId") || undefined }) }); }
export async function PUT(request) {
  const body = await request.json().catch(() => ({}));
  const nodes = await getLocalProxyNodes({ subscriptionId: body.subscriptionId || undefined });
  const results = [];
  for (const node of nodes) {
    try { results.push(await checkLocalProxyNode(node.id, { testUrl: body.testUrl })); }
    catch (error) { results.push({ ...node, healthStatus: "unhealthy", lastError: error.message }); }
  }
  const healthy = results.filter((node) => node.healthStatus === "healthy").length;
  return NextResponse.json({ nodes: results, testedNodes: results.length, healthyNodes: healthy, unhealthyNodes: results.length - healthy });
}
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const urls = typeof body.urls === "string" ? body.urls : typeof body.url === "string" ? body.url : "";
  if (!urls.trim()) return NextResponse.json({ error: "At least one proxy URL is required" }, { status: 400 });
  const lines = urls.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  const nodes = parseSubscriptionText(lines.join("\n"));
  if (!nodes.length) return NextResponse.json({ error: "No supported proxy URLs found" }, { status: 400 });
  const imported = [];
  for (const node of nodes) imported.push(await createLocalProxyNode({ ...node, subscriptionId: null }));
  return NextResponse.json({ nodes: imported, importedNodes: imported.length, rejectedLines: lines.length - nodes.length }, { status: 201 });
}
export async function DELETE(request) {
  const body = await request.json().catch(() => ({}));
  const healthStatus = body.healthStatus || "degraded";
  if (healthStatus !== "degraded") return NextResponse.json({ error: "Only degraded nodes can be bulk deleted" }, { status: 400 });
  const removed = await deleteLocalProxyNodesByHealthStatus(healthStatus, { subscriptionId: body.subscriptionId || undefined });
  return NextResponse.json({ success: true, deletedNodes: removed.length, nodes: removed });
}
