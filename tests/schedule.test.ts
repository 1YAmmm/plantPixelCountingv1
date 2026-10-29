import { describe, expect, it } from "vitest";
import { describeDays, describeSchedule, formatTime, formatUtcOffset, localUtcOffset } from "@/lib/schedule";

describe("report schedule display", () => {
  it("describes days and time", () => {
    expect(describeDays([0, 1, 2, 3, 4, 5, 6])).toBe("Every day");
    expect(describeDays([1, 2, 3, 4, 5])).toBe("Weekdays");
    expect(describeDays([0, 6])).toBe("Weekends");
    expect(describeDays([0, 1, 3])).toBe("Mon, Wed, Sun");
    expect(describeDays([])).toBe("No days");
    expect(formatTime("07:05")).toBe("7:05");
    expect(describeSchedule({ days: [1, 5], time: "18:30" })).toBe("Mon, Fri at 18:30");
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
