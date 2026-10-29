import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationState } from "@/lib/automation/config";
import { DEFAULT_DETECTION_SETTINGS } from "@/lib/detection/settings";
import { DEFAULT_VISION_SETTINGS } from "@/lib/vision/settings";

// The daily-report routes called directly, with the JSON-file store in a temp folder and email mocked.

vi.mock("@/lib/server/email", () => ({
  sendEmail: vi.fn(async () => ({ via: "gmail" })),
  emailConfigured: () => true,
}));

vi.mock("@/lib/vision/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vision/node")>();
  return { ...actual, cropGuideSquare: vi.fn(actual.cropGuideSquare) };
});

const { sendEmail } = await import("@/lib/server/email");
const { cropGuideSquare } = await import("@/lib/vision/node");
const { adminToken } = await import("@/lib/server/auth");
const deviceConfig = await import("@/app/api/device/config/route");
const deviceCaptures = await import("@/app/api/device/captures/route");
const automation = await import("@/app/api/automation/route");
const session = await import("@/app/api/automation/session/route");
const testRoute = await import("@/app/api/automation/test/route");

const KEY = "test-device-key-0123456789";
const PASSWORD = "admin-pass";
const BASE = "http://localhost:3000";
const photo = new Uint8Array(readFileSync(path.join(import.meta.dirname, "../test-images/synthetic/rosette-healthy.jpg")));

let dir: string;
const env = { ...process.env };

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "plant-automation-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.DEVICE_API_KEY = KEY;
  process.env.ADMIN_PASSWORD = PASSWORD;
  process.env.AUTOMATION_DATA_FILE = path.join(dir, `${Math.random().toString(36).slice(2)}.json`);
  for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) delete process.env[k];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T22:00:00Z")); // Thu 29 Oct, 06:00 in Manila
  vi.mocked(sendEmail).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...env };
});

const admin = { cookie: `plant_admin=${adminToken(PASSWORD)}` };
const device = { authorization: `Bearer ${KEY}` };

async function poll(headers: Record<string, string> = device) {
  const res = await deviceConfig.GET(new Request(`${BASE}/api/device/config?fw=2.0.0&ip=192.168.1.23&rssi=-61&heap=91000`, { headers }));
  return { status: res.status, text: await res.text() };
}

async function upload(slot: string, body: Uint8Array<ArrayBuffer> = photo, headers: Record<string, string> = device) {
  const res = await deviceCaptures.POST(
    new Request(`${BASE}/api/device/captures`, { method: "POST", body, headers: { ...headers, "content-type": "image/jpeg", "x-slot": slot } }),
  );
  return { status: res.status, text: (await res.text()).trim() };
}

async function getState(): Promise<AutomationState> {
  const res = await automation.GET(new Request(`${BASE}/api/automation`, { headers: admin }));
  expect(res.status).toBe(200);
  return res.json();
}

async function put(body: unknown) {
  const res = await automation.PUT(new Request(`${BASE}/api/automation`, { method: "PUT", body: JSON.stringify(body), headers: { ...admin, "content-type": "application/json" } }));
  return { status: res.status, body: await res.json() };
}

const schedule = { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], time: "07:00", timeZone: "Asia/Manila" };
const analysis = { vision: DEFAULT_VISION_SETTINGS, thresholds: DEFAULT_DETECTION_SETTINGS, baselineCoverPcts: [30, 31, 32], copiedAt: "2026-10-28T21:00:00.000Z" };
const SLOT = "sched-2026-10-28T23:00:00.000Z";

async function setUp() {
  expect((await put({ recipients: ["Ana@Example.com", "ben@example.com"] })).status).toBe(200);
  expect((await put({ schedule, analysis })).status).toBe(200);
}

