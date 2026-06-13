// Single edit point for the backend URL.
//  - Local dev:    http://localhost:8787
//  - On-glasses:   your cloudflared HTTPS tunnel, e.g. https://xxxx.trycloudflare.com
// (The tunnel URL changes each restart on the free tier — update it here.)
window.WISER_CONFIG = {
  BACKEND_URL: "http://localhost:8787",
};
