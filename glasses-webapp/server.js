// Tiny static file server (local dev + Vercel-compatible).
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

http
  .createServer((req, res) => {
    let urlPath = req.url.split("?")[0];
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
  .listen(PORT, () => console.log("glasses-webapp on http://localhost:" + PORT));
