import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { addCityIfMissing } from "./utils/addCityToCountry.js";

app.post("/api/city/add", async (req, res) => {
  try {
    const { city } = req.body;

    if (!city) {
      return res.status(400).json({ error: "City is required" });
    }

    const result = await addCityIfMissing(city);

    return res.json(result);

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Failed to add city"
    });
  }
});

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post("/api/ask", async (req, res) => {
  try {
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({
        error: "Question is required."
      });
    }

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      input: [
        {
          role: "system",
          content: `
You are City Tour Guide AI v3.

Return ONLY valid JSON.
Do not include markdown, comments, explanations, or extra text.

The JSON MUST strictly follow this schema:

{
  "name": "City name",
  "interests": [
    { "name": "", "map_link": "", "description": "" }
  ],
  "local_food_tip": "",
  "full_day": {
    "morning": "",
    "afternoon": "",
    "sunset": "",
    "night": ""
  },
  "seasons": {
    "spring": {
      "event": "",
      "description": "",
      "ideas": [
        { "name": "", "map_link": "", "description": "" }
      ]
    },
    "summer": {
      "event": "",
      "description": "",
      "ideas": [
        { "name": "", "map_link": "", "description": "" }
      ]
    },
    "autumn": {
      "event": "",
      "description": "",
      "ideas": [
        { "name": "", "map_link": "", "description": "" }
      ]
    },
    "winter": {
      "event": "",
      "description": "",
      "ideas": [
        { "name": "", "map_link": "", "description": "" }
      ]
    }
  },
  "public_transport_tips": [
    { "tip": "", "link": "" }
  ],
  "city_events": [
    {
      "name": "",
      "season": "",
      "description": "",
      "website": "",
      "dates": ""
    }
  ],
  "places": [
    { "name": "", "map_link": "", "description": "" }
  ],
  "hidden_gems": [
    { "name": "", "map_link": "", "description": "" }
  ]
}

Rules:
- All map_link values MUST use Google Maps coordinates format:
  https://www.google.com/maps/search/?api=1&query=LAT,LON
- Use realistic, well-known locations.
- Keep descriptions concise and factual.
- No emojis inside JSON values.
- Do NOT wrap JSON in code blocks.
`
        },
        {
          role: "user",
          content: question
        }
      ]
    });

    const jsonOutput = response.output[0].content[0].text;
    const parsed = JSON.parse(jsonOutput);

    return res.json(parsed);

  } catch (err) {
    console.error("OPENAI ERROR FULL:");
    console.error(err);

    const status =
      err?.status ||
      err?.response?.status ||
      500;

    if (status === 429) {
      return res.status(429).json({
        error:
          "Billing is not active or quota is exceeded. Please add payment details in OpenAI dashboard."
      });
    }

    if (status === 401) {
      return res.status(401).json({
        error: "Invalid OpenAI API key."
      });
    }

    return res.status(500).json({
      error: "Backend error while generating city guide."
    });
  }
});

app.listen(process.env.PORT || 3001, () => {
  console.log(`API running on http://localhost:${process.env.PORT || 3001}`);
});
