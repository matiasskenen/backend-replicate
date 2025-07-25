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
app.use("/output", express.static("output"));

const historyByUser = {};

// 🧠 Plantillas de prompt por estilo
const styleTemplates = {
  "Realista": (text) =>
    `photo-realistic render of ${text}, studio lighting, 8k, no text, no humans, ultra detail`,
  "Cuento infantil": (text) =>
    `storybook illustration of ${text}, colorful, watercolor, children's book style, soft light, no text, no humans`,
  "Surrealista": (text) =>
    `surrealist painting of ${text}, dreamlike composition, Salvador Dalí style, vivid colors, no humans, no text`,
};

// 🧠 Negative prompt común
const negativePrompt = "realistic human, skin, face, text, watermark";

app.post("/generate", async (req, res) => {
  const { prompt, userId, style } = req.body;

  if (!prompt || !userId) {
    return res.status(400).json({ error: "Faltan datos: prompt o userId" });
  }

  const buildPrompt = styleTemplates[style] || ((t) => t);
  const finalPrompt = buildPrompt(prompt);

  try {
    const response = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "ac732df83cea7fff18b8472768c88ad041fa750ff7682a21affe81863cbe77e4",
        input: {
          prompt: finalPrompt,
          negative_prompt: negativePrompt,
          width: 768,
          height: 768,
          guidance_scale: 7.5,
          num_inference_steps: 50,
        },
      }),
    });

    const data = await response.json();
    console.log("🔍 Respuesta de Replicate:", data);

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

    if (!imageUrl || typeof imageUrl !== "string" || !imageUrl.startsWith("http")) {
      console.error("🛑 Imagen no generada:", JSON.stringify(result, null, 2));
      return res.status(500).json({ error: "No se generó imagen válida", detail: result });
    }

    const imageBuffer = await (await fetch(imageUrl)).buffer();
    if (!imageBuffer?.length) {
      return res.status(500).json({ error: "La imagen descargada está vacía" });
    }

    fs.mkdirSync("output", { recursive: true });
    const filename = `image_${Date.now()}.jpg`;
    const filepath = path.join("output", filename);
    fs.writeFileSync(filepath, imageBuffer);

    if (!historyByUser[userId]) {
      historyByUser[userId] = [];
    }

    historyByUser[userId].push({
      prompt,
      imageUrl,
      savedAs: filename,
      timestamp: Date.now(),
    });

    res.json({
      message: "Imagen generada correctamente",
      imageUrl,
      savedAs: filepath,
    });
  } catch (err) {
    console.error("❌ Error inesperado:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

app.get("/history/:userId", (req, res) => {
  const userId = req.params.userId;
  res.json(historyByUser[userId] || []);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor escuchando en http://localhost:${PORT}`);
});


app.post("/delete", (req, res) => {
  const { userId, savedAs } = req.body;

  if (!userId || !savedAs) {
    return res.status(400).json({ error: "Faltan datos: userId o savedAs" });
  }

  const filePath = path.join("output", savedAs);

  try {
    // Borrar archivo físico
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Validar existencia
    if (!historyByUser[userId]) {
      return res.status(404).json({ error: "Historial no encontrado para el usuario" });
    }

    const historialOriginal = historyByUser[userId];
    const nuevoHistorial = historialOriginal.filter(img => img.savedAs !== savedAs);

    // Validar si realmente eliminó algo
    if (nuevoHistorial.length === historialOriginal.length) {
      return res.status(404).json({ error: "Imagen no encontrada en historial" });
    }

    historyByUser[userId] = nuevoHistorial;

    res.json({ message: "Imagen eliminada correctamente" });
  } catch (err) {
    console.error("❌ Error al eliminar imagen:", err);
    res.status(500).json({ error: "Error interno al eliminar imagen" });
  }
});

app.get('/can-generate/:userId', (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ error: 'Falta userId' });

  const historial = historyByUser[userId] || [];

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const hoyTimestamp = hoy.getTime();

  const generadasHoy = historial.filter(img => img.timestamp >= hoyTimestamp);

  const limite = 3; // máx. gratuito diario
  const restantes = limite - generadasHoy.length;

  res.json({
    allowed: restantes > 0,
    restantes: restantes > 0 ? restantes : 0,
  });
});


