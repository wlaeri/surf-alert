import { neon } from "@neondatabase/serverless";
import { EmailMessage } from "cloudflare:email";

// --- Types ---

interface Env {
  DATABASE_URL: string;
  SURF_SCORE_THRESHOLD: string;
  ALERT_FROM_EMAIL: string;
  ALERT_TIMEZONE?: string;
  ALERT_COOLDOWN_HOURS?: string;
  ALERT_DRY_RUN?: string;
  ALERT_EMAIL: SendEmail;
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

interface AlertContext {
  phrase: string;
  score: number;
  waveHeightFt: number;
  wavePeriodS: number;
  windSpeedMph: number;
  windDirectionDeg: number;
  tideFt: number;
  now: Date;
}

type AlertDecision =
  | { send: true }
  | {
      send: false;
      reason: "below_threshold" | "no_streak" | "outside_window" | "cooldown";
    };

// --- Constants ---

const JUPITER_FL = { lat: 26.93, lon: -80.07 };
const NOAA_STATION = "8722670"; // Lake Worth Pier (nearest active to Jupiter)
const M_TO_FT = 3.28084;
const STREAK_MAX_AGE_MS = 90 * 60 * 1000;

const SURF_LINGO_PHRASES: readonly string[] = [
  "Kowabunga — the Atlantic just cracked open a keg of corduroy.",
  "Glassy. Pumping. Offshore. Jupiter is going off, brah.",
  "Stoke levels critical. Evacuate the office.",
  "Mother Ocean is calling collect — pick up the damn phone.",
  "Peeling A-frames, light wind, no crowd. This is not a drill.",
  "Jupiter is firing like a Roman candle. Wax up.",
  "Corduroy to the horizon. Sell your laptop.",
  "Groomed, glassy, and giggling. Go.",
  "Swell's pulsing, wind's napping — get in the water.",
  "If you don't paddle out, the ghost of Tom Curren will haunt you.",
  "Jupiter just called in sick to work. You should too.",
  "The lineup is empty and the swell has your name on it.",
  "Waves so clean you could eat off them. GO.",
  "Offshore winds, overhead sets, zero excuses.",
  "The Atlantic is showing off. Don't leave it hanging.",
  "Barrels stacking like pancakes at IHOP. Move.",
  "Neptune is slinging A-frames. Catch one before he changes his mind.",
  "Conditions: absurd. Crowds: mythical. Stoke: nuclear.",
  "Swell is marching in formation. Attention! Paddle!",
  "The ocean is in full peacock mode. Show some respect.",
  "Lines from the heavens. Wax up and worship.",
  "Jupiter is gift-wrapping peelers just for you.",
  "Get in the car, get in the water, get in the barrel.",
  "Swell lit, wind bailed, tide stoked. Checkmate.",
  "The reef is humming, the sandbar is singing. Time to dance.",
];

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

// --- Alert Decision (pure) ---

function localHour(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  }).formatToParts(d);
  return Number(parts.find((p) => p.type === "hour")!.value);
}

function decideAlert(args: {
  currentScore: number;
  threshold: number;
  priorScore: number | null;
  priorTimestamp: Date | null;
  lastAlertAt: Date | null;
  now: Date;
  cooldownHours: number;
  timezone: string;
}): AlertDecision {
  if (args.currentScore < args.threshold) {
    return { send: false, reason: "below_threshold" };
  }

  const streakOk =
    args.priorScore !== null &&
    args.priorScore >= args.threshold &&
    args.priorTimestamp !== null &&
    args.now.getTime() - args.priorTimestamp.getTime() <= STREAK_MAX_AGE_MS;
  if (!streakOk) {
    return { send: false, reason: "no_streak" };
  }

  const hour = localHour(args.now, args.timezone);
  if (hour < 5 || hour > 17) {
    return { send: false, reason: "outside_window" };
  }

  if (args.lastAlertAt) {
    const hoursSince =
      (args.now.getTime() - args.lastAlertAt.getTime()) / 3_600_000;
    if (hoursSince < args.cooldownHours) {
      return { send: false, reason: "cooldown" };
    }
  }

  return { send: true };
}

