
import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const required = [
  "TELEGRAM_API_ID",
  "TELEGRAM_API_HASH",
  "TELEGRAM_SESSION_STRING",
  "PUBLIC_BASE_URL",
  "MEDIA_SECRET"
];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }
}

const channels = (process.env.TELEGRAM_CHANNELS || "")
  .split(",")
  .map(c => c.trim().replace(/^@/, ""))
  .filter(Boolean);

const client = new TelegramClient(
  new StringSession(process.env.TELEGRAM_SESSION_STRING),
  Number(process.env.TELEGRAM_API_ID),
  process.env.TELEGRAM_API_HASH,
  { connectionRetries: 5 }
);

const app = express();
app.disable("x-powered-by");

const baseUrl = process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
const secret = process.env.MEDIA_SECRET;
const maxFileBytes = Number(process.env.MAX_FILE_MB || 150) * 1024 * 1024;

const manifest = {
  id: "dev.thegodgivenkido.telegram-library",
  name: "Telegram Music Library",
  version: "1.0.0",
  resources: ["search", "stream"],
  bitchordAuth: false,
  allowDownloads: 0
};

function trackId(channel, messageId) {
  return Buffer.from(JSON.stringify({
    channel,
    messageId
  })).toString("base64url");
}

function parseTrackId(id) {
  try {
    const data = JSON.parse(
      Buffer.from(id, "base64url").toString()
    );

    if (
      !channels.includes(data.channel) ||
      !Number.isInteger(data.messageId)
    ) return null;

    return data;
  } catch {
    return null;
  }
}

function sign(id, expires) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${id}.${expires}`)
    .digest("hex");
}

function equal(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function getAudioInfo(message) {
  const doc = message?.media?.document;
  if (!doc) return null;

  const attrs = doc.attributes || [];

  const audio = attrs.find(
    a => a.className === "DocumentAttributeAudio"
  );

  const filename = attrs.find(
    a => a.className === "DocumentAttributeFilename"
  )?.fileName || "";

  const title =
    audio?.title ||
    filename.replace(/\.[^.]+$/, "") ||
    "Telegram audio";

  const artist = audio?.performer || "Unknown artist";

  const extension = filename.includes(".")
    ? filename.split(".").pop().toLowerCase()
    : "";

  const format = extension ||
    (doc.mimeType?.includes("flac") ? "flac" : "mp3");

  return {
    title,
    artist,
    duration: Number(audio?.duration || 0),
    format,
    mime: doc.mimeType || "audio/mpeg",
    size: Number(doc.size || 0)
  };
}

app.get("/manifest.json", (_req, res) => {
  res.json(manifest);
});

app.get("/health", (_req, res) => {
  res.json({
    ok: client.connected,
    channels: channels.length,
    readOnly: true
  });
});

app.get("/search", async (req, res) => {
  const query = String(req.query.q || "").trim();

  if (query.length < 2) {
    return res.json({ tracks: [] });
  }

  try {
    const results = await Promise.all(
      channels.map(async channel => {
        try {
          const entity = await client.getEntity(`@${channel}`);

          const messages = await client.getMessages(entity, {
            search: query,
            limit: Number(process.env.SEARCH_LIMIT_PER_CHANNEL || 12)
          });

          return messages
            .filter(m => m?.id && m.media?.document)
            .map(message => {
              const info = getAudioInfo(message);

              if (!info || info.size > maxFileBytes) return null;

              return {
                id: trackId(channel, Number(message.id)),
                title: info.title,
                artist: info.artist,
                album: channel,
                duration: info.duration,
                format: info.format,
                audioQuality:
                  info.format === "flac" ? "LOSSLESS" : "HIGH"
              };
            })
            .filter(Boolean);

        } catch (error) {
          console.error(`Search failed: @${channel}`, error.message);
          return [];
        }
      })
    );

    res.json({ tracks: results.flat().slice(0, 40) });

  } catch (error) {
    console.error(error);
    res.status(503).json({ error: "Search unavailable" });
  }
});

app.get("/stream/:id", (req, res) => {
  const id = req.params.id;

  if (!parseTrackId(id)) {
    return res.status(404).json({ error: "Track not found" });
  }

  const expires = Math.floor(Date.now() / 1000) + 1800;
  const signature = sign(id, expires);

  const url =
    `${baseUrl}/audio/${encodeURIComponent(id)}` +
    `?expires=${expires}&sig=${signature}`;

  res.json({
    url,
    format: "audio",
    encrypted: false
  });
});

app.get("/audio/:id", async (req, res) => {
  const id = req.params.id;
  const data = parseTrackId(id);
  const expires = Number(req.query.expires);
  const signature = String(req.query.sig || "");

  if (
    !data ||
    !Number.isInteger(expires) ||
    expires < Math.floor(Date.now() / 1000) ||
    !equal(signature, sign(id, expires))
  ) {
    return res.status(403).end("Invalid or expired link");
  }

  try {
    const entity = await client.getEntity(`@${data.channel}`);

    const messages = await client.getMessages(entity, {
      ids: [data.messageId]
    });

    const message = messages[0];
    const info = getAudioInfo(message);

    if (!info || info.size > maxFileBytes) {
      return res.status(404).end("Audio unavailable");
    }

    const downloaded = await client.downloadMedia(message, {});

    if (!downloaded) {
      return res.status(502).end("Download failed");
    }

    const buffer = Buffer.from(downloaded);

    res.set("Content-Type", info.mime);
    res.set("Accept-Ranges", "bytes");
    res.set("Cache-Control", "private, no-store");

    const range = req.headers.range;

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);

      if (!match) return res.status(416).end();

      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2]
        ? Math.min(Number(match[2]), buffer.length - 1)
        : buffer.length - 1;

      if (start > end || start >= buffer.length) {
        res.set("Content-Range", `bytes */${buffer.length}`);
        return res.status(416).end();
      }

      res.status(206);
      res.set(
        "Content-Range",
        `bytes ${start}-${end}/${buffer.length}`
      );
      res.set("Content-Length", end - start + 1);

      return res.end(buffer.subarray(start, end + 1));
    }

    res.set("Content-Length", buffer.length);
    res.end(buffer);

  } catch (error) {
    console.error("Audio error:", error.message);

    if (!res.headersSent) {
      res.status(502).end("Could not retrieve audio");
    }
  }
});

const port = Number(process.env.PORT || 3000);

try {
  await client.connect();

  console.log("Telegram connected successfully.");
  console.log("Channels:", channels);

  app.listen(port, "0.0.0.0", () => {
    console.log(`Addon running on port ${port}`);
  });

} catch (error) {
  console.error("Telegram connection failed:", error.message);
  process.exit(1);
        }
