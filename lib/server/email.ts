import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import nodemailer, { type Transporter } from "nodemailer";

// Sends the daily report through Gmail with an App Password (newplan.md step 3). One message with
// every recipient in To. Without GMAIL_USER / GMAIL_APP_PASSWORD, development saves the message as
// a .eml file in .data/emails/ instead (open it with any mail app); production reports an error.

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
  /** Content id for inline images (<img src="cid:…">). */
  cid?: string;
}

export interface EmailMessage {
  to: string[];
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

export interface EmailResult {
  /** Where it went: Gmail, or a file in development. */
  via: "gmail" | "file";
  file?: string;
}

export function emailConfigured(): boolean {
  return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

let transport: Transporter | null = null;

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  if (message.to.length === 0) throw new Error("No email recipients are set");
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");
  const mail = {
    from: user ? { name: "Plant monitor", address: user } : "Plant monitor <plant-monitor@localhost>",
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
    attachments: message.attachments,
  };

  if (!user || !pass) {
    if (process.env.NODE_ENV === "production") throw new Error("Email is not set up: GMAIL_USER and GMAIL_APP_PASSWORD are missing on the server");
    const raw = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail(mail);
    const dir = path.join(process.cwd(), ".data", "emails");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.eml`);
    await writeFile(file, raw.message as Buffer);
    console.info(`[email] Gmail not set up; saved to ${file}`);
    return { via: "file", file };
  }

  transport ??= nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  await transport.sendMail(mail);
  return { via: "gmail" };
}
