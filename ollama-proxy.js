import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { Readable } from "stream";

const app = express();

app.use(express.json({ limit: "10mb" }));

const API_KEY = process.env.API_KEY || "super-secret-key";
const OLLAMA_BASE = process.env.OLLAMA_BASE || "http://localhost:11434";
const PORT = Number(process.env.PORT || 3494);

console.log("PORT =", PORT);

// Constant-time API key check
function isAuthorized(authHeader) {
  if (!authHeader || typeof authHeader !== "string") return false;

  const expected = `Bearer ${API_KEY}`;

  if (authHeader.length !== expected.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      Buffer.from(authHeader),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

// Public health endpoint
app.get("/health", (req, res) => {
  res.send("OK");
});

// Protect everything else
app.use((req, res, next) => {
  if (!isAuthorized(req.headers.authorization)) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  next();
});

async function proxyRequest(req, res, ollamaPath) {
  try {
    const ollamaRes = await fetch(`${OLLAMA_BASE}${ollamaPath}`, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
      },
      body:
        req.method === "POST" ||
        req.method === "PUT" ||
        req.method === "PATCH"
          ? JSON.stringify(req.body)
          : undefined,
    });

    // Copy headers
    for (const [key, value] of ollamaRes.headers.entries()) {
      if (
        ![
          "transfer-encoding",
          "connection",
          "keep-alive",
          "proxy-authenticate",
          "proxy-authorization",
          "te",
          "trailers",
          "upgrade",
        ].includes(key.toLowerCase())
      ) {
        res.setHeader(key, value);
      }
    }

    res.status(ollamaRes.status);

    // Handle streamed responses
    if (ollamaRes.body) {
      Readable.fromWeb(ollamaRes.body).pipe(res);
    } else {
      const text = await ollamaRes.text();
      res.send(text);
    }
  } catch (err) {
    console.error("Proxy error:", err);

    res.status(502).json({
      error: "Bad gateway",
      details: err.message,
    });
  }
}

// OpenAI-compatible endpoints
app.post("/v1/chat/completions", (req, res) => {
  proxyRequest(req, res, "/v1/chat/completions");
});

app.post("/api/chat", (req, res) => {
  proxyRequest(req, res, "/api/chat");
});

app.post("/api/generate", (req, res) => {
  proxyRequest(req, res, "/api/generate");
});

app.get("/v1/models", (req, res) => {
  proxyRequest(req, res, "/v1/models");
});

// Diagnostics
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});

process.on("exit", (code) => {
  console.log("Process exiting with code:", code);
});

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`Ollama proxy running on http://127.0.0.1:${PORT}`);
});

server.on("error", (err) => {
  console.error("Server error:", err);
});