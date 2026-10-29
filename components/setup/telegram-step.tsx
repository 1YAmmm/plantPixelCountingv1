"use client";

import { Check, Loader2, Search, Send, User, Users } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { esp32Camera } from "@/lib/ble/esp32-camera";
import { MAX_LABEL_BYTES, truncateBytes } from "@/lib/ble/protocol";
import { findChats, getBot, sendMessage, TOKEN_PATTERN, type TelegramBot, type TelegramChat } from "@/lib/telegram";
import { cameraError, errorMessage, ExternalLink } from "./shared";

// The bot only sends: the camera posts each report to one chat, a person or a group. The browser
// checks the token, finds the chat and sends a first message; then token and chat go to the camera.

const CHAT_ID_PATTERN = /^-?\d{1,16}$/;
const TEST_MESSAGE = "PlantCam is set up. The plant reports will arrive in this chat.";

const CHAT_KIND: Record<TelegramChat["type"], string> = { private: "Person", group: "Group", supergroup: "Group", channel: "Channel" };

export function TelegramStep({ canSave, onDone, onCancel }: { canSave: boolean; onDone: () => void; onCancel?: () => void }) {
  const [token, setToken] = useState("");
  const [bot, setBot] = useState<TelegramBot | null>(null);
  const [chats, setChats] = useState<TelegramChat[] | null>(null);
  const [chatId, setChatId] = useState<number | null>(null);
  const [manualId, setManualId] = useState("");
  const [busy, setBusy] = useState<"check" | "find" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const trimmed = token.trim();
  const manual = manualId.trim();
  const target = manual ? (CHAT_ID_PATTERN.test(manual) ? manual : null) : chatId;

  async function lookForChats() {
    const found = await findChats(trimmed);
    setChats(found);
    setChatId((current) => (current != null && found.some((c) => c.id === current) ? current : (found[0]?.id ?? null)));
  }

  async function check(e: FormEvent) {
    e.preventDefault();
    setBusy("check");
    setError(null);
    try {
      setBot(await getBot(trimmed));
      // Someone who already pressed Start sees their chat straight away.
      await lookForChats().catch(() => setChats(null));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function find() {
    setBusy("find");
    setError(null);
    try {
      await lookForChats();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!bot || target == null) return;
    setBusy("save");
    setError(null);
    try {
      await sendMessage(trimmed, target, TEST_MESSAGE);
      const chat = chats?.find((c) => String(c.id) === String(target));
      const label = truncateBytes(`${chat?.title ?? `chat ${target}`} via @${bot.username}`, MAX_LABEL_BYTES);
      await esp32Camera.setupTelegram({ token: trimmed, chatId: target, label });
      toast.success("Saved on the camera. A test message was sent to Telegram.");
      onDone();
    } catch (err) {
      setError(cameraError(err));
    } finally {
      setBusy(null);
    }
  }

  function useAnotherBot() {
    setBot(null);
    setChats(null);
    setChatId(null);
    setManualId("");
    setError(null);
  }

  if (!bot) {
    return (
      <form onSubmit={check} className="grid gap-3">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            In Telegram, open <ExternalLink href="https://t.me/BotFather">@BotFather</ExternalLink> and send <code className="text-foreground">/newbot</code>.
          </li>
          <li>Give the bot a name, then a username that ends in “bot”.</li>
          <li>BotFather answers with a token. Copy it and paste it here.</li>
        </ol>
        <div className="grid gap-1.5">
          <Label htmlFor="tg-token">Bot token</Label>
          <Input
            id="tg-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="123456789:AAH…"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!trimmed && !TOKEN_PATTERN.test(trimmed)}
            className="font-mono pointer-coarse:h-10"
          />
          <p className="text-xs text-muted-foreground">Keep it secret: anyone with the token can post as your bot. It is saved only on the camera.</p>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy != null || !TOKEN_PATTERN.test(trimmed)}>
            {busy === "check" ? <Loader2 className="animate-spin" /> : <Check />} Check token
          </Button>
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel} disabled={busy != null}>
              Cancel
            </Button>
          )}
        </div>
      </form>
    );
  }

  return (
    <div className="grid gap-4">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
        <Check className="size-4 text-healthy" />
        Bot <ExternalLink href={`https://t.me/${bot.username}`}>@{bot.username}</ExternalLink>
        <span className="text-muted-foreground">({bot.name})</span>
        <button type="button" className="text-muted-foreground underline underline-offset-3 hover:text-foreground" onClick={useAnotherBot} disabled={busy != null}>
          Use another bot
        </button>
      </p>

      <div className="grid gap-2">
        <p className="text-sm font-medium">Who gets the reports?</p>
        <p className="text-sm text-muted-foreground">
          Open <ExternalLink href={`https://t.me/${bot.username}`}>@{bot.username}</ExternalLink> and press <strong className="text-foreground">Start</strong> to get
          them yourself, or add the bot to a group so everyone in it gets them. Then look for chats.
        </p>
        <div>
          <Button type="button" variant="outline" size="sm" onClick={find} disabled={busy != null}>
            {busy === "find" ? <Loader2 className="animate-spin" /> : <Search />} Find chats
          </Button>
        </div>
        {chats && chats.length === 0 && (
          <p className="text-sm text-muted-foreground">No chats yet. Press Start in @{bot.username} (or add it to the group), then press Find chats again.</p>
        )}
        {chats && chats.length > 0 && (
          <div role="radiogroup" aria-label="Chat for the reports" className="grid gap-1.5">
            {chats.map((c) => {
              const selected = !manual && chatId === c.id;
              const Icon = c.type === "private" ? User : Users;
              return (
                <label
                  key={c.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors pointer-coarse:py-3",
                    selected ? "border-primary bg-primary/5" : "hover:bg-muted",
                  )}
                >
                  <input
                    type="radio"
                    name="tg-chat"
                    className="accent-primary"
                    checked={selected}
                    onChange={() => {
                      setChatId(c.id);
                      setManualId("");
                    }}
                  />
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  <span className="text-xs text-muted-foreground">{CHAT_KIND[c.type]}</span>
                </label>
              );
            })}
          </div>
        )}
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Enter a chat ID instead</summary>
          <div className="mt-2 grid max-w-xs gap-1.5">
            <Label htmlFor="tg-chat-id">Chat ID</Label>
            <Input
              id="tg-chat-id"
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              placeholder="-1001234567890"
              inputMode="numeric"
              autoComplete="off"
              aria-invalid={!!manual && !CHAT_ID_PATTERN.test(manual)}
              className="font-mono pointer-coarse:h-10"
            />
            <p className="text-xs text-muted-foreground">For a channel, make the bot an admin of it first.</p>
          </div>
        </details>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={save} disabled={busy != null || target == null || !canSave}>
          {busy === "save" ? <Loader2 className="animate-spin" /> : <Send />} Save and send a test message
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy != null}>
            Cancel
          </Button>
        )}
        {!canSave && <p className="w-full text-xs text-destructive">The camera&apos;s firmware cannot save this yet (see above).</p>}
      </div>
    </div>
  );
}
