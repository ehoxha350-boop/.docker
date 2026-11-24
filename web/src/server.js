const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");

const app = express();
const port = Number(process.env.PORT || 3000);
const apiOrigin = new URL(process.env.API_ORIGIN || "http://localhost:8000");
const adminPassword = process.env.ADMIN_PASSWORD || "";
const apiAdminToken = process.env.API_ADMIN_TOKEN || "";

if (!adminPassword || !apiAdminToken) {
  throw new Error("Set ADMIN_PASSWORD and API_ADMIN_TOKEN before starting the web server");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

app.disable("x-powered-by");

app.post("/auth/check", express.json({ limit: "256kb" }), (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!safeEqual(password, adminPassword)) {
    return res.status(401).json({ detail: "Incorrect admin password" });
  }
  return res.json({ ok: true });
});

app.get("/p/:siteId/:slug", (_req, res) => {
  res.sendFile("post.html", { root: path.resolve(__dirname, "..", "public") });
});

app.use("/api", (req, res) => {
  const isPublic = req.path.startsWith("/public/") || req.path === "/health";
  const authorization = req.headers.authorization || "";
  if (!isPublic && !safeEqual(authorization, `Bearer ${adminPassword}`)) {
    return res.status(401).json({ detail: "Admin authentication required" });
  }

  const upstreamUrl = new URL(req.originalUrl, apiOrigin);
  const headers = { ...req.headers, host: upstreamUrl.host };
  delete headers.authorization;
  if (!isPublic) headers["x-admin-token"] = apiAdminToken;

  const proxyRequest = http.request(
    upstreamUrl,
    { method: req.method, headers },
    (proxyResponse) => {
      res.writeHead(proxyResponse.statusCode || 502, proxyResponse.headers);
      proxyResponse.pipe(res);
    },
  );

  proxyRequest.on("error", (error) => {
    console.error("API proxy request failed:", error.message);
    if (!res.headersSent) {
      res.status(502).json({ detail: "Site administration API is unavailable" });
    }
  });

  req.pipe(proxyRequest);
});

app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(port, "0.0.0.0", () => {
  console.log(`Site administration dashboard listening on port ${port}`);
});
