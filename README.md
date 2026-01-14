# Instantly.ai Automation Service

Playwright-based browser automation service to create Instantly.ai workspaces for customers who select the "setup_instantly" option ($47 fee).

## Overview

This microservice automates the entire Instantly.ai account creation process:
- Account signup with affiliate tracking
- Email verification via Roundcube webmail
- Payment processing (Growth plan @ $47/mo)
- API key creation with full scopes
- Client invitation as admin

## Architecture

```
n8n Workflow (Order Handler)
        ↓
    HTTP Request
        ↓
┌───────────────────────────────────────┐
│  Playwright Service (zeus.local:3100) │
│                                       │
│  1. Navigate to instantly.ai/?via=jay │
│  2. Create account with signup form   │
│  3. Complete onboarding survey        │
│  4. Verify email via webmail          │
│  5. Upgrade to Growth plan ($47/mo)   │
│  6. Complete Stripe payment           │
│  7. Create API key (all:all scope)    │
│  8. Invite client as admin            │
│                                       │
│  Returns: credentials + API key       │
└───────────────────────────────────────┘
        ↓
    Callback to App
```

## API Endpoint

### POST /api/setup-instantly

Creates a new Instantly.ai workspace for a customer.

**Request:**
```json
{
  "order_id": "uuid",
  "instantly_email": "firstname.lastname@lgjconnect.com",
  "client_email": "customer@example.com",
  "client_name": "John Doe",
  "card_number": "4111111111111111",
  "card_expiry": "12/25",
  "card_cvc": "123",
  "imap_host": "mail.lgjconnect.com",
  "imap_user": "firstname.lastname@lgjconnect.com",
  "imap_password": "email_password_here",
  "callback_url": "https://inbox.leadgenjay.com/api/n8n/instantly-setup-complete"
}
```

**Success Response:**
```json
{
  "success": true,
  "instantly_email": "firstname.lastname@lgjconnect.com",
  "instantly_password": "generated_secure_password",
  "instantly_api_key": "api_key_here",
  "affiliate_verified": true
}
```

**Failure Response:**
```json
{
  "success": false,
  "error": "Error message",
  "error_code": "SIGNUP_FAILED",
  "screenshot_url": "/screenshots/order-123-create_account-error.png",
  "step_failed": "create_account"
}
```

## Automation Flow (10 Steps)

### Step 1: Navigate to Instantly
- URL: `https://instantly.ai/?via=jay` (affiliate link)
- Click "START FOR FREE" button
- Redirects to `app.instantly.ai/auth/signup`

### Step 2: Create Account (Signup Form)
- Fill "First Name" (parsed from client_name or email)
- Fill "Last Name"
- Fill "Email" (instantly_email)
- Fill "Password" (auto-generated secure password)
- Check terms checkbox
- Click "Join Now"

### Step 3: Complete Onboarding Survey
- "Where did you find us?" → Type "Lead Gen Jay" in text input
- "What best describes your industry?" → Click "Agency"
- "Company Size" → Click "1-10"
- Click "Continue"

### Step 4: Verify Email via Webmail
- Open new browser tab to Roundcube: `https://lgjconnect.com:2096/?_user=<email>`
- Enter email password
- Click "LOGIN"
- Poll inbox for email from `support@instantly.ai` with subject "Welcome to Instantly"
- Click on email to open
- Click "Click here to confirm your email" link (opens in new tab)
- Verification complete - now on Instantly dashboard

### Step 5: Skip Tour
- Close any "Welcome" popups
- Click "Skip Tour" link if present

### Step 6: Upgrade to Growth Plan
- Click user avatar/icon in bottom left sidebar
- Click "Settings"
- Click "Email Outreach" tab under Billing & Usage
- Find Growth plan section ($47/mo)
- Click "Update Plan"
- Confirmation modal appears: "Great decision!"
- Click "Yes, purchase"
- Redirects to Stripe checkout

### Step 7: Complete Stripe Payment
- This is a full Stripe checkout page (NOT an iframe)
- Fill card number: `1234 1234 1234 1234`
- Fill expiry: `MM / YY`
- Fill CVC
- Fill cardholder name: "Jay Feldman"
- Fill billing address:
  - Address: "700 NE 25th Street"
  - City: "Miami"
  - State: "Florida" (dropdown)
  - ZIP: "33137"
