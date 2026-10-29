import { describe, expect, it } from "vitest";
import {
  ALL_DAYS,
  describeDays,
  describeSchedule,
  dueSlot,
  formatZoned,
  nextRunAt,
  recipientsSchema,
  scheduleSchema,
  slotId,
  slotTime,
  splitRecipients,
  zonedToUtc,
  type Schedule,
} from "@/lib/automation/schedule";

// 28 Oct 2026 is a Wednesday. Manila is UTC+8 all year; New York switches to EDT on 8 Mar 2026
// and back to EST on 1 Nov 2026.

const utc = (iso: string) => Date.parse(iso);
const manila = (patch: Partial<Schedule> = {}): Schedule => ({ enabled: true, days: [...ALL_DAYS], time: "07:00", timeZone: "Asia/Manila", ...patch });
const newYork = (patch: Partial<Schedule> = {}): Schedule => manila({ timeZone: "America/New_York", ...patch });

describe("zonedToUtc", () => {
  it("converts a fixed-offset zone", () => {
    expect(zonedToUtc({ year: 2026, month: 10, day: 29 }, "07:00", "Asia/Manila")).toBe(utc("2026-10-28T23:00:00Z"));
    expect(zonedToUtc({ year: 2026, month: 1, day: 1 }, "00:30", "Asia/Manila")).toBe(utc("2025-12-31T16:30:00Z"));
  });

  it("follows DST on both transition days", () => {
    expect(zonedToUtc({ year: 2026, month: 3, day: 7 }, "07:00", "America/New_York")).toBe(utc("2026-03-07T12:00:00Z"));
    expect(zonedToUtc({ year: 2026, month: 3, day: 8 }, "07:00", "America/New_York")).toBe(utc("2026-03-08T11:00:00Z"));
    expect(zonedToUtc({ year: 2026, month: 10, day: 31 }, "07:00", "America/New_York")).toBe(utc("2026-10-31T11:00:00Z"));
    expect(zonedToUtc({ year: 2026, month: 11, day: 1 }, "07:00", "America/New_York")).toBe(utc("2026-11-01T12:00:00Z"));
  });

  it("moves a skipped time forward and takes the first of a repeated one", () => {
    // 02:30 does not exist on 8 Mar (02:00 → 03:00): 03:30 EDT.
    expect(zonedToUtc({ year: 2026, month: 3, day: 8 }, "02:30", "America/New_York")).toBe(utc("2026-03-08T07:30:00Z"));
    // 01:30 happens twice on 1 Nov: the first is still EDT.
    expect(zonedToUtc({ year: 2026, month: 11, day: 1 }, "01:30", "America/New_York")).toBe(utc("2026-11-01T05:30:00Z"));
  });
});

describe("dueSlot", () => {
  it("is due from the set time until 3 hours later", () => {
    const at = utc("2026-10-28T23:00:00Z"); // Thu 29 Oct, 07:00 in Manila
    expect(dueSlot(manila(), at - 60_000)).toBeNull();
    expect(dueSlot(manila(), at)).toEqual({ id: "sched-2026-10-28T23:00:00.000Z", at });
    expect(dueSlot(manila(), at + 30_000)?.at).toBe(at);
    expect(dueSlot(manila(), at + 3 * 3600_000)?.at).toBe(at);
    expect(dueSlot(manila(), at + 3 * 3600_000 + 1000)).toBeNull();
  });

  it("only on the selected days", () => {
    const thu = utc("2026-10-28T23:00:30Z");
    expect(dueSlot(manila({ days: [1, 3, 5] }), thu)).toBeNull();
    expect(dueSlot(manila({ days: [4] }), thu)?.id).toBe("sched-2026-10-28T23:00:00.000Z");
  });

  it("finds yesterday's late slot after midnight", () => {
    // 23:30 Manila on Wed, checked at 01:00 Thu.
    expect(dueSlot(manila({ time: "23:30", days: [3] }), utc("2026-10-28T17:00:00Z"))?.id).toBe("sched-2026-10-28T15:30:00.000Z");
  });

  it("works in a DST zone", () => {
    expect(dueSlot(newYork(), utc("2026-11-01T12:00:30Z"))?.id).toBe("sched-2026-11-01T12:00:00.000Z");
    expect(dueSlot(newYork(), utc("2026-03-08T11:00:30Z"))?.id).toBe("sched-2026-03-08T11:00:00.000Z");
  });

  it("skips times before the schedule was saved", () => {
    const now = utc("2026-10-28T23:30:00Z");
    expect(dueSlot(manila(), now, utc("2026-10-28T23:10:00Z"))).toBeNull();
    expect(dueSlot(manila(), now, utc("2026-10-28T22:50:00Z"))?.at).toBe(utc("2026-10-28T23:00:00Z"));
  });

  it("is never due when off or with no days", () => {
    const now = utc("2026-10-28T23:00:30Z");
    expect(dueSlot(manila({ enabled: false }), now)).toBeNull();
    expect(dueSlot(manila({ days: [] }), now)).toBeNull();
  });
});

