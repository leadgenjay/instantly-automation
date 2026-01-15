import { Page } from "playwright";
import { logger } from "./logger.js";

const TWOCAPTCHA_API_KEY = process.env.TWOCAPTCHA_API_KEY || "99d956eccc4fa81375d710b7b243f738";
const TWOCAPTCHA_API_URL = "https://2captcha.com";

interface CaptchaResult {
  success: boolean;
  token?: string;
  error?: string;
}

/**
 * Solve reCAPTCHA v2 using 2Captcha service
 */
export async function solveRecaptchaV2(
  page: Page,
  pageUrl: string
): Promise<CaptchaResult> {
  try {
    // Extract sitekey from the page
    const sitekey = await extractSitekey(page);
    if (!sitekey) {
      return { success: false, error: "Could not find reCAPTCHA sitekey" };
    }

    logger.info("Found reCAPTCHA sitekey, sending to 2Captcha", { sitekey });

    // Submit CAPTCHA to 2Captcha
    const taskId = await submitCaptcha(sitekey, pageUrl);
    if (!taskId) {
      return { success: false, error: "Failed to submit CAPTCHA to 2Captcha" };
    }

    logger.info("CAPTCHA submitted, waiting for solution", { taskId });

    // Poll for result (up to 120 seconds)
    const token = await pollForResult(taskId, 120000);
    if (!token) {
      return { success: false, error: "CAPTCHA solving timed out" };
    }

    logger.info("CAPTCHA solved successfully");

    // Inject the token into the page
    await injectCaptchaToken(page, token);

    return { success: true, token };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    logger.error("CAPTCHA solving failed", { error: errorMsg });
    return { success: false, error: errorMsg };
  }
}

/**
 * Check if a CAPTCHA is present on the page
 */
export async function detectCaptcha(page: Page): Promise<boolean> {
  try {
    // Check for reCAPTCHA iframe or challenge
    const recaptchaFrame = await page.$('iframe[src*="recaptcha"]');
    const recaptchaDiv = await page.$('.g-recaptcha, [data-sitekey]');
    const captchaChallenge = await page.$('iframe[title*="recaptcha challenge"]');

    return !!(recaptchaFrame || recaptchaDiv || captchaChallenge);
  } catch {
    return false;
  }
}

/**
 * Extract the reCAPTCHA sitekey from the page
 */
async function extractSitekey(page: Page): Promise<string | null> {
  try {
    // Try data-sitekey attribute
    const sitekey = await page.$eval(
      '[data-sitekey], .g-recaptcha',
      (el) => el.getAttribute('data-sitekey')
    ).catch(() => null);

    if (sitekey) return sitekey;

    // Try extracting from iframe src
    const iframeSrc = await page.$eval(
      'iframe[src*="recaptcha"]',
      (el) => el.getAttribute('src')
    ).catch(() => null);

    if (iframeSrc) {
      const match = iframeSrc.match(/[?&]k=([^&]+)/);
      if (match) return match[1];
    }

    // Try extracting from script
    const pageContent = await page.content();
    const scriptMatch = pageContent.match(/sitekey['":\s]+['"]([^'"]+)['"]/i);
    if (scriptMatch) return scriptMatch[1];

    return null;
  } catch {
    return null;
  }
}

/**
 * Submit CAPTCHA to 2Captcha API
 */
async function submitCaptcha(sitekey: string, pageUrl: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      key: TWOCAPTCHA_API_KEY,
      method: "userrecaptcha",
      googlekey: sitekey,
      pageurl: pageUrl,
      json: "1",
    });

    const response = await fetch(`${TWOCAPTCHA_API_URL}/in.php?${params}`);
    const data = await response.json();

    if (data.status === 1) {
      return data.request;
    }

    logger.error("2Captcha submit failed", { error: data.request });
    return null;
  } catch (error) {
    logger.error("2Captcha submit error", { error });
    return null;
  }
}

/**
 * Poll 2Captcha for the solution
 */
async function pollForResult(taskId: string, timeout: number): Promise<string | null> {
  const startTime = Date.now();
  const pollInterval = 5000; // 5 seconds

  // Wait 15 seconds before first poll (2Captcha recommendation)
  await new Promise((resolve) => setTimeout(resolve, 15000));

  while (Date.now() - startTime < timeout) {
    try {
      const params = new URLSearchParams({
        key: TWOCAPTCHA_API_KEY,
        action: "get",
        id: taskId,
        json: "1",
      });

      const response = await fetch(`${TWOCAPTCHA_API_URL}/res.php?${params}`);
      const data = await response.json();

      if (data.status === 1) {
        return data.request;
      }

      if (data.request !== "CAPCHA_NOT_READY") {
        logger.error("2Captcha error", { error: data.request });
        return null;
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    } catch (error) {
      logger.error("2Captcha poll error", { error });
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  return null;
}

/**
 * Inject the solved CAPTCHA token into the page
 */
async function injectCaptchaToken(page: Page, token: string): Promise<void> {
  // Set the g-recaptcha-response textarea
  await page.evaluate((token) => {
    // Find and fill the response textarea
    const textarea = document.querySelector('#g-recaptcha-response') as HTMLTextAreaElement;
    if (textarea) {
      textarea.value = token;
      textarea.style.display = 'block'; // Make visible temporarily
    }

    // Also try to find any hidden textarea with recaptcha response
    const hiddenTextareas = document.querySelectorAll('textarea[name="g-recaptcha-response"]');
    hiddenTextareas.forEach((ta) => {
      (ta as HTMLTextAreaElement).value = token;
    });

    // Try to call the callback function if it exists
    const recaptchaCallback = (window as any).onRecaptchaSuccess ||
                              (window as any).recaptchaCallback ||
                              (window as any).___grecaptcha_cfg?.clients?.[0]?.L?.L?.callback;

    if (typeof recaptchaCallback === 'function') {
      recaptchaCallback(token);
    }
  }, token);

  // Wait a moment for the token to be processed
  await page.waitForTimeout(1000);
}
