"use client";

import { Loader2, Wifi } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { esp32Camera } from "@/lib/ble/esp32-camera";
import type { DeviceInfo } from "@/lib/ble/protocol";
import { cameraError } from "./shared";

function wifiError(e: unknown, ssid: string): string {
  const message = cameraError(e);
  if (/^network not found$/i.test(message)) {
    return `The camera cannot find “${ssid}”. Check the name (capital letters count) and that it is a 2.4 GHz network in range of the camera, then try again.`;
  }
  if (/^wrong password$/i.test(message)) return "Wrong WiFi password.";
  if (/^timeout$/i.test(message)) return `The camera could not join “${ssid}” in time. Try again.`;
  return message;
}

export function WifiStep({ info, onDone, onCancel }: { info: DeviceInfo; onDone: () => void; onCancel?: () => void }) {
  const [ssid, setSsid] = useState(info.ssid ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const name = ssid.trim();
    setBusy(true);
    setError(null);
    try {
      const next = await esp32Camera.setupWifi({ ssid: name, password });
      setPassword("");
      toast.success(`The camera is on “${name}”${next?.ip ? ` (IP ${next.ip})` : ""}`);
      onDone();
    } catch (err) {
      setError(wifiError(err, name));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="grid gap-3">
      {info.ssid && !info.wifi && <p className="text-sm text-muted-foreground">“{info.ssid}” is saved, but the camera is not on it now.</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="wifi-ssid">WiFi name</Label>
          <Input id="wifi-ssid" value={ssid} onChange={(e) => setSsid(e.target.value)} autoComplete="off" maxLength={32} required className="pointer-coarse:h-10" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="wifi-pass">WiFi password</Label>
          <Input
            id="wifi-pass"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            maxLength={63}
            className="pointer-coarse:h-10"
          />
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-2">
          2.4 GHz WiFi only: the camera cannot join 5 GHz-only networks. It needs internet access to send the reports.
        </p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !ssid.trim()}>
          {busy ? <Loader2 className="animate-spin" /> : <Wifi />}
          {busy ? "Connecting the camera…" : "Save and connect"}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
