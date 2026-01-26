import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";
import { requireAuth } from "../middleware/auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "data");
const USERS_PATH = path.join(DATA_DIR, "users.json");
const JWT_SECRET = process.env.JWT_SECRET;

const AMOUNT_TO_TOKENS = {
  5: 7,
  10: 20,
  20: 50
};

const AMOUNT_TO_PLAN = {
  5: "basic",
  10: "premium",
  20: "premium_plus"
};

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_BASE_URL = process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com";
const PAYPAL_MERCHANT_ID = process.env.PAYPAL_MERCHANT_ID || "";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function assertPayPalConfigured() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    const err = new Error("PayPal credentials are not configured.");
    err.status = 500;
    throw err;
  }
}

function normalizeAmountValue(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return null;
  }
  return Number(amount.toFixed(2));
}

function resolveAllowedAmount(amount) {
  if (!AMOUNT_TO_TOKENS[amount]) {
    return null;
  }
  return amount;
}

async function getPayPalAccessToken() {
  assertPayPalConfigured();

  const credentials = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error_description || "Failed to fetch PayPal access token.");
    err.status = 502;
    throw err;
  }

  if (!data?.access_token) {
    const err = new Error("PayPal access token is missing.");
    err.status = 502;
    throw err;
  }

  return data.access_token;
}

async function paypalRequest(pathname, { method = "GET", accessToken, body } = {}) {
  const response = await fetch(`${PAYPAL_BASE_URL}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.message || "PayPal request failed.");
    err.status = 502;
    throw err;
  }

  return data;
}

function readUsers() {
  try {
    const raw = fs.readFileSync(USERS_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2), "utf8");
}

function signUserToken(user) {
  if (!JWT_SECRET) {
    const err = new Error("JWT secret is not configured.");
    err.status = 500;
    throw err;
  }

  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      plan: user.plan
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function creditTokensForUser(email, amount) {
  const tokens = AMOUNT_TO_TOKENS[amount];
  const plan = AMOUNT_TO_PLAN[amount];

  if (!tokens || !plan) {
    const err = new Error("Unsupported amount.");
    err.status = 400;
    throw err;
  }

  const users = readUsers();
  const normalized = normalizeEmail(email);
  const user = users.find((u) => normalizeEmail(u.email) === normalized);
  if (!user) {
    const err = new Error("User not found.");
    err.status = 404;
    throw err;
  }

  if (typeof user.tokens !== "number" || Number.isNaN(user.tokens)) {
    user.tokens = 0;
  }

  user.tokens += tokens;
  user.plan = plan;
  writeUsers(users);

  return {
    user,
    tokens
  };
}

export function registerWebhookRoutes(app) {
  /**
   * Client-side PayPal confirmation hook.
   * Expects authenticated user and amount that was paid.
   * This does NOT validate against PayPal servers; it relies on auth + client flow.
   */
  app.post("/api/payments/paypal/credit", requireAuth, (req, res) => {
    return res.status(410).json({
      error: "Legacy PayPal credit endpoint is disabled. Use create-order and capture-order."
    });
  });

  app.post("/api/payments/paypal/create-order", requireAuth, async (req, res) => {
    try {
      const amount = resolveAllowedAmount(normalizeAmountValue(req.body?.amount));
      if (!amount) {
        return res.status(400).json({ error: "Unsupported amount." });
      }

      const accessToken = await getPayPalAccessToken();
      const order = await paypalRequest("/v2/checkout/orders", {
        method: "POST",
        accessToken,
        body: {
          intent: "CAPTURE",
          purchase_units: [
            {
              amount: {
                currency_code: "EUR",
                value: amount.toFixed(2)
              }
            }
          ]
        }
      });

      if (!order?.id) {
        return res.status(502).json({ error: "PayPal order ID missing." });
      }

      return res.json({ id: order.id });
    } catch (err) {
      const status = err.status || 500;
      return res.status(status).json({ error: err.message || "Failed to create PayPal order." });
    }
  });

  app.post("/api/payments/paypal/capture-order", requireAuth, async (req, res) => {
    try {
      const orderId = String(req.body?.orderId || "").trim();
      if (!orderId) {
        return res.status(400).json({ error: "Order ID is required." });
      }

      const accessToken = await getPayPalAccessToken();
      const order = await paypalRequest(`/v2/checkout/orders/${orderId}/capture`, {
        method: "POST",
        accessToken
      });

      const purchaseUnit = order?.purchase_units?.[0];
      const capture = purchaseUnit?.payments?.captures?.[0];
      const status = capture?.status || order?.status;
      const value = normalizeAmountValue(capture?.amount?.value);
      const currency = capture?.amount?.currency_code;

      if (status !== "COMPLETED") {
        return res.status(400).json({ error: "PayPal order not completed." });
      }

      if (!value || !currency || currency !== "EUR") {
        return res.status(400).json({ error: "Invalid PayPal capture amount." });
      }

      const allowedAmount = resolveAllowedAmount(value);
      if (!allowedAmount) {
        return res.status(400).json({ error: "Unsupported capture amount." });
      }

      if (PAYPAL_MERCHANT_ID) {
        const payeeId = purchaseUnit?.payee?.merchant_id;
        if (payeeId && payeeId !== PAYPAL_MERCHANT_ID) {
          return res.status(400).json({ error: "Payee mismatch for PayPal capture." });
        }
      }

      const result = creditTokensForUser(req.user?.email, allowedAmount);
      const token = signUserToken(result.user);

      return res.json({
        ok: true,
        plan: result.user.plan,
        tokensAdded: result.tokens,
        totalTokens: result.user.tokens,
        token
      });
    } catch (err) {
      const status = err.status || 500;
      return res.status(status).json({ error: err.message || "Failed to capture PayPal order." });
    }
  });
}
