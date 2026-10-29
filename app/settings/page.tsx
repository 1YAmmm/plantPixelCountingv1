import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { DailyReport } from "@/components/settings/daily-report";
import { SettingsEditor } from "@/components/settings/settings-editor";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="The daily email report is saved on the server. What counts as leaf and the wilting thresholds are saved in this browser only; the report uses a copy of them."
      />
      <div className="space-y-8">
        <DailyReport />
        <SettingsEditor />
      </div>
    </>
  );
}
