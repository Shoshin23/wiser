// Tiny static file server (local dev + Vercel-compatible).
// Special-cases /config.js: serves it GENERATED from environment variables so
// the demo/live toggle is env-based (WISER_DEMO, WISER_BACKEND_URL).
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const mime = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function configJs() {
  const cfg = {
    BACKEND_URL: process.env.WISER_BACKEND_URL || "http://localhost:8787",
    // default DEMO=true unless explicitly set to "false"
    DEMO: process.env.WISER_DEMO ? process.env.WISER_DEMO === "true" : true,
  };
  return "// generated from env by server.js\nwindow.WISER_CONFIG = " + JSON.stringify(cfg, null, 2) + ";\n";
}

http
  .createServer((req, res) => {
    let urlPath = req.url.split("?")[0];

    if (urlPath === "/config.js") {
      res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
      res.end(configJs());
      return;
    }

    let filePath = "." + (urlPath === "/" ? "/index.html" : urlPath);
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("<h1>404 Not Found</h1>");
        return;
      }
      res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream" });
      res.end(content);
    });
  })
  .listen(PORT, () => {
    const demo = process.env.WISER_DEMO ? process.env.WISER_DEMO === "true" : true;
    console.log("glasses-webapp on http://localhost:" + PORT + "  (DEMO=" + demo + ")");
  });
