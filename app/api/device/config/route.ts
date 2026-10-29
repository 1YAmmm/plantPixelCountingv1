import type { DeviceRecord } from "@/lib/automation/config";
import { requireDevice } from "@/lib/server/auth";
import { KEYS, pendingSlot, POLL_SECONDS, readConfig } from "@/lib/server/automation";
import { getKv } from "@/lib/server/kv";

// The camera's poll (newplan.md step 5), every POLL_SECONDS: "anything to do?". Records that the
// camera is online (which also completes setup step 1, WiFi) and answers in text/plain, one
// key=value per line, so the firmware needs no JSON parser:
//   poll=60
//   capture=<slot id>      only when a set time is due or a test photo was asked for
//
// Query: fw (firmware version), ip, rssi (dBm), heap (free bytes). Header: Authorization: Bearer <DEVICE_API_KEY>.

function text(value: string | null, max = 40): string | null {
  const v = value?.trim();
  return v ? v.slice(0, max) : null;
}

function int(value: string | null): number | null {
  const n = value == null || value === "" ? NaN : Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export async function GET(request: Request) {
  const denied = requireDevice(request);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const now = Date.now();
  const kv = getKv();
  const device: DeviceRecord = {
    lastSeenAt: new Date(now).toISOString(),
    firmware: text(params.get("fw")),
    ip: text(params.get("ip")),
    rssi: int(params.get("rssi")),
    freeHeap: int(params.get("heap")),
  };
  const [, config] = await Promise.all([kv.set(KEYS.device, device), readConfig(kv)]);

  const lines = [`poll=${POLL_SECONDS}`];
  const slot = await pendingSlot(kv, config, now);
  if (slot) lines.push(`capture=${slot}`);
  return new Response(`${lines.join("\n")}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