describe("auth", () => {
  it("rejects the camera without the right key", async () => {
    expect((await poll({})).status).toBe(401);
    expect((await poll({ authorization: "Bearer nope" })).status).toBe(401);
    expect((await upload(SLOT, photo, { authorization: "Bearer nope" })).status).toBe(401);
  });

  it("needs the admin cookie for the settings", async () => {
    expect((await automation.GET(new Request(`${BASE}/api/automation`))).status).toBe(401);
    expect((await automation.GET(new Request(`${BASE}/api/automation`, { headers: { cookie: "plant_admin=forged" } }))).status).toBe(401);
    expect((await testRoute.POST(new Request(`${BASE}/api/automation/test`, { method: "POST", body: '{"kind":"email"}' }))).status).toBe(401);
  });

  it("signs in with the password", async () => {
    const wrong = await session.POST(new Request(`${BASE}/api/automation/session`, { method: "POST", body: JSON.stringify({ password: "guess" }) }));
    expect(wrong.status).toBe(401);
    const right = await session.POST(new Request(`${BASE}/api/automation/session`, { method: "POST", body: JSON.stringify({ password: PASSWORD }) }));
    expect(right.status).toBe(200);
    const cookie = right.headers.get("set-cookie")!;
    expect(cookie).toContain(`plant_admin=${adminToken(PASSWORD)}`);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it("is unavailable until the server has a device key", async () => {
    delete process.env.DEVICE_API_KEY;
    expect((await poll()).status).toBe(503);
  });
});

describe("setup steps", () => {
  it("marks step 1 done once the camera polls", async () => {
    expect((await getState()).device).toBeNull();
    expect(await poll()).toEqual({ status: 200, text: "poll=60\n" });
    const state = await getState();
    expect(state.device).toMatchObject({ lastSeenAt: "2026-10-28T22:00:00.000Z", firmware: "2.0.0", ip: "192.168.1.23", rssi: -61, freeHeap: 91000 });
    expect(state.deviceKey).toBe(KEY);
  });

  it("saves each step on its own", async () => {
    const r1 = await put({ recipients: [" Ana@Example.com", "ben@example.com", "ana@example.com"] });
    expect(r1.body.recipients).toEqual(["ana@example.com", "ben@example.com"]);
    expect(r1.body.schedule).toBeNull();

    const r2 = await put({ schedule, analysis });
    expect(r2.body).toMatchObject({ schedule, recipients: ["ana@example.com", "ben@example.com"], nextRunAt: "2026-10-28T23:00:00.000Z" });

    const r3 = await put({ recipients: ["carl@example.org"] });
    expect(r3.body).toMatchObject({ schedule, recipients: ["carl@example.org"], analysis });
  });

  it("will not start the schedule without recipients", async () => {
    const r = await put({ schedule, analysis });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Add at least one email first");
    expect((await put({ recipients: [] })).status).toBe(400);
    expect((await put({ recipients: ["nope"] })).status).toBe(400);
  });
});

describe("scheduled photo", () => {
  it("asks for the photo at the set time, emails it once, and ignores retries", async () => {
    await setUp();
    expect((await poll()).text).not.toContain("capture=");

    vi.setSystemTime(new Date("2026-10-28T23:00:20Z"));
    expect((await poll()).text).toBe(`poll=60\ncapture=${SLOT}\n`);

    expect(await upload(SLOT)).toEqual({ status: 200, text: "ok" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const message = vi.mocked(sendEmail).mock.calls[0][0];
    expect(message.to).toEqual(["ana@example.com", "ben@example.com"]);
    expect(message.subject).toMatch(/^Plant report · Thu 29 Oct 2026, 7:00 · /);
    expect(message.attachments?.map((a) => a.cid)).toEqual(["photo@plant-report", "overlay@plant-report"]);

    // Done: not asked again, and a retry of the same upload sends nothing.
    expect((await poll()).text).not.toContain("capture=");
    expect(await upload(SLOT)).toEqual({ status: 200, text: "duplicate" });
    expect(sendEmail).toHaveBeenCalledTimes(1);

    const { lastReport } = await getState();
    expect(lastReport).toMatchObject({ slotId: SLOT, state: "done", late: false, sentTo: ["ana@example.com", "ben@example.com"], emailError: null, baselinePct: 31 });
    expect(lastReport!.coverPct).toBeGreaterThan(0);
    expect(lastReport!.status).not.toBe("unknown");
  });

  it("takes a missed photo late, within 3 hours", async () => {
    await setUp();
    vi.setSystemTime(new Date("2026-10-29T01:30:00Z"));
    expect((await poll()).text).toContain(`capture=${SLOT}`);
    await upload(SLOT);
    expect((await getState()).lastReport).toMatchObject({ late: true });
    expect(vi.mocked(sendEmail).mock.calls[0][0].text).toContain("Late:");

    vi.setSystemTime(new Date("2026-10-30T02:30:00Z")); // 3.5 h after Friday's 07:00
    expect((await poll()).text).not.toContain("capture=");
  });

  it("does not photograph a time that passed before the schedule was saved", async () => {
    vi.setSystemTime(new Date("2026-10-28T23:30:00Z"));
    await setUp();
    expect((await poll()).text).not.toContain("capture=");
  });

  it("releases the slot when the analysis fails, so the camera tries again", async () => {
    await setUp();
    vi.setSystemTime(new Date("2026-10-28T23:00:20Z"));
    vi.mocked(cropGuideSquare).mockRejectedValueOnce(new Error("bad jpeg"));
    expect((await upload(SLOT)).status).toBe(500);
    expect(sendEmail).not.toHaveBeenCalled();
    expect((await poll()).text).toContain(`capture=${SLOT}`);
    expect(await upload(SLOT)).toEqual({ status: 200, text: "ok" });
  });

  it("keeps the report when the email fails", async () => {
    await setUp();
    vi.setSystemTime(new Date("2026-10-28T23:00:20Z"));
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("Invalid login"));
    expect(await upload(SLOT)).toEqual({ status: 200, text: "ok (email failed)" });
    expect((await getState()).lastReport).toMatchObject({ emailError: "Invalid login", sentTo: [] });
    expect((await poll()).text).not.toContain("capture=");
  });

  it("rejects photos nobody asked for", async () => {
    await setUp();
    expect((await upload("sched-2026-10-20T23:00:00.000Z")).status).toBe(409);
    expect((await upload("manual-1")).status).toBe(409);
    expect((await upload("../../etc")).status).toBe(400);
    vi.setSystemTime(new Date("2026-10-28T23:00:20Z"));
    expect((await upload(SLOT, new Uint8Array([1, 2, 3]))).status).toBe(415);
  });
});

describe("test buttons", () => {
  async function test(kind: string) {
    const res = await testRoute.POST(new Request(`${BASE}/api/automation/test`, { method: "POST", body: JSON.stringify({ kind }), headers: admin }));
    return { status: res.status, body: await res.json() };
  }

  it("sends a test email to the saved recipients", async () => {
    expect((await test("email")).status).toBe(400);
    await put({ recipients: ["ana@example.com"] });
    expect(await test("email")).toMatchObject({ status: 200, body: { sentTo: ["ana@example.com"] } });
    expect(vi.mocked(sendEmail).mock.calls[0][0].subject).toMatch(/^Test email · /);
  });

  it("takes a test photo at the next poll", async () => {
    await setUp();
    const { body } = await test("capture");
    expect(body.slotId).toBe(`manual-${Date.parse("2026-10-28T22:00:00Z")}`);
    expect((await getState()).captureNow).toBe(body.slotId);
    expect((await poll()).text).toContain(`capture=${body.slotId}`);
    expect(await upload(body.slotId)).toEqual({ status: 200, text: "ok" });
    expect(vi.mocked(sendEmail).mock.calls[0][0].subject).toMatch(/^Test photo · /);
    expect((await getState()).captureNow).toBeNull();
    expect((await poll()).text).not.toContain("capture=");
  });

  it("drops a test photo the camera did not pick up in time", async () => {
    await setUp();
    const { body } = await test("capture");
    vi.setSystemTime(new Date("2026-10-28T22:11:00Z"));
    expect((await poll()).text).not.toContain(body.slotId);
  });
});
