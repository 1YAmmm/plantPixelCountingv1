import { Analyzer } from "@/components/analyzer/analyzer";
import { PageHeader } from "@/components/page-header";

export default function AnalyzePage() {
  return (
    <>
      <PageHeader
        title="Analyze a plant"
        description="Frame the plant in the square, with the phone held flat or the ESP32-CAM mounted above it. Green pixels are counted as leaf cover of the square."
      />
      <Analyzer />
    </>
  );
}
