import { describe, expect, it } from "vitest";
import { buildReport, escapeHtml, OVERLAY_CID, PHOTO_CID, renderReportEmail } from "@/lib/automation/report";
import { DEFAULT_DETECTION_SETTINGS } from "@/lib/detection/settings";

const thresholds = DEFAULT_DETECTION_SETTINGS; // mild from 10%, wilting from 25%, discoloration note from 15%
const analysis = (coveragePct: number, issues: string[] = [], discolorationPct = 2) => ({
  metrics: { coveragePct, discolorationPct },
  issues: issues.map((message) => ({ message })),
});
const takenAt = Date.parse("2026-10-28T23:00:40Z");

describe("buildReport", () => {
  it("compares the leaf cover with the baseline", () => {
    const baseline = { thresholds, baselineCoverPcts: [39, 40, 41] };
    expect(buildReport(analysis(38), baseline)).toMatchObject({ status: "healthy", baselinePct: 40, valid: true });
    expect(buildReport(analysis(36), baseline)).toMatchObject({ status: "mild", wilt: 10 });
    expect(buildReport(analysis(28), baseline)).toMatchObject({ status: "wilting", wilt: 30 });
    const grown = buildReport(analysis(44), baseline);
    expect(grown.status).toBe("healthy");
    expect(grown.wilt).toBeCloseTo(-10);
  });

  it("is unknown without a baseline", () => {
    expect(buildReport(analysis(30), { thresholds, baselineCoverPcts: [] })).toMatchObject({ status: "unknown", wilt: null, baselinePct: null, valid: true });
  });

  it("is unknown when the photo failed a check, and says why", () => {
    const r = buildReport(analysis(20, ["Too dark (12% brightness)"], 30), { thresholds, baselineCoverPcts: [40] });
    expect(r).toMatchObject({ status: "unknown", valid: false, issues: ["Too dark (12% brightness)"], discolored: false });
  });

  it("flags discoloration above the threshold", () => {
    expect(buildReport(analysis(40, [], 20), { thresholds, baselineCoverPcts: [40] }).discolored).toBe(true);
  });
});

describe("renderReportEmail", () => {
  it("contains the status, the numbers and the inline images", () => {
    const report = buildReport(analysis(36, [], 3.25), { thresholds, baselineCoverPcts: [40] });
    const email = renderReportEmail(report, { takenAt, timeZone: "Asia/Manila", late: false, images: true });
    expect(email.subject).toBe("Plant report · Thu 29 Oct 2026, 7:00 · Mild Wilting");
    for (const part of [email.html, email.text]) {
      expect(part).toContain("Mild Wilting");
      expect(part).toContain("10.0%");
      expect(part).toContain("36.0%");
      expect(part).toContain("3.3%");
      expect(part).toContain("40.0%");
    }
    expect(email.html).toContain(`cid:${PHOTO_CID}`);
    expect(email.html).toContain(`cid:${OVERLAY_CID}`);
  });

  it("explains photo problems and late photos, escaping the text", () => {
    const report = buildReport(analysis(20, ['Too dark <script>alert("x")</script>']), { thresholds, baselineCoverPcts: [40] });
    const email = renderReportEmail(report, {
      takenAt: Date.parse("2026-10-29T01:10:00Z"),
      timeZone: "Asia/Manila",
      late: true,
      scheduledAt: Date.parse("2026-10-28T23:00:00Z"),
      images: false,
    });
    expect(email.subject).toContain("Unknown");
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("Too dark &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(email.html).toContain("Status not computed");
    expect(email.html).toContain("was due at Thu 29 Oct, 7:00");
    expect(email.html).not.toContain("cid:");
    expect(email.text).toContain("Late:");
  });

  it("marks test emails and missing baselines", () => {
    const report = buildReport(analysis(30), { thresholds, baselineCoverPcts: [] });
    const email = renderReportEmail(report, { takenAt, timeZone: "Asia/Manila", late: false, images: false, test: true });
    expect(email.subject.startsWith("Test email · ")).toBe(true);
    expect(email.text).toContain("No baseline yet");
  });

  it("escapes HTML", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});
