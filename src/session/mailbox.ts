/**
 * Read the Cinépolis login code from the DEDICATED bot mailbox over IMAP.
 * The password is a Gmail app password stored in the macOS Keychain
 * (service "cines-mx-imap", account = mailbox address) or, alternatively,
 * CINES_IMAP_PASSWORD in a 0600 env file. Only the 6-digit code leaves this
 * module; message bodies are never logged.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodeMailbox } from "./session.js";

const run = promisify(execFile);

/** Extract a 6-digit code from a Cinépolis e-mail; prefer digits near "código/code". */
export function extractCode(subject: string, text: string): string | undefined {
  const body = `${subject}\n${text}`.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  const near = /(c[oó]digo|code|verificaci[oó]n|verifica)[^0-9]{0,80}(\d{6})(?!\d)/i.exec(body);
  if (near) return near[2];
  const all = [...body.matchAll(/(?<![\d#])(\d{6})(?!\d)/g)].map((m) => m[1]!);
  const uniq = [...new Set(all)];
  return uniq.length === 1 ? uniq[0] : undefined;
}

export async function keychainSecret(service: string, account?: string): Promise<string | undefined> {
  try {
    const args = ["find-generic-password", "-s", service, "-w"];
    if (account) args.splice(3, 0, "-a", account);
    const { stdout } = await run("/usr/bin/security", args, { timeout: 10_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface ImapOptions {
  user: string;
  password: () => Promise<string | undefined>;
  host?: string;
  /** Sender filter, e.g. "cinepolis" (substring of From). */
  fromContains?: string;
}

export class ImapCodeMailbox implements CodeMailbox {
  constructor(private readonly o: ImapOptions) {}

  async waitForCode(since: number, timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const code = await this.checkOnce(since);
      if (code) return code;
      await new Promise((r) => setTimeout(r, 5000));
    }
    return undefined;
  }

  private async checkOnce(since: number): Promise<string | undefined> {
    const pass = await this.o.password();
    if (!pass) throw new Error("IMAP app password not found (Keychain service cines-mx-imap)");
    const { ImapFlow } = await import("imapflow");
    const client = new ImapFlow({ host: this.o.host ?? "imap.gmail.com", port: 993, secure: true, auth: { user: this.o.user, pass }, logger: false });
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const sinceDate = new Date(since - 60_000);
        const uids = (await client.search({ since: sinceDate, from: this.o.fromContains ?? "cinepolis" }, { uid: true })) || [];
        for (const uid of [...uids].reverse().slice(0, 5)) {
          const msg = await client.fetchOne(String(uid), { envelope: true, internalDate: true, source: true }, { uid: true });
          if (!msg) continue;
          const at = new Date(msg.internalDate ?? 0).getTime();
          if (at < since - 5_000) continue;
          const raw = msg.source?.toString("utf8") ?? "";
          const text = decodeQuotedPrintable(raw);
          const code = extractCode(msg.envelope?.subject ?? "", text);
          if (code) return code;
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
    return undefined;
  }
}

/** Minimal quoted-printable (UTF-8) + base64 part decoding, enough to find digits. */
export function decodeQuotedPrintable(raw: string): string {
  let s = raw
    .replace(/=\r?\n/g, "")
    .replace(/(?:=[0-9A-F]{2})+/gi, (run) => Buffer.from(run.split("=").filter(Boolean).map((h) => parseInt(h, 16))).toString("utf8"));
  // Decode base64 bodies (text/html or text/plain parts).
  s = s.replace(/Content-Transfer-Encoding:\s*base64\s*\r?\n(?:[^\r\n]+\r?\n)*?\r?\n([A-Za-z0-9+/=\r\n]+)/gi, (_m, b64: string) => {
    try {
      return Buffer.from(b64.replace(/\s+/g, ""), "base64").toString("utf8");
    } catch {
      return "";
    }
  });
  return s;
}
