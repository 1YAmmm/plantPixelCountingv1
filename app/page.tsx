import { Analyzer } from "@/components/analyzer/analyzer";
import { PageHeader } from "@/components/page-header";

export default function AnalyzePage() {
  return (
    <>
      <PageHeader
        title="Analyze a plant"
        description="Frame the plant in the square and hold the phone flat. Green pixels are counted as leaf cover of the square."
      />
      <Analyzer />
    </>
  );
}
