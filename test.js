import Replicate from "replicate";
import dotenv from "dotenv";
import fs from "fs";
import fetch from "node-fetch";

dotenv.config();

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

const run = async () => {
  try {
    const output = await replicate.run("black-forest-labs/flux-schnell", {
      input: {
        prompt: "a futuristic robot in a neon-lit alley",
      },
    });

    const imageUrl = output[0];
    console.log("✅ URL de imagen:", imageUrl);

    const response = await fetch(imageUrl);
    const buffer = await response.buffer();
    fs.writeFileSync("output.jpg", buffer);
    console.log("🖼️ Imagen guardada como output.jpg");
  } catch (error) {
    console.error("❌ Error:", error);
  }
};

run();
