/**
 * IMAP Service - DEPRECATED
 *
 * This file is kept as a stub for backward compatibility.
 * Email verification is now handled via Roundcube webmail browser automation
 * in src/automation/instantly.ts
 *
 * The webmail approach is more reliable and doesn't require IMAP credentials.
 */

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
 * @deprecated Use webmail verification via browser automation instead
 */
export async function pollForVerificationCode(
  _options: ImapPollOptions
): Promise<string> {
  logger.warn(
    "IMAP polling is deprecated. Use webmail verification via browser automation."
  );
  throw new Error("IMAP polling is deprecated. Use webmail verification instead.");
}

/**
 * @deprecated Use webmail verification via browser automation instead
 */
export async function testImapConnection(
  _options: Omit<ImapPollOptions, "timeout" | "fromEmail">
): Promise<boolean> {
  logger.warn("IMAP testing is deprecated.");
  return false;
}