describe("nextRunAt", () => {
  it("returns the next set time across the week", () => {
    const now = utc("2026-10-28T23:00:30Z"); // Thu 07:00:30 Manila
    expect(nextRunAt(manila(), now)).toBe(utc("2026-10-29T23:00:00Z"));
    expect(nextRunAt(manila(), utc("2026-10-28T22:59:00Z"))).toBe(utc("2026-10-28T23:00:00Z"));
    expect(nextRunAt(manila({ days: [1] }), now)).toBe(utc("2026-11-01T23:00:00Z")); // Mon 2 Nov
    expect(nextRunAt(manila({ days: [4] }), now)).toBe(utc("2026-11-04T23:00:00Z")); // a week later
    expect(nextRunAt(newYork(), utc("2026-10-31T12:00:00Z"))).toBe(utc("2026-11-01T12:00:00Z"));
    expect(nextRunAt(manila({ enabled: false }), now)).toBeNull();
    expect(nextRunAt(manila({ days: [] }), now)).toBeNull();
  });
});

describe("slot ids and display", () => {
  it("round-trips slot ids", () => {
    const at = utc("2026-10-28T23:00:00Z");
    expect(slotTime(slotId(at))).toBe(at);
    expect(slotTime("manual-123")).toBeNull();
  });

  it("describes the days and time", () => {
    expect(describeDays([0, 1, 2, 3, 4, 5, 6])).toBe("Every day");
    expect(describeDays([1, 2, 3, 4, 5])).toBe("Weekdays");
    expect(describeDays([0, 6])).toBe("Weekends");
    expect(describeDays([5, 1, 3])).toBe("Mon, Wed, Fri");
    expect(describeDays([0, 1])).toBe("Mon, Sun");
    expect(describeSchedule({ days: [...ALL_DAYS], time: "07:00" })).toBe("Every day at 7:00");
    expect(formatZoned(utc("2026-10-28T23:00:00Z"), "Asia/Manila")).toBe("Thu 29 Oct 2026, 7:00");
    expect(formatZoned(utc("2026-10-28T23:05:00Z"), "Asia/Manila", { year: false })).toBe("Thu 29 Oct, 7:05");
  });
});

describe("schemas", () => {
  it("validates the schedule", () => {
    expect(scheduleSchema.parse({ enabled: true, days: [3, 1, 3], time: "07:00", timeZone: "Asia/Manila" }).days).toEqual([1, 3]);
    expect(scheduleSchema.safeParse({ enabled: true, days: [], time: "7:00", timeZone: "Asia/Manila" }).success).toBe(false);
    expect(scheduleSchema.safeParse({ enabled: true, days: [], time: "24:00", timeZone: "Asia/Manila" }).success).toBe(false);
    expect(scheduleSchema.safeParse({ enabled: true, days: [7], time: "07:00", timeZone: "Asia/Manila" }).success).toBe(false);
    expect(scheduleSchema.safeParse({ enabled: true, days: [], time: "07:00", timeZone: "Mars/Olympus" }).success).toBe(false);
  });

  it("cleans up the recipients", () => {
    expect(splitRecipients(" Ana@Example.com, ben@example.com;\n\ncarl@example.org ")).toEqual(["Ana@Example.com", "ben@example.com", "carl@example.org"]);
    expect(recipientsSchema.parse([" Ana@Example.com ", "ana@example.com", "ben@example.com"])).toEqual(["ana@example.com", "ben@example.com"]);
    expect(recipientsSchema.safeParse([]).success).toBe(false);
    expect(recipientsSchema.safeParse(["not-an-email"]).success).toBe(false);
    expect(recipientsSchema.safeParse(Array.from({ length: 21 }, (_, i) => `p${i}@example.com`)).success).toBe(false);
    expect(recipientsSchema.safeParse(Array.from({ length: 20 }, (_, i) => `p${i}@example.com`)).success).toBe(true);
  });
});
