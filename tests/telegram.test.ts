import { afterEach, describe, expect, it, vi } from "vitest";
import { chatsFromUpdates, findChats, getBot, sendMessage, TelegramError, TOKEN_PATTERN } from "@/lib/telegram";

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch(...responses: Array<Response | Error>) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("token", () => {
  it("accepts what BotFather hands out and nothing else", () => {
    expect(TOKEN_PATTERN.test(TOKEN)).toBe(true);
    expect(TOKEN_PATTERN.test("7012345678:AAE-x_y9Zq1234567890abcdefghijklmno")).toBe(true);
    for (const bad of ["", "123456789", "abc:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", "123456789:short", `${TOKEN} extra`]) {
      expect(TOKEN_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe("Bot API calls", () => {
  it("checks the token with getMe (a plain GET)", async () => {
    const fetchMock = stubFetch(reply({ ok: true, result: { id: 123456789, is_bot: true, first_name: "Plant reports", username: "plant_reports_bot" } }));
    await expect(getBot(TOKEN)).resolves.toEqual({ id: 123456789, name: "Plant reports", username: "plant_reports_bot" });
    expect(fetchMock).toHaveBeenCalledWith(`https://api.telegram.org/bot${TOKEN}/getMe`, undefined);
  });

  it("explains a wrong token, a webhook and an unreachable Telegram", async () => {
    stubFetch(reply({ ok: false, error_code: 401, description: "Unauthorized" }, 401));
    await expect(getBot(TOKEN)).rejects.toMatchObject({ name: "TelegramError", code: 401, message: expect.stringMatching(/BotFather/) });

    stubFetch(reply({ ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" }, 409));
    await expect(findChats(TOKEN)).rejects.toMatchObject({ code: 409, message: expect.stringMatching(/webhook/) });

    stubFetch(new TypeError("Failed to fetch"));
    const error = await getBot(TOKEN).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramError);
    expect(error).toMatchObject({ code: 0, message: expect.stringMatching(/internet/) });
  });

  it("sends a message as a form POST without custom headers (no CORS preflight)", async () => {
    const fetchMock = stubFetch(reply({ ok: true, result: { message_id: 1 } }));
    await sendMessage(TOKEN, -1001234567890, "Hello");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeInstanceOf(URLSearchParams);
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({ chat_id: "-1001234567890", text: "Hello" });
  });

  it("explains a chat the bot cannot write to", async () => {
    stubFetch(reply({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, 403));
    await expect(sendMessage(TOKEN, 42, "Hi")).rejects.toMatchObject({ code: 403, message: expect.stringMatching(/Start/) });
  });
});

describe("finding chats", () => {
  const ana = { id: 42, type: "private", first_name: "Ana", last_name: "Cruz", username: "anacruz" };
  const farm = { id: -1001234567890, type: "supergroup", title: "Farm team" };
  const old = { id: -987, type: "group", title: "Old group" };

  it("lists people and groups, newest first, without duplicates or groups the bot left", () => {
    const chats = chatsFromUpdates([
      { update_id: 1, message: { message_id: 1, chat: ana, text: "/start" } },
      { update_id: 2, my_chat_member: { chat: old, new_chat_member: { status: "member" } } },
      { update_id: 3, my_chat_member: { chat: farm, new_chat_member: { status: "member" } } },
      { update_id: 4, my_chat_member: { chat: old, new_chat_member: { status: "left" } } },
      { update_id: 5, message: { message_id: 2, chat: ana, text: "hello" } },
      { update_id: 6, callback_query: { id: "x" } },
    ]);
    expect(chats).toEqual([
      { id: 42, type: "private", title: "Ana Cruz", username: "anacruz" },
      { id: -1001234567890, type: "supergroup", title: "Farm team", username: null },
    ]);
  });

  it("names a chat by its username or id when it has no name", () => {
    expect(chatsFromUpdates([{ channel_post: { chat: { id: -100555, type: "channel", username: "farmnews" } } }])[0].title).toBe("@farmnews");
    expect(chatsFromUpdates([{ message: { chat: { id: 7, type: "private" } } }])[0].title).toBe("7");
  });

  it("reads the chats from getUpdates", async () => {
    const fetchMock = stubFetch(reply({ ok: true, result: [{ update_id: 1, message: { chat: ana, text: "/start" } }] }));
    await expect(findChats(TOKEN)).resolves.toEqual([{ id: 42, type: "private", title: "Ana Cruz", username: "anacruz" }]);
    expect(fetchMock).toHaveBeenCalledWith(`https://api.telegram.org/bot${TOKEN}/getUpdates`, undefined);
  });
});
