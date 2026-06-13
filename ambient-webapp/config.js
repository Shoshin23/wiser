// Runtime config for the ambient webapp.
// When served by server.js this file is GENERATED (see server.js → configJs()).
// This static default is the fallback for static hosting / opening the file directly.
window.WISER_CONFIG = {
  BACKEND_URL: "",        // same origin (served by server.js); set to a full URL for split hosting
  CHUNK_MS: 5000,         // rolling STT segment length
  SCAN_INTERVAL_MS: 8000, // debounced opportunity-scan cadence
};
