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

export class BotBrowser implements SessionBrowser, PaymentUi {
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
      return !/\/(signin|authflow|login)/i.test(page.url());
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
