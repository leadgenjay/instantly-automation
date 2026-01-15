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
  // Set the g-recaptcha-response textarea and trigger callback
  await page.evaluate((token) => {
    // Find all response textareas and fill them
    const textareas = document.querySelectorAll('textarea[name="g-recaptcha-response"], #g-recaptcha-response');
    textareas.forEach((ta) => {
      (ta as HTMLTextAreaElement).value = token;
    });

    // Find the callback function - try multiple approaches
    let callback: ((token: string) => void) | null = null;

    // Approach 1: Check common global callback names
    const globalCallbacks = ['onRecaptchaSuccess', 'recaptchaCallback', 'captchaCallback', 'onCaptchaSuccess'];
    for (const name of globalCallbacks) {
      if (typeof (window as any)[name] === 'function') {
        callback = (window as any)[name];
        break;
      }
    }

    // Approach 2: Find callback from grecaptcha config
    if (!callback) {
      try {
        const cfg = (window as any).___grecaptcha_cfg;
        if (cfg?.clients) {
          for (const client of Object.values(cfg.clients) as any[]) {
            // Navigate through the nested structure to find callback
            const findCallback = (obj: any, depth = 0): any => {
              if (depth > 10 || !obj) return null;
              if (typeof obj === 'function') return obj;
              if (typeof obj.callback === 'function') return obj.callback;
              if (typeof obj === 'object') {
                for (const key of Object.keys(obj)) {
                  const result = findCallback(obj[key], depth + 1);
                  if (result) return result;
                }
              }
              return null;
            };
            callback = findCallback(client);
            if (callback) break;
          }
        }
      } catch (e) {
        console.log('Error finding grecaptcha callback:', e);
      }
    }

    // Approach 3: Find callback from data-callback attribute
    if (!callback) {
      const recaptchaDiv = document.querySelector('.g-recaptcha[data-callback], [data-callback]');
      if (recaptchaDiv) {
        const callbackName = recaptchaDiv.getAttribute('data-callback');
        if (callbackName && typeof (window as any)[callbackName] === 'function') {
          callback = (window as any)[callbackName];
        }
      }
    }

    // Execute the callback
    if (callback) {
      console.log('Executing reCAPTCHA callback');
      callback(token);
    } else {
      console.log('No callback found, trying grecaptcha.execute');
      // Try to use grecaptcha API directly
      if ((window as any).grecaptcha) {
        try {
          (window as any).grecaptcha.execute();
        } catch (e) {
          console.log('grecaptcha.execute failed:', e);
        }
      }
    }

  }, token);

  // Wait for the CAPTCHA challenge iframe to disappear (indicates success)
  logger.info("Waiting for CAPTCHA overlay to dismiss...");

  try {
    // Wait for either the challenge iframe to disappear or become hidden
    await Promise.race([
      page.waitForSelector('iframe[title*="recaptcha challenge"]', { state: 'hidden', timeout: 10000 }).catch(() => null),
      page.waitForSelector('iframe[src*="bframe"]', { state: 'hidden', timeout: 10000 }).catch(() => null),
      page.waitForTimeout(3000), // Fallback: just wait 3 seconds
    ]);

    // Additional wait for any animations
    await page.waitForTimeout(1000);

    // Check if CAPTCHA is still visible
    const stillVisible = await page.$('iframe[title*="recaptcha challenge"]:visible, iframe[src*="bframe"]:visible');
    if (stillVisible) {
      logger.warn("CAPTCHA overlay may still be visible after token injection");
    } else {
      logger.info("CAPTCHA overlay dismissed successfully");
    }
  } catch (error) {
    logger.warn("Could not verify CAPTCHA dismissal", { error });
  }
}
