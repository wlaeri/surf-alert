import { neon } from "@neondatabase/serverless";

// --- Types ---

interface Env {
  DATABASE_URL: string;
  SURF_SCORE_THRESHOLD: string;
}

interface MarineData {
  waveHeightFt: number;
  wavePeriodS: number;
  swellDirectionDeg: number;
}

interface WindData {
  windSpeedMph: number;
  windDirectionDeg: number;
}

interface TideData {
  tideFt: number;
}

interface SurfScore {
  score: number;
  isGood: boolean;
}

interface Notifier {
  send(message: string): Promise<void>;
}

// --- Constants ---

const JUPITER_FL = { lat: 26.93, lon: -80.07 };
const NOAA_STATION = "8722670"; // Lake Worth Pier (nearest active to Jupiter)
const ALERT_COOLDOWN_HOURS = 6;
const MS_TO_MPH = 2.23694;
const M_TO_FT = 3.28084;

// --- API Fetching ---

async function fetchMarineData(): Promise<MarineData> {
  const url =
    `https://marine-api.open-meteo.com/v1/marine` +
    `?latitude=${JUPITER_FL.lat}&longitude=${JUPITER_FL.lon}` +
    `&current=wave_height,wave_period,wave_direction`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Marine API error: ${res.status}`);
  const data = await res.json<any>();
  const c = data.current;

  return {
    waveHeightFt: c.wave_height * M_TO_FT,
    wavePeriodS: c.wave_period,
    swellDirectionDeg: c.wave_direction,
  };
}

async function fetchWindData(): Promise<WindData> {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${JUPITER_FL.lat}&longitude=${JUPITER_FL.lon}` +
    `&current=wind_speed_10m,wind_direction_10m` +
    `&wind_speed_unit=mph`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wind API error: ${res.status}`);
  const data = await res.json<any>();
  const c = data.current;

  return {
    windSpeedMph: c.wind_speed_10m,
    windDirectionDeg: c.wind_direction_10m,
  };
}

async function fetchTideData(): Promise<TideData> {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const url =
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
    `?date=latest&station=${NOAA_STATION}&product=water_level` +
    `&datum=MLLW&units=english&time_zone=gmt&format=json`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`NOAA API error: ${res.status}`);
  const data = await res.json<any>();

  if (!data.data?.length) throw new Error("No tide data available");

  return { tideFt: parseFloat(data.data[0].v) };
}

// --- Scoring ---

function computeSurfScore(inputs: {
  waveHeightFt: number;
  wavePeriodS: number;
  windSpeedMph: number;
  windDirectionDeg: number;
  tideFt: number;
}): SurfScore {
  let score = 0;

  // Wave height: ideal 2.5–4.5 ft (max 40 pts)
  const { waveHeightFt } = inputs;
  if (waveHeightFt >= 2.5 && waveHeightFt <= 4.5) {
    score += 40;
  } else if (waveHeightFt >= 1.5 && waveHeightFt < 2.5) {
    score += 25;
  } else if (waveHeightFt > 4.5 && waveHeightFt <= 6) {
    score += 25;
  } else if (waveHeightFt >= 1) {
    score += 10;
  }

  // Wave period: >= 8s is great (max 30 pts)
  if (inputs.wavePeriodS >= 10) {
    score += 30;
  } else if (inputs.wavePeriodS >= 8) {
    score += 25;
  } else if (inputs.wavePeriodS >= 6) {
    score += 15;
  } else {
    score += 5;
  }

  // Wind: lighter is better, onshore (E/SE ~45-135°) is worse (max 20 pts)
  const isOnshore =
    inputs.windDirectionDeg >= 45 && inputs.windDirectionDeg <= 135;
  if (inputs.windSpeedMph <= 5) {
    score += 20;
  } else if (inputs.windSpeedMph <= 10) {
    score += isOnshore ? 10 : 15;
  } else if (inputs.windSpeedMph <= 15) {
    score += isOnshore ? 3 : 8;
  }
  // >15 mph: 0 pts

  // Tide: mid-tide is best for Jupiter (max 10 pts)
  const { tideFt } = inputs;
  if (tideFt >= 1 && tideFt <= 3) {
    score += 10;
  } else if (tideFt >= 0.5 && tideFt <= 4) {
    score += 6;
  } else {
    score += 2;
  }

  return { score: Math.min(score, 100), isGood: score >= 70 };
}

// --- Alert Logic ---

function shouldSendAlert(
  currentScore: number,
  threshold: number,
  lastAlertTime: Date | null
): boolean {
  if (currentScore < threshold) return false;
  if (!lastAlertTime) return true;

  const hoursSince =
    (Date.now() - lastAlertTime.getTime()) / (1000 * 60 * 60);
  return hoursSince >= ALERT_COOLDOWN_HOURS;
}

// --- Notifications ---

function formatAlertMessage(inputs: {
  waveHeightFt: number;
  wavePeriodS: number;
  windSpeedMph: number;
  score: number;
}): string {
  const windLabel =
    inputs.windSpeedMph <= 5
      ? "glassy"
      : inputs.windSpeedMph <= 10
        ? "light wind"
        : "moderate wind";

  return (
    `🏄 Surf looks good in Jupiter! ` +
    `${inputs.waveHeightFt.toFixed(1)}ft @ ${inputs.wavePeriodS.toFixed(0)}s, ` +
    `${windLabel} (${inputs.windSpeedMph.toFixed(0)}mph) — ` +
    `score: ${inputs.score}/100`
  );
}

class ConsoleNotifier implements Notifier {
  async send(message: string): Promise<void> {
    console.log(`[ALERT] ${message}`);
  }
}

// --- Database ---

type Sql = ReturnType<typeof neon<false, false>>;

async function insertObservation(
  sql: Sql,
  obs: {
    waveHeightFt: number;
    wavePeriodS: number;
    windSpeedMph: number;
    windDirectionDeg: number;
    tideFt: number;
    surfScore: number;
  }
) {
  await sql`
    INSERT INTO surf_observations (timestamp, wave_height_ft, wave_period_s, wind_speed_mph, wind_direction_deg, tide_ft, surf_score)
    VALUES (now(), ${obs.waveHeightFt}, ${obs.wavePeriodS}, ${obs.windSpeedMph}, ${obs.windDirectionDeg}, ${obs.tideFt}, ${obs.surfScore})
  `;
}

async function getLastAlertTime(sql: Sql): Promise<Date | null> {
  const rows = await sql`
    SELECT timestamp FROM alerts ORDER BY timestamp DESC LIMIT 1
  ` as Record<string, any>[];
  return rows.length ? new Date(rows[0].timestamp) : null;
}

async function insertAlert(sql: Sql, score: number, message: string) {
  await sql`
    INSERT INTO alerts (timestamp, surf_score, message)
    VALUES (now(), ${score}, ${message})
  `;
}

// --- Main Handler ---

async function handleScheduled(env: Env): Promise<string> {
  const sql = neon(env.DATABASE_URL);
  const threshold = parseInt(env.SURF_SCORE_THRESHOLD || "70", 10);
  const notifier = new ConsoleNotifier();

  // 1. Fetch data (parallel)
  console.log("Fetching marine, wind, and tide data...");
  const [marine, wind, tide] = await Promise.all([
    fetchMarineData(),
    fetchWindData(),
    fetchTideData(),
  ]);

  console.log(
    `Data: ${marine.waveHeightFt.toFixed(1)}ft @ ${marine.wavePeriodS}s, ` +
      `wind ${wind.windSpeedMph.toFixed(0)}mph/${wind.windDirectionDeg}°, ` +
      `tide ${tide.tideFt.toFixed(1)}ft`
  );

  // 2. Compute score
  const { score, isGood } = computeSurfScore({
    waveHeightFt: marine.waveHeightFt,
    wavePeriodS: marine.wavePeriodS,
    windSpeedMph: wind.windSpeedMph,
    windDirectionDeg: wind.windDirectionDeg,
    tideFt: tide.tideFt,
  });

  console.log(`Surf score: ${score}/100 (good: ${isGood})`);

  // 3. Store observation
  await insertObservation(sql, {
    waveHeightFt: marine.waveHeightFt,
    wavePeriodS: marine.wavePeriodS,
    windSpeedMph: wind.windSpeedMph,
    windDirectionDeg: wind.windDirectionDeg,
    tideFt: tide.tideFt,
    surfScore: score,
  });

  // 4. Check alert
  const lastAlert = await getLastAlertTime(sql);
  if (shouldSendAlert(score, threshold, lastAlert)) {
    const message = formatAlertMessage({
      waveHeightFt: marine.waveHeightFt,
      wavePeriodS: marine.wavePeriodS,
      windSpeedMph: wind.windSpeedMph,
      score,
    });
    await notifier.send(message);
    await insertAlert(sql, score, message);
    return message;
  }

  return `Score ${score}/100 — no alert sent`;
}

// --- Worker Export ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const result = await handleScheduled(env);
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: any) {
      console.error("Fetch handler error:", err);
      return new Response(
        JSON.stringify({ ok: false, error: err.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(
      handleScheduled(env).catch((err) =>
        console.error("Scheduled handler error:", err)
      )
    );
  },
};
