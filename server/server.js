import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";

const app = express();
app.use(cors({ origin: "*", methods: ["GET","POST"] }));
app.use(express.json());

const UPLOAD_DIR = "./audio";
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".bin";
    cb(null, `${req.params.code}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

app.get("/ping", (req, res) => res.json({ ok: true }));

app.post("/audio/:code", upload.single("audio"), (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR);
  files.filter(f => f.startsWith(req.params.code + ".") && f !== req.file.filename)
       .forEach(f => fs.unlinkSync(path.join(UPLOAD_DIR, f)));
  console.log(`Uploaded: ${req.params.code} — ${req.file?.filename}`);
  res.json({ ok: true, code: req.params.code, file: req.file?.filename });
});

app.get("/audio/:code", (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR);
  const match = files.find(f => f.startsWith(req.params.code + "."));
  if (!match) return res.status(404).json({ error: "Not found" });
  console.log(`Serving: ${match}`);
  res.sendFile(path.resolve(path.join(UPLOAD_DIR, match)));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on :${PORT}`);
  // Keep-alive ping for Render free tier
  const SELF_URL = process.env.RENDER_EXTERNAL_URL;
  if (SELF_URL) {
    setInterval(() => {
      fetch(`${SELF_URL}/ping`).catch(() => {});
    }, 10 * 60 * 1000);
    console.log(`Keep-alive ping enabled for ${SELF_URL}`);
  }
});
