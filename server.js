// server.js (robust, safe)
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

let OpenAI;
try {
  OpenAI = require("openai");
} catch (err) {
  // openai not installed — we'll still allow basic functionality
  OpenAI = null;
}

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json());

function sampleTotalsFromInputs({ tuition = 0, months = 12, rent = 0, food = 0, transport = 0, scholarship = 0 }) {
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
    const oneTime = 200 + 800 + 500;
    totals.push(tuition + livingTotal + oneTime - scholarship);
  }

  totals.sort((a, b) => a - b);
  return {
    p10: Math.round(totals[Math.floor(0.1 * totals.length)]),
    median: Math.round(totals[Math.floor(0.5 * totals.length)]),
    p90: Math.round(totals[Math.floor(0.9 * totals.length)])
  };
}

app.post("/api/estimate", async (req, res) => {
  try {
    const body = req.body || {};
    const tuition = Number(body.tuition) || 0;
    const months = Number(body.months) || 12;
    const rent = Number(body.monthly?.rent) || 0;
    const food = Number(body.monthly?.food) || 0;
    const transport = Number(body.monthly?.transport) || 0;
    const scholarship = Number(body.scholarship) || 0;

    // get numeric safe values
    const inputs = { tuition, months, rent, food, transport, scholarship };

    // compute deterministic median living too
    const livingMedian = Math.round((rent + food + transport + 70 + 100) * months);

    // Monte Carlo totals
    const totals = sampleTotalsFromInputs(inputs);

    // Default recommendations (fallback)
    let recommendations = [
      "Consider shared housing (could reduce rent by ~25–40%).",
      "Apply for university / local scholarships early.",
      "Cook at home to reduce food costs.",
      "Look for on-campus part-time roles if eligible.",
      "Shop around for student travel/health insurance."
    ];

    // If OpenAI installed and API key present, try to call it.
    if (OpenAI && process.env.OPENAI_API_KEY) {
      try {
        const client = new OpenAI.OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        // Compose simple prompt (ask for JSON array)
        const aiPrompt = `
You are a helpful cost advisor for international students.
Tuition: ${tuition} USD
Monthly: rent ${rent}, food ${food}, transport ${transport}
Scholarship: ${scholarship} USD
Duration: ${months} months
Return 5 short actionable tips as a JSON array of strings only.
`;

        // Support both older and newer package shapes: try chat.completions first (many versions support it)
        let aiResultText = null;
        if (client.chat && client.chat.completions && typeof client.chat.completions.create === "function") {
          // older style
          const aiResp = await client.chat.completions.create({
            model: "gpt-4",
            messages: [
              { role: "system", content: "You are a helpful cost estimator assistant." },
              { role: "user", content: aiPrompt }
            ],
            temperature: 0.7
          });
          aiResultText = aiResp?.choices?.[0]?.message?.content;
        } else if (typeof client.responses === "object" && typeof client.responses.create === "function") {
          // newer OpenAI SDK (responses API)
          const aiResp = await client.responses.create({
            model: "gpt-4",
            input: aiPrompt,
            temperature: 0.7
          });
          aiResultText = aiResp?.output?.[0]?.content?.[0]?.text || aiResp?.output_text;
        } else {
          // unknown client shape — skip
          aiResultText = null;
        }

        if (aiResultText) {
          try {
            const parsed = JSON.parse(aiResultText);
            if (Array.isArray(parsed) && parsed.length > 0) recommendations = parsed;
          } catch (e) {
            // Not valid JSON — try to extract lines
            const lines = aiResultText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            if (lines.length >= 1) {
              // take first 5 non-empty lines as fallback
              recommendations = lines.slice(0, 5).map(l => l.replace(/^\d+[\.\)]\s*/, ""));
            }
          }
        }
      } catch (aiErr) {
        console.error("OpenAI call failed:", aiErr && aiErr.message ? aiErr.message : aiErr);
        // keep default recommendations
      }
    } else {
      if (!OpenAI) console.warn("openai package is not installed. Install with: npm install openai");
      if (!process.env.OPENAI_API_KEY) console.warn("OPENAI_API_KEY not found in environment variables.");
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

    return res.json(response);
  } catch (err) {
    console.error("Unhandled server error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "Internal server error", details: err && err.message ? err.message : String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Estimator backend listening on http://localhost:${PORT}`);
});
