import fetch from "node-fetch";
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
import crypto from "crypto";
import nodemailer from "nodemailer";
import { requireAuth } from "./middleware/auth.js";
import { registerWebhookRoutes } from "./routes/webhook.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
registerWebhookRoutes(app);

app.get("/", (req, res) => {
  res.json({
    status: "OK",
    name: "Places To Visit API",
    version: "1.0.0"
  });
});

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const COUNTRIES_DIR = path.join(DATA_DIR, "countries");
const cityGeoCache = new Map();
const smtpPort = Number(process.env.SMTP_PORT || 587);
const mailTransport = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: smtpPort,
      secure: smtpPort === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined
    })
  : null;
const SMTP_FROM = process.env.SMTP_FROM || process.env.SMTP_USER || "";


function normalizeName(value) {
  return value
    ? value
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
    : "";
}

function normalizeKey(value) {
  return normalizeName(value).replace(/\s+/g, "");
}

async function cityExistsInFile(fileName, cityName) {
  const resolved = resolveCountryFile(fileName);
  if (resolved.error) return null;

  const raw = await fs.promises.readFile(resolved.path, "utf8");
  const parsed = JSON.parse(raw);
  const cities = Array.isArray(parsed?.cities) ? parsed.cities : [];
  const target = normalizeName(cityName);

  return cities.find((entry) => normalizeName(entry?.name) === target) || null;
}

const COUNTRY_ALIASES = {
  "bosniaandherzegovina": "Bosnia and Herzegowina",
  "cotedivoire": "Cote d'Ivoire",
  "czechia": "Czech Republic",
  "holysee": "Vatican City",
  "macedonia": "North Macedonia",
  "northmacedonia": "North Macedonia",
  "republicofmoldova": "Moldova",
  "republicofturkey": "Turkey (Europe)",
  "russianfederation": "Russia (Europe)",
  "slovakrepublic": "Slovakia",
  "swissconfederation": "Swizerland",
  "turkiye": "Turkey (Europe)",
  "unitedkingdomofgreatbritainandnorthernireland": "United Kingdom"
};

function resolveCountryAlias(input) {
  const key = normalizeKey(input);
  return COUNTRY_ALIASES[key] || input;
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeJsonFile(filePath, data) {
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeUserName(value) {
  return normalizeName(String(value || "").trim()).replace(/\s+/g, " ");
}

function buildClientUrl(req, pathname) {
  const base = process.env.CLIENT_URL || `${req.protocol}://${req.get("host")}`;
  return new URL(pathname, base).toString();
}

async function sendSignupEmail(to, confirmUrl) {
  if (!mailTransport) {
    throw new Error("Email transport is not configured.");
  }
  if (!SMTP_FROM) {
    throw new Error("SMTP_FROM is not configured.");
  }
  await mailTransport.sendMail({
    from: SMTP_FROM,
    to,
    subject: "Confirm your account",
    text: `Please confirm your account by opening this link: ${confirmUrl}`,
    html: `<p>Please confirm your account by clicking the link below:</p><p><a href="${confirmUrl}">Confirm account</a></p>`
  });
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

async function resolveCountryForCity(city) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("city", city);
  url.searchParams.set("addressdetails", "1");

  const response = await fetch(url, {
    headers: {
      "User-Agent": "places-to-visit-ai/1.0",
      "Accept-Language": "en"
    }
  });

  if (!response.ok) return null;
  const data = await response.json();
  const country = data?.[0]?.address?.country || "";
  return country || null;
}

async function findCountryFileByName(countryName) {
  if (!countryName) return null;

  const aliased = resolveCountryAlias(countryName);
  const normalizedTarget = normalizeName(aliased);
  const targetKey = normalizeKey(aliased);
  const files = await fs.promises.readdir(COUNTRIES_DIR);

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const fullPath = path.join(COUNTRIES_DIR, file);
      const raw = await fs.promises.readFile(fullPath, "utf8");
      const parsed = JSON.parse(raw);
      const name = parsed?.name || "";
      if (!name) continue;

      const normalizedName = normalizeName(name);
      if (normalizedName === normalizedTarget) {
        return { file, country: name };
      }

      const normalizedNameKey = normalizeKey(name);
      if (normalizedNameKey && normalizedNameKey === targetKey) {
        return { file, country: name };
      }
    } catch (err) {
      console.error(`Failed to load country file: ${file}`);
    }
  }

  return null;
}

