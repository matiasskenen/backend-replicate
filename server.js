import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch"; // Necesario para descargar la imagen después de generarla
import fs from "fs";
import path from "path";
import { createClient } from '@supabase/supabase-js';
import Replicate from "replicate"; // <-- ¡NUEVO! Importa el cliente de Replicate

// Carga las variables de entorno desde el archivo .env
dotenv.config();

// Inicializa el cliente de Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // ⚠️ Debe ser la service role key
);

// Inicializa el cliente de Replicate con tu token API
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

const app = express();
// Asegúrate de que esta URL base sea correcta para tu despliegue (ej. en Render.com)
const baseUrl = 'https://backend-replicate-ekci.onrender.com';

// Configuración de middlewares
app.use(cors()); // Habilita CORS para permitir solicitudes desde diferentes orígenes
app.use(express.json()); // Habilita el parseo de cuerpos de solicitud JSON
app.use("/output", express.static("output")); // Sirve archivos estáticos desde la carpeta 'output'

// Style Templates: Definiciones de cómo transformar un prompt base
// Ajustados para trabajar mejor con Stable Diffusion
const styleTemplates = {
  "Realista": (text) =>
    `photo-realistic render of ${text}, studio lighting, 8k, ultra detail, professional photography, cinematic, sharp focus`,
  "Cuento infantil": (text) =>
    `storybook illustration of ${text}, vibrant, watercolor, children's book style, soft light, whimsical, hand-drawn feel`,
  "Surrealista": (text) =>
    `surrealist painting of ${text}, dreamlike composition, Salvador Dalí style, vivid colors, highly imaginative, mysterious, ethereal`,
};

// Negative Prompt Base: Texto para indicarle a la IA qué NO queremos en la imagen
// Muy importante para controlar la calidad y evitar artefactos con Stable Diffusion
const negativePromptBase = "text, watermark, ugly, deformed, blurry, low resolution, bad anatomy, bad hands, missing fingers, extra fingers, poorly drawn face, disfigured, out of frame, error, cropped, jpeg artifacts, signature, username, abstract, realistic human, skin, face, NSFW";

// Endpoint para la GENERACIÓN de imágenes
app.post("/generate", async (req, res) => {
  const { prompt, userId, style } = req.body;

  // Validación de datos de entrada
  if (!prompt || !userId) {
    return res.status(400).json({ error: "Faltan datos: prompt o userId" });
  }

  // Aplica el estilo al prompt, si existe
  const buildPrompt = styleTemplates[style] || ((t) => t);
  const finalPrompt = buildPrompt(prompt);

  try {
    // === CAMBIO CLAVE: Llamada a la API de Stable Diffusion a través de Replicate ===

    // Define el ID del modelo y la versión.
    // Puedes encontrar la versión más reciente en la página del modelo en replicate.com,
    // por ejemplo, para SDXL base: https://replicate.com/stability-ai/sdxl
    const modelIdentifier = "stability-ai/stable-diffusion"; // <-- ¡CAMBIO AQUÍ!
    const modelVersion = "ac732df83cea7fff18b8472768c88ad041fa750ff7682a21affe81863cbe77e4"; // <-- ¡CAMBIO AQUÍ!

    // Ejecuta la generación de imagen usando el cliente de Replicate
    // El método .run() maneja el polling internamente, lo que simplifica mucho el código.
    const output = await replicate.run(
      `${modelIdentifier}:${modelVersion}`, // Formato "modelo:version"
      {
        input: {
          prompt: finalPrompt,
          negative_prompt: negativePromptBase, // Usamos el negative prompt definido
          width: 512, // Resolución recomendada para SDXL
          height: 512,
          num_outputs: 1, // Cantidad de imágenes a generar por solicitud
          num_inference_steps: 25, // Pasos de inferencia: más pasos pueden mejorar la calidad (pero son más lentos)
          guidance_scale: 7.5, // Cuánto la IA debe seguir el prompt (valores típicos entre 7 y 8.5)
          // Puedes añadir otros parámetros de Stable Diffusion aquí si el modelo los soporta,
          // como 'seed' para resultados reproducibles, 'scheduler', etc.
        },
      }
    );

    // El resultado de replicate.run() para modelos de imagen es un array de URLs (o null si falla)
    const imageUrl = output && output.length > 0 ? output[0] : null;

    if (!imageUrl) {
      console.error("❌ La generación de imagen no devolvió una URL válida:", output);
      return res.status(500).json({ error: "No se pudo obtener la URL de la imagen de Replicate" });
    }

    // Descargar la imagen de la URL proporcionada por Replicate
    const imageDownloadResponse = await fetch(imageUrl);
    const imageBuffer = await imageDownloadResponse.buffer();

    if (!imageBuffer?.length) {
      return res.status(500).json({ error: "La imagen descargada está vacía o corrupta" });
    }

    // Guardar el archivo de imagen localmente en la carpeta 'output'
    fs.mkdirSync("output", { recursive: true }); // Crea la carpeta si no existe
    const filename = `image_${Date.now()}.png`; // Nombre de archivo único
    const filepath = path.join("output", filename);
    fs.writeFileSync(filepath, imageBuffer);

    // Guardar el registro de la imagen generada en Supabase
    const { error: supabaseError } = await supabase.from("historial").insert([
      {
        prompt,
        image_url: `${baseUrl}/output/${filename}`, // URL pública de la imagen
        user_id: userId,
        created_at: new Date().toISOString(),
      },
    ]);

    if (supabaseError) {
      console.error("❌ Error al guardar en Supabase:", supabaseError.message);
      // Nota: Aquí podrías decidir si devuelves un error al usuario o solo logueas,
      // ya que la imagen sí se generó y guardó localmente.
    }

    // Responder al cliente con los detalles de la imagen generada
    res.json({
      message: "Imagen generada correctamente",
      imageUrl: `${baseUrl}/output/${filename}`,
      savedAs: filename,
    });
  } catch (err) {
    console.error("❌ Error inesperado al generar imagen con Replicate:", err);
    // Captura cualquier error durante el proceso de generación o descarga
    res.status(500).json({ error: "Error interno del servidor al generar imagen", detail: err.message });
  }
});

