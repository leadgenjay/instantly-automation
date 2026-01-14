import Imap from "imap";
import { simpleParser, ParsedMail } from "mailparser";
import { logger } from "../utils/logger.js";

interface ImapPollOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  tls: boolean;
  timeout: number;
  fromEmail: string;
}

/**
 * Poll IMAP inbox for verification code from Instantly
 * Waits for new emails and extracts the verification code
 */
export async function pollForVerificationCode(options: ImapPollOptions): Promise<string> {
  const { host, port, user, password, tls, timeout, fromEmail } = options;
  const startTime = Date.now();

  logger.info("Starting IMAP poll for verification code", {
    host,
    user,
    fromEmail,
    timeout,
  });

  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user,
      password,
      host,
      port,
      tls,
      tlsOptions: { rejectUnauthorized: false },
    });

    let pollInterval: NodeJS.Timeout | null = null;
    let resolved = false;

    const cleanup = () => {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      try {
        imap.end();
      } catch {
        // Ignore cleanup errors
      }
    };

    const checkForVerificationEmail = () => {
      if (resolved) return;

      // Check timeout
      if (Date.now() - startTime > timeout) {
        cleanup();
        reject(new Error("Verification email timeout"));
        return;
      }

      imap.openBox("INBOX", false, (err, _box) => {
        if (err) {
          logger.error("Failed to open INBOX", { error: err.message });
          return;
        }

        // Search for unread emails from Instantly
        const searchCriteria = [
          "UNSEEN",
          ["FROM", fromEmail],
          ["SINCE", new Date(startTime)],
        ];

        imap.search(searchCriteria, (searchErr, results) => {
          if (searchErr) {
            logger.error("IMAP search failed", { error: searchErr.message });
            return;
          }

          if (!results || results.length === 0) {
            logger.debug("No new verification emails found yet");
            return;
          }

          logger.info(`Found ${results.length} potential verification email(s)`);

          // Fetch the latest email
          const latestUid = results[results.length - 1];
          const fetch = imap.fetch([latestUid], { bodies: "", markSeen: true });

          fetch.on("message", (msg) => {
            msg.on("body", (stream) => {
              simpleParser(stream, async (parseErr: Error | null, parsed: ParsedMail) => {
                if (parseErr) {
                  logger.error("Failed to parse email", { error: parseErr.message });
                  return;
                }

                const code = extractVerificationCode(parsed);
                if (code && !resolved) {
                  resolved = true;
                  logger.info("Verification code extracted successfully");
                  cleanup();
                  resolve(code);
                }
              });
            });
          });

          fetch.once("error", (fetchErr) => {
            logger.error("Fetch error", { error: fetchErr.message });
          });
        });
      });
    };

    imap.once("ready", () => {
      logger.info("IMAP connection established");
      // Check immediately, then poll every 5 seconds
      checkForVerificationEmail();
      pollInterval = setInterval(checkForVerificationEmail, 5000);
    });

    imap.once("error", (err: Error) => {
      logger.error("IMAP connection error", { error: err.message });
      cleanup();
      if (!resolved) {
        reject(new Error(`IMAP connection failed: ${err.message}`));
      }
    });

    imap.once("end", () => {
      logger.debug("IMAP connection ended");
    });

    imap.connect();

    // Set overall timeout
    setTimeout(() => {
      if (!resolved) {
        cleanup();
        reject(new Error("Verification email timeout - no code received"));
      }
    }, timeout);
  });
}

/**
 * Extract verification code from parsed email
 * Tries multiple patterns to find the code
 */
function extractVerificationCode(email: ParsedMail): string | null {
  const content = email.text || email.html || "";

  // Common patterns for verification codes
  const patterns = [
    // 6-digit code
    /(?:verification|code|otp|confirm)[^\d]*(\d{6})/i,
    /(\d{6})[^\d]*(?:verification|code|otp|confirm)/i,
    // Code in the format "Your code is: XXXXXX"
    /(?:your\s+)?code\s*(?:is)?:?\s*(\d{4,8})/i,
    // Code in the format "Enter XXXXXX"
    /enter\s+(\d{4,8})/i,
    // Code in bold or special formatting
    /<strong>(\d{4,8})<\/strong>/i,
    // Just a standalone 6-digit number (fallback)
    /\b(\d{6})\b/,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      logger.debug("Found verification code with pattern", { pattern: pattern.toString() });
      return match[1];
    }
  }

  // Try extracting from subject
  if (email.subject) {
    const subjectMatch = email.subject.match(/(\d{4,8})/);
    if (subjectMatch && subjectMatch[1]) {
      logger.debug("Found verification code in subject");
      return subjectMatch[1];
    }
  }

  logger.warn("Could not extract verification code from email", {
    subject: email.subject,
    hasText: !!email.text,
    hasHtml: !!email.html,
  });

  return null;
}

/**
 * Simple IMAP connection test
 */
export async function testImapConnection(options: Omit<ImapPollOptions, "timeout" | "fromEmail">): Promise<boolean> {
  return new Promise((resolve) => {
    const imap = new Imap({
      user: options.user,
      password: options.password,
      host: options.host,
      port: options.port,
      tls: options.tls,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 10000,
    });

    imap.once("ready", () => {
      logger.info("IMAP connection test successful");
      imap.end();
      resolve(true);
    });

    imap.once("error", (err: Error) => {
      logger.error("IMAP connection test failed", { error: err.message });
      resolve(false);
    });

    imap.connect();
  });
}
