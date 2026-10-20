/** Wire the stateful services (holds, session, purchases) for the server. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HoldService } from "./cinepolis/orders.js";
import type { CinepolisProvider } from "./cinepolis/provider.js";
import { PaymentArm } from "./order/arm.js";
import { PaypalDriver, buyerFromEnv } from "./order/paypal.js";
import { CardDriver } from "./order/card.js";
import { DryRunDriver, MethodRouter, NotYetEnabledDriver, PurchaseLedger, capMxn, type PaymentDriver } from "./order/purchase.js";
import { SecureInputBroker } from "./secure.js";
import { BotBrowser, defaultDirs } from "./session/browser.js";
import { DEFAULT_CODE_SENDER, ImapCodeMailbox, keychainSecret } from "./session/mailbox.js";
import { SessionManager } from "./session/session.js";

export interface Services {
  holds: HoldService;
  session: SessionManager;
  broker: SecureInputBroker;
  ledger: PurchaseLedger;
  driver: PaymentDriver;
  dryRunDriver: PaymentDriver;
  /** One-shot arm; real payment runs only when armed via `cinesctl arm-payment`. */
  arm?: PaymentArm;
  stop: () => void;
}

export function armFile(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.CINES_STATE_DIR ?? stateDir(home), "payment-arm.json");
}

export function stateDir(home = homedir()): string {
  return join(home, "Library", "Application Support", "cines-mx", "state");
}

/** The bot-mailbox reader when CINES_IMAP_USER is set; shared by the server and the CLI. */
export function buildMailbox(env: NodeJS.ProcessEnv = process.env): ImapCodeMailbox | undefined {
  const user = env.CINES_IMAP_USER;
  if (!user) return undefined;
  return new ImapCodeMailbox({
    user,
    password: async () => env.CINES_IMAP_PASSWORD ?? (await keychainSecret("cines-mx-imap", user)),
    fromContains: env.CINES_CODE_SENDER ?? DEFAULT_CODE_SENDER,
  });
}

export function buildServices(provider: CinepolisProvider, env = process.env, home = homedir()): Services {
  const dir = env.CINES_STATE_DIR ?? stateDir(home);
  const broker = new SecureInputBroker();
  const profileDir = defaultDirs(home).profileDir;
  const browser = existsSync(profileDir) || env.CINES_BROWSER === "1" ? new BotBrowser() : undefined;
  const mailbox = buildMailbox(env);
  const session = new SessionManager({ browser, mailbox, broker, loginEmail: env.CINES_LOGIN_EMAIL, staticToken: env.CINES_ACCESS_TOKEN });
  const holds = new HoldService({ client: provider.client, stateFile: join(dir, "holds.json"), capMxn: capMxn(env) });
  void holds.releaseOrphans().catch(() => undefined);
  const ledger = new PurchaseLedger(join(dir, "purchases.json"));
  // Keep the session warm: every 6 h when a bot profile exists.
  let timer: NodeJS.Timeout | undefined;
  if (browser && env.CINES_KEEPALIVE !== "0") {
    timer = setInterval(() => void session.keepAlive(), 6 * 3_600_000);
    timer.unref();
  }
  return {
    holds,
    session,
    broker,
    ledger,
    driver: browser
      ? new MethodRouter({
          card: new CardDriver({
            client: provider.client,
            holds,
            accessToken: () => session.getAccessToken({ allowLogin: false }),
            buyer: buyerFromEnv(env),
            ui: browser,
            defaultLastFour: /^\d{4}$/.test(env.CINES_CARD_LAST4 ?? "") ? env.CINES_CARD_LAST4 : undefined,
          }),
          paypal: new PaypalDriver({
            client: provider.client,
            holds,
            accessToken: () => session.getAccessToken({ allowLogin: false }),
            buyer: buyerFromEnv(env),
            ui: browser,
            waitMs: Number(env.CINES_PAYPAL_WAIT_MIN ?? 15) * 60_000,
          }),
        })
      : new NotYetEnabledDriver(),
    arm: new PaymentArm(armFile(env, home)),
    dryRunDriver: new DryRunDriver(),
    stop: () => timer && clearInterval(timer),
  };
}
