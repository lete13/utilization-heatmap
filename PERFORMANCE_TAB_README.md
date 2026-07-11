# Performance Tab — How Everything Is Calculated

This document explains every metric, alert, and chart on the **Performance** tab of the Elysian Clearing app, and how each number is derived in the background.

The same explanation is available in-app: **Performance tab → "How it works" button** (top right).

---

## Data source

Every number comes from your bookings synced from **Hosthub**.

- The server **auto-syncs every 2 hours** and stores the result in the database. This tab reads that stored data.
- **"Refresh now"** triggers an immediate Hosthub sync (pulls fresh, saves it, and updates the tab).
- Dates are stored as **D/M/YYYY** (e.g. `12/7/2026` = 12 July).
- **Cancelled bookings** and **maintenance/owner blocks** are excluded from all calculations.

---

## Core metrics

### Occupancy

```
Occupancy = distinct booked nights ÷ nights in the window
```

- Each calendar night is counted **once**, so overlapping or duplicate bookings can never push occupancy above 100%.
- **Past** windows (15d, 30d) look backward from today.
- **Forward** windows (7d, 30d) look ahead from today.

### ADR (Average Daily Rate)

For each booking checking in within the window, take **payout ÷ nights** (a per-night rate), then **average** those across all qualifying bookings.

The **ADR change arrow** (on ADR 30d):

- Compares current 30-day ADR against the **prior 30 days** (days 31–60 ago).
- Only appears when **both** periods have **≥3 bookings** and a **plausible rate (≥€15)** — this suppresses noise from one-off or mispriced bookings.

### Booking Pace

```
Pace = this property's forward occupancy − portfolio average forward occupancy
```

- **Pace 7d** and **Pace 30d** compare a property's forward occupancy against the **portfolio average** forward occupancy right now.
- ↑ = pacing **ahead** of your other listings; ↓ = **behind** (shown in points).
- This is an honest like-for-like ("how am I doing vs the rest of the portfolio today"), not a misleading future-vs-completed-past comparison.

---

## Categories

Properties are grouped into three categories, shown as sections in the table:

| Category | Type | Alert logic |
|---|---|---|
| **Attiki** | Athens/Piraeus day-to-day short-stay | Near-term occupancy |
| **Thessaloniki** | Thessaloniki city apartments (short-stay) | Near-term occupancy |
| **City Escapes** | Islands / villas / getaways (longer stays) | Empty-night gaps |

Categorisation is by name matching (**"contains"**, case-insensitive). Anything not in the Thessaloniki or City Escapes lists is treated as Attiki.

---

## Vacancy alerts

### Attiki & Thessaloniki (occupancy-based)

Judged on **near-term fill** — the next **3 days**:

- Below **40% booked** → 🟠 **orange**
- Below **20% booked** → 🔴 **red**
- The badge shows the actual **% booked**.

### City Escapes (gap-based)

Judged on **consecutive empty nights**:

- **3+** empty nights in the next **15 days** → 🟠 **orange**
- **10+** empty nights in the next **20 days** → 🔴 **red**

### Recent-strength grace

If an occupancy-based property (Attiki/Thessaloniki) was **≥80% occupied over the past 7 days**, a **red** alert is **softened to orange**. A proven performer with a short-term forward dip is not treated as critical. (It is downgraded, not hidden — you still see it as orange.)

---

## Deterioration signals (the "Signals" column)

These detect a property **starting to go bad** by comparing today against a stored snapshot from **~3 days ago**. The server saves one compact snapshot per day, so these signals **need a few days of accumulated history to activate** (they show "building baseline" until then).

| Signal | Fires when | Orange | Red |
|---|---|---|---|
| **Occupancy erosion** | Next-14-day occupancy dropped vs baseline | −10 pts | −20 pts |
| **Sudden vacancy** | Booked nights (30d) disappeared (a cancellation) | −2 nights | −4 nights |
| **ADR drift** | Trailing ADR slid down | −5% | −12% |
| **Pace slowdown** | Forward occupancy fell below the property's own recent average | −10 pts | −20 pts |

A property can trip several at once. Each is shown as its own coloured badge with the magnitude of the change.

---

## Heatmap

Each property's **next 30 nights**, one cell per day:

- 🟩 **Green** = booked
- 🟨 **Gold** = check-in / check-out day
- ⬛ **Dark** = empty
- 🟧/🟥 **Orange/Red** = empty gap that triggers a gap-based alert (City Escapes)
- **Mondays** are labelled in gold to help read weeks.

---

## 3-month course chart (📈 button per property)

Opens a modal showing **weekly actuals over the last 13 weeks**:

- **Gold line** = occupancy (left axis, %)
- **Teal line** = ADR (right axis, €)
- Weeks with **no bookings at all** are drawn as **dotted "no-data" segments** rather than a misleading drop to zero.
- The ADR axis shows 7 gridline values for easier reading.

This is **actual historical data only** — there is intentionally **no forecast line**, to avoid presenting guesswork as prediction.

---

## Summary KPI cards

At the top of the tab:

| Card | What it shows |
|---|---|
| **Properties** | Count of tracked properties |
| **Avg Occupancy 30d** | Portfolio average past-30-day occupancy |
| **Avg Fwd Occupancy** | Portfolio average next-30-day booked occupancy |
| **Avg Nightly Rate** | Portfolio average ADR (past 30 days) |
| **Vacancy Alerts** | Count of red / orange alerts |
| **Deteriorating** | Count of red / orange trend signals (or "building baseline" until history matures) |

---

## Tuning

All thresholds are configurable in the code, at the top of the Performance tab block in `index.html`:

- **`ALERT_RULES`** — occupancy % thresholds (Attiki/Thess) and gap thresholds (City Escapes)
- **`TREND_RULES`** — the four deterioration signal thresholds + how many days back to compare
- **`GRACE_RULE`** — the recent-strength look-back window and occupancy bar (default: past 7 days, 80%)
- **`THESSALONIKI_APARTMENTS`** / **`CITY_ESCAPE_APARTMENTS`** — the property name lists that drive categorisation

Change a value, commit, and Railway redeploys automatically.

---

## Deployment notes

- The Performance tab lives entirely in **`index.html`**.
- The **snapshot storage** for deterioration signals lives in **`server.js`** (saves a daily snapshot to the database and exposes `/api/history`). Both files must be deployed for trend detection to work.
- Data auto-refreshes every 2 hours; the tab also pulls the latest on open and on "Refresh now".

---

## What to expect after deploying

- **Day 1:** categories, occupancy, ADR, pace, alerts (with grace), heatmap, and the 3-month chart all work immediately.
- **Signals column** shows "building baseline" until ~3+ daily snapshots accumulate.
- **~Day 3–4:** occupancy erosion and sudden vacancy activate.
- **~Day 7+:** pace slowdown and ADR drift become meaningful.

If after ~4 days the Deteriorating KPI still says "building baseline," check the Railway deploy logs for `[snapshot] saved …` lines — their absence means snapshots aren't being written (usually a database issue on that project).
