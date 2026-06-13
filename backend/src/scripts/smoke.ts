import "dotenv/config";
import { askAgent } from "../agent";

// Quick proof the Agent SDK + ANTHROPIC_API_KEY + subprocess all work.
// Usage: npm run smoke -- "your prompt here"
const prompt = process.argv.slice(2).join(" ") || "Say hello in one short sentence.";

askAgent(prompt)
  .then((answer) => {
    console.log("PROMPT:", prompt);
    console.log("ANSWER:", answer);
    process.exit(0);
  })
  .catch((err) => {
    console.error("ERROR:", err);
    process.exit(1);
  });
