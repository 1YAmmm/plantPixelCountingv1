import { PageHeader } from "@/components/page-header";
import { CameraSetup } from "@/components/setup/camera-setup";

export default function SetupPage() {
  return (
    <>
      <PageHeader
        title="Set up the plant camera"
        description="Put the PlantCam on WiFi and choose the Telegram chat for its reports. After that the camera takes the photo, analyzes it and sends the report by itself."
      />
      <CameraSetup />
    </>
  );
}
