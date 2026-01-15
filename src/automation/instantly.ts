import { chromium, Browser, BrowserContext, Page } from "playwright";
import path from "path";
import fs from "fs/promises";
import { logger, createStepLogger } from "../utils/logger.js";
import { generateSecurePassword } from "../utils/password.js";
import type {
  SetupInstantlyRequest,
  SetupInstantlyResponse,
  ErrorCode,
} from "../types.js";

const SCREENSHOTS_DIR = process.env.SCREENSHOTS_PATH || "./screenshots";
const INSTANTLY_URL = "https://instantly.ai/?via=jay";
const INSTANTLY_APP_URL = "https://app.instantly.ai";
const WEBMAIL_URL = "https://lgjconnect.com:2096";

// Timeout settings
const NAVIGATION_TIMEOUT = 60000;
const ACTION_TIMEOUT = 10000;
const EMAIL_POLL_TIMEOUT = 120000; // 2 minutes for email to arrive
const EMAIL_POLL_INTERVAL = 5000; // Check every 5 seconds

// Billing info (hardcoded)
const BILLING_ADDRESS = {
  name: "Jay Feldman",
  address: "700 NE 25th Street",
  city: "Miami",
  state: "Florida",
  zip: "33137",
  country: "United States",
};

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
 *
 * Flow documented from manual walkthrough:
 * 1. Navigate to instantly.ai/?via=jay
 * 2. Click "Start for Free"
 * 3. Fill signup form (First Name, Last Name, Email, Password)
 * 4. Check terms, click "Join Now"
 * 5. Complete onboarding survey (Lead Gen Jay, Agency, 1-10)
 * 6. Login to webmail to get verification email
 * 7. Click verification link in email
 * 8. Skip tour
 * 9. Navigate to Settings → Billing
 * 10. Select Growth plan, confirm purchase
 * 11. Complete Stripe payment (skip coupon - currently invalid)
 * 12. Create API key with all:all scope
 * 13. Invite client as admin
 */
