// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

let OpenAI;
try {
  OpenAI = require("openai");
} catch {
  console.warn("⚠️ openai package not found. Install with: npm install openai");
  OpenAI = null;
}

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json());

// --- Monte Carlo Simulation for Cost Estimation ---
function sampleTotalsFromInputs({
  tuition = 0,
  months = 12,
  rent = 0,
  food = 0,
  transport = 0,
  scholarship = 0
}) {
  function randn_bm(mean = 0, std = 1) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2 * Math.PI * v) * std + mean;
  }

  const rentStd = Math.max(0.1 * rent, 50);
  const foodStd = Math.max(0.15 * food, 20);
  const transportStd = Math.max(0.2 * transport, 10);

  const sims = 500;
  const totals = [];

  for (let i = 0; i < sims; i++) {
    const r = Math.max(0, randn_bm(rent, rentStd));
    const f = Math.max(0, randn_bm(food, foodStd));
    const tr = Math.max(0, randn_bm(transport, transportStd));
    const utilities = 70;
    const misc = 100;
    const monthlyTotal = r + f + tr + utilities + misc;
    const livingTotal = monthlyTotal * months;
    const oneTime = 200 + 800 + 500; // visa + flight + setup
    totals.push(tuition + livingTotal + oneTime - scholarship);
  }

  totals.sort((a, b) => a - b);
  return {
    p10: Math.round(totals[Math.floor(0.1 * totals.length)]),
    median: Math.round(totals[Math.floor(0.5 * totals.length)]),
    p90: Math.round(totals[Math.floor(0.9 * totals.length)])
  };
}

// --- POST: /api/estimate ---
app.post("/api/estimate", async (req, res) => {
  try {
    const body = req.body || {};
    const tuition = Number(body.tuition) || 0;
    const months = Number(body.months) || 12;
    const rent = Number(body.monthly?.rent) || 0;
    const food = Number(body.monthly?.food) || 0;
    const transport = Number(body.monthly?.transport) || 0;
    const scholarship = Number(body.scholarship) || 0;

    const inputs = { tuition, months, rent, food, transport, scholarship };
    const livingMedian = Math.round((rent + food + transport + 70 + 100) * months);
    const totals = sampleTotalsFromInputs(inputs);

    let recommendations = [
      "Consider shared housing (reduce rent by 25–40%).",
      "Apply early for university or local scholarships.",
      "Cook at home to save 30–50% on food costs.",
      "Look for part-time campus jobs if eligible.",
      "Compare travel/health insurance for student discounts."
    ];

    // --- Optional: OpenAI Smart Recommendations ---
    if (OpenAI && process.env.OPENAI_API_KEY) {
      try {
        const client = new OpenAI.OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        const aiPrompt = `
You are a cost advisor for international students.
Tuition: ${tuition} USD
Monthly costs: rent ${rent}, food ${food}, transport ${transport}
Scholarship: ${scholarship} USD
Duration: ${months} months
Return exactly 5 short actionable money-saving tips as a JSON array of strings.
`;

        let aiText = null;

        // Support both SDK shapes
        if (client.chat?.completions?.create) {
          const aiResp = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "You are a cost estimation assistant." },
              { role: "user", content: aiPrompt }
            ],
            temperature: 0.7
          });
          aiText = aiResp.choices?.[0]?.message?.content;
        } else if (client.responses?.create) {
          const aiResp = await client.responses.create({
            model: "gpt-4o-mini",
            input: aiPrompt,
            temperature: 0.7
          });
          aiText = aiResp.output?.[0]?.content?.[0]?.text || aiResp.output_text;
        }

        if (aiText) {
          try {
            const parsed = JSON.parse(aiText);
            if (Array.isArray(parsed)) recommendations = parsed;
          } catch {
            const lines = aiText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            if (lines.length >= 1) recommendations = lines.slice(0, 5);
          }
        }
      } catch (e) {
        console.error("⚠️ OpenAI request failed:", e.message);
      }
    }

    const response = {
      currency: "USD",
      estimate: {
        tuition: Math.round(tuition),
        living_median: livingMedian,
        one_time: 200 + 800 + 500,
        scholarships: -Math.round(scholarship),
        total_median: totals.median,
        total_p10: totals.p10,
        total_p90: totals.p90,
        months
      },
      breakdown: [
        { label: "Tuition", amount: Math.round(tuition) },
        { label: "Living (median)", amount: livingMedian },
        { label: "One-time", amount: 200 + 800 + 500 },
        { label: "Scholarships", amount: -Math.round(scholarship) }
      ],
      recommendations
    };

    res.json(response);
  } catch (err) {
    console.error("❌ Internal server error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/", (req, res) => {
  res.send("✅ AI Cost Estimator backend is running successfully!");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
