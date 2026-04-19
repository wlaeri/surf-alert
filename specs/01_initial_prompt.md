# Surf Alert

You are a senior TypeScript backend engineer. Build a production-ready MVP for a "Surf Alert" system focused on Jupiter, Florida.

---

## Goal

Create a Cloudflare Worker that runs on a cron schedule (hourly), fetches marine + tide data, computes a surf score, stores results in Neon (Postgres), and sends a notification if conditions are good.

---

## Tech Stack (MANDATORY)

- Runtime: Cloudflare Workers
- Language: TypeScript
- Database: Neon (serverless Postgres)
- HTTP: native fetch (no heavy SDKs)
- Scheduling: Cloudflare Cron Triggers
- No frameworks (no Express, no Next.js)

---

## Data Sources

Use free APIs:

### 1. Open-Meteo Marine API
- wave height
- wave period
- swell direction
- wind speed + direction

### 2. NOAA CO-OPS API
- tides
- station ID: 8722495 (Jupiter Inlet)

---

## Database (Neon)

Design a minimal schema:

### Table: surf_observations
- id (uuid)
- timestamp (utc)
- wave_height_ft (float)
- wave_period_s (float)
- wind_speed_mph (float)
- wind_direction_deg (int)
- tide_ft (float)
- surf_score (int)
- created_at (timestamp default now())

### Table: alerts
- id (uuid)
- timestamp (utc)
- surf_score (int)
- message (text)
- created_at (timestamp default now())

---

## Core Logic

Implement:

### computeSurfScore(inputs) → { score: number, isGood: boolean }

Inputs:
- wave height (ft)
- wave period (seconds)
- wind speed (mph)
- wind direction (degrees)
- tide (ft)

Rules:
- ideal wave height: 2.5–4.5 ft
- ideal period: >= 8 sec
- penalize strong onshore wind (>12 mph)
- keep scoring simple but modular

Return:
- score (0–100)
- isGood (score >= 70)

---

## Alert Logic

Implement:

### shouldSendAlert(currentScore, lastAlertTimestamp)

Rules:
- send alert only if score >= threshold
- AND no alert sent in last 6 hours

---

## Notification

Create a pluggable notification system:

- start with console.log
- structure so it can later support:
  - email
  - Slack webhook
  - Pushover

Include a formatted message like:
"Surf looks good: 3.2ft @ 9s, light wind — worth going"

---

## Cloudflare Worker Structure

- export default object with:
  - fetch() handler (optional for testing)
  - scheduled(event, env, ctx) handler (PRIMARY ENTRYPOINT)

The scheduled handler should:
1. fetch marine data
2. fetch tide data
3. compute surf score
4. insert into Neon
5. check last alert
6. send alert if needed
7. persist alert

---

## Neon Integration

- Use standard Postgres driver compatible with Cloudflare Workers (neon HTTP or serverless driver)
- Use environment variables:
  - DATABASE_URL

Include:
- connection setup
- example queries (insert + select)

---

## Environment Variables

Define:

- DATABASE_URL
- SURF_SCORE_THRESHOLD (default 70)

---

## Output Requirements

Provide:

1. Full TypeScript Worker code (single file is fine)
2. SQL schema (CREATE TABLE statements)
3. Example wrangler.toml with cron config
4. Instructions to deploy:
   - install wrangler
   - set env vars
   - deploy worker
5. Example curl/test method

---

## Constraints

- Keep it under ~250–300 lines
- Clean, readable, production-quality code
- No unnecessary abstractions
- Prefer small pure functions

---

## Bonus (if easy)

- Add basic logging
- Handle API failures gracefully
- Add retry logic (simple)

---

Start with the code immediately.