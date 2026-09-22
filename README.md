# Revive Rides Auto Detailing — Booking Website

Single-page marketing + booking site for Revive Rides, a mobile auto detailing business. Dark automotive theme built around the brand's blue/cyan identity.

## Features

- **Flat, automotive design** — grey background, solid blue/cyan accents, Josefin Sans typography
- **Visual availability calendar** — month grid with one appointment per day; Mon–Thu runs a single four-time slot (3:30–4:15 PM), Friday a single two-time slot (4:45–5:00 PM), and Saturday/Sunday offer ten times across three independent slots (8:30–9:30 AM, 1:00–1:30 PM, 4:45–5:00 PM). Booked days get an ✕ strike-through and become unclickable for every visitor. Add dates you confirmed offline to the `OWNER_BOOKED` list at the top of the script *and* in `server.js`
- **Unique confirmation links** — picking a time and sending the pre-filled text does *not* mark anything booked. When the request text is generated, the site also asks the server for a unique, non-guessable one-time link (`yoursite.com/confirm/x7f9k2…`) tied to that exact date and time. The link is appended to the pre-filled text message *and* shown on the page with a Copy button so it can be sent manually. Opening the link — from any device — instantly marks the whole day booked for every visitor; re-opening it shows "This booking is already confirmed". No password, no admin panel: the unguessable link itself is the gate
- **Privacy** — no localStorage, sessionStorage, or cookies, and no customer info is kept anywhere. The server holds only the shared booking state (booked day keys + one-time tokens); no names, addresses, or phone numbers ever reach it. Serve the site through `server.js` (not a plain static host) so the shared state and confirmation links work
- **Persistent shared booking store** — bookings live in Redis (Upstash), not server memory, so every visitor on every device sees the same calendar instantly and bookings never disappear. Confirmation is atomic (a single Lua script), so two people racing for the same slot can never both win. One-time confirmation links expire after 24 hours; confirmed bookings never expire
- **SMS booking flow** — visitor picks a plan, a day on the calendar, enters address/phone, and the site opens their Messages app with the full request pre-filled
- **Package cards** — Exterior Detail, Premium Interior Detail (highlighted as "Most Popular"), Full Auto Detail, each with feature lists and pricing; "Select Package" pre-fills the booking form
- **Mobile navigation** — hamburger menu with animated toggle on small screens
- **Static, motion-free UI** — no scroll or float animations; only essential feedback transitions (hover, nav, toast)
- **Custom SVG artwork** — logo mark, hero car illustration, inline icons (no external icon fonts; Josefin Sans loads from Google Fonts)
- **Utilities disclosure** — prominent notice that customers must provide an outdoor spigot/hose and a working outlet; the business does not bring its own water or power. Also covers removing loose items and accepted payment methods (Venmo and cash)
- **Extras** — sticky translucent header, service hours, service-area and phone/email cards, contact strip, `prefers-reduced-motion` support, auto-updating copyright year

## Files

- `index.html` — the entire site (HTML + CSS + JS in one file)
- `confirm.html` — the page a visitor lands on after opening a unique `/confirm/:token` link
- `server.js` — zero-dependency Node server: serves the site, reads/writes booking state from the persistent store (Upstash Redis REST by default), issues one-time confirmation links, and handles `/confirm/:token`
- `package.json` — npm config (`node server.js` via `npm start`, `npm test` for the booking-store self-test)

## To Run the Site

```bash
npm start            # runs `node server.js` — the booking state + links need this
```

Then visit http://localhost:3000.

### Booking storage

Booking state is read from and written to a persistent shared store — never process memory:

| Priority | Backend | Environment variables |
|---|---|---|
| 1 | **Upstash Redis REST** (production; the official successor of Vercel KV, sunset Dec 2024) | `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`) |
| 2 | Redis over TCP (self-hosting; needs `npm i --no-save redis`) | `REDIS_URL` |
| 3 | In-memory (local development only — bookings are not shared between visitors and vanish on restart) | none |

```bash
npm test            # runs `node server.js --self-test` — verifies booking
                    # persistence, weekend slot independence, and atomic
                    # double-booking protection against the configured store
```

The server logs which backend is in use at startup; if a production deploy ever falls back to memory, it logs a loud warning — check the Vercel function logs if bookings seem to vanish.

## Customization Points

All content lives in `index.html` — search for these:

| What | Where |
|---|---|
| Phone number | `tel:+15086659868` links and displayed text |
| Package names / prices / features | `.service-card` blocks in the Services section |
| Bookable times (Mon–Thu: 3:30–4:15 PM, Fri: 4:45/5:00 PM, Sat/Sun: 8:30 AM–5:00 PM slot list) | `MON_THU_TIMES` / `FRIDAY_TIMES` / `SATURDAY_TIMES` arrays + `WEEKEND_SLOT_GROUPS` in the script (mirrored in `server.js`) |
| Confirmed bookings to x-out for all visitors | `OWNER_BOOKED` array near the top of the script — entries are `'YYYY-MM-DD'` (e.g. `'2026-09-15'`) — and the matching `OWNER_BOOKED` set in `server.js` |
| SMS destination number | the `sms:+15086659868` link in the booking submit handler |
| Service area radius | "Service area" aside card |
| Brand colors | CSS custom properties in `:root` (`--blue`, `--cyan`, etc.) |
| Font | `--font` custom property + the Google Fonts `<link>` in `<head>` |

### Hosting notes

The site must be served through `server.js` (or any host that runs it) — the shared booked-day state and the one-time confirmation links require the server and its persistent store, so a plain static host can't provide them. Behind a reverse proxy, `x-forwarded-host` / `x-forwarded-proto` headers are used to build the confirmation links.

On Vercel: add the **Upstash** integration from the Marketplace (Storage → Upstash Redis), which injects `KV_REST_API_URL` / `KV_REST_API_TOKEN` as server-side environment variables automatically. Never put store credentials in client code or files served to the browser. Deploy credentials live only in Vercel Project Settings → Environment Variables; confirmed bookings persist in Redis indefinitely, and pending links expire on their own after 24 hours.

## Design Notes

- Palette: `#232323` grey background, `#0033cc` deep blue + `#00cfff` cyan accents (from the logo), all solid colors — no gradients
- Typography: Josefin Sans throughout (Google Fonts, 400/600/700 weights)
- Buttons are solid deep blue; cards lift and highlight cyan on hover
- Fully responsive: 4/3/2/1-column grids collapse at 1024px, 820px, and 640px
