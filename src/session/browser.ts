/**
 * The bot's own browser profile (never the user's personal Chrome profile).
 * Patchright + the installed Google Chrome, persistent user-data-dir under
 * ~/Library/Application Support/cines-mx/browser-profile. One process at a
 * time (lock file). Used for: session keepalive, e-mail-code login, the
 * one-time logins (Cinépolis, PayPal) and the payment step.
 *
 * Live selectors for the login page are verified on setup day; any page we do
 * not recognize stops the flow with a screenshot instead of guessing.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CinesError } from "../errors.js";
import { DEUNA_SDK_URL, type CardSession, type CardUi, type PaymentMethodInfo, type SavedCard, type VaultCard } from "../order/card.js";
import type { PaymentPage, PaymentUi } from "../order/paypal.js";
import type { SessionBrowser } from "./session.js";

export const SITE = "https://cinepolis.com/mx";

export interface BotBrowserOptions {
  profileDir?: string;
  screenshotsDir?: string;
  headless?: boolean;
  /** Chrome channel (default "chrome" = installed Google Chrome). */
  channel?: string;
}

export function defaultDirs(home = homedir()) {
  const base = join(home, "Library", "Application Support", "cines-mx");
  return { profileDir: join(base, "browser-profile"), screenshotsDir: join(base, "screenshots") };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ctx = any;
type Page = any;

export class BotBrowser implements SessionBrowser, PaymentUi, CardUi {
  private readonly profileDir: string;
  private readonly shotsDir: string;
  private readonly lockFile: string;

  constructor(private readonly o: BotBrowserOptions = {}) {
    const d = defaultDirs();
    this.profileDir = o.profileDir ?? d.profileDir;
    this.shotsDir = o.screenshotsDir ?? d.screenshotsDir;
    this.lockFile = join(this.profileDir, "..", "browser.lock");
  }

  /** Run `fn` with the persistent context; refuses if another process holds the profile. */
  async with<T>(fn: (ctx: Ctx) => Promise<T>, opts: { headless?: boolean } = {}): Promise<T> {
    mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    if (existsSync(this.lockFile)) {
      const pid = Number(readFileSync(this.lockFile, "utf8"));
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        /* stale */
      }
      if (alive && pid !== process.pid) throw new CinesError("CINES_UNAVAILABLE", "El navegador del bot está ocupado; intenta en un momento.", { retryable: true });
    }
    writeFileSync(this.lockFile, String(process.pid));
    const { chromium } = await import("patchright");
    const ctx = await chromium.launchPersistentContext(this.profileDir, {
      channel: this.o.channel ?? "chrome",
      // Cloudflare serves "Attention Required" to headless Chrome on cinepolis.com
      // (verified 2026-10-19); headed Chrome passes. Default to headed.
      headless: opts.headless ?? this.o.headless ?? false,
      viewport: null,
      locale: "es-MX",
      timezoneId: "America/Mexico_City",
      args: ["--window-size=1280,900"],
    });
    try {
      return await fn(ctx);
    } finally {
      await ctx.close().catch(() => undefined);
      rmSync(this.lockFile, { force: true });
    }
  }

  async screenshot(page: Page, name: string): Promise<string> {
    mkdirSync(this.shotsDir, { recursive: true, mode: 0o700 });
    const file = join(this.shotsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}.png`);
    await page.screenshot({ path: file, fullPage: false }).catch(() => undefined);
    return file;
  }

  static async readAuth0(page: Page): Promise<Record<string, string>> {
    return page.evaluate(() => {
      const out: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("@@auth0spajs@@")) out[k] = localStorage.getItem(k) ?? "";
      }
      return out;
    });
  }

  /** Let the SPA run getTokenSilently (refresh-token rotation happens inside the site's code). */
  async refresh(): Promise<Record<string, string>> {
    return this.with(async (ctx) => {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 45_000 });
      // The home page alone makes auth0-spa-js refresh the token (a guessed
      // /mi-cuenta URL answered HTTP 500 live on 2026-10-20 and was dropped).
      await page.waitForTimeout(8000);
      return BotBrowser.readAuth0(page);
    });
  }

  /** The login button lives in a header menu opened by an icon-only button. */
  static async openLogin(page: Page): Promise<boolean> {
    const login = page.locator("button:has-text('Iniciar sesión'), a:has-text('Iniciar sesión')");
    const visible = async () => {
      for (let i = 0; i < (await login.count()); i++) if (await login.nth(i).isVisible().catch(() => false)) return login.nth(i);
      return undefined;
    };
    let target = await visible();
    if (!target) {
      const icons = page.locator("header button");
      for (let i = 0; i < Math.min(await icons.count(), 12) && !target; i++) {
        const b = icons.nth(i);
        if (!(await b.isVisible().catch(() => false)) || ((await b.textContent()) ?? "").trim()) continue;
        await b.click().catch(() => undefined);
        await page.waitForTimeout(800);
        target = await visible();
      }
    }
    if (!target) return false;
    await target.click();
    return true;
  }

  /**
   * Automated e-mail-code login. Steps: open login, type e-mail, submit,
   * call getCode() once, type the code, wait for the auth0 cache.
   * Selectors are provisional until recorded on setup day.
   */
  async loginWithEmailCode(email: string, getCode: (requestedAt: number) => Promise<string>): Promise<Record<string, string>> {
    return this.with(async (ctx) => {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(5000);
      const before = await BotBrowser.readAuth0(page);
      if (Object.keys(before).length) return before;
      if (!(await BotBrowser.openLogin(page))) {
        throw new CinesError("CINES_SCHEMA_CHANGED", `No encontré el botón de login (captura: ${await this.screenshot(page, "login-button")})`);
      }
      const emailInput = page.locator('input[type="email"], input[name="email"], input#username').first();
      await emailInput.waitFor({ timeout: 20_000 }).catch(async () => {
        throw new CinesError("CINES_SCHEMA_CHANGED", `Página de login inesperada (captura: ${await this.screenshot(page, "login-email")})`);
      });
      await emailInput.fill(email);
      const requestedAt = Date.now();
      await page.locator('button[type="submit"], button[name="action"]').first().click();
      const codeInput = page.locator('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"], input[maxlength="6"]').first();
      await codeInput.waitFor({ timeout: 30_000 }).catch(async () => {
        throw new CinesError("CINES_SCHEMA_CHANGED", `No apareció la pantalla del código (captura: ${await this.screenshot(page, "login-code")})`);
      });
      const code = await getCode(requestedAt);
      await codeInput.fill(code);
      await page.getByRole("button", { name: /confirmar|continuar|verificar/i }).first().click().catch(() => page.keyboard.press("Enter"));
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(1000);
        const entries = await BotBrowser.readAuth0(page);
        if (Object.keys(entries).length) return entries;
      }
      throw new CinesError("CINES_SESSION_EXPIRED", `El código no inició sesión (captura: ${await this.screenshot(page, "login-result")})`);
    });
  }

  /** One-time, headed: the user logs in by hand; returns when the auth0 cache appears (or times out). */
  async interactiveLogin(timeoutMs = 10 * 60_000): Promise<boolean> {
    return this.with(async (ctx) => {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(SITE, { waitUntil: "domcontentloaded" });
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (Object.keys(await BotBrowser.readAuth0(page).catch(() => ({}))).length) return true;
        await page.waitForTimeout(2000);
      }
      return false;
    }, { headless: false });
  }

  /** Read-only: is PayPal still logged in inside the bot profile? */
  async paypalLoggedIn(): Promise<boolean> {
    return this.with(async (ctx) => {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto("https://www.paypal.com/myaccount/summary", { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(4000);
      // Logged out = any redirect to a sign-in flow, on any PayPal host/locale.
      const u = String(page.url());
      if (/\/(signin|authflow|login|webapps\/auth)/i.test(u)) return false;
      return /\/myaccount\b/i.test(u);
    });
  }

  /** PaymentUi: open the checkout in the headed bot window and keep it open while `fn` runs. */
  async run<T>(url: string, fn: (page: PaymentPage) => Promise<T>): Promise<T> {
    return this.with(async (ctx) => {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.bringToFront().catch(() => undefined);
      const wrapper: PaymentPage = {
        isClosed: () => page.isClosed(),
        text: async () => {
          const parts = [await page.innerText("body").catch(() => "")];
          for (const f of page.frames()) parts.push(await f.innerText("body").catch(() => ""));
          for (const pg of ctx.pages()) if (pg !== page) parts.push(String(pg.url()));
          return parts.join("\n");
        },
        screenshot: async (name) => (page.isClosed() ? undefined : this.screenshot(page, name)),
      };
      return fn(wrapper);
    });
  }

  /**
   * CardUi: cinepolis.com in the headed bot window with DEUNA's SDK and vault
   * iframe embedded exactly as the site's payment page does. Selectors come
   * from the vault's own bundle (cinepolis.elements.deuna.com, 2026-10-20):
   * pay view = "*NNNN" + input[name=cvv] + button "Pagar"; "Cambiar tarjeta"
   * opens the list. Delete ("delete card") and "Agregar nueva tarjeta" are
   * never clicked.
   */
  async runCard<T>(opts: { vaultUrl: string; method: PaymentMethodInfo }, fn: (s: CardSession) => Promise<T>): Promise<T> {
    return this.with(async (ctx) => {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.bringToFront().catch(() => undefined);
      await page.waitForTimeout(3000);
      await page.evaluate(() => {
        const w = window as unknown as { __cinesVault: unknown[] };
        w.__cinesVault = [];
        window.addEventListener("message", (e: MessageEvent) => {
          if (!/\.deuna\.com$/.test(new URL(e.origin).hostname)) return;
          try {
            let d: unknown = e.data;
            for (let i = 0; i < 3 && typeof d === "string"; i++) d = JSON.parse(d);
            const m = d as { type?: string; data?: { metadata?: { createdCard?: Record<string, unknown>; errorCode?: unknown; errorMessage?: unknown } } };
            if (!m || typeof m.type !== "string") return;
            const c = m.data?.metadata?.createdCard;
            // Keep only non-secret fields.
            w.__cinesVault.push({
              type: m.type,
              card: c ? { id: c.id ?? c.cardId, firstSix: c.firstSix, lastFour: c.lastFour, company: c.company, cardType: c.cardType } : undefined,
              error: m.data?.metadata?.errorMessage ? String(m.data.metadata.errorMessage).slice(0, 160) : undefined,
            });
          } catch {
            /* not ours */
          }
        });
      });
      await page.addScriptTag({ url: DEUNA_SDK_URL }).catch(() => undefined);
      await page.evaluate((src: string) => {
        const f = document.createElement("iframe");
        f.id = "vault-widget-iframe";
        f.title = "Iframe Tarjeta de crédito o débito";
        f.src = src;
        f.setAttribute("style", "position:fixed;top:24px;left:50%;transform:translateX(-50%);width:440px;height:680px;z-index:2147483647;background:#fff;border:0;border-radius:12px;box-shadow:0 0 0 9999px rgba(0,0,0,.45)");
        document.body.appendChild(f);
      }, opts.vaultUrl);
      const frame = page.frameLocator("#vault-widget-iframe");
      const ready = frame.locator("input[name='cvv']").or(frame.getByText("Agregar nueva tarjeta")).or(frame.getByText("Selecciona una tarjeta")).first();
      await ready.waitFor({ timeout: 45_000 }).catch(async () => {
        throw new CinesError("CINES_PAYMENT_FAILED", `El monedero de DEUNA no cargó (captura: ${await this.screenshot(page, "vault-load")}).`);
      });
      const readCards = async (): Promise<SavedCard[]> => {
        const f = page.frames().find((x: { url(): string }) => /elements\.deuna\.com/.test(x.url()));
        if (!f) return [];
        return f.evaluate(() => {
          const out: { lastFour: string; isDefault: boolean; expired: boolean }[] = [];
          for (const el of Array.from(document.querySelectorAll("p"))) {
            const m = /^\*(\d{4})$/.exec((el.textContent ?? "").trim());
            if (!m) continue;
            let box: Element | null = el;
            for (let i = 0; i < 4 && box && box.parentElement; i++) box = box.parentElement;
            const t = box?.textContent ?? "";
            out.push({ lastFour: m[1]!, isDefault: /Predeterminada/.test(t), expired: /Expirada/.test(t) });
          }
          return out;
        });
      };
      const session: CardSession = {
        cards: async (all) => {
          // Pay view = saved card + CVV; the new-card form also has a CVV field, plus the card number.
          const payView = (await frame.locator("input[name='cvv']").count()) > 0 && (await frame.locator("input[name='card_number']").count()) === 0;
          if (!all) {
            const shown = await readCards();
            return payView ? shown.slice(0, 1).map((c) => ({ ...c, selected: true })) : shown;
          }
          if (payView) {
            await frame.getByText("Cambiar tarjeta", { exact: true }).click();
            await frame.getByText("Selecciona una tarjeta").waitFor({ timeout: 10_000 });
          }
          return readCards();
        },
        selectCard: async (lastFour) => {
          await frame.getByText(`*${lastFour}`, { exact: true }).first().click();
          await frame.locator("input[name='cvv']").waitFor({ timeout: 10_000 });
          const shown = await readCards();
          if (shown[0]?.lastFour !== lastFour) throw new Error(`no pude seleccionar la tarjeta *${lastFour}`);
        },
        fraudId: async () =>
          page.evaluate(
            async (a: { pk: string; env: string; fraud: unknown }) => {
              const sdk = (window as unknown as { DeunaSDK?: { config?: unknown; initialize(o: unknown): Promise<void>; generateFraudId(p: unknown): Promise<string> } }).DeunaSDK;
              if (!sdk) return undefined;
              if (!sdk.config) await sdk.initialize({ publicApiKey: a.pk, env: a.env });
              const id = await Promise.race([sdk.generateFraudId(a.fraud), new Promise<undefined>((r) => setTimeout(() => r(undefined), 25_000))]);
              return typeof id === "string" && id ? id : undefined;
            },
            { pk: opts.method.publicKey ?? "", env: opts.method.env ?? "production", fraud: opts.method.fraud },
          ),
        submitCvv: async (cvv) => {
          const input = frame.locator("input[name='cvv']");
          await input.click();
          await input.pressSequentially(cvv, { delay: 70 });
          await frame.getByRole("button", { name: /^Pagar$/ }).click();
          const until = Date.now() + 45_000;
          while (Date.now() < until) {
            await page.waitForTimeout(500);
            const msgs = (await page.evaluate(() => (window as unknown as { __cinesVault: unknown[] }).__cinesVault)) as { type: string; card?: VaultCard; error?: string }[];
            const ok = msgs.find((m) => m.type === "vaultSaveSuccess");
            if (ok?.card?.id) return ok.card;
            const bad = msgs.find((m) => m.type === "vaultSaveError");
            if (bad) throw new CinesError("CINES_PAYMENT_FAILED", `DEUNA rechazó la tarjeta${bad.error ? `: ${bad.error}` : ""}`);
          }
          throw new CinesError("CINES_PAYMENT_FAILED", `DEUNA no confirmó el CVV (captura: ${await this.screenshot(page, "vault-cvv")})`);
        },
        screenshot: async (name) => (page.isClosed() ? undefined : this.screenshot(page, name)),
      };
      return fn(session);
    });
  }

  /** One-time, headed: the user logs into PayPal in the bot profile; returns when they close the window. */
  async interactivePaypal(timeoutMs = 10 * 60_000): Promise<void> {
    await this.with(async (ctx) => {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto("https://www.paypal.com/signin", { waitUntil: "domcontentloaded" });
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        ctx.on("close", () => {
          clearTimeout(t);
          resolve();
        });
        page.on("close", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }, { headless: false });
  }
}
