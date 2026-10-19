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

/** Default sender of Cinépolis account e-mail (a Cinépolis domain, not a personal address). */
export const DEFAULT_CODE_SENDER = "serviciocinepolis.com.mx";

/** Only verification-code e-mails, not promos from the same sender. */
export function isCodeEmail(subject: string, text: string): boolean {
  const s = subject.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  if (/(verific|codigo|code|inicio de sesion|iniciar sesion|acceso)/.test(s)) return true;
  // Some templates use a generic subject; then the body must say "código de verificación".
  const b = text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  return /codigo de (verificacion|acceso|seguridad)|verifica tu cuenta/.test(b);
}

/** Extract a 6-digit code from a Cinépolis code e-mail; requires it to be next to "código/code". */
export function extractCode(subject: string, text: string): string | undefined {
  const body = `${subject}\n${text}`.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  const near = /(c[oó]digo|code|verificaci[oó]n|verifica)[^0-9]{0,120}(\d{6})(?!\d)/i.exec(body);
  if (near) return near[2];
  if (!isCodeEmail(subject, text)) return undefined;
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

  /** Newest verification-code e-mail received after `since` (others, e.g. promos, are skipped). */
  private async checkOnce(since: number): Promise<string | undefined> {
    const pass = await this.o.password();
    if (!pass) throw new Error("IMAP app password not found (Keychain service cines-mx-imap)");
    const { ImapFlow } = await import("imapflow");
    const client = new ImapFlow({ host: this.o.host ?? "imap.gmail.com", port: 993, secure: true, auth: { user: this.o.user, pass }, logger: false });
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const sinceDate = new Date(since - 24 * 3_600_000); // IMAP SINCE is date-granular
        const uids = (await client.search({ since: sinceDate, from: this.o.fromContains ?? DEFAULT_CODE_SENDER }, { uid: true })) || [];
        const candidates: { at: number; code: string }[] = [];
        for (const uid of [...uids].reverse().slice(0, 10)) {
          const msg = await client.fetchOne(String(uid), { envelope: true, internalDate: true, source: true }, { uid: true });
          if (!msg) continue;
          const at = new Date(msg.internalDate ?? 0).getTime();
          if (at < since - 5_000) continue; // only mail that arrived after the login request
          const subject = msg.envelope?.subject ?? "";
          const text = decodeQuotedPrintable(msg.source?.toString("utf8") ?? "");
          if (!isCodeEmail(subject, text)) continue;
          const code = extractCode(subject, text);
          if (code) candidates.push({ at, code });
        }
        candidates.sort((a, b) => b.at - a.at);
        return candidates[0]?.code;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
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
