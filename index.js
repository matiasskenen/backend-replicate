const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

app.post('/generar', async (req, res) => {
  const prompt = req.body.prompt;
  if (!prompt) return res.status(400).json({ error: 'Falta el prompt' });

  try {
    const response = await axios.post(
      'https://api.replicate.com/v1/predictions',
      {
        version: "c582c9473d2d44f5b24e040ba42eeb77f90bb4b6eb6b2f3c216b34719ec23c0a",


        input: { prompt }
      },
      {
        headers: {
          Authorization: `Token ${REPLICATE_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Polling (espera a que se genere la imagen)
    let result = response.data;
    while (result.status !== 'succeeded' && result.status !== 'failed') {
      await new Promise(r => setTimeout(r, 1500));
      const poll = await axios.get(
        `https://api.replicate.com/v1/predictions/${result.id}`,
        {
          headers: {
            Authorization: `Token ${REPLICATE_API_TOKEN}`
          }
        }
      );
      result = poll.data;
    }

    if (result.status === 'succeeded') {
      res.json({ image: result.output[result.output.length - 1] });
    } else {
      res.status(500).json({ error: 'Fallo la generación' });
    }

  } catch (err) {
    console.error("ERROR REPLICATE >>>", err.response?.data || err.message);
    res.status(500).json({ error: 'Error al llamar a Replicatesss' });
  }
});

app.listen(3000, () => {
  console.log('Servidor corriendo en http://localhost:3000');
});