// Endpoint para CONSULTAR EL HISTORIAL de imágenes de un usuario
app.get("/history/:userId", async (req, res) => {
  const userId = req.params.userId;

  const { data, error } = await supabase
    .from("historial")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false }); // Ordenar por fecha, las más recientes primero

  if (error) {
    console.error("❌ Error al obtener el historial de Supabase:", error.message);
    return res.status(500).json({ error: "No se pudo obtener el historial" });
  }

  res.json(data || []); // Devuelve el historial o un array vacío si no hay datos
});

// Endpoint para VERIFICAR SI UN USUARIO PUEDE GENERAR una nueva imagen
app.get('/can-generate/:userId', async (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ error: 'Falta userId' });

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0); // Establece la hora al comienzo del día (00:00:00)
  const fechaISO = hoy.toISOString(); // Formato ISO para la consulta de Supabase

  // Cuenta las generaciones del usuario hoy
  const { count, error: histError } = await supabase
    .from('historial')
    .select('*', { count: 'exact', head: true }) // count: 'exact' para obtener el número total
    .eq('user_id', userId)
    .gte('created_at', fechaISO); // Solo cuenta las generadas desde el inicio de hoy

  if (histError) {
    console.error('❌ Error al consultar historial para límite:', histError.message);
    return res.status(500).json({ error: 'Error al consultar historial de generaciones' });
  }

  // Busca el bonus de generaciones para el usuario
  const { data: bonusData, error: bonusError } = await supabase
    .from('bonus_generaciones')
    .select('bonus')
    .eq('user_id', userId)
    .single(); // Espera un único resultado o null

  const bonus = bonusData?.bonus || 0; // Si no hay bonus, es 0

  const limite = 3 + bonus; // Límite base (ej. 3) + cualquier bonus
  const restantes = Math.max(0, limite - count); // Generaciones restantes, nunca menos de 0

  res.json({
    allowed: restantes > 0, // Indica si el usuario puede generar al menos una imagen más
    restantes, // Número de generaciones restantes
  });
});

// Endpoint para SUMAR BONUS de generaciones a un usuario
app.post('/sumar-bonus', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Falta userId' });

  const hoy = new Date().toISOString().slice(0, 10); // Formato 'YYYY-MM-DD' para la fecha del bonus

  try {
    // Intenta obtener el bonus actual del usuario y la fecha de la última actualización
    const { data, error: fetchError } = await supabase
      .from('bonus_generaciones')
      .select('bonus, fecha')
      .eq('user_id', userId)
      .single();

    // PGRST116 es el código de error de Supabase cuando no se encuentra ninguna fila (no es un error real en este caso)
    if (fetchError && fetchError.code !== 'PGRST116') {
      console.error('❌ Error al obtener bonus existente:', fetchError.message);
      return res.status(500).json({ error: 'Error al obtener bonus' });
    }

    let nuevoBonus = 1; // Por defecto, se suma 1

    // Si ya hay un registro de bonus para hoy, incrementa el bonus existente
    if (data?.fecha === hoy) {
      nuevoBonus = (data.bonus || 0) + 1;
    }

    // Inserta o actualiza el registro de bonus para el usuario y la fecha actual
    const { error: upsertError } = await supabase
      .from('bonus_generaciones')
      .upsert(
        { user_id: userId, bonus: nuevoBonus, fecha: hoy },
        { onConflict: 'user_id' } // Si 'user_id' ya existe, actualiza la fila
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

// Endpoint para BORRAR IMAGEN (tanto del sistema de archivos local como de Supabase)
app.post("/delete", async (req, res) => {
  const { userId, savedAs } = req.body;

  if (!userId || !savedAs) {
    return res.status(400).json({ error: "Faltan datos para eliminar" });
  }

  const filePath = path.join("output", savedAs); // Ruta local del archivo

  try {
    // Eliminar archivo localmente si existe
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`✅ Archivo local ${savedAs} eliminado.`);
    } else {
      console.log(`⚠️ Archivo local ${savedAs} no encontrado.`);
    }

    // También eliminar de Supabase
    // Asegúrate de que la image_url coincida exactamente con lo que guardas
    const { error } = await supabase
      .from("historial")
      .delete()
      .eq("user_id", userId)
      .eq("image_url", `${baseUrl}/output/${savedAs}`);

    if (error) {
      console.error("⚠️ No se pudo borrar de Supabase:", error.message);
      // No devolvemos un error 500 si la imagen local ya se borró, solo si Supabase falló críticamente.
    } else {
        console.log(`✅ Registro de Supabase para ${savedAs} eliminado.`);
    }

    res.json({ message: "Imagen eliminada correctamente" });
  } catch (err) {
    console.error("❌ Error al eliminar imagen:", err);
    res.status(500).json({ error: "Error al eliminar imagen" });
  }
});

// Inicio del servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor escuchando en http://localhost:${PORT}`);
});