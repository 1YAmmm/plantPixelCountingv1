"use client";

import { Bluetooth, Camera, Check, Loader2, LogOut, Mail, RefreshCw, Send, TriangleAlert, Wifi } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { AnalysisSnapshot, AutomationState, AutomationUpdate, ReportSummary } from "@/lib/automation/config";
import { ALL_DAYS, DAY_NAMES, describeSchedule, formatZoned, MAX_RECIPIENTS, recipientsSchema, splitRecipients, WEEK_ORDER, type Schedule } from "@/lib/automation/schedule";
import { esp32Camera } from "@/lib/ble/esp32-camera";
import { baselineStores, thresholdStore, useBaseline, visionSettingsStore } from "@/lib/browser/store";
import { formatDateTime, formatPct } from "@/lib/format";

// newplan.md step 6: the daily photo + email report, set up once in three steps, in order:
//   1. Camera WiFi (over Bluetooth; skipped when the server already hears from the camera)
//   2. Email recipients
//   3. Days and time
// Everything here is saved on the server (app/api/automation), unlike the rest of this page.

type StepId = 1 | 2 | 3;

interface WifiWait {
  /** device.lastSeenAt before the setup; any newer poll means the camera checked in. */
  prevLastSeen: string | null;
  startedAt: number;
  ip: string | null;
}

interface PhotoWait {
  slotId: string;
  startedAt: number;
}

/** Without a check-in after this long, the likely causes are shown. */
const CHECK_IN_HINT_MS = 2 * 60 * 1000;
/** The server drops a test photo the camera did not pick up within 10 minutes. */
const PHOTO_WAIT_MS = 11 * 60 * 1000;
/** The camera polls every minute; quiet for longer than this means offline. */
const OFFLINE_AFTER_MS = 5 * 60 * 1000;

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function subscribeClock(onChange: () => void) {
  const id = setInterval(onChange, 10_000);
  return () => clearInterval(id);
}

/** The time, updated every 10 s, for "last seen 40 s ago". */
function useNow(): number {
  return useSyncExternalStore(
    subscribeClock,
    () => Math.floor(Date.now() / 10_000) * 10_000,
    () => 0,
  );
}

function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** JSON with sorted keys, to compare settings regardless of key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** This browser's analysis settings and ESP32 baseline, as copied to the server. */
function browserAnalysis(): AnalysisSnapshot {
  return {
    vision: visionSettingsStore.read(),
    thresholds: thresholdStore.read(),
    baselineCoverPcts: baselineStores.esp32.read().samples.map((s) => s.coverPct),
    copiedAt: new Date().toISOString(),
  };
}

function firmwareMajor(version: string): number {
  const n = Number.parseInt(version, 10);
  return Number.isFinite(n) ? n : 0;
}

function cameraError(e: unknown): string {
  const message = errorMessage(e).replace(/^ESP32-CAM: /, "");
  if (message === "unknown command") return "The camera's firmware is too old. Flash firmware 2.0 (README → Flash the firmware), then try again.";
  return message.charAt(0).toUpperCase() + message.slice(1);
}

