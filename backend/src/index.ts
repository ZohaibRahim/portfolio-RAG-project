import express, {
  NextFunction,
  Request,
  Response,
} from "express";
import cors from "cors";
import helmet from "helmet";
import {
  ipKeyGenerator,
  rateLimit,
} from "express-rate-limit";

import { env } from "./config/env.js";
import { answerQuestion } from "./services/ragService.js";

/**
 * Create the Express application.
 */
const app = express();

/**
 * Azure App Service sits behind a reverse proxy.
 *
 * Trust one proxy hop so Express can use the forwarded
 * client IP for rate limiting.
 */
app.set("trust proxy", 1);

/**
 * Maximum allowed question length.
 */
const MAX_QUESTION_LENGTH = 500;

/**
 * Maximum /api/ask requests allowed per IP per minute.
 */
const ASK_RATE_LIMIT_PER_MINUTE = 20;

/**
 * Do not expose Express through X-Powered-By.
 */
app.disable("x-powered-by");

/**
 * Common HTTP security headers.
 *
 * Cross-Origin-Resource-Policy is explicitly relaxed to
 * "cross-origin" because this API is called by a React
 * frontend served from a different origin (localhost:5173
 * during development, the Vercel domain in production).
 * Helmet's default `same-origin` policy would otherwise
 * fight our CORS configuration.
 */
app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: "cross-origin",
    },
  })
);

// Allow the React development server to call the backend.
//
// During local development:
// React  -> http://localhost:5173
// API    -> http://localhost:3000
app.use(
  cors({
    origin: env.allowedOrigin,
  })
);

/**
 * Parse incoming JSON bodies.
 *
 * Portfolio questions are tiny, so 10 KB is more than
 * enough. Rejecting oversize bodies here — before the
 * route handler sees them — is a cheap first line of
 * defence against abuse.
 */
app.use(
  express.json({
    limit: "10kb",
  })
);

/**
 * Simple health endpoint.
 *
 * Returns only the minimum a monitor needs. We deliberately
 * do NOT expose the AI provider or search index name here,
 * so an unauthenticated client cannot tell whether we are
 * running on Ollama, Azure OpenAI, or which Search index
 * is active.
 */
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
  });
});

/**
 * Build a stable rate-limit key from the client IP.
 *
 * Azure App Service may expose IPv4 client addresses
 * through Express as:
 *
 *   203.0.113.10:54321
 *
 * The source port changes between connections, so it must
 * not be part of the rate-limit identity.
 *
 * After removing an Azure-added port, ipKeyGenerator()
 * handles IPv4 normally and applies appropriate subnet
 * handling for IPv6 clients.
 */
function getRateLimitKey(req: Request): string {
  const rawIp =
    req.ip ??
    req.socket.remoteAddress ??
    "unknown";

  let normalizedIp = rawIp;

  /**
   * Azure commonly supplies IPv4 addresses with a source
   * port, for example:
   *
   *   50.69.228.123:51855
   *
   * Remove only the port portion.
   */
  const ipv4WithPort =
    normalizedIp.match(
      /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/
    );

  if (ipv4WithPort) {
    normalizedIp = ipv4WithPort[1];
  }

  /**
   * Also support bracketed IPv6 with a port:
   *
   *   [2001:db8::1]:54321
   *
   * Normal IPv6 addresses without a port are left intact.
   */
  const ipv6WithPort =
    normalizedIp.match(
      /^\[([0-9a-fA-F:]+)\]:\d+$/
    );

  if (ipv6WithPort) {
    normalizedIp = ipv6WithPort[1];
  }

  return ipKeyGenerator(
    normalizedIp
  );
}

/**
 * Rate limiter for /api/ask only.
 *
 * We deliberately do not rate-limit /api/health so external
 * monitoring probes stay unaffected.
 */
const askLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: ASK_RATE_LIMIT_PER_MINUTE,

  /**
   * Azure's proxy may append a source port to req.ip.
   * Normalize it before using the IP as the rate-limit key.
   */
  keyGenerator: (req) =>
    getRateLimitKey(req),

  standardHeaders: "draft-7",
  legacyHeaders: false,

  handler: (_req, res) => {
    res.status(429).json({
      error:
        "Too many requests. Please try again shortly.",
    });
  },
});

/**
 * Handler for POST /api/ask.
 *
 * Validation flow:
 * 1. Question must be present and a string.
 * 2. After whitespace trimming, it must not be empty.
 * 3. After trimming, it must be no longer than
 *    MAX_QUESTION_LENGTH.
 *
 * Unexpected errors are handed off to the centralized error
 * middleware via `next(error)` so this handler doesn't have
 * to duplicate the "safe error response" logic.
 */
async function askHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const rawQuestion = req.body?.question;

    if (typeof rawQuestion !== "string") {
      res.status(400).json({
        error: "Question must be a string.",
      });
      return;
    }

    const question = rawQuestion.trim();

    if (question.length === 0) {
      res.status(400).json({
        error: "Question cannot be empty.",
      });
      return;
    }

    if (question.length > MAX_QUESTION_LENGTH) {
      res.status(400).json({
        error:
          `Question must be ${MAX_QUESTION_LENGTH} characters or fewer.`,
      });
      return;
    }

    // Run retrieval + grounded answer generation.
    const result = await answerQuestion(question);

    res.json(result);
  } catch (error) {
    // Delegate to the centralized error handler.
    next(error);
  }
}

/**
 * Route registration.
 *
 * askLimiter runs before askHandler so a client that is
 * already over quota never reaches the RAG pipeline.
 */
app.post("/api/ask", askLimiter, askHandler);

/**
 * Body-parser error handler.
 *
 * When express.json() encounters malformed JSON, it forwards
 * a SyntaxError with `type: "entity.parse.failed"`. When the
 * body exceeds our 10 KB limit, it forwards an error with
 * `type: "entity.too.large"`. We translate both into clean
 * client-facing responses before they hit the generic 500
 * handler below.
 */
app.use(
  (
    error: unknown,
    _req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const bodyError = error as {
      type?: string;
      status?: number;
    };

    if (bodyError.type === "entity.parse.failed") {
      res.status(400).json({
        error: "Invalid JSON body.",
      });
      return;
    }

    if (bodyError.type === "entity.too.large") {
      res.status(413).json({
        error: "Request body too large.",
      });
      return;
    }

    next(error);
  }
);

/**
 * Centralized error handler.
 *
 * Any error that reaches this point is logged server-side
 * for debugging but only ever surfaces to the client as a
 * generic 500. This guarantees we never leak:
 *
 * - stack traces
 * - Azure error bodies
 * - API keys
 * - internal endpoint URLs
 * - AI provider or model names
 */
app.use(
  (
    error: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    console.error(error);

    if (res.headersSent) {
      return;
    }

    res.status(500).json({
      error: "An unexpected error occurred.",
    });
  }
);

// Start the backend server.
app.listen(env.port, () => {
  console.log(
    `Portfolio RAG API running at http://localhost:${env.port}`
  );

  console.log(
    `AI provider: ${env.aiProvider}`
  );

  console.log(
    `Search index: ${env.azureSearchIndexName}`
  );
});
