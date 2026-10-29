// The Telegram Bot API, called from the browser during setup to check the bot token, find the chat
// that gets the reports and send it a first message. The camera keeps the token and sends the
// reports itself. api.telegram.org allows any origin, but answers a CORS preflight with 501, so only
// "simple" requests are used: GET, or POST with a form body and no custom headers.

const API = "https://api.telegram.org";

/** What @BotFather hands out: "<bot id>:<secret>". */
export const TOKEN_PATTERN = /^\d{5,}:[\w-]{30,}$/;

export interface TelegramBot {
  id: number;
  name: string;
  username: string;
}

export interface TelegramChat {
  /** Up to 52 significant bits (Telegram's guarantee), so a JS number is exact. */
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  /** A person's name or the group's title. */
  title: string;
  username: string | null;
}

export class TelegramError extends Error {
  constructor(
    message: string,
    /** Telegram's error_code; 0 when Telegram could not be reached. */
    readonly code: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

function friendlyError(code: number, description: string): string {
  if (code === 401 || code === 404) return "Telegram does not know this bot token. Copy it again from @BotFather.";
  if (code === 409) return "This bot is already used by another program (it has a webhook). Create a new bot for the camera with @BotFather.";
  if (code === 403) return "The bot may not write to this chat. Press Start in the bot's chat, or add the bot to the group again.";
  if (/chat not found/i.test(description)) return "Telegram cannot find this chat. Press Start in the bot's chat, then look for chats again.";
  return description || `Telegram error ${code}`;
}

async function call<T>(token: string, method: string, form?: Record<string, string>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, form ? { method: "POST", body: new URLSearchParams(form) } : undefined);
  } catch {
    throw new TelegramError("Could not reach Telegram. Check this device's internet connection.", 0);
  }
  const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; error_code?: number; description?: string } | null;
  if (!data?.ok) {
    const code = data?.error_code ?? res.status;
    throw new TelegramError(friendlyError(code, data?.description ?? ""), code);
  }
  return data.result as T;
}

/** Check the token; returns the bot's name and username. */
export async function getBot(token: string): Promise<TelegramBot> {
  const me = await call<{ id: number; first_name: string; username: string }>(token, "getMe");
  return { id: me.id, name: me.first_name, username: me.username };
}

interface RawChat {
  id: number;
  type: TelegramChat["type"];
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

function toChat(raw: RawChat): TelegramChat {
  const name = [raw.first_name, raw.last_name].filter(Boolean).join(" ");
  return { id: raw.id, type: raw.type, title: raw.title || name || (raw.username ? `@${raw.username}` : String(raw.id)), username: raw.username ?? null };
}

/**
 * The chats in a getUpdates result, newest first: people who wrote to the bot and groups or
 * channels it was added to. A chat the bot was later removed from is left out.
 */
export function chatsFromUpdates(updates: unknown[]): TelegramChat[] {
  const chats = new Map<number, TelegramChat>();
  for (const u of updates as Array<Record<string, { chat?: RawChat; new_chat_member?: { status?: string } } | undefined>>) {
    const member = u.my_chat_member; // the bot itself joining or leaving
    const chat = (u.message ?? u.edited_message ?? u.channel_post ?? u.edited_channel_post ?? member)?.chat;
    if (!chat || typeof chat.id !== "number") continue;
    chats.delete(chat.id); // re-added below, so the order follows the latest update
    const status = member?.new_chat_member?.status;
    if (status === "left" || status === "kicked") continue;
    chats.set(chat.id, toChat(chat));
  }
  return [...chats.values()].reverse();
}

/**
 * Chats that wrote to the bot or added it in the last 24 h (what Telegram keeps for getUpdates).
 * Without an offset nothing is marked as read, so searching again finds the same chats.
 */
export async function findChats(token: string): Promise<TelegramChat[]> {
  return chatsFromUpdates(await call<unknown[]>(token, "getUpdates"));
}

export async function sendMessage(token: string, chatId: number | string, text: string): Promise<void> {
  await call(token, "sendMessage", { chat_id: String(chatId), text });
}
