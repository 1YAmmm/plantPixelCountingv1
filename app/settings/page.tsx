import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { SettingsEditor } from "@/components/settings/settings-editor";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Adjust what counts as leaf and the wilting thresholds. Saved in this browser only." />
      <SettingsEditor />
    </>
  );
}
