import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Middleware para exponer imágenes guardadas
app.use("/output", express.static("output"));

// Historial global separado por usuario
const historyByUser = {};

// Endpoint para generar imagen
app.post("/generate", async (req, res) => {
  const { prompt, userId } = req.body;

  if (!prompt || !userId) {
    return res.status(400).json({ error: "Faltan datos: prompt o userId" });
  }

  try {
    const response = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "ac732df83cea7fff18b8472768c88ad041fa750ff7682a21affe81863cbe77e4",
        input: { prompt },
      }),
    });

    const data = await response.json();

    if (!data?.urls?.get) {
      return res.status(500).json({ error: "Fallo al crear la predicción", detail: data });
    }

    let result;
    let tries = 0;
    while (!result?.output?.[0] && tries < 20) {
      await new Promise((r) => setTimeout(r, 1500));
      const poll = await fetch(data.urls.get, {
        headers: {
          Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
        },
      });
      result = await poll.json();
      tries++;
    }

    const imageUrl = result?.output?.[0];
    if (!imageUrl) {
      return res.status(500).json({ error: "No se generó la imagen" });
    }

    const imageBuffer = await (await fetch(imageUrl)).buffer();
    fs.mkdirSync("output", { recursive: true });
    const filename = `image_${Date.now()}.jpg`;
    const filepath = path.join("output", filename);
    fs.writeFileSync(filepath, imageBuffer);

    // Guardar en historial
    if (!historyByUser[userId]) {
      historyByUser[userId] = [];
    }
    historyByUser[userId].push({ prompt, imageUrl, savedAs: filename, timestamp: Date.now() });

    res.json({
      message: "Imagen generada correctamente",
      imageUrl,
      savedAs: filepath,
    });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

// Endpoint para historial por usuario
app.get("/history/:userId", (req, res) => {
  const userId = req.params.userId;
  res.json(historyByUser[userId] || []);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor escuchando en http://localhost:${PORT}`);
});