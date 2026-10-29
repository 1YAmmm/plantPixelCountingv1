import { describe, expect, it } from "vitest";
import { describeDays, describeEvery, describeSchedule, EVERY_HOURS, EVERY_MINUTES, formatTime, formatUtcOffset, localUtcOffset } from "@/lib/schedule";

describe("report schedule display", () => {
  it("describes days and time on a 12-hour clock", () => {
    expect(describeDays([0, 1, 2, 3, 4, 5, 6])).toBe("Every day");
    expect(describeDays([1, 2, 3, 4, 5])).toBe("Weekdays");
    expect(describeDays([0, 6])).toBe("Weekends");
    expect(describeDays([0, 1, 3])).toBe("Mon, Wed, Sun");
    expect(describeDays([])).toBe("No days");
    expect(formatTime("07:05")).toBe("7:05 AM");
    expect(formatTime("00:15")).toBe("12:15 AM");
    expect(formatTime("12:00")).toBe("12:00 PM");
    expect(formatTime("23:59")).toBe("11:59 PM");
    expect(describeSchedule({ days: [1, 5], time: "18:30" })).toBe("Mon, Fri at 6:30 PM");
  });

  it("describes reports every few minutes or hours", () => {
    expect(describeEvery(1)).toBe("Every minute");
    expect(describeEvery(30)).toBe("Every 30 minutes");
    expect(describeEvery(60)).toBe("Every hour");
    expect(describeEvery(720)).toBe("Every 12 hours");
    expect(describeSchedule({ days: [0, 1, 2, 3, 4, 5, 6], time: "00:00", everyMinutes: 120 })).toBe("Every 2 hours");
    // Each divides a day, so the reports fall on the same clock times every day.
    for (const m of [...EVERY_MINUTES, ...EVERY_HOURS.map((h) => h * 60)]) expect(1440 % m).toBe(0);
  });

  it("formats UTC offsets", () => {
    expect(formatUtcOffset(480)).toBe("UTC+8");
    expect(formatUtcOffset(330)).toBe("UTC+5:30");
    expect(formatUtcOffset(-180)).toBe("UTC−3");
    expect(formatUtcOffset(-570)).toBe("UTC−9:30");
    expect(formatUtcOffset(0)).toBe("UTC+0");
  });

  it("reads this device's offset east of UTC", () => {
    expect(localUtcOffset({ getTimezoneOffset: () => -480 } as Date)).toBe(480);
    expect(localUtcOffset({ getTimezoneOffset: () => 300 } as Date)).toBe(-300);
    expect(localUtcOffset({ getTimezoneOffset: () => 0 } as Date)).toBe(0);
  });
});
