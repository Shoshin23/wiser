import "dotenv/config";
import express from "express";
import cors from "cors";
import { router } from "./routes";
import { askAgent } from "./agent";

const PORT = Number(process.env.PORT ?? 8787);

for (const name of ["GROQ_API_KEY", "ANTHROPIC_API_KEY"]) {
  if (!process.env[name]) {
    console.error(`FATAL: ${name} is not set. Copy backend/.env.example to backend/.env and fill it in.`);
    process.exit(1);
  }
}

const app = express();
app.use(cors({ origin: true })); // permissive for the hackathon
app.use(express.json({ limit: "15mb" }));
app.use("/api", router);

app.listen(PORT, () => {
  console.log(`wiser backend listening on http://localhost:${PORT}`);
  // Pay the Agent SDK subprocess cold-start now, not on the first real request.
  askAgent("Reply with the single word: ready.")
    .then((r) => console.log(`[warm-up] agent ok: ${r.slice(0, 60)}`))
    .catch((e) => console.warn("[warm-up] agent failed (continuing):", e instanceof Error ? e.message : e));
});
