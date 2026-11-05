import { eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, driveItems, backups } from "@/db/schema";

/**
 * Cloudflare R2 Free Tier Safety Caps.
 * - Free Tier limit: 10 GB (10,737,418,240 bytes)
 * - Hard Safety Cap: 8.0 GB (Auto-suspension triggers here, leaving a strict 2.0 GB safety buffer)
 * - Warning Cap: 6.5 GB (Alert threshold)
 */
export const R2_FREE_TIER_BYTES = 10 * 1024 * 1024 * 1024;
export const R2_HARD_SAFETY_CAP_BYTES = 8 * 1024 * 1024 * 1024;
export const R2_WARNING_THRESHOLD_BYTES = 6.5 * 1024 * 1024 * 1024;

export class StorageQuotaExceededError extends Error {
	constructor(message = "Limite di sicurezza storage (8 GB) raggiunto. Upload bloccato per prevenire costi su Cloudflare R2.") {
		super(message);
		this.name = "StorageQuotaExceededError";
	}
}

export interface StorageUsageSummary {
	totalUsedBytes: number;
	totalUsedMb: number;
	totalUsedGb: number;
	hardCapBytes: number;
	hardCapGb: number;
	freeTierBytes: number;
	percentageOfHardCap: number;
	isWarning: boolean;
	isSuspended: boolean;
}

let cachedUsage: { timestamp: number; summary: StorageUsageSummary } | null = null;
const CACHE_TTL_MS = 15_000; // Cache usage for 15s to keep D1 query budget minimal

/**
 * Returns current storage usage across attachments, drive items, and completed database backups.
 */
export async function getStorageUsageSummary(env: CloudflareEnv, forceFresh = false): Promise<StorageUsageSummary> {
	const now = Date.now();
	if (!forceFresh && cachedUsage && now - cachedUsage.timestamp < CACHE_TTL_MS) {
		return cachedUsage.summary;
	}

	try {
		const db = getDb(env);

		// 1. Attachments not in trash
		const [attResult] = await db
			.select({ total: sql<number>`coalesce(sum(${messageAttachments.size}), 0)` })
			.from(messageAttachments)
			.where(isNull(messageAttachments.trashedAt));

		// 2. Drive items not in trash
		const [driveResult] = await db
			.select({ total: sql<number>`coalesce(sum(${driveItems.size}), 0)` })
			.from(driveItems)
			.where(isNull(driveItems.trashedAt));

		// 3. Completed database backups
		const [backupResult] = await db
			.select({ total: sql<number>`coalesce(sum(${backups.size}), 0)` })
			.from(backups)
			.where(eq(backups.status, "completed"));

		const attachmentsBytes = Number(attResult?.total ?? 0);
		const driveBytes = Number(driveResult?.total ?? 0);
		const backupsBytes = Number(backupResult?.total ?? 0);

		const totalUsedBytes = attachmentsBytes + driveBytes + backupsBytes;
		const totalUsedMb = Math.round((totalUsedBytes / (1024 * 1024)) * 100) / 100;
		const totalUsedGb = Math.round((totalUsedBytes / (1024 * 1024 * 1024)) * 100) / 100;

		const isSuspended = totalUsedBytes >= R2_HARD_SAFETY_CAP_BYTES;
		const isWarning = totalUsedBytes >= R2_WARNING_THRESHOLD_BYTES;
		const percentageOfHardCap = Math.min(100, Math.round((totalUsedBytes / R2_HARD_SAFETY_CAP_BYTES) * 100));

		const summary: StorageUsageSummary = {
			totalUsedBytes,
			totalUsedMb,
			totalUsedGb,
			hardCapBytes: R2_HARD_SAFETY_CAP_BYTES,
			hardCapGb: 8.0,
			freeTierBytes: R2_FREE_TIER_BYTES,
			percentageOfHardCap,
			isWarning,
			isSuspended,
		};

		cachedUsage = { timestamp: now, summary };
		return summary;
	} catch (error) {
		console.warn("[QuotaGuard] Impossibile calcolare l'uso storage, fallback conservativo:", error);
		return {
			totalUsedBytes: 0,
			totalUsedMb: 0,
			totalUsedGb: 0,
			hardCapBytes: R2_HARD_SAFETY_CAP_BYTES,
			hardCapGb: 8.0,
			freeTierBytes: R2_FREE_TIER_BYTES,
			percentageOfHardCap: 0,
			isWarning: false,
			isSuspended: false,
		};
	}
}

export function estimatePayloadSize(value: unknown): number {
	if (!value) return 0;
	if (value instanceof ArrayBuffer) return value.byteLength;
	if (ArrayBuffer.isView(value)) return value.byteLength;
	if (typeof value === "string") return new TextEncoder().encode(value).length;
	if (typeof (value as { size?: unknown }).size === "number") return (value as { size: number }).size;
	return 0;
}

/**
 * Asserts that the incoming write will not exceed the hard safety cap (8.0 GB).
 * Throws StorageQuotaExceededError if limit is reached.
 */
export async function assertStorageQuota(env: CloudflareEnv, incomingBytes = 0): Promise<void> {
	const summary = await getStorageUsageSummary(env);
	if (summary.isSuspended || summary.totalUsedBytes + incomingBytes >= R2_HARD_SAFETY_CAP_BYTES) {
		throw new StorageQuotaExceededError(
			`Sospensione di sicurezza attiva: capacità di sicurezza di 8 GB superata (${summary.totalUsedGb} GB usati). Operazione bloccata per evitare costi Cloudflare R2.`
		);
	}
}

/**
 * Wraps an R2Bucket instance with an automatic circuit-breaker proxy that intercepts `put`
 * and `createMultipartUpload` to guarantee no writes ever push storage into the paid tier.
 */
export function wrapBucketWithQuotaGuard(bucket: R2Bucket, env: CloudflareEnv): R2Bucket {
	return new Proxy(bucket, {
		get(target, property, receiver) {
			if (property === "put") {
				return async (
					key: string,
					value: Parameters<R2Bucket["put"]>[1],
					options?: Parameters<R2Bucket["put"]>[2]
				) => {
					const size = estimatePayloadSize(value);
					await assertStorageQuota(env, size);
					return target.put(key, value, options);
				};
			}

			if (property === "createMultipartUpload") {
				return async (key: string, options?: Parameters<R2Bucket["createMultipartUpload"]>[1]) => {
					// Check quota with default minimum chunk reserve (5 MB)
					await assertStorageQuota(env, 5 * 1024 * 1024);
					return target.createMultipartUpload(key, options);
				};
			}

			const val = Reflect.get(target, property, receiver);
			return typeof val === "function" ? val.bind(target) : val;
		},
	});
}
