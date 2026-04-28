# Surf Alert — Email Alerting

Extends `01_initial_prompt.md`. Replaces the console notifier with email and adds guardrails so we only send alerts when conditions are actually worth paddling out.

---

## Goal

Deliver surf alerts by email, with copy drawn from a bank of over-the-top
surf-lingo phrases, and gated by guardrails that prevent false-positive and
inconvenient alerts.

---

## Email Delivery

Use **Cloudflare Email Workers** via a `send_email` binding. The binding is
declared in `wrangler.toml` and exposed on `env` at runtime as a sender
object with a `send(message)` method that accepts a MIME-formatted
`EmailMessage` (from `cloudflare:email`).

### Wrangler binding

```toml
[[send_email]]
name = "ALERT_EMAIL"
destination_address = "wlaeri@gmail.com"
```

Pinning `destination_address` locks the binding to a single verified
recipient (this is a Cloudflare safety feature — the recipient must be
verified under Email Routing on the sending domain).

### Constraints

- `to`: must be `wlaeri@gmail.com` (verified destination on the Email
  Routing zone).
- `from`: any address on a domain managed by this Cloudflare account with
  Email Routing enabled — the specific local-part and subdomain don't
  matter. Default to `alerts@<cf-managed-domain>`; pick whatever is
  cheapest to wire up in the Cloudflare dashboard. Store it in
  `ALERT_FROM_EMAIL` so the code doesn't hardcode a domain.
- Message: build via `EmailMessage` + a MIME string (`mimetext` or a small
  hand-rolled MIME builder — prefer the latter to avoid a dep). Include
  both `text/plain` and `text/html` parts.

### Notifier interface

Implement `CloudflareEmailNotifier implements Notifier` in `src/index.ts`.
Keep the existing `Notifier` contract (`send(message: string): Promise<void>`)
and pass structured context (score, wave, wind, tide, phrase) through a
second argument or a dedicated method so the email body can include more
than the one-liner.

### Dry-run

`ALERT_DRY_RUN=1` → skip the binding call and log the rendered email
(subject + text body) to `console.log`. Useful for local testing before the
binding is wired up.

---

## Phrase Bank

A static array of 15–25 canned phrases, hand-written, over-the-top surf
lingo. Pick one uniformly at random per alert.

Ship the following 25 phrases inline in `src/index.ts` as
`SURF_LINGO_PHRASES: readonly string[]`. Selection:
`phrases[Math.floor(Math.random() * phrases.length)]`.

1. "Kowabunga — the Atlantic just cracked open a keg of corduroy."
2. "Glassy. Pumping. Offshore. Jupiter is going off, brah."
3. "Stoke levels critical. Evacuate the office."
4. "Mother Ocean is calling collect — pick up the damn phone."
5. "Peeling A-frames, light wind, no crowd. This is not a drill."
6. "Jupiter is firing like a Roman candle. Wax up."
7. "Corduroy to the horizon. Sell your laptop."
8. "Groomed, glassy, and giggling. Go."
9. "Swell's pulsing, wind's napping — get in the water."
10. "If you don't paddle out, the ghost of Tom Curren will haunt you."
11. "Jupiter just called in sick to work. You should too."
12. "The lineup is empty and the swell has your name on it."
13. "Waves so clean you could eat off them. GO."
14. "Offshore winds, overhead sets, zero excuses."
15. "The Atlantic is showing off. Don't leave it hanging."
16. "Barrels stacking like pancakes at IHOP. Move."
17. "Neptune is slinging A-frames. Catch one before he changes his mind."
18. "Conditions: absurd. Crowds: mythical. Stoke: nuclear."
19. "Swell is marching in formation. Attention! Paddle!"
20. "The ocean is in full peacock mode. Show some respect."
21. "Lines from the heavens. Wax up and worship."
22. "Jupiter is gift-wrapping peelers just for you."
23. "Get in the car, get in the water, get in the barrel."
24. "Swell lit, wind bailed, tide stoked. Checkmate."
25. "The reef is humming, the sandbar is singing. Time to dance."