async function generateCityInFile(fileName, city, fallbackCountry) {
  const resolved = resolveCountryFile(fileName);
  if (resolved.error) {
    const err = new Error(resolved.error);
    err.status = 400;
    throw err;
  }

  const raw = await fs.promises.readFile(resolved.path, "utf8");
  const parsed = JSON.parse(raw);
  parsed.cities = Array.isArray(parsed.cities) ? parsed.cities : [];

  const trimmedCity = city.trim();
  if (!trimmedCity) {
    const err = new Error("City is required.");
    err.status = 400;
    throw err;
  }
  const normalizedCity = normalizeName(trimmedCity);
  const existing = parsed.cities.find(
    (entry) => normalizeName(entry?.name) === normalizedCity
  );

  if (existing) {
    return { created: false, city: existing.name, country: parsed.name, file: fileName };
  }

  const promptCountry = parsed?.name || fallbackCountry || "";
  const response = await client.responses.create({
    model: "gpt-4.1-nano",
    max_output_tokens: 1500,
    text: {
      format: { type: "json_object" }
    },
    input: [
      {
        role: "system",
        content: `
You are City Tour Guide AI. Reply with JSON only (no markdown/comments).
City: ${trimmedCity}
Country: ${promptCountry}

Schema:
{
  "name": "",
  "interests": {
    "Art & Culture": [{ "name": "", "map_link": "", "description": "" }],
    "Photo Spots": [{ "name": "", "map_link": "", "description": "" }],
    "Food & Nightlife": [{ "name": "", "map_link": "", "description": "" }],
    "Nature & Relaxation": [{ "name": "", "map_link": "", "description": "" }]
  },
  "local_food_tip": "",
  "full_day": { "Morning": "", "Afternoon": "", "Sunset": "", "Night": "" },
  "seasons": {
    "spring": { "main_event": "", "description": "", "ideas": [{ "name": "", "map_link": "", "description": "" }] },
    "summer": { "main_event": "", "description": "", "ideas": [{ "name": "", "map_link": "", "description": "" }] },
    "autumn": { "main_event": "", "description": "", "ideas": [{ "name": "", "map_link": "", "description": "" }] },
    "winter": { "main_event": "", "description": "", "ideas": [{ "name": "", "map_link": "", "description": "" }] }
  },
  "public_transport_tips": [{ "tip": "", "link": "" }],
  "city_events": [{ "name": "", "season": "", "description": "", "website": "", "dates": "" }],
  "places": [{ "name": "", "map_link": "", "description": "" }],
  "hidden_gems": [{ "name": "", "map_link": "", "description": "" }]
}

Rules: interests is an object; use Google Maps search URLs; keep descriptions concise; full_day may include short <a> links and emojis.
`
      }
    ]
  });

  const jsonText = response.output?.[0]?.content?.[0]?.text || "";
  const cityJSON = JSON.parse(jsonText);

  if (!cityJSON?.name) {
    const err = new Error("Invalid AI response.");
    err.status = 500;
    throw err;
  }
  if (normalizeName(cityJSON.name) !== normalizeName(trimmedCity)) {
    cityJSON.name = trimmedCity;
  }

  parsed.cities.push(cityJSON);
  parsed.cities.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  await fs.promises.writeFile(resolved.path, JSON.stringify(parsed, null, 2), "utf8");

  return { created: true, city: cityJSON.name, country: parsed.name, file: fileName };
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

const PLAN_RANK = {
  free: 0,
  basic: 1,
  premium: 2,
  premium_plus: 3
};

function planAllows(plan, allowed) {
  const rank = PLAN_RANK[plan] ?? 0;
  const allowedRanks = allowed
    .map((key) => PLAN_RANK[key])
    .filter((value) => Number.isFinite(value));

  if (!allowedRanks.length) return false;

  const onlyFree = allowedRanks.every((value) => value === PLAN_RANK.free);
  if (onlyFree) return rank === PLAN_RANK.free;

  const minAllowed = Math.min(...allowedRanks);
  return rank >= minAllowed;
}

app.post("/api/city/add", requireAuth, async (req, res) => {
  try {
    if (!planAllows(req.user?.plan, ["basic", "premium"])) {
      return res.status(403).json({
        error: "Your plan does not allow adding new cities."
      });
    }

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

app.post("/api/ask", requireAuth, async (req, res) => {
  try {
    if (!planAllows(req.user?.plan, ["premium"])) {
      return res.status(403).json({
        error: "Your plan does not allow using the AI guide."
      });
    }

    const { question } = req.body;

    if (!question) {
      return res.status(400).json({
        error: "Question is required."
      });
    }

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      max_output_tokens: 900,
      text: {
        format: { type: "json_object" }
      },
      input: [
        {
          role: "system",
          content: `
You are City Tour Guide AI. Reply with JSON only (no markdown/comments).

Schema:
{
  "name": "City name",
  "interests": {
    "Art & Culture": [{ "name": "", "map_link": "", "description": "" }],
    "Photo Spots": [{ "name": "", "map_link": "", "description": "" }],
    "Food & Nightlife": [{ "name": "", "map_link": "", "description": "" }],
    "Nature & Relaxation": [{ "name": "", "map_link": "", "description": "" }]
  },
  "local_food_tip": "",
  "full_day": { "Morning": "", "Afternoon": "", "Sunset": "", "Night": "" },
  "seasons": {
    "spring": { "main_event": "", "description": "", "ideas": [{ "name": "", "map_link": "", "description": "" }] },
    "summer": { "main_event": "", "description": "", "ideas": [{ "name": "", "map_link": "", "description": "" }] },
    "autumn": { "main_event": "", "description": "", "ideas": [{ "name": "", "map_link": "", "description": "" }] },
    "winter": { "main_event": "", "description": "", "ideas": [{ "name": "", "map_link": "", "description": "" }] }
  },
  "public_transport_tips": [{ "tip": "", "link": "" }],
  "city_events": [{ "name": "", "season": "", "description": "", "website": "", "dates": "" }],
  "places": [{ "name": "", "map_link": "", "description": "" }],
  "hidden_gems": [{ "name": "", "map_link": "", "description": "" }]
}

Rules: interests is an object; use realistic well-known locations; Google Maps search URLs; concise descriptions; full_day may include short <a> links and emojis.
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

app.post("/api/ask/personalized", requireAuth, async (req, res) => {
  try {
    if (!planAllows(req.user?.plan, ["premium"])) {
      return res.status(403).json({
        error: "Your plan does not allow using the AI guide."
      });
    }

    const { city, interests } = req.body || {};
    if (!city || !interests) {
      return res.status(400).json({ error: "City and interests are required." });
    }

    const trimmedCity = city.trim();
    const trimmedInterests = interests.trim();
    if (!trimmedCity || !trimmedInterests) {
      return res.status(400).json({ error: "City and interests are required." });
    }

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      max_output_tokens: 1500,
      text: {
        format: { type: "json_object" }
      },
      input: [
        {
          role: "system",
          content: `
You are City Tour Guide AI. Reply with JSON only (no markdown/comments).
Create a personalized schedule for the given city and interests with meals included.

Schema:
{
  "city": "",
  "interests": "",
  "itinerary": [
    { "time": "09:00", "title": "", "type": "breakfast|visit|lunch|dinner|break|activity", "description": "", "map_link": "" }
  ],
  "tips": [{ "tip": "", "map_link": "" }]
}

Rules: include breakfast/lunch/dinner entries; use realistic locations tied to interests; Google Maps search URLs; concise factual descriptions; no emojis.
`
        },
        {
          role: "user",
          content: `City: ${trimmedCity}\nInterests: ${trimmedInterests}`
        }
      ]
    });

    const jsonText = response.output?.[0]?.content?.[0]?.text || "";
    const parsed = JSON.parse(jsonText);

    return res.json(parsed);
  } catch (err) {
    console.error("OPENAI ERROR:");
    console.error(err);
    return res.status(500).json({
      error: "Backend error while generating personalized city guide."
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

app.get("/api/geo/locate", async (req, res) => {
  try {
    const city = String(req.query.city || "").trim();
    if (!city) {
      return res.status(400).json({ error: "City is required." });
    }

    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("city", city);
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
    const entry = Array.isArray(data) ? data[0] : null;
    const lat = Number(entry?.lat);
    const lon = Number(entry?.lon);
    const address = entry?.address || {};
    const resolvedCity =
      address.city ||
      address.town ||
      address.village ||
      address.municipality ||
      address.county ||
      city;
    const country = address.country || "";

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !country) {
      return res.status(404).json({ error: "Location not found." });
    }

    return res.json({ city: resolvedCity, country, lat, lon });
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

app.post("/api/countries/:file/cities", requireAuth, async (req, res) => {
  try {
    if (!planAllows(req.user?.plan, ["basic", "premium"])) {
      return res.status(403).json({
        error: "Your plan does not allow adding new cities."
      });
    }

    const fileName = req.params.file;
    const { city, country } = req.body || {};

    if (!city || typeof city !== "string") {
      return res.status(400).json({ error: "City is required." });
    }
    const result = await generateCityInFile(fileName, city, country);
    return res.json(result);
  } catch (err) {
    console.error(err);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || "Failed to generate city data." });
  }
});

app.post("/api/cities/generate", requireAuth, async (req, res) => {
  try {
    if (!planAllows(req.user?.plan, ["basic", "premium"])) {
      return res.status(403).json({
        error: "Your plan does not allow adding new cities."
      });
    }

    const { city, country } = req.body || {};
    if (!city || typeof city !== "string") {
      return res.status(400).json({ error: "City is required." });
    }

    const trimmedCity = city.trim();
    if (!trimmedCity) {
      return res.status(400).json({ error: "City is required." });
    }

    let resolvedCountry = country?.trim();
    if (!resolvedCountry) {
      resolvedCountry = await resolveCountryForCity(trimmedCity);
    }

    if (!resolvedCountry) {
      return res.status(404).json({ error: "Country could not be resolved." });
    }

    const match = await findCountryFileByName(resolvedCountry);
    if (!match) {
      return res.status(404).json({ error: "No data file for resolved country." });
    }

    const existingCity = await cityExistsInFile(match.file, trimmedCity);
    if (existingCity) {
      return res.json({
        created: false,
        city: existingCity.name,
        country: match.country,
        file: match.file
      });
    }

    const result = await generateCityInFile(match.file, trimmedCity, match.country);
    return res.json(result);
  } catch (err) {
    console.error(err);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || "Failed to generate city data." });
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
const PENDING_USERS_PATH = path.join(DATA_DIR, "pending_users.json");

app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const users = await readJsonFile(USERS_PATH, []);
    const match = users.find((u) => u.id === req.user?.userId);

    return res.json({
      userId: req.user?.userId,
      name: match?.name || "",
      email: req.user?.email,
      plan: req.user?.plan,
      tokens: Number(match?.tokens || 0)
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to load user profile." });
  }
});

app.get("/api/auth/name-check", async (req, res) => {
  try {
    const rawName = String(req.query.name || "").trim();
    if (!rawName) {
      return res.status(400).json({ error: "Name is required." });
    }

    const normalized = normalizeUserName(rawName);
    const users = await readJsonFile(USERS_PATH, []);
    const pending = await readJsonFile(PENDING_USERS_PATH, []);

    const exists =
      users.some((u) => normalizeUserName(u.name) === normalized) ||
      pending.some((u) => normalizeUserName(u.name) === normalized);

    return res.json({ available: !exists });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to check name availability." });
  }
});


app.post("/api/auth/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email, and password required" });
    }

    const normalizedName = normalizeUserName(name);
    if (!normalizedName) {
      return res.status(400).json({ error: "Name is required." });
    }

    const normalizedEmail = normalizeEmail(email);
    const users = await readJsonFile(USERS_PATH, []);
    const existing = users.find((u) => normalizeEmail(u.email) === normalizedEmail);
    if (existing) {
      return res.status(409).json({ error: "User already exists." });
    }
    const nameExists = users.find((u) => normalizeUserName(u.name) === normalizedName);
    if (nameExists) {
      return res.status(409).json({ error: "Name already exists." });
    }

    const pending = await readJsonFile(PENDING_USERS_PATH, []);
    const pendingExisting = pending.find((u) => normalizeEmail(u.email) === normalizedEmail);
    if (pendingExisting) {
      return res.status(409).json({ error: "Signup already pending. Check your email to confirm." });
    }
    const pendingName = pending.find((u) => normalizeUserName(u.name) === normalizedName);
    if (pendingName) {
      return res.status(409).json({ error: "Name already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const token = crypto.randomBytes(32).toString("hex");
    const entry = {
      id: `u_${Date.now()}`,
      name: normalizedName,
      email: normalizedEmail,
      passwordHash,
      plan: "free",
      token,
      createdAt: new Date().toISOString()
    };

    pending.push(entry);
    await writeJsonFile(PENDING_USERS_PATH, pending);

    const confirmUrl = `${req.protocol}://${req.get("host")}/api/auth/confirm?token=${token}`;

    try {
      await sendSignupEmail(normalizedEmail, confirmUrl);
    } catch (mailErr) {
      pending.pop();
      await writeJsonFile(PENDING_USERS_PATH, pending);
      throw mailErr;
    }

    return res.json({ message: "Confirmation email sent. Please check your inbox." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Failed to create signup request." });
  }
});

app.get("/api/auth/confirm", async (req, res) => {
  try {
    const token = String(req.query.token || "");
    if (!token) {
      return res.status(400).send("Invalid or expired token.");
    }

    const pending = await readJsonFile(PENDING_USERS_PATH, []);
    const idx = pending.findIndex((u) => u.token === token);
    if (idx === -1) {
      return res.status(400).send("Invalid or expired token.");
    }

    const entry = pending[idx];
    pending.splice(idx, 1);
    await writeJsonFile(PENDING_USERS_PATH, pending);

    const users = await readJsonFile(USERS_PATH, []);
    let user = users.find((u) => normalizeEmail(u.email) === normalizeEmail(entry.email));

    if (!user) {
      user = {
        id: entry.id,
        name: entry.name,
        email: entry.email,
        passwordHash: entry.passwordHash,
        plan: entry.plan || "free",
        tokens: Number(entry.tokens || 0)
      };
      users.push(user);
      await writeJsonFile(USERS_PATH, users);
    }

    const authToken = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        plan: user.plan
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    const redirectUrl = buildClientUrl(req, "/");
    const url = new URL(redirectUrl);
    url.searchParams.set("token", authToken);

    return res.redirect(url.toString());
  } catch (err) {
    console.error(err);
    return res.status(500).send("Failed to confirm signup.");
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { username, name, email, password } = req.body || {};
  const rawIdentifier = username ?? name ?? email;

  if (!rawIdentifier || !password) {
    return res.status(400).json({ error: "Username or email and password required" });
  }

  const users = await readJsonFile(USERS_PATH, []);
  const normalizedName = normalizeUserName(rawIdentifier);
  const normalizedEmail = normalizeEmail(rawIdentifier);
  const user = users.find(
    (u) =>
      normalizeUserName(u.name) === normalizedName ||
      normalizeEmail(u.email) === normalizedEmail
  );

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
      name: user.name,
      email: user.email,
      plan: user.plan,
      tokens: Number(user.tokens || 0)
    }
  });
});
