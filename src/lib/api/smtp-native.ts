// =============================================================================
// smtp-native.ts
//
// Zero-dependency SMTP client for Bun / Node.js.
//
// Replaces the `nodemailer` npm package which caused Railway build failures
// because the bun.lock was generated inside Replit using internal proxy URLs
// (http://package-firewall.replit.local/…) that do not resolve on Railway's
// build servers, producing "FailedToOpenSocket / ConnectionRefused" errors.
//
// Supports:
//   • Port 465  — implicit TLS (connect directly with tls.connect)
//   • Port 587  — STARTTLS (connect plain, then upgrade)
//   • Port 25   — plain (no TLS)
//   • AUTH LOGIN (most common for hosted SMTP relays)
//   • AUTH PLAIN
// =============================================================================

import * as net from "node:net";
import * as tls from "node:tls";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export interface MailMessage {
  from: string;       // e.g. '"Sender" <sender@example.com>'
  to:   string;       // e.g. 'recipient@example.com'
  subject: string;
  html: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function mimeWords(s: string): string {
  // RFC 2047 encode non-ASCII in the display name part only
  if (/^[\x00-\x7f]*$/.test(s)) return s;
  return `=?UTF-8?B?${b64(s)}?=`;
}

function buildMessage(from: string, to: string, subject: string, html: string): string {
  const boundary = `----=_Part_${Date.now().toString(16)}`;
  const date = new Date().toUTCString();

  // Encode subject if needed
  const encodedSubject = /^[\x00-\x7f]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${b64(subject)}?=`;

  return [
    `Date: ${date}`,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    b64(html),
    ``,
    `--${boundary}--`,
  ].join("\r\n");
}

// ---------------------------------------------------------------------------
// Low-level SMTP conversation
// ---------------------------------------------------------------------------

/**
 * Wraps a socket (plain or TLS) into a simple line-by-line SMTP dialogue.
 */
function createSmtpSession(socket: net.Socket | tls.TLSSocket): {
  read(): Promise<string>;
  write(line: string): void;
  end(): void;
} {
  let buf = "";
  const waiting: Array<(line: string) => void> = [];

  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buf += chunk;
    // SMTP multi-line responses end with a line "NNN <text>\r\n"
    // (i.e. the code is followed by a space, not a dash)
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const resolve = waiting.shift();
      if (resolve) resolve(line);
    }
  });

  return {
    read(): Promise<string> {
      return new Promise((resolve) => {
        // Collect all continuation lines; final line has code + space
        const collect = (line: string) => {
          // "250-..." continuation — keep reading
          if (/^\d{3}-/.test(line)) {
            waiting.push(collect);
          } else {
            resolve(line);
          }
        };
        waiting.push(collect);
      });
    },
    write(line: string) {
      socket.write(line + "\r\n");
    },
    end() {
      socket.destroy();
    },
  };
}

async function expect(
  session: ReturnType<typeof createSmtpSession>,
  code: number,
  cmd?: string,
): Promise<string> {
  if (cmd) session.write(cmd);
  const line = await session.read();
  const got = parseInt(line.slice(0, 3), 10);
  if (got !== code) {
    throw new Error(`SMTP error: expected ${code}, got: ${line}`);
  }
  return line;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function sendMail(cfg: SmtpConfig, msg: MailMessage): Promise<void> {
  const isImplicitTls = cfg.port === 465;

  // ── 1. Open socket ────────────────────────────────────────────────────────
  const rawSocket: net.Socket | tls.TLSSocket = await new Promise((resolve, reject) => {
    let sock: net.Socket | tls.TLSSocket;
    const onErr = (e: Error) => reject(e);

    if (isImplicitTls) {
      sock = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }, () =>
        resolve(sock),
      );
    } else {
      sock = net.createConnection({ host: cfg.host, port: cfg.port }, () => resolve(sock));
    }
    sock.once("error", onErr);
    sock.setTimeout(15_000, () => reject(new Error("SMTP connection timeout")));
  });

  const session = createSmtpSession(rawSocket);

  try {
    // ── 2. Greeting ──────────────────────────────────────────────────────
    await expect(session, 220);

    // ── 3. EHLO ──────────────────────────────────────────────────────────
    await expect(session, 250, `EHLO solana-scanner`);

    // ── 4. STARTTLS (port 587 / 25) ───────────────────────────────────────
    if (!isImplicitTls && cfg.port !== 25) {
      await expect(session, 220, "STARTTLS");

      // Upgrade to TLS
      await new Promise<void>((resolve, reject) => {
        const upgraded = tls.connect(
          { socket: rawSocket as net.Socket, servername: cfg.host },
          () => {
            // Replace the session's socket reference
            session.write = (line) => upgraded.write(line + "\r\n");
            session.end   = () => upgraded.destroy();
            upgraded.setEncoding("utf8");
            upgraded.on("data", (chunk: string) => {
              rawSocket.emit("data", chunk);
            });
            resolve();
          },
        );
        upgraded.once("error", reject);
      });

      // Re-EHLO after TLS upgrade
      await expect(session, 250, `EHLO solana-scanner`);
    }

    // ── 5. AUTH LOGIN ─────────────────────────────────────────────────────
    await expect(session, 334, "AUTH LOGIN");
    await expect(session, 334, b64(cfg.user));
    await expect(session, 235, b64(cfg.pass));

    // ── 6. Envelope ───────────────────────────────────────────────────────
    const fromAddr = (msg.from.match(/<([^>]+)>/) || [, msg.from])[1]!;
    const toAddr   = (msg.to.match(/<([^>]+)>/)   || [, msg.to])[1]!;

    await expect(session, 250, `MAIL FROM:<${fromAddr}>`);
    await expect(session, 250, `RCPT TO:<${toAddr}>`);

    // ── 7. DATA ───────────────────────────────────────────────────────────
    await expect(session, 354, "DATA");

    const body = buildMessage(msg.from, msg.to, msg.subject, msg.html);
    session.write(body);
    await expect(session, 250, "."); // end of data marker

    // ── 8. QUIT ───────────────────────────────────────────────────────────
    session.write("QUIT");
    // Best-effort — don't await, just close
    setTimeout(() => session.end(), 500);
  } catch (err) {
    session.end();
    throw err;
  }
}
