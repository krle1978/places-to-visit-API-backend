import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { addCityIfMissing } from "./utils/addCityToCountry.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const COUNTRIES_DIR = path.join(DATA_DIR, "countries");
const cityGeoCache = new Map();

function normalizeName(value) {
  return value
    ? value
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
    : "";
}

function resolveCountryFile(fileName) {
  if (!fileName || !fileName.endsWith(".json")) {
    return { error: "Invalid file name." };
  }

  const resolvedPath = path.resolve(COUNTRIES_DIR, fileName);
  if (!resolvedPath.startsWith(COUNTRIES_DIR + path.sep)) {
    return { error: "Invalid file path." };
  }

  return { path: resolvedPath };
}

async function geocodeCity(city, country) {
  const key = `${city}|${country || ""}`;
  if (cityGeoCache.has(key)) return cityGeoCache.get(key);

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("city", city);
  if (country) url.searchParams.set("country", country);

  const response = await fetch(url, {
    headers: {
      "User-Agent": "places-to-visit-ai/1.0",
      "Accept-Language": "en"
    }
  });

  if (!response.ok) return null;
  const data = await response.json();
  if (!Array.isArray(data) || !data[0]) return null;

  const result = {
    lat: Number(data[0].lat),
    lon: Number(data[0].lon)
  };

  if (!Number.isFinite(result.lat) || !Number.isFinite(result.lon)) {
    return null;
  }

  cityGeoCache.set(key, result);
  return result;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return 6371 * c;
}

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
You are City Tour Guide AI.

Return ONLY valid JSON.
No markdown, no comments, no explanations.

The JSON MUST strictly follow this schema:

