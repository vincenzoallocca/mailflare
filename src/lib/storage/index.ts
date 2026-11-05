import { getObjectStorageConfig } from "@/lib/storage/b2-config";
import { openB2Bucket } from "@/lib/storage/b2-bucket";
import { wrapBucketWithQuotaGuard } from "@/lib/storage/quota-guard";

const wrapped = new WeakMap<object, CloudflareEnv>();
const proxies = new WeakSet<object>();

/**
 * Returns env with BUCKET served by Backblaze B2 (B2_*) or AWS S3 (S3_*) when configured; otherwise env unchanged
 * (the native R2 binding on Workers). Every caller reads `env.BUCKET`, so this one place decides where objects live
 * AND enforces the 8.0 GB hard safety cap to guarantee Cloudflare R2 free tier is never exceeded.
 */
export function withStorage(env: CloudflareEnv): CloudflareEnv {
	if (proxies.has(env)) return env;
	const cached = wrapped.get(env);
	if (cached) return cached;
	const config = getObjectStorageConfig(env);
	const rawBucket = config ? openB2Bucket(config) : env.BUCKET;
	if (!rawBucket) return env;

	// Enforce hard circuit breaker on writes to prevent charges
	const bucket = wrapBucketWithQuotaGuard(rawBucket, env);
	const proxy = new Proxy(env, { get: (target, property) => (property === "BUCKET" ? bucket : Reflect.get(target, property)) });
	wrapped.set(env, proxy);
	proxies.add(proxy);
	return proxy;
}