// --- Phrase Selection ---

function pickPhrase(): string {
  return SURF_LINGO_PHRASES[
    Math.floor(Math.random() * SURF_LINGO_PHRASES.length)
  ];
}

// --- Email Rendering ---

function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function encodeSubject(s: string): string {
  return `=?UTF-8?B?${base64Utf8(s)}?=`;
}

function renderText(ctx: AlertContext): string {
  return [
    ctx.phrase,
    "",
    `Jupiter, FL · ${ctx.now.toUTCString()}`,
    "",
    `Waves: ${ctx.waveHeightFt.toFixed(1)}ft @ ${ctx.wavePeriodS.toFixed(0)}s`,
    `Wind:  ${ctx.windSpeedMph.toFixed(0)}mph · ${ctx.windDirectionDeg}°`,
    `Tide:  ${ctx.tideFt.toFixed(1)}ft`,
    `Score: ${ctx.score}/100`,
  ].join("\n");
}

function renderHtml(ctx: AlertContext): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#666">${label}</td><td style="padding:4px 0"><strong>${value}</strong></td></tr>`;
  return `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;max-width:520px;margin:0 auto;padding:24px">
<h1 style="font-size:22px;line-height:1.3;margin:0 0 16px">${escapeHtml(ctx.phrase)}</h1>
<p style="color:#666;margin:0 0 16px">Jupiter, FL · ${escapeHtml(ctx.now.toUTCString())}</p>
<table style="border-collapse:collapse;font-size:14px">
${row("Waves", `${ctx.waveHeightFt.toFixed(1)}ft @ ${ctx.wavePeriodS.toFixed(0)}s`)}
${row("Wind", `${ctx.windSpeedMph.toFixed(0)}mph · ${ctx.windDirectionDeg}°`)}
${row("Tide", `${ctx.tideFt.toFixed(1)}ft`)}
${row("Score", `${ctx.score}/100`)}
</table>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildMimeMessage(args: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}): string {
  const boundary = `bdy_${crypto.randomUUID()}`;
  const messageId = `<${crypto.randomUUID()}@surf-alert>`;
  return [
    `From: ${args.from}`,
    `To: ${args.to}`,
    `Subject: ${encodeSubject(args.subject)}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    base64Utf8(args.text),
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    base64Utf8(args.html),
    `--${boundary}--`,
    ``,
  ].join("\r\n");
}

// --- Notifier ---

class CloudflareEmailNotifier {
  constructor(
    private readonly binding: SendEmail,
    private readonly from: string,
    private readonly to: string,
    private readonly dryRun: boolean,
  ) {}

  async sendAlert(ctx: AlertContext): Promise<void> {
    const text = renderText(ctx);
    const html = renderHtml(ctx);
    const mime = buildMimeMessage({
      from: this.from,
      to: this.to,
      subject: ctx.phrase,
      text,
      html,
    });

    if (this.dryRun) {
      console.log(`[DRY-RUN] to=${this.to} subject="${ctx.phrase}"\n${text}`);
      return;
    }

    const msg = new EmailMessage(this.from, this.to, mime);
    await this.binding.send(msg);
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
  },
) {
  await sql`
    INSERT INTO surf_observations (timestamp, wave_height_ft, wave_period_s, wind_speed_mph, wind_direction_deg, tide_ft, surf_score)
    VALUES (now(), ${obs.waveHeightFt}, ${obs.wavePeriodS}, ${obs.windSpeedMph}, ${obs.windDirectionDeg}, ${obs.tideFt}, ${obs.surfScore})
  `;
}

async function getPreviousObservation(
  sql: Sql,
): Promise<{ surfScore: number; timestamp: Date } | null> {
  const rows = (await sql`
    SELECT surf_score, timestamp FROM surf_observations ORDER BY timestamp DESC LIMIT 1
  `) as Record<string, any>[];
  if (!rows.length) return null;
  return {
    surfScore: rows[0].surf_score,
    timestamp: new Date(rows[0].timestamp),
  };
}

