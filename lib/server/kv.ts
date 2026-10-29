import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Redis } from "@upstash/redis";

// Small key-value store for the daily report (newplan.md step 1). Upstash Redis when its REST
// variables are set (Vercel → Storage → Upstash Redis), otherwise a JSON file in .data/ for local
// development and tests (AUTOMATION_DATA_FILE overrides the path). Values are JSON.

export interface KvOptions {
  /** Expire the key after this many seconds. */
  ttlSec?: number;
}

export interface Kv {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: KvOptions): Promise<void>;
  /** Set only if the key does not exist. Returns false if it already existed. */
  setIfAbsent(key: string, value: unknown, opts?: KvOptions): Promise<boolean>;
  del(key: string): Promise<void>;
}

function redisKv(redis: Redis): Kv {
  return {
    get: (key) => redis.get(key),
    async set(key, value, opts) {
      if (opts?.ttlSec) await redis.set(key, value, { ex: opts.ttlSec });
      else await redis.set(key, value);
    },
    async setIfAbsent(key, value, opts) {
      const result = opts?.ttlSec ? await redis.set(key, value, { nx: true, ex: opts.ttlSec }) : await redis.set(key, value, { nx: true });
      return result === "OK";
    },
    async del(key) {
      await redis.del(key);
    },
  };
}

interface FileEntry {
  value: unknown;
  /** Epoch ms. */
  expiresAt?: number;
}

type FileData = Record<string, FileEntry>;

/** Local development and tests only; the path is not traced into the deployed server bundle. */
function dataFile(): string {
  return process.env.AUTOMATION_DATA_FILE || path.join(process.cwd(), ".data", "automation.json");
}

/** One read-modify-write at a time, so concurrent requests in this process do not lose writes. */
let fileQueue: Promise<unknown> = Promise.resolve();

function withFile<T>(run: (data: FileData) => { result: T; changed: boolean }): Promise<T> {
  const next = fileQueue.then(async () => {
    const file = dataFile();
    let data: FileData = {};
    try {
      data = JSON.parse(await readFile(/* turbopackIgnore: true */ file, "utf8")) as FileData;
    } catch {
      data = {};
    }
    const now = Date.now();
    let changed = false;
    for (const [key, entry] of Object.entries(data)) {
      if (entry.expiresAt != null && entry.expiresAt <= now) {
        delete data[key];
        changed = true;
      }
    }
    const out = run(data);
    if (out.changed || changed) {
      await mkdir(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(/* turbopackIgnore: true */ tmp, JSON.stringify(data, null, 2));
      await rename(/* turbopackIgnore: true */ tmp, file);
    }
    return out.result;
  });
  fileQueue = next.catch(() => {});
  return next;
}

function entry(value: unknown, opts?: KvOptions): FileEntry {
  // Round-trip through JSON so the file backend returns the same shapes as Redis.
  const copy: unknown = JSON.parse(JSON.stringify(value));
  return opts?.ttlSec ? { value: copy, expiresAt: Date.now() + opts.ttlSec * 1000 } : { value: copy };
}

const fileKv: Kv = {
  get: <T>(key: string) => withFile((data) => ({ result: (data[key]?.value as T | undefined) ?? null, changed: false })),
  set: (key, value, opts) =>
    withFile((data) => {
      data[key] = entry(value, opts);
      return { result: undefined, changed: true };
    }),
  setIfAbsent: (key, value, opts) =>
    withFile((data) => {
      if (key in data) return { result: false, changed: false };
      data[key] = entry(value, opts);
      return { result: true, changed: true };
    }),
  del: (key) =>
    withFile((data) => {
      const had = key in data;
      delete data[key];
      return { result: undefined, changed: had };
    }),
};

let redis: Kv | null = null;

export function getKv(): Kv {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return fileKv;
  return (redis ??= redisKv(new Redis({ url, token })));
}