function isLocalHost(url: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

const textareaClass =
  "min-h-24 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive md:text-sm dark:bg-input/30";

function StepRow({
  n,
  title,
  state,
  summary,
  onChange,
  changeLabel = "Change",
  children,
}: {
  n: StepId;
  title: string;
  state: "done" | "active" | "locked";
  summary?: ReactNode;
  onChange?: () => void;
  changeLabel?: string;
  children?: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
          state === "done" && "bg-healthy/15 text-healthy",
          state === "active" && "bg-primary text-primary-foreground",
          state === "locked" && "bg-muted text-muted-foreground",
        )}
        aria-hidden
      >
        {state === "done" ? <Check className="size-4" /> : n}
      </span>
      <div className="min-w-0 flex-1 space-y-3 pt-0.5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h3 className={cn("font-medium", state === "locked" && "text-muted-foreground")}>
            <span className="sr-only">Step {n}: </span>
            {title}
          </h3>
          {state === "done" && onChange && (
            <Button variant="ghost" size="sm" onClick={onChange}>
              {changeLabel}
            </Button>
          )}
        </div>
        {state === "done" && summary && <div className="text-sm text-muted-foreground">{summary}</div>}
        {state === "locked" && <p className="text-sm text-muted-foreground">Finish step {n - 1} first.</p>}
        {state === "active" && children}
      </div>
    </li>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/automation/session", { method: "POST", body: { password } });
      setPassword("");
      onSignedIn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid max-w-sm gap-2">
      <Label htmlFor="admin-password">Admin password</Label>
      <div className="flex gap-2">
        <Input
          id="admin-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={!!error}
          className="pointer-coarse:h-10"
        />
        <Button type="submit" disabled={busy || !password}>
          {busy && <Loader2 className="animate-spin" />} Sign in
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">The ADMIN_PASSWORD set on the server. It protects the recipients and the client&apos;s Gmail.</p>
    </form>
  );
}

