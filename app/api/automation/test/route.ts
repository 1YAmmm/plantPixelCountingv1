import { renderReportEmail, SAMPLE_REPORT } from "@/lib/automation/report";
import { requireAdmin } from "@/lib/server/auth";
import { KEYS, manualSlotId, readConfig } from "@/lib/server/automation";
import { sendEmail } from "@/lib/server/email";
import { getKv } from "@/lib/server/kv";

// Test buttons on the Settings card (newplan.md step 5). Admin cookie required.
//   { kind: "email" }    sends an example report to the saved recipients now
//   { kind: "capture" }  asks the camera for a photo at its next poll (within about a minute);
//                        it is analyzed and emailed like a scheduled one

export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let kind: unknown;
  try {
    kind = ((await request.json()) as { kind?: unknown }).kind;
  } catch {
    kind = undefined;
  }
  const kv = getKv();
  const config = await readConfig(kv);

  if (kind === "email") {
    const to = config.recipients ?? [];
    if (to.length === 0) return Response.json({ error: "Save at least one email first" }, { status: 400 });
    const email = renderReportEmail(SAMPLE_REPORT, {
      takenAt: Date.now(),
      timeZone: config.schedule?.timeZone ?? "UTC",
      late: false,
      images: false,
      test: true,
    });
    try {
      const result = await sendEmail({ to, ...email });
      return Response.json({ sentTo: to, via: result.via, file: result.file ?? null });
    } catch (e) {
      console.error("[test] email failed", e);
      return Response.json({ error: `Could not send: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
    }
  }

  if (kind === "capture") {
    if (!config.recipients?.length) return Response.json({ error: "Save at least one email first" }, { status: 400 });
    const slotId = manualSlotId(Date.now());
    await kv.set(KEYS.config, { ...config, captureNow: slotId });
    return Response.json({ slotId });
  }

  return Response.json({ error: 'kind must be "email" or "capture"' }, { status: 400 });
}
