import { automationUpdateSchema, type AutomationConfig } from "@/lib/automation/config";
import { requireAdmin } from "@/lib/server/auth";
import { KEYS, readConfig, readState } from "@/lib/server/automation";
import { getKv } from "@/lib/server/kv";

// The Settings page's "Daily email report" card (newplan.md steps 5–6). GET returns everything
// the card shows; PUT saves one setup step at a time: { recipients } (step 2) or
// { schedule, analysis } (step 3). Admin cookie required.

function fail(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return Response.json(await readState(getKv(), Date.now()), { headers: { "cache-control": "no-store" } });
}

export async function PUT(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("Send JSON", 400);
  }
  const parsed = automationUpdateSchema.safeParse(body);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid settings", 400);
  const update = parsed.data;

  const kv = getKv();
  const now = Date.now();
  const current = await readConfig(kv);
  const next: AutomationConfig = { ...current };
  if (update.recipients) next.recipients = update.recipients;
  if (update.analysis) next.analysis = update.analysis;
  if (update.schedule) {
    if (update.schedule.enabled && !next.recipients?.length) return fail("Add at least one email first", 400);
    const before = current.schedule;
    const changed =
      !before ||
      (update.schedule.enabled && !before.enabled) ||
      before.time !== update.schedule.time ||
      before.timeZone !== update.schedule.timeZone ||
      before.days.join() !== update.schedule.days.join();
    next.schedule = update.schedule;
    // Set times before this save are not photographed (saving 07:00 at 08:00 waits for tomorrow).
    if (changed) next.scheduleSince = new Date(now).toISOString();
  }
  await kv.set(KEYS.config, next);
  return Response.json(await readState(kv, now));
}