function WifiStep({
  state,
  wait,
  now,
  onSaved,
  onCancel,
}: {
  state: AutomationState;
  wait: WifiWait | null;
  now: number;
  onSaved: (ip: string | null) => void;
  onCancel?: () => void;
}) {
  const cam = useSyncExternalStore(esp32Camera.subscribe, esp32Camera.getSnapshot, esp32Camera.getServerSnapshot);
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [server, setServer] = useState(() => window.location.origin);
  const [otherWifi, setOtherWifi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = cam.connection === "connected";
  const info = connected ? cam.info : null;
  const oldFirmware = info != null && firmwareMajor(info.firmware) < 2;
  const keepWifi = !!info?.wifi && !otherWifi;
  const serverValid = /^https?:\/\/[^\s/]+/i.test(server.trim());
  const localServer = isLocalHost(server);

  async function connect() {
    setError(null);
    try {
      if (cam.deviceName && cam.connection === "disconnected") await esp32Camera.connect();
      else await esp32Camera.pick();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!state.deviceKey) return;
    setBusy(true);
    setError(null);
    try {
      const target = server.trim().replace(/\/+$/, "");
      const { ip } = await esp32Camera.setupWifi(keepWifi ? { server: target, key: state.deviceKey } : { ssid, password, server: target, key: state.deviceKey });
      setPassword("");
      // Bluetooth is not needed any more, and WiFi gets the radio to itself.
      esp32Camera.disconnect();
      onSaved(ip);
    } catch (err) {
      setError(cameraError(err));
    } finally {
      setBusy(false);
    }
  }

  if (wait) {
    const slow = now - wait.startedAt > CHECK_IN_HINT_MS;
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
          Connected{wait.ip ? `, IP ${wait.ip}` : ""}. Waiting for the camera to check in with the server…
        </p>
        {slow && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>The camera has not checked in yet</AlertTitle>
            <AlertDescription>
              <ul className="list-inside list-disc">
                <li>The server address is wrong (the camera cannot use “localhost”: use this computer&apos;s network address).</li>
                <li>The server cannot be reached from the camera&apos;s WiFi (another network, or a firewall).</li>
                <li>The device key does not match the server&apos;s DEVICE_API_KEY.</li>
              </ul>
              The camera&apos;s serial monitor (115200 baud) shows each attempt.
            </AlertDescription>
          </Alert>
        )}
      </div>
    );
  }

  if (!cam.supported) {
    return (
      <Alert>
        <Bluetooth />
        <AlertTitle>WiFi setup uses Bluetooth</AlertTitle>
        <AlertDescription>Open this page in Chrome or Edge (Android, Windows or macOS) near the camera, then come back to this step.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      {!state.deviceKey && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>DEVICE_API_KEY is not set on the server</AlertTitle>
          <AlertDescription>Add it to the environment variables (a long random string), restart or redeploy, then reload this page.</AlertDescription>
        </Alert>
      )}
      {!connected ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={connect} disabled={cam.connection === "connecting"}>
            {cam.connection === "connecting" ? <Loader2 className="animate-spin" /> : <Bluetooth />}
            {cam.connection === "connecting" ? "Connecting…" : "Connect camera"}
          </Button>
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <p className="w-full text-xs text-muted-foreground">Power the camera and stay near it. Pick PlantCam-XXXX in the browser&apos;s list.</p>
        </div>
      ) : oldFirmware ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Firmware {info.firmware} has no WiFi</AlertTitle>
          <AlertDescription>Flash firmware 2.0 (README → Flash the firmware), then connect again.</AlertDescription>
        </Alert>
      ) : (
        <form onSubmit={save} className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            Connected to {cam.deviceName ?? "the camera"}.{" "}
            {info?.wifi ? (
              <>
                It is on WiFi “{info.ssid}”{info.ip ? ` (IP ${info.ip})` : ""}.{" "}
                <button type="button" className="underline underline-offset-3 hover:text-foreground" onClick={() => setOtherWifi((v) => !v)}>
                  {otherWifi ? "Keep this WiFi" : "Use another WiFi"}
                </button>
              </>
            ) : (
              "It is not on WiFi yet."
            )}
          </p>
          {!keepWifi && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="wifi-ssid">WiFi name</Label>
                <Input id="wifi-ssid" value={ssid} onChange={(e) => setSsid(e.target.value)} autoComplete="off" maxLength={32} required className="pointer-coarse:h-10" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="wifi-pass">WiFi password</Label>
                <Input id="wifi-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" maxLength={63} className="pointer-coarse:h-10" />
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-2">2.4 GHz WiFi only: the camera cannot join 5 GHz-only networks.</p>
            </div>
          )}
          <details className="text-sm" open={localServer}>
            <summary className="cursor-pointer text-muted-foreground">Advanced</summary>
            <div className="mt-2 grid gap-1.5">
              <Label htmlFor="wifi-server">Server address</Label>
              <Input id="wifi-server" value={server} onChange={(e) => setServer(e.target.value)} aria-invalid={!serverValid || localServer} className="pointer-coarse:h-10" />
              <p className={cn("text-xs", localServer ? "text-destructive" : "text-muted-foreground")}>
                {localServer
                  ? "The camera cannot reach localhost. Use this computer's network address, for example http://192.168.1.10:3000."
                  : "Where the camera sends its photos. Normally this site's address."}
              </p>
            </div>
          </details>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !state.deviceKey || !serverValid || localServer || (!keepWifi && !ssid.trim())}>
              {busy ? <Loader2 className="animate-spin" /> : <Wifi />}
              {busy ? "Connecting the camera…" : keepWifi ? "Save" : "Save WiFi"}
            </Button>
            {onCancel && (
              <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
      {!connected && error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function EmailStep({ state, onSaved, onCancel }: { state: AutomationState; onSaved: (next: AutomationState) => void; onCancel?: () => void }) {
  const [text, setText] = useState(() => state.recipients.join("\n"));
  const [busy, setBusy] = useState(false);
  const entries = splitRecipients(text);
  const parsed = recipientsSchema.safeParse(entries);
  const invalid = entries.filter((e) => !recipientsSchema.safeParse([e]).success);
  const problem = entries.length === 0 ? null : invalid.length ? `Not valid: ${invalid.join(", ")}` : !parsed.success ? parsed.error.issues[0]?.message : null;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!parsed.success) return;
    setBusy(true);
    try {
      const next = await api<AutomationState>("/api/automation", { method: "PUT", body: { recipients: parsed.data } satisfies AutomationUpdate });
      toast.success(`Saved ${next.recipients.length} email${next.recipients.length === 1 ? "" : "s"}`);
      onSaved(next);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="grid gap-2">
      <Label htmlFor="recipients">Send the results to</Label>
      <textarea
        id="recipients"
        className={textareaClass}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"ana@example.com\nben@example.com"}
        aria-invalid={!!problem}
        spellCheck={false}
        autoCapitalize="off"
      />
      <p className={cn("text-xs", problem ? "text-destructive" : "text-muted-foreground")}>
        {problem ?? `One per line or separated by commas, up to ${MAX_RECIPIENTS}. Everyone gets the same email.`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !parsed.success}>
          {busy ? <Loader2 className="animate-spin" /> : <Mail />} Save emails
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

function TimeStep({ state, onSaved, onCancel }: { state: AutomationState; onSaved: (next: AutomationState) => void; onCancel?: () => void }) {
  const [days, setDays] = useState<number[]>(() => state.schedule?.days ?? [...ALL_DAYS]);
  const [time, setTime] = useState(() => state.schedule?.time ?? "07:00");
  const [busy, setBusy] = useState(false);
  const { samples } = useBaseline("esp32");
  const timeZone = browserTimeZone();
  const everyDay = days.length === 7;
  const running = !!state.schedule?.enabled;

  function toggleDay(day: number) {
    setDays((d) => (d.includes(day) ? d.filter((x) => x !== day) : [...d, day].sort((a, b) => a - b)));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const schedule: Schedule = { enabled: true, days, time, timeZone };
      const next = await api<AutomationState>("/api/automation", { method: "PUT", body: { schedule, analysis: browserAnalysis() } satisfies AutomationUpdate });
      toast.success(`Daily report on: ${describeSchedule(schedule)}`);
      onSaved(next);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="grid gap-4">
      <div className="grid gap-2">
        <label className="flex w-fit items-center gap-2 text-sm font-medium">
          <Switch checked={everyDay} onCheckedChange={(on) => setDays(on ? [...ALL_DAYS] : [])} />
          Every day
        </label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
          {WEEK_ORDER.map((day) => {
            const on = days.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-pressed={on}
                onClick={() => toggleDay(day)}
                className={cn(
                  "h-8 min-w-11 rounded-lg border px-2 text-sm transition-colors pointer-coarse:h-10",
                  on ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted",
                )}
              >
                {DAY_NAMES[day]}
              </button>
            );
          })}
        </div>
        {days.length === 0 && <p className="text-xs text-destructive">Pick at least one day.</p>}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="report-time">Time</Label>
        <Input id="report-time" type="time" value={time} onChange={(e) => e.target.value && setTime(e.target.value)} required className="w-32 pointer-coarse:h-10" />
        <p className="text-xs text-muted-foreground">Time zone {timeZone} (this device). The photo is taken within about a minute of this time.</p>
      </div>
      {samples.length === 0 && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>No ESP32-CAM baseline in this browser</AlertTitle>
          <AlertDescription>
            The status will be “Unknown” until there is one: take 3 healthy photos with the ESP32-CAM on the Analyze page, then copy the settings again here. The
            numbers are still sent.
          </AlertDescription>
        </Alert>
      )}
      <p className="text-xs text-muted-foreground">Saving also copies this browser&apos;s leaf colours, thresholds and ESP32-CAM baseline to the server.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || days.length === 0}>
          {busy ? <Loader2 className="animate-spin" /> : <Check />} {running ? "Save" : "Start daily report"}
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

function LastReport({ report, timeZone }: { report: ReportSummary; timeZone: string }) {
  if (report.state === "processing") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Loader2 className="size-3.5 animate-spin" /> Analyzing the photo from {formatZoned(Date.parse(report.receivedAt), timeZone, { year: false })}…
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
      Last report {formatZoned(Date.parse(report.receivedAt), timeZone, { year: false })}
      <StatusBadge status={report.status} size="sm" />
      {report.emailError ? (
        <span className="text-destructive">email failed: {report.emailError}</span>
      ) : (
        <span>
          (sent to {report.sentTo.length}
          {report.late ? ", late" : ""})
        </span>
      )}
    </span>
  );
}

export function DailyReport() {
  const [state, setState] = useState<AutomationState | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [auth, setAuth] = useState<"loading" | "signed-out" | "signed-in" | "unavailable">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StepId | null>(null);
  const [wifiWait, setWifiWait] = useState<WifiWait | null>(null);
  const [photoWait, setPhotoWait] = useState<PhotoWait | null>(null);
  const [busy, setBusy] = useState<"test-email" | "test-photo" | "toggle" | "copy" | null>(null);
  // Mirrors of the waits for refresh(), which runs from timers.
  const waits = useRef<{ wifi: WifiWait | null; photo: PhotoWait | null }>({ wifi: null, photo: null });
  const now = useNow();
  const vision = visionSettingsStore.useValue();
  const thresholds = thresholdStore.useValue();
  const { samples } = useBaseline("esp32");

  const startWifiWait = (w: WifiWait | null) => {
    waits.current.wifi = w;
    setWifiWait(w);
  };
  const startPhotoWait = (w: PhotoWait | null) => {
    waits.current.photo = w;
    setPhotoWait(w);
  };

  const accept = useCallback((s: AutomationState) => {
    setState(s);
    setFetchedAt(Date.now());
    setAuth("signed-in");
    setLoadError(null);
    const wifi = waits.current.wifi;
    if (wifi && s.device && s.device.lastSeenAt !== wifi.prevLastSeen) {
      waits.current.wifi = null;
      setWifiWait(null);
      setEditing(null);
      toast.success("The camera is on WiFi and checked in with the server");
    }
    const photo = waits.current.photo;
    if (photo) {
      if (s.lastReport?.slotId === photo.slotId && s.lastReport.state === "done") {
        waits.current.photo = null;
        setPhotoWait(null);
        if (s.lastReport.emailError) toast.error(`Photo analyzed, but the email failed: ${s.lastReport.emailError}`);
        else toast.success(`Test photo analyzed and emailed to ${s.lastReport.sentTo.length}`);
      } else if (Date.now() - photo.startedAt > PHOTO_WAIT_MS) {
        waits.current.photo = null;
        setPhotoWait(null);
        toast.error("The camera did not take the test photo. Check that it is powered and online.");
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      accept(await api<AutomationState>("/api/automation"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuth("signed-out");
      else if (e instanceof ApiError && e.status === 503) {
        setAuth("unavailable");
        setLoadError(e.message);
      } else setLoadError(errorMessage(e));
    }
  }, [accept]);

  // Load once, then keep "last seen" and the last report current; faster while waiting for the camera.
  const fast = !!wifiWait || !!photoWait || state?.lastReport?.state === "processing";
  useEffect(() => {
    const first = auth === "loading" ? setTimeout(() => void refresh(), 0) : undefined;
    const poll = auth === "signed-in" ? setInterval(() => void refresh(), fast ? 5_000 : 30_000) : undefined;
    return () => {
      clearTimeout(first);
      clearInterval(poll);
    };
  }, [auth, fast, refresh]);

  async function signOut() {
    await api("/api/automation/session", { method: "DELETE" }).catch(() => {});
    setState(null);
    setAuth("signed-out");
  }

  async function update(body: AutomationUpdate, kind: "toggle" | "copy", success: string) {
    setBusy(kind);
    try {
      accept(await api<AutomationState>("/api/automation", { method: "PUT", body }));
      toast.success(success);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function testEmail() {
    setBusy("test-email");
    try {
      const r = await api<{ sentTo: string[]; via: "gmail" | "file"; file: string | null }>("/api/automation/test", { method: "POST", body: { kind: "email" } });
      if (r.via === "file") toast.warning(`Gmail is not set up on this server: the email was saved to ${r.file}`);
      else toast.success(`Test email sent to ${r.sentTo.length}. Ask them to check their spam folder too.`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function testPhoto() {
    setBusy("test-photo");
    try {
      const { slotId } = await api<{ slotId: string }>("/api/automation/test", { method: "POST", body: { kind: "capture" } });
      startPhotoWait({ slotId, startedAt: Date.now() });
      toast.info("The camera takes the photo at its next check-in, within about a minute.");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const header = (
    <CardHeader>
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1.5">
          <CardTitle>Daily email report</CardTitle>
          <CardDescription>
            The ESP32-CAM takes a photo on the days and time you set, the server analyzes it and emails the results. Saved on the server, not only in this
            browser.
          </CardDescription>
        </div>
        {auth === "signed-in" && (
          <Button variant="ghost" size="sm" onClick={signOut}>
            <LogOut /> Sign out
          </Button>
        )}
      </div>
    </CardHeader>
  );

  if (auth !== "signed-in" || !state) {
    return (
      <Card>
        {header}
        <CardContent>
          {auth === "loading" && !loadError && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </p>
          )}
          {auth === "signed-out" && <SignIn onSignedIn={() => void refresh()} />}
          {auth === "unavailable" && (
            <Alert>
              <TriangleAlert />
              <AlertTitle>Not set up on this server</AlertTitle>
              <AlertDescription>{loadError}. Set ADMIN_PASSWORD, DEVICE_API_KEY, GMAIL_USER and GMAIL_APP_PASSWORD (README → Daily email report).</AlertDescription>
            </Alert>
          )}
          {auth === "loading" && loadError && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-destructive">
              {loadError}
              <Button variant="outline" size="sm" onClick={() => void refresh()}>
                <RefreshCw /> Try again
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  const timeZone = state.schedule?.timeZone ?? browserTimeZone();
  const done: Record<StepId, boolean> = { 1: !!state.device, 2: state.recipients.length > 0, 3: !!state.schedule };
  const firstOpen = ([1, 2, 3] as const).find((n) => !done[n]) ?? null;
  const active: StepId | null = wifiWait ? 1 : (editing ?? firstOpen);
  const stepState = (n: StepId): "done" | "active" | "locked" => {
    if (n === active) return "active";
    const earlierDone = ([1, 2, 3] as const).filter((m) => m < n).every((m) => done[m]);
    return done[n] && earlierDone ? "done" : "locked";
  };
  const change = (n: StepId) => (wifiWait ? undefined : () => setEditing(n));
  const cancel = (n: StepId) => (done[n] ? () => setEditing(null) : undefined);

  const serverNow = Date.parse(state.serverTime) + Math.max(0, now - fetchedAt);
  const seenAgo = state.device ? serverNow - Date.parse(state.device.lastSeenAt) : null;
  const online = seenAgo != null && seenAgo < OFFLINE_AFTER_MS;
  const copied = state.analysis;
  const analysisChanged =
    !!copied &&
    stableJson({ vision: copied.vision, thresholds: copied.thresholds, baseline: copied.baselineCoverPcts }) !==
      stableJson({ vision, thresholds, baseline: samples.map((s) => s.coverPct) });

  return (
    <Card>
      {header}
      <CardContent className="space-y-5">
        {!state.emailConfigured && (
          <Alert>
            <TriangleAlert />
            <AlertTitle>Gmail is not set up on this server</AlertTitle>
            <AlertDescription>
              Set GMAIL_USER and GMAIL_APP_PASSWORD. Until then, local development saves each email to .data/emails/ and a deployed site reports an error.
            </AlertDescription>
          </Alert>
        )}

        <ol className="space-y-5">
          <StepRow
            n={1}
            title="Camera WiFi"
            state={stepState(1)}
            onChange={change(1)}
            changeLabel="Change WiFi"
            summary={
              state.device && (
                <span>
                  Camera on WiFi · last seen {formatAgo(seenAgo ?? 0)}
                  {state.device.ip ? ` · IP ${state.device.ip}` : ""}
                  {state.device.rssi != null ? ` · signal ${state.device.rssi} dBm` : ""}
                </span>
              )
            }
          >
            <WifiStep
              state={state}
              wait={wifiWait}
              now={now}
              onCancel={cancel(1)}
              onSaved={(ip) => startWifiWait({ prevLastSeen: state.device?.lastSeenAt ?? null, startedAt: Date.now(), ip })}
            />
          </StepRow>

          <StepRow
            n={2}
            title="Email recipients"
            state={stepState(2)}
            onChange={change(2)}
            summary={
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 break-words">
                  {state.recipients.slice(0, 3).join(", ")}
                  {state.recipients.length > 3 ? ` +${state.recipients.length - 3} more` : ""}
                </span>
                <Button variant="outline" size="sm" onClick={testEmail} disabled={busy != null}>
                  {busy === "test-email" ? <Loader2 className="animate-spin" /> : <Send />} Send test email
                </Button>
              </div>
            }
          >
            <EmailStep
              state={state}
              onCancel={cancel(2)}
              onSaved={(next) => {
                accept(next);
                setEditing(null);
              }}
            />
          </StepRow>

          <StepRow
            n={3}
            title="When to take the photo and send the results"
            state={stepState(3)}
            onChange={change(3)}
            summary={
              state.schedule && (
                <div className="space-y-1">
                  <p>
                    {describeSchedule(state.schedule)} · {state.schedule.timeZone}
                    {!state.schedule.enabled && " · paused"}
                  </p>
                  {copied && (
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      Analysis settings copied from this browser {formatDateTime(copied.copiedAt)}
                      {copied.baselineCoverPcts.length
                        ? ` · baseline ${formatPct(copied.baselineCoverPcts.reduce((a, b) => a + b, 0) / copied.baselineCoverPcts.length)} leaf cover`
                        : " · no baseline"}
                      {analysisChanged && (
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={busy != null}
                          onClick={() => update({ analysis: browserAnalysis() }, "copy", "Analysis settings copied to the server")}
                        >
                          {busy === "copy" ? <Loader2 className="animate-spin" /> : <RefreshCw />} Copy again
                        </Button>
                      )}
                    </p>
                  )}
                </div>
              )
            }
          >
            <TimeStep
              state={state}
              onCancel={cancel(3)}
              onSaved={(next) => {
                accept(next);
                setEditing(null);
              }}
            />
          </StepRow>
        </ol>

        {firstOpen == null && state.schedule && (
          <div className="space-y-3 rounded-lg border bg-muted/40 p-3">
            <label className="flex items-center justify-between gap-3 text-sm font-medium">
              Daily report {state.schedule.enabled ? "on" : "paused"}
              <Switch
                checked={state.schedule.enabled}
                disabled={busy != null}
                onCheckedChange={(enabled) =>
                  update({ schedule: { ...state.schedule!, enabled } }, "toggle", enabled ? "Daily report on" : "Daily report paused")
                }
              />
            </label>
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
              {online ? (
                <span className="text-healthy">Camera online</span>
              ) : (
                <span className="text-destructive">Camera offline</span>
              )}
              <span>· last seen {formatAgo(seenAgo ?? 0)}</span>
              {state.schedule.enabled && (
                <>
                  <span>· {describeSchedule(state.schedule)}</span>
                  {state.nextRunAt && <span>· Next photo {formatZoned(Date.parse(state.nextRunAt), timeZone, { year: false })}</span>}
                </>
              )}
              {state.lastReport && (
                <>
                  <span>·</span>
                  <LastReport report={state.lastReport} timeZone={timeZone} />
                </>
              )}
            </p>
            {!online && (
              <p className="text-xs text-destructive">Check the camera&apos;s power and WiFi. A photo missed at the set time is still taken if it is back within 3 hours.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={testPhoto} disabled={busy != null || !!photoWait}>
                {busy === "test-photo" || photoWait ? <Loader2 className="animate-spin" /> : <Camera />}
                {photoWait ? "Waiting for the camera…" : "Take test photo now"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