{
  "name": "City name",
  "interests": {
    "Art & Culture": [
      { "name": "", "map_link": "", "description": "" }
    ],
    "Photo Spots": [
      { "name": "", "map_link": "", "description": "" }
    ],
    "Food & Nightlife": [
      { "name": "", "map_link": "", "description": "" }
    ],
    "Nature & Relaxation": [
      { "name": "", "map_link": "", "description": "" }
    ]
  },
  "local_food_tip": "",
  "full_day": {
    "Morning": "",
    "Afternoon": "",
    "Sunset": "",
    "Night": ""
  },
  "seasons": {
    "spring": {
      "main_event": "",
      "description": "",
      "ideas": [
        { "name": "", "map_link": "", "description": "" }
      ]
    },
    "summer": {
      "main_event": "",
      "description": "",
      "ideas": [
        { "name": "", "map_link": "", "description": "" }
      ]
    },
    "autumn": {
      "main_event": "",
      "description": "",
      "ideas": [
        { "name": "", "map_link": "", "description": "" }
      ]
    },
    "winter": {
      "main_event": "",
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
- interests MUST be an object, not an array
- Use realistic, well-known locations
- All map_link values MUST be Google Maps search URLs
- Descriptions must be factual and concise
- No emojis inside JSON values
`
        },
        {
          role: "user",
          content: question
        }
      ]
    });

    const jsonText = response.output[0].content[0].text;
    const parsed = JSON.parse(jsonText);

    return res.json(parsed);
  } catch (err) {
    console.error("OPENAI ERROR:");
    console.error(err);

    return res.status(500).json({
      error: "Backend error while generating city guide."
    });
  }
});

app.get("/api/geo/reverse", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "Invalid coordinates." });
    }

    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", lat.toString());
    url.searchParams.set("lon", lon.toString());
    url.searchParams.set("zoom", "10");
    url.searchParams.set("addressdetails", "1");

    const response = await fetch(url, {
      headers: {
        "User-Agent": "places-to-visit-ai/1.0",
        "Accept-Language": "en"
      }
    });

    if (!response.ok) {
      return res.status(502).json({ error: "Failed to resolve location." });
    }

    const data = await response.json();
    const address = data?.address || {};
    const city =
      address.city ||
      address.town ||
      address.village ||
      address.municipality ||
      address.county ||
      "";
    const country = address.country || "";

    if (!city || !country) {
      return res.status(404).json({ error: "Location not found." });
    }

    return res.json({ city, country });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to resolve location." });
  }
});

app.get("/api/geo/nearest", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const fileName = req.query.file;

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "Invalid coordinates." });
    }

    const resolved = resolveCountryFile(fileName);
    if (resolved.error) {
      return res.status(400).json({ error: resolved.error });
    }

    const raw = await fs.promises.readFile(resolved.path, "utf8");
    const parsed = JSON.parse(raw);
    const cities = Array.isArray(parsed?.cities) ? parsed.cities : [];

    let bestCity = null;
    let bestDistance = Infinity;

    for (const city of cities) {
      const name = city?.name;
      if (!name) continue;

      const coords = await geocodeCity(name, parsed?.name);
      if (!coords) continue;

      const dist = haversineKm(lat, lon, coords.lat, coords.lon);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestCity = name;
      }
    }

    if (!bestCity) {
      return res.status(404).json({ error: "No nearby city found." });
    }

    return res.json({ city: bestCity });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to find nearest city." });
  }
});

app.post("/api/countries/:file/cities", async (req, res) => {
  try {
    const fileName = req.params.file;
    const { city, country } = req.body || {};

    if (!city || typeof city !== "string") {
      return res.status(400).json({ error: "City is required." });
    }

    const resolved = resolveCountryFile(fileName);
    if (resolved.error) {
      return res.status(400).json({ error: resolved.error });
    }

    const raw = await fs.promises.readFile(resolved.path, "utf8");
    const parsed = JSON.parse(raw);
    parsed.cities = Array.isArray(parsed.cities) ? parsed.cities : [];

    const normalizedCity = normalizeName(city);
    const existing = parsed.cities.find(
      (entry) => normalizeName(entry?.name) === normalizedCity
    );

    if (existing) {
      return res.json({ created: false, city: existing.name });
    }

    const promptCountry = parsed?.name || country || "";
    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      input: [
        {
          role: "system",
          content: `
You are City Tour Guide AI.

Return ONLY valid JSON.
No markdown, no comments, no explanations.

Generate data for a city guide.
City: ${city}
Country: ${promptCountry}

The JSON MUST follow this schema:
{
  "name": "",
  "interests": {
    "Art & Culture": [
      { "name": "", "map_link": "", "description": "" }
    ],
    "Photo Spots": [
      { "name": "", "map_link": "", "description": "" }
    ],
    "Food & Nightlife": [
      { "name": "", "map_link": "", "description": "" }
    ],
    "Nature & Relaxation": [
      { "name": "", "map_link": "", "description": "" }
    ]
  },
  "local_food_tip": "",
  "full_day": {
    "Morning": "",
    "Afternoon": "",
    "Sunset": "",
    "Night": ""
  },
  "seasons": {
    "spring": {
      "main_event": "",
      "description": "",
      "ideas": [
        { "name": "", "map_link": "", "description": "" }
      ]
    },
    "summer": {
      "main_event": "",
      "description": "",
      "ideas": [
        { "name": "", "map_link": "", "description": "" }
      ]
    },
    "autumn": {
      "main_event": "",
      "description": "",
      "ideas": [
        { "name": "", "map_link": "", "description": "" }
      ]
    },
    "winter": {
      "main_event": "",
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
- interests MUST be an object, not an array
- All map_link values MUST be Google Maps search URLs
- Descriptions must be factual and concise
- No emojis inside JSON values
`
        }
      ]
    });

    const jsonText = response.output?.[0]?.content?.[0]?.text || "";
    const cityJSON = JSON.parse(jsonText);

    if (!cityJSON?.name) {
      return res.status(500).json({ error: "Invalid AI response." });
    }

    parsed.cities.push(cityJSON);
    parsed.cities.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    await fs.promises.writeFile(resolved.path, JSON.stringify(parsed, null, 2), "utf8");

    return res.json({ created: true, city: cityJSON.name });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to generate city data." });
  }
});

app.get("/api/countries", async (req, res) => {
  try {
    const files = await fs.promises.readdir(COUNTRIES_DIR);
    const jsonFiles = files.filter((file) => file.endsWith(".json"));

    const entries = await Promise.all(
      jsonFiles.map(async (file) => {
        try {
          const fullPath = path.join(COUNTRIES_DIR, file);
          const raw = await fs.promises.readFile(fullPath, "utf8");
          const parsed = JSON.parse(raw);
          if (!parsed?.name) return null;
          return { name: parsed.name, file };
        } catch (err) {
          console.error(`Failed to load country file: ${file}`);
          return null;
        }
      })
    );

    const countries = entries
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));

    return res.json({ countries });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to list countries." });
  }
});

app.get("/api/countries/:file", (req, res) => {
  const fileName = req.params.file;
  const resolved = resolveCountryFile(fileName);
  if (resolved.error) {
    return res.status(400).json({ error: resolved.error });
  }

  fs.readFile(resolved.path, "utf8", (err, data) => {
    if (err) {
      return res.status(404).json({ error: "File not found." });
    }

    try {
      return res.json(JSON.parse(data));
    } catch (parseErr) {
      return res.status(500).json({ error: "Invalid JSON file." });
    }
  });
});

app.listen(process.env.PORT || 3001, () => {
  console.log(`API running on http://localhost:${process.env.PORT || 3001}`);
});

const USERS_PATH = path.join(DATA_DIR, "users.json");

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  const users = JSON.parse(fs.readFileSync(USERS_PATH, "utf8"));
  const user = users.find(u => u.email === email);

  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      plan: user.plan
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({
    token,
    user: {
      email: user.email,
      plan: user.plan
    }
  });
});
