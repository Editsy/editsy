/**
 * Email transport for magic-link logins. SMTP is the "WordPress parity"
 * option, the credentials nearly every site owner already has (domain
 * email, host SMTP, a Gmail app password). Any other delivery (Resend,
 * Postmark, …) plugs in by implementing Mailer.
 */

export interface Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

export interface SmtpMailerOptions {
  /** smtp(s)://user:pass@host:port */
  url: string;
  /** From address, e.g. "Maine Chill <noreply@mainechill.example>" */
  from: string;
}

/** SMTP via nodemailer (dynamic import so it stays out of non-email code paths). */
export function createSmtpMailer(opts: SmtpMailerOptions): Mailer {
  let transportPromise: Promise<{ sendMail(m: object): Promise<unknown> }> | undefined;
  const transport = () =>
    (transportPromise ??= import("nodemailer").then((m) => m.default.createTransport(opts.url)));
  return {
    async send(message) {
      await (await transport()).sendMail({ from: opts.from, ...message });
    },
  };
}

/**
 * Build a mailer from the environment:
 *   EDITSY_SMTP_URL   - smtp(s)://user:pass@host:port
 *   EDITSY_EMAIL_FROM - sender address (defaults to the SMTP user)
 */
export function mailerFromEnv(
  env: Record<string, string | undefined> = process.env,
): Mailer | undefined {
  const url = env.EDITSY_SMTP_URL;
  if (!url) return undefined;
  const from = env.EDITSY_EMAIL_FROM ?? decodeURIComponent(new URL(url).username);
  if (!from) throw new Error("set EDITSY_EMAIL_FROM (or include a user in EDITSY_SMTP_URL)");
  return createSmtpMailer({ url, from });
}
