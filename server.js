import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // ⚠️ Debe ser la service role key
);

const app = express();
app.use(cors());
app.use(express.json());
app.use("/output", express.static("output"));

const styleTemplates = {
  "Realista": (text) =>
    `photo-realistic render of ${text}, studio lighting, 8k, no text, no humans, ultra detail`,
  "Cuento infantil": (text) =>
    `storybook illustration of ${text}, colorful, watercolor, children's book style, soft light, no text, no humans`,
  "Surrealista": (text) =>
    `surrealist painting of ${text}, dreamlike composition, Salvador Dalí style, vivid colors, no humans, no text`,
};

const negativePrompt = "realistic human, skin, face, text, watermark";

// GENERACIÓN
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
    if (!data?.urls?.get) {
      return res.status(500).json({ error: "Fallo al crear predicción", detail: data });
    }

    // Esperar resultado
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
      return res.status(500).json({ error: "Imagen inválida", detail: result });
    }

    // Descargar imagen
    const imageBuffer = await (await fetch(imageUrl)).buffer();
    if (!imageBuffer?.length) {
      return res.status(500).json({ error: "La imagen descargada está vacía" });
    }

    // Guardar archivo localmente
    fs.mkdirSync("output", { recursive: true });
    const filename = `image_${Date.now()}.jpg`;
    const filepath = path.join("output", filename);
    fs.writeFileSync(filepath, imageBuffer);

    // Guardar en Supabase
    const { error } = await supabase.from("historial").insert([
      {
        prompt,
        image_url: `/output/${filename}`, // tu backend lo sirve
        user_id: userId,
        created_at: new Date().toISOString(),
      },
    ]);

    if (error) {
      console.error("❌ Error al guardar en Supabase:", error.message);
    }

    res.json({
      message: "Imagen generada correctamente",
      imageUrl: `/output/${filename}`,
      savedAs: filename,
    });
  } catch (err) {
    console.error("❌ Error inesperado:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// CONSULTA DE HISTORIAL
app.get("/history/:userId", async (req, res) => {
  const userId = req.params.userId;

  const { data, error } = await supabase
    .from("historial")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    return res.status(500).json({ error: "No se pudo obtener el historial" });
  }

  res.json(data || []);
});

// VERIFICAR SI PUEDE GENERAR
app.get('/can-generate/:userId', async (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ error: 'Falta userId' });

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0); // comienzo del día
  const fechaISO = hoy.toISOString();

  const { count, error: histError } = await supabase
    .from('historial')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', fechaISO);

  if (histError) {
    console.error('❌ Error al consultar historial:', histError.message);
    return res.status(500).json({ error: 'Error al consultar historial' });
  }

  // Buscar bonus
  const { data: bonusData, error: bonusError } = await supabase
    .from('bonus_generaciones')
    .select('bonus')
    .eq('user_id', userId)
    .single();

  const bonus = bonusData?.bonus || 0;

  const limite = 3 + bonus;
  const restantes = Math.max(0, limite - count);

  res.json({
    allowed: restantes > 0,
    restantes,
  });
});


// BORRAR IMAGEN (local y Supabase)
app.post("/delete", async (req, res) => {
  const { userId, savedAs } = req.body;

  if (!userId || !savedAs) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  const filePath = path.join("output", savedAs);

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // También eliminar de Supabase
    const { error } = await supabase
      .from("historial")
      .delete()
      .eq("user_id", userId)
      .eq("image_url", `/output/${savedAs}`);

    if (error) {
      console.error("⚠️ No se pudo borrar de Supabase:", error.message);
    }

    res.json({ message: "Imagen eliminada correctamente" });
  } catch (err) {
    res.status(500).json({ error: "Error al eliminar imagen" });
  }
});

// INICIO
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor escuchando en http://localhost:${PORT}`);
});
