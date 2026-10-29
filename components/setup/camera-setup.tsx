"use client";

import { Bluetooth, BluetoothOff, Loader2, RefreshCw, Send, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { esp32Camera } from "@/lib/ble/esp32-camera";
import { firmwareAtLeast, firmwareMajor, INTERVAL_FIRMWARE, TELEGRAM_FIRMWARE, type DeviceStatus } from "@/lib/ble/protocol";
import { describeSchedule, formatUtcOffset } from "@/lib/schedule";
import { ScheduleStep } from "./schedule-step";
import { cameraError, errorMessage, StepRow, useCamera, useMounted } from "./shared";
import { TelegramStep } from "./telegram-step";
import { WifiStep } from "./wifi-step";

// The whole web app: set the PlantCam up over Bluetooth, in three steps, in order:
//   1. WiFi (the camera needs the internet to reach Telegram)
//   2. The Telegram bot and the chat that gets the reports
//   3. Days and time of the report
// Everything is saved on the camera, which then takes the photo, analyzes it and sends the report
// by itself; this page shows what the camera reports in its Info.

type StepId = 1 | 2 | 3;

const REPORT_PROGRESS: Partial<Record<DeviceStatus["state"], string>> = {
  capturing: "Taking the photo…",
  analyzing: "Analyzing the photo…",
  sending: "Sending to Telegram…",
};

function ConnectCard() {
  const cam = useCamera();
  const [error, setError] = useState<string | null>(null);
  const connecting = cam.connection === "connecting";

  async function connect(another = false) {
    setError(null);
    try {
      if (!another && cam.deviceName) await esp32Camera.connect();
      else await esp32Camera.pick();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect the camera</CardTitle>
        <CardDescription>Power the PlantCam and stay within a few metres of it. The setup uses Bluetooth.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => connect()} disabled={connecting}>
            {connecting ? <Loader2 className="animate-spin" /> : <Bluetooth />}
            {connecting ? "Connecting…" : cam.deviceName ? `Reconnect to ${cam.deviceName}` : "Connect camera"}
          </Button>
          {cam.deviceName && !connecting && (
            <Button variant="ghost" onClick={() => connect(true)}>
              Choose another camera
            </Button>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="text-sm text-muted-foreground">
          <p>Pick PlantCam-XXXX in the browser&apos;s list. You will also need:</p>
          <ul className="mt-1 list-inside list-disc">
            <li>the name and password of a 2.4 GHz WiFi with internet, near the camera</li>
            <li>Telegram on your phone or computer, to create the bot that sends the reports</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

export function CameraSetup() {
  const mounted = useMounted();
  const cam = useCamera();
  const [editing, setEditing] = useState<StepId | null>(null);
  const [testing, setTesting] = useState(false);

  if (!mounted) return null;

  if (!cam.supported) {
    return (
      <Alert>
        <Bluetooth />
        <AlertTitle>This browser cannot connect to the camera</AlertTitle>
        <AlertDescription>The setup uses Bluetooth: open this page in Chrome or Edge on Android, Windows or macOS (not on an iPhone).</AlertDescription>
      </Alert>
    );
  }

  const info = cam.connection === "connected" ? cam.info : null;
  if (!info) return <ConnectCard />;

  const canSave = firmwareMajor(info.firmware) >= TELEGRAM_FIRMWARE;
  const done: Record<StepId, boolean> = { 1: info.wifi, 2: info.telegram, 3: !!info.schedule };
  const firstOpen = ([1, 2, 3] as const).find((n) => !done[n]) ?? null;
  const active: StepId | null = editing ?? firstOpen;
  const stepState = (n: StepId): "done" | "active" | "locked" => {
    if (n === active) return "active";
    const earlierDone = ([1, 2, 3] as const).filter((m) => m < n).every((m) => done[m]);
    return done[n] && earlierDone ? "done" : "locked";
  };
  const change = (n: StepId) => (cam.busy ? undefined : () => setEditing(n));
  const cancel = (n: StepId) => (done[n] ? () => setEditing(null) : undefined);
  const finish = () => setEditing(null);

  async function refresh() {
    try {
      await esp32Camera.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function testReport() {
    setTesting(true);
    try {
      await esp32Camera.sendReport();
      toast.success("Report sent. Check Telegram.");
    } catch (e) {
      toast.error(cameraError(e));
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1.5">
            <CardTitle>{cam.deviceName}</CardTitle>
            <CardDescription>Connected over Bluetooth · firmware {info.firmware}</CardDescription>
          </div>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={refresh} disabled={cam.busy}>
              <RefreshCw /> Refresh
            </Button>
            <Button variant="ghost" size="sm" onClick={() => esp32Camera.disconnect()} disabled={cam.busy}>
              <BluetoothOff /> Disconnect
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {!info.camera && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>The camera module did not start</AlertTitle>
            <AlertDescription>Check the ribbon cable, then restart the board. Reports need a working camera.</AlertDescription>
          </Alert>
        )}
        {!canSave && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Firmware {info.firmware} cannot send Telegram reports</AlertTitle>
            <AlertDescription>
              Flash firmware {TELEGRAM_FIRMWARE} or newer (README → Flash the firmware), then connect again. The WiFi step already works.
            </AlertDescription>
          </Alert>
        )}

        <ol className="space-y-5">
          <StepRow
            n={1}
            title="WiFi"
            state={stepState(1)}
            onChange={change(1)}
            changeLabel="Change WiFi"
            summary={
              <span>
                On “{info.ssid}”{info.ip ? ` · IP ${info.ip}` : ""}
                {info.rssi != null ? ` · signal ${info.rssi} dBm` : ""}
              </span>
            }
          >
            <WifiStep info={info} onDone={finish} onCancel={cancel(1)} />
          </StepRow>

          <StepRow
            n={2}
            title="Telegram"
            state={stepState(2)}
            onChange={change(2)}
            changeLabel="Change chat"
            summary={<span>Reports go to {info.telegramLabel ?? "the saved chat"}</span>}
          >
            <TelegramStep canSave={canSave} onDone={finish} onCancel={cancel(2)} />
          </StepRow>

          <StepRow
            n={3}
            title="When to send the report"
            state={stepState(3)}
            onChange={change(3)}
            summary={info.schedule && <span>{`${describeSchedule(info.schedule)} (${formatUtcOffset(info.schedule.utcOffset)})`}</span>}
          >
            <ScheduleStep current={info.schedule} canSave={canSave} intervals={firmwareAtLeast(info.firmware, INTERVAL_FIRMWARE)} onDone={finish} onCancel={cancel(3)} />
          </StepRow>
        </ol>

        {firstOpen == null && editing == null && info.schedule && (
          <div className="space-y-3 rounded-lg border bg-muted/40 p-3">
            <p className="text-sm">
              All set. {describeSchedule(info.schedule)}, the camera takes 3 photos, measures the leaves and sends the result to {info.telegramLabel ?? "Telegram"}. You can
              disconnect and close this page: the camera works on its own.
            </p>
            {!info.clock && (
              <p className="text-xs text-destructive">
                The camera does not have the time yet, so it cannot follow the schedule. It gets it from the internet once it is on WiFi; press Refresh in a moment.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={testReport} disabled={cam.busy}>
                {testing ? <Loader2 className="animate-spin" /> : <Send />}
                {testing ? (cam.status && REPORT_PROGRESS[cam.status.state]) || "Starting…" : "Send a test report now"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => esp32Camera.disconnect()} disabled={cam.busy}>
                <BluetoothOff /> Done, disconnect
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
