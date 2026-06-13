import { Router } from "express";
import multer from "multer";
import { runAsk, runAskText } from "./pipeline";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
});

export const router = Router();

router.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Voice (+ optional image) -> spoken answer card. multipart: audio, image
router.post(
  "/ask",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const audio = files?.audio?.[0];
      if (!audio) return res.status(400).json({ error: "missing 'audio' file" });
      const image = files?.image?.[0];

      const result = await runAsk(audio.buffer, {
        filename: audio.originalname || "recording.webm",
        contentType: audio.mimetype || "audio/webm",
        imageB64: image ? image.buffer.toString("base64") : undefined,
        imageMediaType: image?.mimetype,
      });
      res.json(result);
    } catch (err) {
      console.error("/ask error:", err);
      res.status(500).json({ error: errMsg(err) });
    }
  },
);

// Typed-prompt fallback (bypasses STT). JSON: { text, imageB64?, imageMediaType? }
router.post("/ask-text", async (req, res) => {
  try {
    const { text, imageB64, imageMediaType } = req.body ?? {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "missing 'text'" });
    }
    const result = await runAskText(text, imageB64, imageMediaType);
    res.json(result);
  } catch (err) {
    console.error("/ask-text error:", err);
    res.status(500).json({ error: errMsg(err) });
  }
});

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