- **IMPORTANT:** Uncheck "Save my information for faster checkout"
- **NOTE:** Skip coupon code "LGJ" (currently invalid)
- Click "Subscribe"
- Wait for redirect back to Instantly

### Step 8: Handle Post-Payment
- Close any "Welcome back" popups
- Wait for page to stabilize

### Step 9: Create API Key
- Navigate to Settings → Integrations → API Keys
- Click "Version 2" tab if not already selected
- Click "Create API Key"
- Fill name: "LGJ"
- Click "Select scopes" dropdown
- Select "all:all"
- Click outside dropdown to close it (required!)
- Click "Create"
- Copy API key from success modal
- Click "Ok" to close modal

### Step 10: Invite Client as Admin
- Click "Account & Settings" tab
- Click "Workspace & members" in sidebar
- Fill client email in the invite form
- Ensure "Admin" role is selected
- Click "Invite"

## Error Codes

| Code | Description |
|------|-------------|
| `VALIDATION_ERROR` | Invalid request parameters |
| `SIGNUP_FAILED` | Account creation or onboarding failed |
| `VERIFICATION_TIMEOUT` | Email verification timed out (2 min limit) |
| `VERIFICATION_FAILED` | Could not complete email verification |
| `PAYMENT_FAILED` | Stripe payment or plan upgrade failed |
| `API_KEY_FAILED` | Could not create API key |
| `ADMIN_INVITE_FAILED` | Could not invite client as admin |
| `TIMEOUT` | General timeout |
| `BROWSER_ERROR` | Browser launch or navigation failed |
| `INTERNAL_ERROR` | Unknown error |

## Environment Variables

```env
# Service Port
PORT=3100

# API Key for authentication
PLAYWRIGHT_SERVICE_API_KEY=your_secret_key

# Headless mode (set to "false" for debugging)
HEADLESS=true

# Screenshots storage path
SCREENSHOTS_PATH=./screenshots
```

## Deployment

### Docker Compose

```yaml
version: '3.8'
services:
  instantly-automation:
    build: .
    ports:
      - "3100:3100"
    environment:
      - PORT=3100
      - PLAYWRIGHT_SERVICE_API_KEY=${PLAYWRIGHT_SERVICE_API_KEY}
      - HEADLESS=true
    volumes:
      - ./screenshots:/app/screenshots
    restart: unless-stopped
```

### Deploy to zeus.local

```bash
# Build and push
docker build -t instantly-automation .
docker save instantly-automation | ssh zeus.local docker load

# Or use docker-compose
docker-compose up -d
```

## Debugging

### View Logs
```bash
docker logs instantly-automation -f
```

### Non-Headless Mode
Set `HEADLESS=false` to watch the browser automation in action:
```bash
HEADLESS=false npm run dev
```

### Screenshots
On any failure, a screenshot is captured and saved to `/screenshots/` with the pattern:
`{order_id}-{step_name}-error.png`

## n8n Workflow Integration

The n8n workflow "Instantly Playwright Automation" (ID: q62nk0mbsu1l3N8K) calls this service.

### Input from Order Handler
```javascript
{
  order_id: orderData.order_id,
  instantly_email: `${firstName}.${lastName}@lgjconnect.com`,
  email_password: 'LGJsecurepass123?',
  client_email: orderData.email,
  client_name: `${orderData['First name']} ${orderData['Last name']}`,
  cardData: {
    pan: cardData.pan,
    expirationMonth: cardData.expirationMonth,
    expirationYear: cardData.expirationYear,
    cvv: cardData.cvv
  }
}
```

### Callback Endpoint
Results are sent to: `POST /api/n8n/instantly-setup-complete`

## Hardcoded Values

| Value | Description |
|-------|-------------|
| `instantly.ai/?via=jay` | Affiliate tracking URL |
| `Lead Gen Jay` | Referral source in onboarding |
| `Agency` | Industry selection |
| `1-10` | Company size selection |
| `lgjconnect.com:2096` | Webmail server |
| `Jay Feldman` | Billing name |
| `700 NE 25th Street` | Billing address |
| `Miami, FL 33137` | Billing city/state/zip |
| `LGJ` | API key name |
| `all:all` | API key scope |
| `Admin` | Client invitation role |

## Security Notes

1. **Credit card data** is passed through and never stored
2. **Passwords** are encrypted with AES-256-GCM before storage
3. **Service** runs on internal network only (zeus.local)
4. **Screenshots** are not publicly accessible