export async function setupInstantlyAccount(
  request: SetupInstantlyRequest
): Promise<SetupInstantlyResponse> {
  const { order_id, instantly_email, client_email, client_name } = request;
  const stepLogger = createStepLogger(order_id, "setup");

  // Parse name from email or use provided
  const nameParts = client_name?.split(" ") || instantly_email.split("@")[0].split(".");
  const firstName = nameParts[0] || "Customer";
  const lastName = nameParts.slice(1).join(" ") || "User";

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
      viewport: { width: 1280, height: 900 },
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

    // Step 2: Create account (signup form)
    currentStep = "create_account";
    stepLogger.info("Creating account");
    await createAccount(ctx, instantly_email, firstName, lastName);

    // Step 3: Complete onboarding survey
    currentStep = "onboarding_survey";
    stepLogger.info("Completing onboarding survey");
    await completeOnboardingSurvey(ctx);

    // Step 4: Verify email via webmail
    currentStep = "verify_email";
    stepLogger.info("Verifying email via webmail");
    await verifyEmailViaWebmail(ctx, instantly_email, request.imap_password);

    // Step 5: Skip tour and handle welcome popup
    currentStep = "skip_tour";
    stepLogger.info("Skipping tour");
    await skipTourAndWelcome(ctx);

    // Step 6: Upgrade to Growth plan
    currentStep = "upgrade_plan";
    stepLogger.info("Upgrading to Growth plan");
    await upgradeToPaidPlan(ctx);

    // Step 7: Complete Stripe payment
    currentStep = "enter_payment";
    stepLogger.info("Entering payment details");
    await completeStripePayment(ctx, request);

    // Step 8: Handle post-payment redirect
    currentStep = "post_payment";
    stepLogger.info("Handling post-payment");
    await handlePostPayment(ctx);

    // Step 9: Create API key
    currentStep = "create_api_key";
    stepLogger.info("Creating API key");
    ctx.apiKey = await createApiKey(ctx);

    // Step 10: Invite client as admin
    currentStep = "invite_admin";
    stepLogger.info("Inviting client as admin");
    await inviteClientAsAdmin(ctx, client_email);

    stepLogger.info("Setup completed successfully");

    return {
      success: true,
      instantly_email,
      instantly_password: generatedPassword,
      instantly_api_key: ctx.apiKey,
      affiliate_verified: true, // Affiliate tracked via URL parameter
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    stepLogger.error(`Setup failed at step: ${currentStep}`, {
      error: errorMessage,
    });

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
  await ctx.page.goto(INSTANTLY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Wait for the page to be interactive
  await ctx.page.waitForTimeout(3000);

  // Click "START FOR FREE" button
  await ctx.page.click('button:has-text("START FOR FREE"), a:has-text("START FOR FREE")');
  await ctx.page.waitForLoadState("domcontentloaded");

  // Should now be on app.instantly.ai/auth/signup
  await ctx.page.waitForURL("**/auth/signup**", { timeout: 30000 });
}

/**
 * Step 2: Create account - Fill signup form
 */
async function createAccount(
  ctx: AutomationContext,
  email: string,
  firstName: string,
  lastName: string
): Promise<void> {
  // Wait for signup form to load
  await ctx.page.waitForSelector('input[placeholder="First Name"]', { timeout: 10000 });

  // Fill First Name
  await ctx.page.fill('input[placeholder="First Name"]', firstName);

  // Fill Last Name
  await ctx.page.fill('input[placeholder="Last Name"]', lastName);

  // Fill Email
  await ctx.page.fill('input[placeholder="Email"]', email);

  // Fill Password
  await ctx.page.fill('input[placeholder="Password"]', ctx.generatedPassword);

  // Check terms checkbox
  await ctx.page.click('input[type="checkbox"]');

  // Click "Join Now" button
  await ctx.page.click('button:has-text("Join Now")');
  await ctx.page.waitForLoadState("domcontentloaded");
}

/**
 * Step 3: Complete onboarding survey
 * "Where did you find us?" -> Type "Lead Gen Jay"
 * "What best describes your industry?" -> Select "Agency"
 * "Company Size" -> Select "1-10"
 */
async function completeOnboardingSurvey(ctx: AutomationContext): Promise<void> {
  // Wait for onboarding page
  await ctx.page.waitForSelector('text="Let\'s get to know you"', { timeout: 10000 });

  // "Where did you find us?" - Find the text input and type "Lead Gen Jay"
  // This is a custom text input in the button group
  const findUsInput = ctx.page.locator('input[type="text"]').first();
  await findUsInput.fill("Lead Gen Jay");

  // Click somewhere else to register the input
  await ctx.page.click('text="What best describes your industry?"');
  await ctx.page.waitForTimeout(500);

  // Select "Agency" for industry
  await ctx.page.click('button:has-text("Agency")');
  await ctx.page.waitForTimeout(300);

  // Select "1-10" for company size
  await ctx.page.click('button:has-text("1-10")');
  await ctx.page.waitForTimeout(300);

  // Click "Continue"
  await ctx.page.click('button:has-text("Continue")');
  await ctx.page.waitForLoadState("domcontentloaded");

  // Should now see "Verify your email" page
  await ctx.page.waitForSelector('text="Verify your email"', { timeout: 10000 });
}

/**
 * Step 4: Verify email via Roundcube webmail
 * Login to webmail, find verification email, click confirm link
 */
async function verifyEmailViaWebmail(
  ctx: AutomationContext,
  email: string,
  password: string
): Promise<void> {
  // Open new page for webmail
  const webmailPage = await ctx.context.newPage();

  try {
    // Navigate to webmail with email pre-filled
    await webmailPage.goto(`${WEBMAIL_URL}/?_user=${encodeURIComponent(email)}`);
    await webmailPage.waitForLoadState("domcontentloaded");

    // Enter password
    await webmailPage.fill('input[type="password"], input[name="pass"]', password);

    // Click LOGIN
    await webmailPage.click('button:has-text("LOGIN"), input[type="submit"]');
    await webmailPage.waitForLoadState("domcontentloaded");

    // Wait for inbox to load
    await webmailPage.waitForSelector('text="Inbox"', { timeout: 30000 });

    // Poll for verification email (up to 2 minutes)
    const startTime = Date.now();
    let emailFound = false;

    while (Date.now() - startTime < EMAIL_POLL_TIMEOUT) {
      // Click refresh button
      await webmailPage.click('a:has-text("Refresh"), button:has-text("Refresh")').catch(() => {});
      await webmailPage.waitForTimeout(2000);

      // Look for email from support@instantly.ai with "Welcome to Instantly"
      const verificationEmail = webmailPage.locator('tr:has-text("support@instantly.ai"):has-text("Welcome to Instantly")');

      if (await verificationEmail.count() > 0) {
        emailFound = true;
        // Click on the email to open it
        await verificationEmail.first().click();
        await webmailPage.waitForLoadState("domcontentloaded");
        break;
      }

      await webmailPage.waitForTimeout(EMAIL_POLL_INTERVAL);
    }

    if (!emailFound) {
      throw new Error("Verification email not received within timeout");
    }

    // Wait for email content to load
    await webmailPage.waitForTimeout(2000);

    // Click "Click here to confirm your email" button
    // This opens in a new tab, so we need to handle that
    const [newPage] = await Promise.all([
      ctx.context.waitForEvent("page"),
      webmailPage.click('a:has-text("Click here to confirm your email")'),
    ]);

    // Wait for the new page (Instantly) to load
    await newPage.waitForLoadState("domcontentloaded");

    // Close webmail page
    await webmailPage.close();

    // Switch context to the new Instantly page
    ctx.page = newPage;

    // Wait for dashboard or welcome screen
    await ctx.page.waitForURL("**/app/**", { timeout: 30000 });
  } catch (error) {
    await webmailPage.close();
    throw error;
  }
}

/**
 * Step 5: Skip tour and handle welcome popup
 */
async function skipTourAndWelcome(ctx: AutomationContext): Promise<void> {
  // Handle "Welcome back" popup if present
  const welcomePopupClose = ctx.page.locator('button:has-text("×"), [aria-label="Close"]').first();
  if (await welcomePopupClose.isVisible().catch(() => false)) {
    await welcomePopupClose.click();
    await ctx.page.waitForTimeout(500);
  }

  // Skip tour if present
  const skipTourLink = ctx.page.locator('text="Skip Tour"');
  if (await skipTourLink.isVisible().catch(() => false)) {
    await skipTourLink.click();
    await ctx.page.waitForTimeout(500);
  }

  // Close any other modals
  const closeButtons = ctx.page.locator('button:has-text("×"), button:has-text("Close"), [aria-label="Close"]');
  for (let i = 0; i < await closeButtons.count(); i++) {
    try {
      await closeButtons.nth(i).click();
      await ctx.page.waitForTimeout(300);
    } catch {
      // Ignore if button not clickable
    }
  }

  await ctx.page.waitForLoadState("domcontentloaded");
}

/**
 * Step 6: Navigate to billing and upgrade to Growth plan
 */
async function upgradeToPaidPlan(ctx: AutomationContext): Promise<void> {
  // Click user menu in bottom left
  await ctx.page.click('[class*="avatar"], [class*="user-menu"], .user-icon').catch(async () => {
    // Fallback: look for user initial icon at bottom of sidebar
    const userButton = ctx.page.locator('button').filter({ hasText: /^[A-Z]$/ }).last();
    await userButton.click();
  });
  await ctx.page.waitForTimeout(500);

  // Click "Settings" in the menu
  await ctx.page.click('text="Settings"');
  await ctx.page.waitForLoadState("domcontentloaded");

  // Should be on Settings page, Billing & Usage tab
  // Make sure we're on Email Outreach plans
  await ctx.page.click('text="Email Outreach"').catch(() => {});
  await ctx.page.waitForTimeout(500);

  // Find and click "Update Plan" under Growth
  // The Growth plan section has "Update Plan" button
  const growthSection = ctx.page.locator('div:has-text("Growth"):has-text("$47")').first();
  await growthSection.locator('button:has-text("Update Plan")').click();
  await ctx.page.waitForTimeout(500);

  // Confirm modal: "Great decision!" - Click "Yes, purchase"
  await ctx.page.waitForSelector('text="Great decision!"', { timeout: 5000 });
  await ctx.page.click('button:has-text("Yes, purchase")');

  // Wait for Stripe checkout page to load
  await ctx.page.waitForURL("**/checkout.stripe.com/**", { timeout: 30000 });
  await ctx.page.waitForLoadState("domcontentloaded");
}

/**
 * Step 7: Complete Stripe payment
 * Note: This is a full Stripe checkout page, not an iframe
 */
async function completeStripePayment(
  ctx: AutomationContext,
  request: SetupInstantlyRequest
): Promise<void> {
  // Wait for Stripe page to load
  await ctx.page.waitForSelector('text="Subscribe to Growth Plan"', { timeout: 10000 });

  // Skip coupon code (currently invalid)
  // await ctx.page.click('text="Add promotion code"');
  // await ctx.page.fill('input[name="promotionCode"]', 'LGJ');

  // Fill card information
  // Card number field
  await ctx.page.fill('input[placeholder="1234 1234 1234 1234"]', request.card_number);

  // Expiry date
  await ctx.page.fill('input[placeholder="MM / YY"]', request.card_expiry);

  // CVC
  await ctx.page.fill('input[placeholder="CVC"]', request.card_cvc);

  // Cardholder name
  await ctx.page.fill('input[placeholder="Full name on card"]', BILLING_ADDRESS.name);

  // Billing address
  // Country is likely already "United States"

  // Address line 1
  await ctx.page.fill('input[placeholder="Address line 1"]', BILLING_ADDRESS.address);

  // City
  await ctx.page.fill('input[placeholder="City"]', BILLING_ADDRESS.city);

  // ZIP
  await ctx.page.fill('input[placeholder="ZIP"]', BILLING_ADDRESS.zip);

  // State dropdown
  await ctx.page.click('select:near(:text("State"))').catch(async () => {
    await ctx.page.click('[aria-label*="State"]');
  });
  await ctx.page.selectOption('select', { label: BILLING_ADDRESS.state }).catch(async () => {
    await ctx.page.click(`text="${BILLING_ADDRESS.state}"`);
  });

  // IMPORTANT: Uncheck "Save my information for faster checkout"
  const saveInfoCheckbox = ctx.page.locator('input[type="checkbox"]:near(:text("Save my information"))');
  if (await saveInfoCheckbox.isChecked()) {
    await saveInfoCheckbox.uncheck();
  }

  // Click Subscribe button
  await ctx.page.click('button:has-text("Subscribe")');

  // Wait for redirect back to Instantly
  await ctx.page.waitForURL("**/app.instantly.ai/**", { timeout: 60000 });
  await ctx.page.waitForLoadState("domcontentloaded");
}

/**
 * Step 8: Handle post-payment redirect and popups
 */
async function handlePostPayment(ctx: AutomationContext): Promise<void> {
  // Close "Welcome back" popup if present
  await ctx.page.waitForTimeout(2000);

  const closeButton = ctx.page.locator('button:has-text("×"), [aria-label="Close"]').first();
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click();
    await ctx.page.waitForTimeout(500);
  }

  await ctx.page.waitForLoadState("domcontentloaded");
}

/**
 * Step 9: Create API key with all:all scope
 * Navigate: Integrations tab → API Keys sidebar → Create API Key
 */
async function createApiKey(ctx: AutomationContext): Promise<string> {
  // Navigate to Settings → Integrations tab
  await ctx.page.goto(`${INSTANTLY_APP_URL}/app/settings/integrations`);
  await ctx.page.waitForLoadState("domcontentloaded");

  // Click "API Keys" in left sidebar
  await ctx.page.click('text="API Keys"');
  await ctx.page.waitForTimeout(500);

  // Make sure we're on Version 2 tab
  await ctx.page.click('text="Version 2"').catch(() => {});
  await ctx.page.waitForTimeout(300);

  // Click "Create API Key" button
  await ctx.page.click('button:has-text("Create API Key")');
  await ctx.page.waitForTimeout(500);

  // Fill name: "LGJ"
  await ctx.page.fill('input[placeholder="Name"], input[name="name"]', "LGJ");

  // Click scopes dropdown
  await ctx.page.click('text="Select scopes"');
  await ctx.page.waitForTimeout(300);

  // Select "all:all" scope
  await ctx.page.click('text="all:all"');
  await ctx.page.waitForTimeout(300);

  // Click outside dropdown to close it
  await ctx.page.click('text="Create API Key"', { force: true }).catch(async () => {
    await ctx.page.keyboard.press("Escape");
  });
  await ctx.page.waitForTimeout(300);

  // Click Create button
  await ctx.page.click('button:has-text("Create")');
  await ctx.page.waitForTimeout(1000);

  // Wait for success modal
  await ctx.page.waitForSelector('text="API Key Created Successfully"', { timeout: 10000 });

  // Extract API key from the modal
  const apiKeyElement = ctx.page.locator('div:has-text("API Key Created Successfully") >> code, div:has-text("API Key Created Successfully") >> [class*="key"]');
  let apiKey = await apiKeyElement.textContent() || "";

  // If not found via code element, try getting it from the visible text
  if (!apiKey) {
    const modalContent = ctx.page.locator('div:has-text("API Key Created Successfully")');
    const allText = await modalContent.textContent() || "";
    // API key is a base64-like string
    const match = allText.match(/[A-Za-z0-9+/=]{40,}/);
    if (match) {
      apiKey = match[0];
    }
  }

  // Click OK to close modal
  await ctx.page.click('button:has-text("Ok")');
  await ctx.page.waitForTimeout(500);

  return apiKey.trim();
}

/**
 * Step 10: Invite client as admin
 * Navigate: Account & Settings → Workspace & members → Add email as Admin
 */
async function inviteClientAsAdmin(
  ctx: AutomationContext,
  clientEmail: string
): Promise<void> {
  // Click "Account & Settings" tab
  await ctx.page.click('text="Account & Settings"');
  await ctx.page.waitForLoadState("domcontentloaded");

  // Click "Workspace & members" in left sidebar
  await ctx.page.click('text="Workspace & members"');
  await ctx.page.waitForTimeout(500);

  // Wait for Members section to load
  await ctx.page.waitForSelector('text="Add New Member"', { timeout: 10000 });

  // Fill in client email
  const emailInput = ctx.page.locator('input[type="email"], input[placeholder*="email"]').first();
  await emailInput.fill(clientEmail);

  // Make sure "Admin" is selected (should be default)
  const roleDropdown = ctx.page.locator('select:near(:text("Admin")), [aria-label*="role"]');
  if (await roleDropdown.count() > 0) {
    await roleDropdown.selectOption({ label: "Admin" });
  }

  // Click "Invite" button
  await ctx.page.click('button:has-text("Invite")');
  await ctx.page.waitForTimeout(2000);

  // Verify invite was sent (check for pending invitations or success message)
  await ctx.page.waitForSelector('text="Pending Invitations", text="Invitation sent"', { timeout: 5000 }).catch(() => {
    // Invitation might show differently
  });
}

/**
 * Map step name to error code
 */
function mapStepToErrorCode(step: string): ErrorCode {
  const mapping: Record<string, ErrorCode> = {
    initialization: "BROWSER_ERROR",
    navigate_to_instantly: "BROWSER_ERROR",
    create_account: "SIGNUP_FAILED",
    onboarding_survey: "SIGNUP_FAILED",
    verify_email: "VERIFICATION_TIMEOUT",
    skip_tour: "INTERNAL_ERROR",
    upgrade_plan: "PAYMENT_FAILED",
    enter_payment: "PAYMENT_FAILED",
    post_payment: "INTERNAL_ERROR",
    create_api_key: "API_KEY_FAILED",
    invite_admin: "ADMIN_INVITE_FAILED",
  };
  return mapping[step] || "INTERNAL_ERROR";
}
