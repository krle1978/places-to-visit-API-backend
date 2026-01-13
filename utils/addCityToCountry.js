import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const COUNTRIES_PATH = path.resolve(
  process.cwd(),
  "assets/recommendations/countries"
);

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * MAIN FUNCTION
 */
export async function addCityIfMissing(cityName) {
  const normalizedCity = cityName.trim().toLowerCase();

  // --------------------------------------------------
  // 1. CHECK IF CITY ALREADY EXISTS
  // --------------------------------------------------
  const files = fs.readdirSync(COUNTRIES_PATH);

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    const filePath = path.join(COUNTRIES_PATH, file);
    const json = JSON.parse(fs.readFileSync(filePath, "utf8"));

    const found = json?.cities?.find(
      c => c.name.toLowerCase() === normalizedCity
    );

    if (found) {
      return {
        exists: true,
        country: json.name,
        city: found.name
      };
    }
  }

  // --------------------------------------------------
  // 2. CITY NOT FOUND → GENERATE WITH OPENAI
  // --------------------------------------------------
  const aiResponse = await client.responses.create({
    model: "gpt-4.1-mini",
    text: {
      format: { type: "json_object" }
    },
    input: [
      {
        role: "system",
        content: `
            You are City Tour Guide AI.

            Return ONLY valid JSON.
            No markdown, no text outside JSON.

            City name: ${cityName}

            The JSON MUST follow this schema:
            {
            "name": "",
            "interests": [],
            "local_food_tip": "",
            "full_day": {},
            "seasons": {},
            "public_transport_tips": [],
            "city_events": [],
            "places": [],
            "hidden_gems": []
            }
            `
      }
    ]
  });

  const cityJSON = JSON.parse(
    aiResponse.output[0].content[0].text
  );

  if (!cityJSON?.name) {
    throw new Error("Invalid AI response: missing city name");
  }

  // --------------------------------------------------
  // 3. DETERMINE COUNTRY (SIMPLE HEURISTIC)
  // --------------------------------------------------
  // You can later replace this with smarter logic if needed
  const countryKey = detectCountryByCity(cityJSON.name);

  if (!countryKey) {
    throw new Error("Country could not be determined");
  }

  const countryFile = files.find(f =>
    f.toLowerCase().includes(countryKey.toLowerCase())
  );

  if (!countryFile) {
    throw new Error("Country JSON file not found");
  }

  // --------------------------------------------------
  // 4. INSERT CITY & SORT
  // --------------------------------------------------
  const countryPath = path.join(COUNTRIES_PATH, countryFile);
  const countryJSON = JSON.parse(fs.readFileSync(countryPath, "utf8"));

  countryJSON.cities.push(cityJSON);

  countryJSON.cities.sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  fs.writeFileSync(
    countryPath,
    JSON.stringify(countryJSON, null, 2),
    "utf8"
  );

  return {
    exists: false,
    country: countryJSON.name,
    city: cityJSON.name
  };
}

/**
 * VERY SIMPLE COUNTRY DETECTOR
 * (replace later if needed)
 */
function detectCountryByCity(city) {
  const map = {
    vienna: "austria",
    paris: "france",
    berlin: "germany",
    rome: "italy",
    madrid: "spain",
    lisbon: "portugal",
    belgrade: "serbia"
  };

  return map[city.toLowerCase()] || null;
}
