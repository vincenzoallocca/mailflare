import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { getStorageUsageSummary } from "@/lib/storage/quota-guard";

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;

	const summary = await getStorageUsageSummary(env, true);
	return NextResponse.json(summary, {
		headers: { "Cache-Control": "no-store" },
	});
}
