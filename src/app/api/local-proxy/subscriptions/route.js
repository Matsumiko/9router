import { NextResponse } from "next/server";
import { createProxySubscription, getProxySubscriptions } from "@/lib/db/index.js";

function normalize(body = {}) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!name || !url) return { error: "Name and URL are required" };
  try { const parsed = new URL(url); if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(); } catch { return { error: "Subscription URL must use HTTP or HTTPS" }; }
  if (/\r|\n/.test(url)) return { error: "Invalid URL" };
  return { name, url, isActive: body.isActive !== false };
}
export async function GET() { return NextResponse.json({ subscriptions: await getProxySubscriptions() }); }
export async function POST(request) { const value = normalize(await request.json()); if (value.error) return NextResponse.json(value, { status: 400 }); return NextResponse.json({ subscription: await createProxySubscription(value) }, { status: 201 }); }
