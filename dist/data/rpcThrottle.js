import { logger } from "../logger.js";
import { config } from "../config.js";
let queue = Promise.resolve();
let lastCallAt = 0;
/**
 * Serializes public-RPC reads to avoid rate-limit storms. Transient network
 * failures get a few short retries within the same queue item, so a retry
 * cannot deadlock behind the request that initiated it.
 */
export function throttledRpcCall(fn, retries = 3) {
    const run = async () => {
        for (let attempt = 0;; attempt++) {
            const wait = Math.max(0, lastCallAt + config.rpc.minIntervalMs - Date.now());
            if (wait > 0)
                await new Promise((resolve) => setTimeout(resolve, wait));
            lastCallAt = Date.now();
            try {
                return await fn();
            }
            catch (err) {
                const message = String(err?.message ?? err);
                const retryable = message.includes("429") ||
                    message.includes("Too Many Requests") ||
                    message.includes("fetch failed") ||
                    message.includes("Connect Timeout") ||
                    message.includes("ECONNRESET");
                if (!retryable || attempt >= retries)
                    throw err;
                const backoff = Math.min(500, 75 * (attempt + 1));
                logger.warn(`Transient RPC error; retrying in ${backoff}ms (${retries - attempt} retries left)`);
                await new Promise((resolve) => setTimeout(resolve, backoff));
            }
        }
    };
    const result = queue.then(run);
    queue = result.then(() => undefined, () => undefined);
    return result;
}