async function getLastAlertTime(sql: Sql): Promise<Date | null> {
  const rows = (await sql`
    SELECT timestamp FROM alerts ORDER BY timestamp DESC LIMIT 1
  `) as Record<string, any>[];
  return rows.length ? new Date(rows[0].timestamp) : null;
}

async function insertAlert(
  sql: Sql,
  score: number,
  message: string,
  phrase: string,
) {
  await sql`
    INSERT INTO alerts (timestamp, surf_score, message, phrase)
    VALUES (now(), ${score}, ${message}, ${phrase})
  `;
}

// --- Main Handler ---

async function handleScheduled(env: Env): Promise<string> {
  const sql = neon(env.DATABASE_URL);
  const threshold = parseInt(env.SURF_SCORE_THRESHOLD || "70", 10);
  const cooldownHours = parseInt(env.ALERT_COOLDOWN_HOURS || "24", 10);
  const timezone = env.ALERT_TIMEZONE || "America/New_York";
  const dryRun = env.ALERT_DRY_RUN === "1";
  const to = "wlaeri@gmail.com"; // pinned at binding level; mirrored here for MIME headers
  const notifier = new CloudflareEmailNotifier(
    env.ALERT_EMAIL,
    env.ALERT_FROM_EMAIL,
    to,
    dryRun,
  );

  console.log("Fetching marine, wind, and tide data...");
  const [marine, wind, tide] = await Promise.all([
    fetchMarineData(),
    fetchWindData(),
    fetchTideData(),
  ]);

  console.log(
    `Data: ${marine.waveHeightFt.toFixed(1)}ft @ ${marine.wavePeriodS}s, ` +
      `wind ${wind.windSpeedMph.toFixed(0)}mph/${wind.windDirectionDeg}°, ` +
      `tide ${tide.tideFt.toFixed(1)}ft`,
  );

  const { score } = computeSurfScore({
    waveHeightFt: marine.waveHeightFt,
    wavePeriodS: marine.wavePeriodS,
    windSpeedMph: wind.windSpeedMph,
    windDirectionDeg: wind.windDirectionDeg,
    tideFt: tide.tideFt,
  });

  console.log(`Surf score: ${score}/100`);

  const prior = await getPreviousObservation(sql);

  await insertObservation(sql, {
    waveHeightFt: marine.waveHeightFt,
    wavePeriodS: marine.wavePeriodS,
    windSpeedMph: wind.windSpeedMph,
    windDirectionDeg: wind.windDirectionDeg,
    tideFt: tide.tideFt,
    surfScore: score,
  });

  const lastAlertAt = await getLastAlertTime(sql);
  const now = new Date();
  const decision = decideAlert({
    currentScore: score,
    threshold,
    priorScore: prior?.surfScore ?? null,
    priorTimestamp: prior?.timestamp ?? null,
    lastAlertAt,
    now,
    cooldownHours,
    timezone,
  });

  if (!decision.send) {
    const summary = `Score ${score}/100 — no alert (${decision.reason})`;
    console.log(summary);
    return summary;
  }

  const phrase = pickPhrase();
  const ctx: AlertContext = {
    phrase,
    score,
    waveHeightFt: marine.waveHeightFt,
    wavePeriodS: marine.wavePeriodS,
    windSpeedMph: wind.windSpeedMph,
    windDirectionDeg: wind.windDirectionDeg,
    tideFt: tide.tideFt,
    now,
  };
  const message = renderText(ctx);
  await notifier.sendAlert(ctx);
  await insertAlert(sql, score, message, phrase);

  const summary = `Alert sent (score ${score}/100): ${phrase}`;
  console.log(summary);
  return summary;
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
      return new Response(JSON.stringify({ ok: false, error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      handleScheduled(env).catch((err) =>
        console.error("Scheduled handler error:", err),
      ),
    );
  },
};
