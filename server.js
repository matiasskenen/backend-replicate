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
const baseUrl = 'https://backend-replicate-ekci.onrender.com'; // Asegúrate de que esta URL base sea correcta para tu despliegue

app.use(cors());
app.use(express.json());
app.use("/output", express.static("output"));

// Nota: Los styleTemplates están pensados para prompts. 
// Para la API de Imagen de Google, los "negative prompts" no son un parámetro directo,
// se suelen integrar en el prompt principal o se omiten.
const styleTemplates = {
  "Realista": (text) =>
    `photo-realistic render of ${text}, studio lighting, 8k, ultra detail`,
  "Cuento infantil": (text) =>
    `storybook illustration of ${text}, colorful, watercolor, children's book style, soft light`,
  "Surrealista": (text) =>
    `surrealist painting of ${text}, dreamlike composition, Salvador Dalí style, vivid colors`,
};

// La API de Imagen de Google no usa un negative_prompt explícito como Replicate/Stable Diffusion
// const negativePrompt = "realistic human, skin, face, text, watermark"; 

// GENERACIÓN
app.post("/generate", async (req, res) => {
  const { prompt, userId, style } = req.body;

  if (!prompt || !userId) {
    return res.status(400).json({ error: "Faltan datos: prompt o userId" });
  }

  const buildPrompt = styleTemplates[style] || ((t) => t);
  const finalPrompt = buildPrompt(prompt);

  try {
    // === CAMBIO CLAVE: Llamada a la API de Imagen de Google ===
    const googleApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${process.env.GOOGLE_API_KEY}`;
    
    const response = await fetch(googleApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        instances: {
          prompt: finalPrompt // El prompt se envía directamente aquí
        },
        parameters: {
          "sampleCount": 1 // Puedes ajustar esto si quieres más de una imagen por solicitud
        }
      }),
    });

    const data = await response.json();

    // Manejo de errores de la API de Google
    if (data.error) {
      console.error("❌ Error de la API de Google:", data.error.message);
      return res.status(data.error.code || 500).json({ error: "Error al generar imagen con Google API", detail: data.error.message });
    }

    // Extraer la imagen base64 de la respuesta
    const base64Image = data?.predictions?.[0]?.bytesBase64Encoded;

    if (!base64Image) {
      return res.status(500).json({ error: "No se pudo obtener la imagen de la respuesta de Google API", detail: data });
    }

    // Convertir base64 a Buffer
    const imageBuffer = Buffer.from(base64Image, 'base64');
    
    if (!imageBuffer?.length) {
      return res.status(500).json({ error: "La imagen descargada está vacía" });
    }

    // Guardar archivo localmente
    fs.mkdirSync("output", { recursive: true });
    const filename = `image_${Date.now()}.png`; // Cambiado a .png ya que la API devuelve png
    const filepath = path.join("output", filename);
    fs.writeFileSync(filepath, imageBuffer);

    // Guardar en Supabase
    const { error: supabaseError } = await supabase.from("historial").insert([
      {
        prompt,
        image_url: `${baseUrl}/output/${filename}`,
        user_id: userId,
        created_at: new Date().toISOString(),
      },
    ]);

    if (supabaseError) {
      console.error("❌ Error al guardar en Supabase:", supabaseError.message);
    }

    res.json({
      message: "Imagen generada correctamente",
      imageUrl: `${baseUrl}/output/${filename}`,
      savedAs: filename,
    });
  } catch (err) {
    console.error("❌ Error inesperado:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// CONSULTA DE HISTORIAL (sin cambios)
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

// VERIFICAR SI PUEDE GENERAR (sin cambios)
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

// SUMAR BONUS (sin cambios)
app.post('/sumar-bonus', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Falta userId' });

  const hoy = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

  try {
    const { data, error: fetchError } = await supabase
      .from('bonus_generaciones')
      .select('bonus, fecha')
      .eq('user_id', userId)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      console.error('❌ Error al obtener bonus:', fetchError.message);
      return res.status(500).json({ error: 'Error al obtener bonus' });
    }

    let nuevoBonus = 1;

    if (data?.fecha === hoy) {
      nuevoBonus = (data.bonus || 0) + 1;
    }

    const { error: upsertError } = await supabase
      .from('bonus_generaciones')
      .upsert(
        { user_id: userId, bonus: nuevoBonus, fecha: hoy },
        { onConflict: 'user_id' }
      );

    if (upsertError) {
      console.error('❌ Error al actualizar bonus:', upsertError.message);
      return res.status(500).json({ error: 'Error al guardar bonus' });
    }

    res.json({ message: 'Bonus actualizado correctamente', bonus: nuevoBonus });
  } catch (err) {
    console.error('❌ Error inesperado en sumar-bonus:', err);
    res.status(500).json({ error: 'Error inesperado' });
  }
});

// BORRAR IMAGEN (local y Supabase) (sin cambios, excepto que ahora es PNG)
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
      // Asegúrate de que la image_url coincida con lo que guardas
      .eq("image_url", `${baseUrl}/output/${savedAs}`); 

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