Optional: persist the selected phrase in the `alerts` row so we can audit
distribution later (see Schema Changes).

---

## Guardrails

An alert may only be sent when **all** of the following hold:

1. **Current score** ≥ `SURF_SCORE_THRESHOLD`.
2. **Two consecutive hours above threshold.** The most recent prior
   observation in `surf_observations` (excluding the one we just inserted)
   also has `surf_score >= threshold`, AND its `timestamp` is within the
   last 90 minutes (tolerance around the hourly cron).
3. **Local-time window.** Current UTC converted to `America/New_York` falls
   in 5:00 AM through 5:59 PM inclusive — i.e. local hour ∈ {5,6,…,17}.
   So a cron firing at 5:00 PM local is allowed; 6:00 PM is not.
4. **Cooldown.** No alert sent in the last `ALERT_COOLDOWN_HOURS` (default
   **24**).

All four are ANDed. Guardrail failures should be logged with the specific
reason, so we can sanity-check the cron output.

### Pure predicate

Refactor `shouldSendAlert` into a pure function that takes all inputs and
returns a discriminated result:

```ts
type AlertDecision =
  | { send: true }
  | { send: false; reason: "below_threshold" | "no_streak" | "outside_window" | "cooldown" };

function decideAlert(args: {
  currentScore: number;
  threshold: number;
  priorScore: number | null;
  priorTimestamp: Date | null;
  lastAlertAt: Date | null;
  now: Date;
  cooldownHours: number;
}): AlertDecision;
```

Keeps the rules unit-testable without the Worker runtime.

### Local-hour helper

Use `Intl.DateTimeFormat` (available in Workers):

```ts
function localHour(d: Date, tz = "America/New_York"): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  }).formatToParts(d);
  return Number(parts.find(p => p.type === "hour")!.value);
}
```

---

## Schema Changes

Minimal. Add one nullable column to `alerts`:

```sql
ALTER TABLE alerts ADD COLUMN phrase TEXT;
```

Write the selected phrase into `phrase` (and keep the existing `message`
column for the full rendered one-liner). Skip a separate
`email_delivery_log` table for MVP — the Resend API response is enough and
the scheduled-handler logs are durable via Cloudflare tail.

---

## Environment Variables

Additions:

- `ALERT_FROM_EMAIL` — required (address on a Cloudflare-managed domain with
  Email Routing enabled)
- `ALERT_DRY_RUN` — optional, `"1"` to suppress the binding call
- `ALERT_TIMEZONE` — optional, defaults to `America/New_York`
- `ALERT_COOLDOWN_HOURS` — optional, defaults to `24`

The recipient is pinned at the binding level (`destination_address` in
`wrangler.toml`), not via env var.

Bindings (not env vars, but belong in `wrangler.toml`):

- `ALERT_EMAIL` — `send_email` binding, `destination_address =
  "wlaeri@gmail.com"`

---

## Handler Changes

In `handleScheduled`:

1. Fetch marine / wind / tide as today.
2. Compute score as today.
3. **Before inserting** the new observation, query the most recent prior
   row: `SELECT surf_score, timestamp FROM surf_observations ORDER BY timestamp DESC LIMIT 1`.
4. Insert the new observation (as today).
5. Build the `AlertDecision` via `decideAlert(...)`.
6. If `send: true`: pick a phrase, render email, call
   `CloudflareEmailNotifier.send`, insert into `alerts` with `phrase`
   column populated.
7. If `send: false`: log the reason and return.

Return value from `handleScheduled` should include the decision reason so
the `fetch` handler's JSON response stays useful for manual testing.

---

## Testing

- Unit tests for `decideAlert` covering each guardrail branch — pure
  function, no runtime deps.
- A small fixture file for `localHour` edge cases (DST transitions,
  midnight UTC vs local).
- Manual smoke test: hit the `fetch` endpoint with `ALERT_DRY_RUN=1` and
  verify the rendered email in logs.

---

## Out of Scope

- Multi-recipient personalization
- Unsubscribe link / list management
- SMS / push / Slack (keep the `Notifier` seam, but don't implement)
- Per-user thresholds
