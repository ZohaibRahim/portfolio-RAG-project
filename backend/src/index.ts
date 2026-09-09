import express, {
  NextFunction,
  Request,
  Response,
} from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import { env } from "./config/env.js";
import { answerQuestion } from "./services/ragService.js";

/**
 * Maximum allowed length for a portfolio question after
 * whitespace trimming.
 *
 * 500 characters comfortably fits any realistic question
 * while making it more expensive for a bad actor to spam
 * long, token-heavy requests through /api/ask.
 */
const MAX_QUESTION_LENGTH = 500;

/**
 * Number of /api/ask requests allowed per IP per minute.
 *
 * Small enough to blunt basic abuse but well above what a
 * real portfolio visitor would ever need. The rate limiter
 * uses express-rate-limit's default in-memory store which
 * is fine for the single-instance V1 deployment; a shared
 * store (Redis, API gateway) would be required if the
 * backend is ever scaled horizontally.
 */
const ASK_RATE_LIMIT_PER_MINUTE = 20;

// Create the Express application.
const app = express();

/**
 * Do not advertise Express as the server framework via the
 * default X-Powered-By response header. Helmet already
 * removes this header, but disabling it explicitly makes
 * the intent obvious and does not rely on helmet's future
 * defaults.
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
 * Rate limiter for /api/ask only.
 *
 * We deliberately do not rate-limit /api/health so external
 * monitoring probes stay unaffected.
 */
const askLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: ASK_RATE_LIMIT_PER_MINUTE,
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
