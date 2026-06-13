// Runtime config for the glasses webapp.
//
// When served by server.js this file is GENERATED from environment variables:
//   WISER_DEMO=true        → seeded demo data, no live coding session (review/rehearse)
//   WISER_DEMO=false       → live app (talks to the orchestrator backend)
//   WISER_BACKEND_URL=...   → backend base URL (default http://localhost:8787)
//
// You can also override per-load with a URL param: ?demo=1 / ?demo=0
// (This static default is the fallback for Vercel/static hosting.)
window.WISER_CONFIG = {
  BACKEND_URL: "http://localhost:8787",
  DEMO: true, // default on so the app runs standalone; flip via WISER_DEMO=false
};
