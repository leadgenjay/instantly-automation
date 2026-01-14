import { chromium, Browser, BrowserContext, Page } from "playwright";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs/promises";
import { logger, createStepLogger } from "../utils/logger.js";
import { generateSecurePassword } from "../utils/password.js";
import { pollForVerificationCode } from "../services/imap.js";
import type { SetupInstantlyRequest, SetupInstantlyResponse, ErrorCode } from "../types.js";

const SCREENSHOTS_DIR = process.env.SCREENSHOTS_PATH || "./screenshots";
const INSTANTLY_URL = "https://instantly.ai/?via=jay";
const INSTANTLY_APP_URL = "https://app.instantly.ai";
const COUPON_CODE = "LGJ";

// Timeout settings
const NAVIGATION_TIMEOUT = 30000;
const ACTION_TIMEOUT = 10000;
const VERIFICATION_TIMEOUT = 120000; // 2 minutes for email verification

interface AutomationContext {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  orderId: string;
  generatedPassword: string;
  apiKey?: string;
}

/**
 * Main function to set up an Instantly.ai account
 */
export async function setupInstantlyAccount(
  request: SetupInstantlyRequest
): Promise<SetupInstantlyResponse> {
  const { order_id, instantly_email, client_email } = request;
  const stepLogger = createStepLogger(order_id, "setup");

  // Ensure screenshots directory exists
  await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });

  let browser: Browser | null = null;
  let currentStep = "initialization";

  try {
    stepLogger.info("Launching browser");
    browser = await chromium.launch({
      headless: process.env.HEADLESS !== "false",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);

    const generatedPassword = generateSecurePassword(16);

    const ctx: AutomationContext = {
      browser,
      context,
      page,
      orderId: order_id,
      generatedPassword,
    };

    // Step 1: Navigate to Instantly with affiliate link
    currentStep = "navigate_to_instantly";
    stepLogger.info("Navigating to Instantly.ai");
    await navigateToInstantly(ctx);

    // Step 2: Create account
    currentStep = "create_account";
    stepLogger.info("Creating account");
    await createAccount(ctx, instantly_email);

    // Step 3: Verify email
    currentStep = "verify_email";
    stepLogger.info("Waiting for verification email");
    const verificationCode = await pollForVerificationCode({
      host: request.imap_host,
      port: 993,
      user: request.imap_user,
      password: request.imap_password,
      tls: true,
      timeout: VERIFICATION_TIMEOUT,
      fromEmail: "noreply@instantly.ai",
    });

    currentStep = "enter_verification_code";
    stepLogger.info("Entering verification code");
    await enterVerificationCode(ctx, verificationCode);

    // Step 4: Upgrade to paid plan
    currentStep = "upgrade_plan";
    stepLogger.info("Navigating to billing");
    await navigateToBilling(ctx);

    // Step 5: Apply coupon code
    currentStep = "apply_coupon";
    stepLogger.info("Applying coupon code");
    await applyCouponCode(ctx);

    // Step 6: Enter payment details
    currentStep = "enter_payment";
    stepLogger.info("Entering payment details");
    await enterPaymentDetails(ctx, request);

    // Step 7: Create API key
    currentStep = "create_api_key";
    stepLogger.info("Creating API key");
    ctx.apiKey = await createApiKey(ctx);

    // Step 8: Invite client as admin
    currentStep = "invite_admin";
    stepLogger.info("Inviting client as admin");
    await inviteAdmin(ctx, client_email);

    // Step 9: Verify affiliate attribution
    currentStep = "verify_affiliate";
    stepLogger.info("Verifying affiliate attribution");
    const affiliateVerified = await verifyAffiliateAttribution(ctx);

    stepLogger.info("Setup completed successfully");

    return {
      success: true,
      instantly_email,
      instantly_password: generatedPassword,
      instantly_api_key: ctx.apiKey,
      affiliate_verified: affiliateVerified,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    stepLogger.error(`Setup failed at step: ${currentStep}`, { error: errorMessage });

    // Capture screenshot on failure
    let screenshotUrl: string | undefined;
    if (browser) {
      try {
        const pages = browser.contexts()[0]?.pages() || [];
        if (pages.length > 0) {
          const screenshotPath = path.join(
            SCREENSHOTS_DIR,
            `${order_id}-${currentStep}-error.png`
          );
          await pages[0].screenshot({ path: screenshotPath, fullPage: true });
          screenshotUrl = screenshotPath;
          stepLogger.info("Error screenshot captured", { path: screenshotPath });
        }
      } catch (screenshotError) {
        stepLogger.error("Failed to capture error screenshot");
      }
    }

    return {
      success: false,
      error: errorMessage,
      error_code: mapStepToErrorCode(currentStep),
      screenshot_url: screenshotUrl,
      step_failed: currentStep,
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * Step 1: Navigate to Instantly with affiliate link
 */
async function navigateToInstantly(ctx: AutomationContext): Promise<void> {
  await ctx.page.goto(INSTANTLY_URL);
  await ctx.page.waitForLoadState("networkidle");

  // Wait for the page to fully load
  await ctx.page.waitForSelector('a[href*="signup"], button:has-text("Sign Up"), a:has-text("Get Started")', {
    timeout: 10000,
  });
}

/**
 * Step 2: Create account
 */
async function createAccount(ctx: AutomationContext, email: string): Promise<void> {
  // Click sign up button - try multiple selectors
  const signupSelectors = [
    'a[href*="signup"]',
    'button:has-text("Sign Up")',
    'a:has-text("Sign Up")',
    'a:has-text("Get Started")',
    'button:has-text("Get Started")',
  ];

  for (const selector of signupSelectors) {
    try {
      const element = await ctx.page.$(selector);
      if (element) {
        await element.click();
        break;
      }
    } catch {
      continue;
    }
  }

  await ctx.page.waitForLoadState("networkidle");

  // Fill signup form
  await ctx.page.waitForSelector('input[type="email"], input[name="email"]');

  // Try different selectors for email input
  const emailInput = await ctx.page.$('input[type="email"]') || await ctx.page.$('input[name="email"]');
  if (emailInput) {
    await emailInput.fill(email);
  }

  // Fill password
  const passwordInput = await ctx.page.$('input[type="password"]') || await ctx.page.$('input[name="password"]');
  if (passwordInput) {
    await passwordInput.fill(ctx.generatedPassword);
  }

  // Submit form
  const submitButton = await ctx.page.$('button[type="submit"]') || await ctx.page.$('button:has-text("Sign Up")');
  if (submitButton) {
    await submitButton.click();
  }

  await ctx.page.waitForLoadState("networkidle");
}

/**
 * Step 3b: Enter verification code
 */
async function enterVerificationCode(ctx: AutomationContext, code: string): Promise<void> {
  // Wait for verification code input
  await ctx.page.waitForSelector('input[name="code"], input[type="text"][maxlength="6"]', {
    timeout: 30000,
  });

  // Try different selectors for code input
  const codeInput =
    (await ctx.page.$('input[name="code"]')) ||
    (await ctx.page.$('input[type="text"][maxlength="6"]')) ||
    (await ctx.page.$('input[placeholder*="code"]'));

  if (codeInput) {
    await codeInput.fill(code);
  }

  // Submit verification
  const submitButton =
    (await ctx.page.$('button[type="submit"]')) ||
    (await ctx.page.$('button:has-text("Verify")')) ||
    (await ctx.page.$('button:has-text("Continue")'));

  if (submitButton) {
    await submitButton.click();
  }

  // Wait for dashboard or next step
  await ctx.page.waitForURL("**/dashboard**", { timeout: 30000 }).catch(() => {
    // May redirect elsewhere, that's ok
  });

  await ctx.page.waitForLoadState("networkidle");
}

/**
 * Step 4: Navigate to billing page
 */
async function navigateToBilling(ctx: AutomationContext): Promise<void> {
  await ctx.page.goto(`${INSTANTLY_APP_URL}/settings/billing`);
  await ctx.page.waitForLoadState("networkidle");

  // Look for upgrade button
  const upgradeButton =
    (await ctx.page.$('button:has-text("Upgrade")')) ||
    (await ctx.page.$('a:has-text("Upgrade")')) ||
    (await ctx.page.$('[data-testid="upgrade-button"]'));

  if (upgradeButton) {
    await upgradeButton.click();
    await ctx.page.waitForLoadState("networkidle");
  }

  // Select Growth plan ($37/mo)
  const growthPlan =
    (await ctx.page.$('[data-plan="growth"]')) ||
    (await ctx.page.$(':has-text("Growth"):has-text("$37")')) ||
    (await ctx.page.$('button:has-text("Growth")'));

  if (growthPlan) {
    await growthPlan.click();
    await ctx.page.waitForLoadState("networkidle");
  }
}

/**
 * Step 5: Apply coupon code
 */
async function applyCouponCode(ctx: AutomationContext): Promise<void> {
  // Look for promo code link/button
  const promoLink =
    (await ctx.page.$('button:has-text("promo")')) ||
    (await ctx.page.$('a:has-text("promo")')) ||
    (await ctx.page.$(':has-text("coupon")')) ||
    (await ctx.page.$(':has-text("discount")'));

  if (promoLink) {
    await promoLink.click();
    await ctx.page.waitForTimeout(500);
  }

  // Enter promo code
  const promoInput =
    (await ctx.page.$('input[name="promoCode"]')) ||
    (await ctx.page.$('input[name="coupon"]')) ||
    (await ctx.page.$('input[placeholder*="promo"]')) ||
    (await ctx.page.$('input[placeholder*="coupon"]'));

  if (promoInput) {
    await promoInput.fill(COUPON_CODE);

    // Apply button
    const applyButton =
      (await ctx.page.$('button:has-text("Apply")')) ||
      (await ctx.page.$('button:has-text("Add")'));

    if (applyButton) {
      await applyButton.click();
      await ctx.page.waitForTimeout(1000);
    }
  }
}

/**
 * Step 6: Enter payment details via Stripe
 */
async function enterPaymentDetails(
  ctx: AutomationContext,
  request: SetupInstantlyRequest
): Promise<void> {
  // Wait for Stripe iframe to load
  const stripeFrame = ctx.page.frameLocator('iframe[name*="stripe"], iframe[src*="stripe"]');

  // Card number
  await stripeFrame
    .locator('input[name="cardnumber"], input[data-elements-stable-field-name="cardNumber"]')
    .fill(request.card_number);

  // Expiry
  await stripeFrame
    .locator('input[name="exp-date"], input[data-elements-stable-field-name="cardExpiry"]')
    .fill(request.card_expiry);

  // CVC
  await stripeFrame
    .locator('input[name="cvc"], input[data-elements-stable-field-name="cardCvc"]')
    .fill(request.card_cvc);

  // ZIP code if present
  if (request.billing_zip) {
    const zipInput = await stripeFrame
      .locator('input[name="postal"], input[name="postalCode"]')
      .count();
    if (zipInput > 0) {
      await stripeFrame
        .locator('input[name="postal"], input[name="postalCode"]')
        .fill(request.billing_zip);
    }
  }

  // Submit payment
  const submitButton =
    (await ctx.page.$('button:has-text("Subscribe")')) ||
    (await ctx.page.$('button:has-text("Pay")')) ||
    (await ctx.page.$('button:has-text("Start")')) ||
    (await ctx.page.$('button[type="submit"]'));

  if (submitButton) {
    await submitButton.click();
  }

  // Wait for payment confirmation
  await ctx.page.waitForURL("**/dashboard**", { timeout: 60000 });
  await ctx.page.waitForLoadState("networkidle");
}

/**
 * Step 7: Create API key with full scopes
 */
async function createApiKey(ctx: AutomationContext): Promise<string> {
  await ctx.page.goto(`${INSTANTLY_APP_URL}/settings/api-keys`);
  await ctx.page.waitForLoadState("networkidle");

  // Click create API key button
  const createButton =
    (await ctx.page.$('button:has-text("Create")')) ||
    (await ctx.page.$('button:has-text("Generate")')) ||
    (await ctx.page.$('button:has-text("New")'));

  if (createButton) {
    await createButton.click();
    await ctx.page.waitForTimeout(500);
  }

  // Enter API key name
  const nameInput =
    (await ctx.page.$('input[name="name"]')) ||
    (await ctx.page.$('input[placeholder*="name"]'));

  if (nameInput) {
    await nameInput.fill(`LGJ Auto - ${ctx.orderId.slice(0, 8)}`);
  }

  // Select all scopes
  const selectAllButton =
    (await ctx.page.$('button:has-text("Select All")')) ||
    (await ctx.page.$('label:has-text("All")')) ||
    (await ctx.page.$('input[type="checkbox"][name="all"]'));

  if (selectAllButton) {
    await selectAllButton.click();
  }

  // Create the API key
  const confirmButton =
    (await ctx.page.$('button:has-text("Create")')) ||
    (await ctx.page.$('button:has-text("Generate")')) ||
    (await ctx.page.$('button[type="submit"]'));

  if (confirmButton) {
    await confirmButton.click();
    await ctx.page.waitForTimeout(2000);
  }

  // Extract the API key from the modal/display
  const apiKeyElement =
    (await ctx.page.$('[data-testid="api-key-value"]')) ||
    (await ctx.page.$('.api-key-value')) ||
    (await ctx.page.$('code')) ||
    (await ctx.page.$('input[readonly]'));

  let apiKey = "";
  if (apiKeyElement) {
    apiKey = (await apiKeyElement.textContent()) || (await apiKeyElement.inputValue()) || "";
  }

  // Close modal if present
  const closeButton = await ctx.page.$('button:has-text("Close"), button:has-text("Done")');
  if (closeButton) {
    await closeButton.click();
  }

  return apiKey.trim();
}

/**
 * Step 8: Invite client as admin
 */
async function inviteAdmin(ctx: AutomationContext, clientEmail: string): Promise<void> {
  await ctx.page.goto(`${INSTANTLY_APP_URL}/settings/team`);
  await ctx.page.waitForLoadState("networkidle");

  // Click invite button
  const inviteButton =
    (await ctx.page.$('button:has-text("Invite")')) ||
    (await ctx.page.$('button:has-text("Add")'));

  if (inviteButton) {
    await inviteButton.click();
    await ctx.page.waitForTimeout(500);
  }

  // Enter email
  const emailInput =
    (await ctx.page.$('input[name="email"]')) ||
    (await ctx.page.$('input[type="email"]')) ||
    (await ctx.page.$('input[placeholder*="email"]'));

  if (emailInput) {
    await emailInput.fill(clientEmail);
  }

  // Select admin role
  const roleSelect = await ctx.page.$('select[name="role"]');
  if (roleSelect) {
    await roleSelect.selectOption("admin");
  } else {
    // Try clicking admin option
    const adminOption =
      (await ctx.page.$('button:has-text("Admin")')) ||
      (await ctx.page.$('label:has-text("Admin")'));
    if (adminOption) {
      await adminOption.click();
    }
  }

  // Send invite
  const sendButton =
    (await ctx.page.$('button:has-text("Send")')) ||
    (await ctx.page.$('button:has-text("Invite")')) ||
    (await ctx.page.$('button[type="submit"]'));

  if (sendButton) {
    await sendButton.click();
    await ctx.page.waitForTimeout(2000);
  }
}

/**
 * Step 9: Verify affiliate attribution
 */
async function verifyAffiliateAttribution(ctx: AutomationContext): Promise<boolean> {
  try {
    await ctx.page.goto(`${INSTANTLY_APP_URL}/settings/account`);
    await ctx.page.waitForLoadState("networkidle");

    // Look for referral/affiliate information
    const pageContent = await ctx.page.content();
    return (
      pageContent.toLowerCase().includes("jay") ||
      pageContent.toLowerCase().includes("via=jay") ||
      pageContent.toLowerCase().includes("referred")
    );
  } catch {
    return false;
  }
}

/**
 * Map step name to error code
 */
function mapStepToErrorCode(step: string): ErrorCode {
  const mapping: Record<string, ErrorCode> = {
    initialization: "BROWSER_ERROR",
    navigate_to_instantly: "BROWSER_ERROR",
    create_account: "SIGNUP_FAILED",
    verify_email: "VERIFICATION_TIMEOUT",
    enter_verification_code: "VERIFICATION_FAILED",
    upgrade_plan: "PAYMENT_FAILED",
    apply_coupon: "COUPON_FAILED",
    enter_payment: "PAYMENT_FAILED",
    create_api_key: "API_KEY_FAILED",
    invite_admin: "ADMIN_INVITE_FAILED",
    verify_affiliate: "INTERNAL_ERROR",
  };
  return mapping[step] || "INTERNAL_ERROR";
}
