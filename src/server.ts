import express, { Request, Response, NextFunction } from "express";
import { config } from "dotenv";
import { setupInstantlyAccount } from "./automation/instantly.js";
import { logger } from "./utils/logger.js";
import type { SetupInstantlyRequest, SetupInstantlyResponse } from "./types.js";

config();

const app = express();
const PORT = process.env.PORT || 3100;
const API_KEY = process.env.API_KEY;

app.use(express.json());

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get("user-agent"),
  });
  next();
});

// Auth middleware
function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!API_KEY) {
    logger.warn("API_KEY not configured - running in development mode");
    return next();
  }

  if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
    logger.warn("Unauthorized request attempted");
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

// Health check endpoint
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  });
});

// Main automation endpoint
app.post(
  "/api/setup-instantly",
  authenticate,
  async (req: Request<{}, SetupInstantlyResponse, SetupInstantlyRequest>, res: Response) => {
    const startTime = Date.now();
    const { order_id, instantly_email, client_email } = req.body;

    logger.info("Starting Instantly setup", {
      order_id,
      instantly_email,
      client_email,
    });

    // Validate required fields
    const requiredFields = [
      "order_id",
      "instantly_email",
      "card_number",
      "card_expiry",
      "card_cvc",
      "client_email",
      "imap_host",
      "imap_user",
      "imap_password",
    ];

    const missingFields = requiredFields.filter(
      (field) => !req.body[field as keyof SetupInstantlyRequest]
    );

    if (missingFields.length > 0) {
      logger.error("Missing required fields", { missingFields, order_id });
      return res.status(400).json({
        success: false,
        error: `Missing required fields: ${missingFields.join(", ")}`,
        error_code: "VALIDATION_ERROR",
      });
    }

    try {
      const result = await setupInstantlyAccount(req.body);

      const duration = Date.now() - startTime;
      logger.info("Instantly setup completed", {
        order_id,
        success: result.success,
        duration_ms: duration,
        error_code: result.error_code,
      });

      // Send callback if provided
      if (req.body.callback_url && result) {
        try {
          await fetch(req.body.callback_url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${API_KEY}`,
            },
            body: JSON.stringify({
              order_id,
              ...result,
            }),
          });
          logger.info("Callback sent successfully", { order_id });
        } catch (callbackError) {
          logger.error("Failed to send callback", {
            order_id,
            error: callbackError instanceof Error ? callbackError.message : "Unknown",
          });
        }
      }

      res.json(result);
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      logger.error("Instantly setup failed with exception", {
        order_id,
        error: errorMessage,
        duration_ms: duration,
      });

      res.status(500).json({
        success: false,
        error: errorMessage,
        error_code: "INTERNAL_ERROR",
      });
    }
  }
);

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error("Unhandled error", { error: err.message, stack: err.stack });
  res.status(500).json({
    success: false,
    error: "Internal server error",
    error_code: "INTERNAL_ERROR",
  });
});

app.listen(PORT, () => {
  logger.info(`Instantly Automation Service running on port ${PORT}`);
});
