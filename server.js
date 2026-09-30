#!/usr/bin/env node
'use strict';

/* ============================================================
   Revive Rides — tiny booking server (no runtime dependencies)

   Booking state lives in a PERSISTENT SHARED STORE, not in
   process memory. This is what makes it correct on Vercel
   serverless, where each request may run on a different,
   isolated instance and idle instances get recycled — in-memory
   state there is invisible to other visitors and evaporates.

   Store selection (first match wins):
     1. Upstash Redis REST  — KV_REST_API_URL + KV_REST_API_TOKEN
        (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).
        The Vercel Marketplace "Upstash" integration injects these
        automatically. HTTP-based: ideal for serverless. PRODUCTION.
     2. Redis (RESP over TCP) — REDIS_URL, e.g.
        redis://default:PASSWORD@host:6379. Needs the optional
        `redis` npm package (npm i --no-save redis) — if it is not
        installed the server logs a warning and keeps searching.
     3. In-memory — LAST RESORT for local development only.
        Never used when a store is configured; logs a loud warning
        if you reach it in production.

   Keys (prefix "rr:"):
     rr:days       HASH  dateKey -> "1"   (days FULLY booked)
     rr:slots      HASH  dateKey -> JSON array of confirmed times
     rr:link:TOKEN       JSON { date, time, confirmed, spent } (24h TTL)

   A booking is ONLY ever marked confirmed through the /confirm/:token
   page (the link sent via text to the business phone). There is
   deliberately no other endpoint or code path that confirms a booking.
     rr:bs               backend id, set at boot ("upstash-rest", etc.)

   ---- CUSTOMER REVIEWS (approve-first moderation) ----
   Visitors submit star ratings + short reviews at the bottom of the
   homepage. Nothing is published automatically: submissions land in a
   pending queue and appear on the site ONLY after the owner approves
   them on a secret admin page (/reviews-admin). Admin actions are
   gated by REVIEWS_ADMIN_KEY and the page is never linked from the
   site. Keys:
     rr:reviews          HASH  id -> JSON review object
       { id, name, rating, text, vehicle, createdAt,
         status: 'pending' | 'approved', approvedAt }
     rr:rl:IP      STRING "count"     (fixed window, 600s TTL)
     rr:ral:TOKEN  STRING  (600s TTL) — one-time admin-login token

   The admin page talks to /api/admin/reviews via JSON POSTs and keeps
   its token only in the tab's JS memory (never localStorage).

   Nothing about customers is stored — no names, addresses, or
   phone numbers ever reach this server. Credentials live only in
   server-side environment variables, never in client code.

   Run:  node server.js           (then open http://localhost:3000)
   Test: node server.js --self-test
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const PUBLIC_DIR = __dirname;
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

/* ---- Local .env fallback ----
   In production, env vars come from the platform (Vercel dashboard).
   For plain `node server.js` locally, populate any UNSET vars from a
   simple KEY=VALUE .env file next to this script (real environment
   variables always win; .env is git-ignored and never served). */
(function loadDotEnvFallback() {
    try {
        var src = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
        src.split(/\r?\n/).forEach(function (line) {
            var m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
            if (!m) return;
            var v = m[2].trim();
            if ((v.charAt(0) === '"' && v.slice(-1) === '"') || (v.charAt(0) === "'" && v.slice(-1) === "'")) v = v.slice(1, -1);
            if (!(m[1] in process.env)) process.env[m[1]] = v;
        });
    } catch (e) { /* no .env file — fine */ }
})();

/* One-time confirmation links stop being usable a day after issue.
   Confirmed bookings have NO expiry — they persist indefinitely. */
const PENDING_LINK_TTL_SECONDS = 60 * 60 * 24;

/* ---- Customer reviews (approve-first moderation) ----
   Submissions land in a pending queue (rr:reviews hash, status
   'pending') and are published to the public /api/reviews feed ONLY
   after the owner approves them on the secret admin page. Display
   order: newest approved first. Limits protect the queue and the
   public feed from spam floods. */
const REVIEW_MIN_LEN = 4;
const REVIEW_MAX_LEN = 1000;
const REVIEW_NAME_MAX = 40;
const REVIEW_VEHICLE_MAX = 60;
const REVIEWS_FEED_LIMIT = 120;      // newest N approved reviews served publicly
const REVIEWS_SUBMIT_PER_WINDOW = 5; // submissions per IP per 10 minutes
const REVIEW_RATE_WINDOW_SECONDS = 600;

/* Reviews are flagged by a list of whole-word patterns (matched
   case-insensitively). Add or trim words to taste. */
const REVIEW_BANNED_WORDS = [
    'fuck', 'shit', 'bitch', 'cunt', 'nigger', 'faggot', 'asshole',
    'dick', 'pussy', 'whore', 'slut'
];

/* Reviews admin: single shared password. Set REVIEWS_ADMIN_KEY in the
   environment (Vercel: Project Settings → Environment Variables; local:
   .env). The admin page stays unlinked and unknown to visitors; all
   moderation actions require the key. */
function reviewsAdminKey() {
    return String(process.env.REVIEWS_ADMIN_KEY || '').trim();
}

function timingSafeEqualStr(a, b) {
    var ab = Buffer.from(String(a));
    var bb = Buffer.from(String(b));
    if (ab.length !== bb.length) {
        // Still burn a comparison to keep timing flat-ish
        crypto.timingSafeEqual(ab, ab);
        return false;
        
    }
    return crypto.timingSafeEqual(ab, bb);
}

/* Simple fixed-window rate limiter backed by the persistent store so it
   works per-instance on serverless. Returns true when ALLOWED. */
async function rateLimit(key, limit, windowSeconds) {
    try {
        var raw = await store.get(key);
        var n = parseInt(raw, 10);
        if (isNaN(n)) n = 0;
        n += 1;
        if (n > limit) return false;
        await store.setEx(key, windowSeconds, String(n));
        return true;
    } catch (e) {
        /* Store trouble: fail OPEN for a public read-friendly feature —
           better a rare missed throttle than a broken site. */
        return true;
    }
}

function clientIp(req) {
    var xf = req.headers['x-forwarded-for'];
    var ip = (typeof xf === 'string' && xf.trim()) ? xf.split(',')[0].trim() : (req.socket && req.socket.remoteAddress) || 'unknown';
    return String(ip).slice(0, 60);
}

function makeToken() {
    // 24 hex chars = 96 bits of randomness — non-guessable
    return crypto.randomBytes(12).toString('hex');
}

/* ---- Owner-blocked days ('YYYY-MM-DD') — mirror of the
   OWNER_BOOKED list in index.html so the server also treats
   them as unavailable. Keep both in sync. ---- */
const OWNER_BOOKED = new Set([
    '2026-09-19',
    '2026-09-20'
]);

/* ---- Owner-blocked dates (mirror of index.html — keep in sync) ----
   FULLY_BLOCKED_DATES: whole day unavailable for everyone.
   PARTIAL_DAY_OPEN_SLOTS: the ONLY bookable slot labels that day;
   every other slot is blocked. Exact YYYY-MM-DD keys, so no other
   dates are ever affected. */
const FULLY_BLOCKED_DATES = new Set([
    '2026-09-26', // Sat, Sep 26 2026 — fully blocked (all slots, all times)
    '2026-09-27', // Sun, Sep 27 2026 — fully blocked (all slots, all times)
    '2026-10-02',
    '2026-10-03',
    '2026-10-04',
    '2026-09-29', // Tue, Sep 29 2026 — fully blocked (client job)            '2026-10-06', // Tue, Oct 6 2026 — fully blocked (client job)
            '2026-10-07' // Wed, Oct 7 2026 — fully blocked (client job)
]);

const PARTIAL_DAY_OPEN_SLOTS = {
    '2026-10-17': ['1:00 PM', '1:15 PM', '1:30 PM'] // early-afternoon slot only
};

/* ---- Weekend slot schedule ----
   Non-weekday days (Saturday/Sunday) run two independent slots:
   Morning (5 times) and Early afternoon (3). The late-afternoon
   slot was removed — its end times ran too close to dusk.
   All slots are open simultaneously — a customer may book any of
   the eight times in any order. Confirming any one time in a slot
   closes that whole slot (its other times become unavailable) and
   leaves the other slots untouched. The day is only fully booked
   once every slot has been used — two bookings total, in any
   order. Mon–Thu keeps a single four-time slot and Friday a single
   two-time slot: one booking per day, same rule as before. */
const WEEKEND_SLOT_GROUPS = [
    { name: 'Morning',         times: ['8:30 AM', '8:45 AM', '9:00 AM', '9:15 AM', '9:30 AM'] },
    { name: 'Early afternoon', times: ['1:00 PM', '1:15 PM', '1:30 PM'] }
];

/* ============================================================
   PERSISTENT STORE BACKENDS
   All backends expose the same async interface:
     hgetall(key) -> object | {}
     hset(key, field, value) -> void
     hdel(key, field) -> void
     get(key) -> string | null
     setEx(key, seconds, value) -> void
     del(key) -> void
     confirm(date, time, groups, open) -> { result: 0|1 } | { error }
       (atomic availability re-check + booking write in one
        indivisible step — two keys: rr:days, rr:slots)
   ============================================================ */

/* ---- Backend 1: Upstash Redis REST (HTTP) — serverless-friendly,
        the official successor of Vercel KV (sunset Dec 2024). ---- */
function makeUpstashRestBackend() {
    var url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
    var token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
    if (!url || !token) return null;
    if (url.slice(-1) === '/') url = url.slice(0, -1);

    async function command(args) {
        for (var attempt = 0; attempt < 2; attempt++) {
            try {
                var res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Bearer ' + token,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(args)
                });
                var data = await res.json().catch(function () { return null; });
                if (!res.ok || !data || data.error) {
                    throw new Error('Upstash REST error: ' + (data && data.error ? data.error : 'HTTP ' + res.status));
                }
                return data.result;
            } catch (err) {
                /* Retry once on a broken/reused keep-alive socket or a
                   refused connection. Safe because EVERY command this
                   server issues is idempotent: replaying HSET/HDEL/SET
                   EX/DEL with the same args yields the same state, and
                   the confirm EVAL re-checks availability, so a replay
                   can never double-apply a booking. */
                var cause = err && (err.cause || err);
                var code = cause && cause.code;
                var deadSocket = code === 'ECONNREFUSED' || code === 'ECONNRESET' ||
                    code === 'EPIPE' || code === 'UND_ERR_SOCKET';
                if (attempt === 0 && deadSocket) continue;
                throw err;
            }
        }
    }

    return {
        id: 'upstash-rest',
        async hgetall(key) {
            /* Real Upstash REST replies to HGETALL with a FLAT array
               [field1, value1, field2, value2, ...] — fold it into an
               object. (An object reply, e.g. from a Redis-compatible
               proxy, is passed through unchanged.) */
            var r = await command(['HGETALL', key]);
            if (Array.isArray(r)) {
                var out = {};
                for (var i = 0; i + 1 < r.length; i += 2) out[r[i]] = r[i + 1];
                return out;
            }
            return r || {};
        },
        async hset(key, field, value) { await command(['HSET', key, field, value]); },
        async hdel(key, field) { await command(['HDEL', key, field]); },
        async get(key) { return (await command(['GET', key])) || null; },
        async setEx(key, seconds, value) { await command(['SET', key, value, 'EX', String(seconds)]); },
        async del(key) { await command(['DEL', key]); },
        async confirm(date, time, groups, open) {
            /* Exactly 2 KEYS (rr:days, rr:slots); date/time/groups/open
               are ARGVs. One HTTP round trip, atomic server-side. */
            return { result: await command(['EVAL', CONFIRM_LUA, '2', 'rr:days', 'rr:slots', date, time, groups, open]) };
        }
    };
}

/* ---- Backend 2: Redis over TCP (RESP). Optional: only works when
        the `redis` npm package is installed locally. Kept for
        self-hosting; Vercel deployments should use REST. ---- */
function makeRedisTcpBackend() {
    var url = process.env.REDIS_URL || process.env.REDIS_TLS_URL || '';
    if (!url) return null;
    var redisModule = null;
    try { redisModule = require('redis'); } catch (e) { /* not installed */ }
    if (!redisModule || !redisModule.createClient) return null;

    var client = redisModule.createClient({ url: url });
    client.on('error', function (err) { console.error('[redis-tcp] client error:', err.message); });
    /* redis v4+ needs an explicit connect(); v3 auto-connects. */
    try { if (typeof client.connect === 'function') client.connect(); } catch (e) { /* v3-style */ }
    var ready = new Promise(function (resolve) {
        if (client.isReady) return resolve();
        client.once('ready', resolve);
    });

    function run(fn) {
        return ready.then(function () { return fn(); });
    }

    return {
        id: 'redis-tcp',
        hgetall(key) { return run(function () { return client.hGetAll(key); }); },
        hset(key, field, value) { return run(function () { return client.hSet(key, field, value); }); },
        hdel(key, field) { return run(function () { return client.hDel(key, field); }); },
        get(key) { return run(function () { return client.get(key); }); },
        setEx(key, seconds, value) { return run(function () { return client.setEx(key, seconds, value); }); },
        del(key) { return run(function () { return client.del(key); }); },
        confirm(date, time, groups, open) {
            return run(function () {
                return client.eval(CONFIRM_LUA, {
                    keys: ['rr:days', 'rr:slots'],
                    arguments: [date, time, groups, open]
                }).then(function (r) { return { result: r }; });
            });
        }
    };
}

/* ---- Backend 3: in-memory. ONLY for local development. This is
        exactly the behaviour that broke the Vercel deployment —
        never rely on it in production. ---- */
function makeMemoryBackend() {
    var hashes = new Map();  // key -> Map(field -> value)
    var strings = new Map(); // key -> { value, expiresAt }
    function sweep() {
        var now = Date.now();
        strings.forEach(function (entry, key) {
            if (entry.expiresAt && entry.expiresAt <= now) strings.delete(key);
        });
    }
    return {
        id: 'memory',
        isMemory: true,
        async hgetall(key) {
            var h = hashes.get(key);
            var out = {};
            if (h) h.forEach(function (v, f) { out[f] = v; });
            return out;
        },
        async hset(key, field, value) {
            var h = hashes.get(key);
            if (!h) { h = new Map(); hashes.set(key, h); }
            h.set(field, String(value));
        },
        async hdel(key, field) {
            var h = hashes.get(key);
            if (h) h.delete(field);
        },
        async get(key) {
            sweep();
            var entry = strings.get(key);
            return entry ? entry.value : null;
        },
        async setEx(key, seconds, value) {
            strings.set(key, { value: value, expiresAt: Date.now() + seconds * 1000 });
        },
        async del(key) { strings.delete(key); },
        async confirm(date, time, groups, open) {
            /* Native JS port of CONFIRM_LUA — identical semantics for
               the dev fallback (no Lua engine in memory mode). Like the
               Lua script, it receives groups/open as JSON strings and
               decodes them itself. */
            function jsonArr(s) {
                if (Array.isArray(s)) return s;
                try { var v = JSON.parse(s); return Array.isArray(v) ? v : []; }
                catch (e) { return []; }
            }
            groups = jsonArr(groups);
            open = jsonArr(open);
            var days = hashes.get('rr:days') || new Map();
            var slots = hashes.get('rr:slots') || new Map();
            if (days.get(date)) return { result: 0 };
            if (time === '') {
                days.set(date, '1');
                hashes.set('rr:days', days);
                return { result: 1 };
            }
            var booked = {};
            var cur = slots.get(date);
            if (cur) {
                try { JSON.parse(cur).forEach(function (t) { booked[t] = true; }); } catch (e) { /* treat as empty */ }
            }
            if (booked[time]) return { result: 0 };
            function slotClosed(times) {
                var used = false, anyOpen = false;
                for (var i = 0; i < times.length; i++) {
                    if (booked[times[i]]) used = true;
                    if (open.length === 0 || open.indexOf(times[i]) !== -1) anyOpen = true;
                }
                return used || !anyOpen;
            }
            for (var g = 0; g < groups.length; g++) {
                if (groups[g].indexOf(time) !== -1 && slotClosed(groups[g])) return { result: 0 };
            }
            booked[time] = true;
            slots.set(date, JSON.stringify(Object.keys(booked).sort()));
            hashes.set('rr:slots', slots);
            /* Day is fully booked only when every slot is used (any of
               its times booked) or fully owner-blocked — leftover times
               inside a used slot do NOT keep the day open. Mirrors the
               CONFIRM_LUA tail exactly. */
            var allClosed = true;
            for (var k = 0; k < groups.length; k++) {
                var groupUsed = false, groupOpen = false;
                for (var j = 0; j < groups[k].length; j++) {
                    var t = groups[k][j];
                    if (booked[t]) groupUsed = true;
                    if (open.length === 0 || open.indexOf(t) !== -1) groupOpen = true;
                }
                if (!groupUsed && groupOpen) { allClosed = false; break; }
            }
            if (allClosed) {
                days.set(date, '1');
                hashes.set('rr:days', days);
                slots.delete(date);
                hashes.set('rr:slots', slots);
            }
            return { result: 1 };
        }
    };
}

function pickBackend() {
    var b = makeUpstashRestBackend();
    if (b) return b;
    b = makeRedisTcpBackend();
    if (b) return b;
    var memory = makeMemoryBackend();
    var production = process.env.VERCEL === '1';
    if (production) {
        console.error(
            '\n*** PRODUCTION WARNING ***\n' +
            'No persistent store configured (set KV_REST_API_URL + KV_REST_API_TOKEN,\n' +
            'or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, or REDIS_URL).\n' +
            'Falling back to IN-MEMORY state: bookings will NOT be shared between\n' +
            'visitors and WILL disappear when instances are recycled.\n'
        );
    }
    return memory;
}

const store = pickBackend();

/* ============================================================
   ATOMIC CONFIRMATION — a single Redis Lua script re-checks
   availability and writes the booking in ONE indivisible step,
   so two visitors racing for the same slot can never both win.
   KEYS[1] = rr:days, KEYS[2] = rr:slots
   ARGV[1] = date, ARGV[2] = time ('' for non-weekend days),
   ARGV[3] = JSON array of weekend slot-group times ('' on
             non-weekend days), ARGV[4] = JSON array of
             owner-open times for partial-day dates ('' otherwise).
   Returns 1 = confirmed, 0 = slot/day already taken.
   ============================================================ */
var CONFIRM_LUA = [
    'local days   = redis.call("HGETALL", KEYS[1])',
    'local slots  = redis.call("HGETALL", KEYS[2])',
    'local d2s    = {}',
    'for i = 1, #days do  d2s[days[i]]  = true end',
    'local date   = ARGV[1]',
    'local time   = ARGV[2]',
    'if d2s[date] then return 0 end',
    'if time == "" then',
    '  redis.call("HSET", KEYS[1], date, "1")',
    '  return 1',
    'end',
    'local booked = {}',
    'local cur = redis.call("HGET", KEYS[2], date)',
    'if cur then',
    '  local ok, arr = pcall(cjson.decode, cur)',
    '  if ok and type(arr) == "table" then',
    '    for _, t in ipairs(arr) do booked[t] = true end',
    '  end',
    'end',
    'if booked[time] then return 0 end',
    'local groups = cjson.decode(ARGV[3])',
    'local open   = cjson.decode(ARGV[4])',
    'for _, gtimes in ipairs(groups) do',
    '  local inGroup, groupUsed, groupOpen = false, false, false',
    '  for _, t in ipairs(gtimes) do',
    '    if t == time then inGroup = true end',
    '    if booked[t] then groupUsed = true end',
    '    if #open == 0 then groupOpen = true',
    '    else',
    '      for _, ot in ipairs(open) do if ot == t then groupOpen = true end end',
    '    end',
    '  end',
    '  if inGroup and (groupUsed or not groupOpen) then return 0 end',
    'end',
    'booked[time] = true',
    'local list = {}',
    'for t, _ in pairs(booked) do list[#list + 1] = t end',
    'table.sort(list)',
    'redis.call("HSET", KEYS[2], date, cjson.encode(list))',
    '-- Day is fully booked only when EVERY slot is used (any of its times booked) or fully owner-blocked. Leftover times inside a used slot do NOT keep the day open.',
    'for _, gtimes in ipairs(groups) do',
    '  local groupUsed = false',
    '  local groupOpen = false',
    '  for _, t in ipairs(gtimes) do',
    '    if booked[t] then groupUsed = true end',
    '    if #open == 0 then groupOpen = true',
    '    else',
    '      for _, ot in ipairs(open) do if ot == t then groupOpen = true end end',
    '    end',
    '  end',
    '  if not groupUsed and groupOpen then return 1 end',
    'end',
    'redis.call("HSET", KEYS[1], date, "1")',
    'redis.call("HDEL", KEYS[2], date)',
    'return 1'
].join('\n');

/* ============================================================
   BOOKING STATE READ/WRITE — every read and write goes through
   the persistent store. Nothing about bookings is held in local
   variables between requests.
   ============================================================ */

async function loadBookedState() {
    var days = await store.hgetall('rr:days');
    var slots = await store.hgetall('rr:slots');
    var bookedDays = new Set();
    Object.keys(days).forEach(function (date) {
        if (days[date]) bookedDays.add(date);
    });
    var bookedSlots = {};
    Object.keys(slots).forEach(function (date) {
        try {
            var arr = JSON.parse(slots[date]);
            if (Array.isArray(arr)) bookedSlots[date] = arr;
        } catch (e) { /* ignore malformed entry */ }
    });
    return { bookedDays: bookedDays, bookedSlots: bookedSlots };
}

function isWeekendDate(date) {
    var parts = date.split('-');
    var dow = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])).getDay();
    return dow === 0 || dow === 6;
}

/* Owner-open times for a partial-day date, or [] when every slot
   time is open (openSlots empty means "no restriction"). */
function ownerOpenTimes(date) {
    return PARTIAL_DAY_OPEN_SLOTS[date] || [];
}

async function isWeekendTimeBookable(state, date, time) {
    if (state.bookedDays.has(date) || OWNER_BOOKED.has(date) || FULLY_BLOCKED_DATES.has(date)) return false;
    var booked = state.bookedSlots[date] || [];
    var open = ownerOpenTimes(date);
    for (var g = 0; g < WEEKEND_SLOT_GROUPS.length; g++) {
        var times = WEEKEND_SLOT_GROUPS[g].times;
        if (times.indexOf(time) === -1) continue;
        for (var j = 0; j < times.length; j++) {
            if (booked.indexOf(times[j]) !== -1) return false; // its slot already used
        }
        if (open.length && open.indexOf(time) === -1) return false; // owner-blocked
        return true;
    }
    return false; // not one of the weekend times
}

async function isDayBookable(state, date) {
    return !state.bookedDays.has(date) && !OWNER_BOOKED.has(date) && !FULLY_BLOCKED_DATES.has(date);
}

/* Confirm atomically in the store. Returns true when this call
   won the slot; false when the day/slot was taken meanwhile. */
async function confirmBooking(date, time) {
    var weekend = isWeekendDate(date);
    var argTime = weekend ? time : '';
    var argGroups = weekend ? JSON.stringify(WEEKEND_SLOT_GROUPS.map(function (g) { return g.times; })) : '';
    var argOpen = weekend ? JSON.stringify(ownerOpenTimes(date)) : '';
    var out = await store.confirm(date, argTime, argGroups, argOpen);
    if (out && out.error) throw new Error(out.error);
    return out && out.result === 1;
}

/* ---- Helpers ---- */
function validateDateKey(date) {
    return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function validateTimeLabel(time) {
    // Only labels produced by the site's slot picker are accepted
    if (typeof time !== 'string') return false;
    return /^(0?[1-9]|1[0-2]):[0-5]\d (AM|PM)$/.test(time);
}

/* ============================================================
   CUSTOMER REVIEWS — approve-first moderation.
   Storage: single hash rr:reviews, field = review id, value = JSON:
     { id, name, rating, text, vehicle, createdAt,
       status: 'pending' | 'approved', approvedAt }
   The public feed (/api/reviews) serves only status='approved'.
   ============================================================ */

function cleanReviewId(id) {
    return (typeof id === 'string' && /^[a-f0-9]{24}$/.test(id)) ? id : null;
}

function readAllReviews() {
    return store.hgetall('rr:reviews').then(function (raw) {
        var out = [];
        Object.keys(raw).forEach(function (id) {
            try {
                var r = JSON.parse(raw[id]);
                if (r && r.id && typeof r.rating === 'number') out.push(r);
            } catch (e) { /* ignore malformed entries */ }
        });
        return out;
    });
}

function publicReviews() {
    return readAllReviews().then(function (all) {
        return all
            .filter(function (r) { return r.status === 'approved'; })
            .sort(function (a, b) { return (b.approvedAt || b.createdAt || '').localeCompare(a.approvedAt || a.createdAt || ''); })
            .slice(0, REVIEWS_FEED_LIMIT);
    });
}

function countPendingReviews() {
    return readAllReviews().then(function (all) {
        var n = 0;
        all.forEach(function (r) { if (r.status === 'pending') n++; });
        return n;
    });
}

/* Whole-word, case-insensitive match against every pattern. */
function hasBannedWord(s) {
    var low = String(s || '').toLowerCase();
    for (var i = 0; i < REVIEW_BANNED_WORDS.length; i++) {
        var w = REVIEW_BANNED_WORDS[i];
        var re = new RegExp('(^|[^a-z])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z]|$)', 'i');
        if (re.test(low)) return true;
    }
    return false;
}

function validateReviewInput(b) {
    if (!b || typeof b !== 'object') return 'Invalid request.';
    var name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : '';
    var text = typeof b.text === 'string' ? b.text.trim().replace(/[ \t]+/g, ' ') : '';
    var vehicle = typeof b.vehicle === 'string' ? b.vehicle.trim().replace(/\s+/g, ' ') : '';
    var rating = typeof b.rating === 'number' ? Math.round(b.rating) : parseInt(b.rating, 10);
    if (!name) return 'Please add your name.';
    if (name.length > REVIEW_NAME_MAX) return 'Name is too long (max ' + REVIEW_NAME_MAX + ' characters).';
    if (rating < 1 || rating > 5 || isNaN(rating)) return 'Rating must be between 1 and 5 stars.';
    if (!text) return 'Please write a few words about your experience.';
    if (text.length < REVIEW_MIN_LEN) return 'Review is too short.';
    if (text.length > REVIEW_MAX_LEN) return 'Review is too long (max ' + REVIEW_MAX_LEN + ' characters).';
    if (vehicle.length > REVIEW_VEHICLE_MAX) return 'Vehicle is too long (max ' + REVIEW_VEHICLE_MAX + ' characters).';
    if (hasBannedWord(name) || hasBannedWord(text) || hasBannedWord(vehicle)) return 'Please keep your review clean.';
    return null;
}

function makeReview(b) {
    return {
        id: makeToken(),
        name: String(b.name).trim().replace(/\s+/g, ' ').slice(0, REVIEW_NAME_MAX),
        rating: Math.max(1, Math.min(5, Math.round(b.rating))),
        text: String(b.text).trim().slice(0, REVIEW_MAX_LEN),
        vehicle: String(b.vehicle || '').trim().slice(0, REVIEW_VEHICLE_MAX),
        createdAt: new Date().toISOString(),
        status: 'pending',
        approvedAt: null
    };
}

function send(res, status, body, headers) {
    const h = Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {});
    res.writeHead(status, h);
    res.end(body);
}

function sendJSON(res, status, obj) {
    send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req) {
    return new Promise(function (resolve) {
        var chunks = '';
        req.on('data', function (c) {
            chunks += c;
            if (chunks.length > 1e4) req.destroy(); // tiny bodies only
        });
        req.on('end', function () { resolve(chunks); });
        req.on('error', function () { resolve(''); });
    });
}

/* ---- Static file serving (extension whitelist — the site is one
   HTML file with inline CSS/JS, so only real web assets are exposed) ---- */
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2'
};

/* Never serve these, whatever their extension */
const DENY_FILES = new Set(['server.js', 'package.json', 'package-lock.json', 'confirm.html', 'reviews-admin.html']);

function serveStatic(res, urlPath) {
    var rel = urlPath === '/' ? '/index.html' : urlPath;
    var ext = path.extname(rel).toLowerCase();
    /* Only serve known web assets — blocks accidental exposure of
       server.js, package.json, .env-style files, and anything else. */
    if (!MIME[ext]) return send(res, 404, 'Not found');
    if (DENY_FILES.has(path.basename(rel).toLowerCase())) return send(res, 404, 'Not found');
    var file = path.normalize(path.join(PUBLIC_DIR, rel));
    var relCheck = path.relative(PUBLIC_DIR, file);
    if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        return send(res, 403, 'Forbidden');
    }
    fs.readFile(file, function (err, data) {
        if (err) return send(res, 404, 'Not found');
        send(res, 200, data, {
            'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': urlPath === '/' || file === INDEX_HTML ? 'no-store' : 'public, max-age=3600',
            'X-Content-Type-Options': 'nosniff'
        });
    });
}

/* ---- Confirmation page (served at /confirm/:token) ---- */
function confirmPageHTML() {
    return fs.readFileSync(path.join(PUBLIC_DIR, 'confirm.html'), 'utf8');
}

/* ---- Reviews admin page (secret, unlinked) ---- */
function adminPageHTML() {
    return fs.readFileSync(path.join(PUBLIC_DIR, 'reviews-admin.html'), 'utf8');
}

/* ---- Request handling ----
   The whole handler runs inside one catch: a store outage or any
   unexpected error becomes a clean 503 for that single request —
   it must never take the instance down (especially on serverless,
   where an unhandled rejection would kill the function). */
async function handle(req, res) {
    var url = new URL(req.url, 'http://x');
    var p = url.pathname;

    /* Public availability — every visitor polls this. Returns only
       day keys (never any customer info). Read straight from the
       persistent store so every visitor, on every instance, sees
       the exact same calendar. */
    if (req.method === 'GET' && p === '/api/availability') {
        try {
            var state = await loadBookedState();
            return sendJSON(res, 200, {
                bookedDays: Array.from(state.bookedDays),
                bookedSlots: state.bookedSlots
            });
        } catch (err) {
            console.error('[availability] store error:', err.message);
            return sendJSON(res, 503, { error: 'Store unavailable' });
        }
    }

    /* Issue a one-time confirmation link for a specific date+slot.        Body: { "date": "2026-09-20", "time": "1:30 PM" } */
    if (req.method === 'POST' && p === '/api/request-link') {
        var body;
        try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { body = {}; }
        var date = body.date, time = body.time;
        if (!validateDateKey(date) || !validateTimeLabel(time)) {
            return sendJSON(res, 400, { error: 'Invalid slot.' });
        }
        var state;
        try {
            state = await loadBookedState();
        } catch (err) {
            console.error('[request-link] store error:', err.message);
            return sendJSON(res, 503, { error: 'Store unavailable' });
        }
        var dayBooked = state.bookedDays.has(date) || OWNER_BOOKED.has(date) || FULLY_BLOCKED_DATES.has(date);
        if (dayBooked) {
            return sendJSON(res, 409, { error: 'That day is already booked.' });
        }
        if (isWeekendDate(date) && !(await isWeekendTimeBookable(state, date, time))) {
            /* Weekend days: two independent slots — any time is
               bookable while its slot is unused. */
            return sendJSON(res, 409, { error: 'That time is not available.' });
        }
        var openSlots = PARTIAL_DAY_OPEN_SLOTS[date];
        if (openSlots && openSlots.indexOf(time) === -1) {
            return sendJSON(res, 409, { error: 'That time is not available.' });
        }
        var token = makeToken();
        var link = { date: date, time: time, confirmed: false, spent: false };
        await store.setEx('rr:link:' + token, PENDING_LINK_TTL_SECONDS, JSON.stringify(link));
        var host = req.headers['x-forwarded-host'] || req.headers.host || ('localhost:' + PORT);
        var proto = req.headers['x-forwarded-proto'] || 'http';
        return sendJSON(res, 200, {
            token: token,
            confirmUrl: proto + '://' + host + '/confirm/' + token
        });
    }

    /* The confirmation page itself. It performs no state change — the
       one-time confirmation happens in the status check below, guarded
       by ?first=1 so replays can never re-confirm anything. */
    var m = p.match(/^\/confirm\/([a-f0-9]{24})$/);
    if (req.method === 'GET' && m) {
        return send(res, 200, confirmPageHTML(), { 'Content-Type': 'text/html; charset=utf-8' });
    }

    /* Status check used by the confirm page to render the right message.
       The page passes ?first=1 on its initial load: that single request
       performs the one-time confirmation and marks the day booked for
       every visitor. Every later check (replays, refreshes, other
       devices) only reports status — the link is spent.

       This is the ONLY code path that can mark a slot booked: it needs
       the unique, non-guessable, one-time link (/confirm/:token), which
       exists only inside the pre-filled text message sent to the
       business phone. Nothing else in this server (or in any client
       file) can confirm a booking. */
    m = p.match(/^\/api\/link\/([a-f0-9]{24})$/);
    if (req.method === 'GET' && m) {
        var token2 = m[1];
        var key = 'rr:link:' + token2;
        var raw;
        try {
            raw = await store.get(key);
        } catch (err) {
            console.error('[link] store error:', err.message);
            return sendJSON(res, 503, { error: 'Store unavailable' });
        }
        if (!raw) {
            // Unknown/spent/expired token — reveals nothing about past links
            return sendJSON(res, 200, { status: 'unknown' });
        }
        var link;
        try { link = JSON.parse(raw); } catch (e) { link = null; }
        if (!link) return sendJSON(res, 200, { status: 'unknown' });

        var justConfirmed = false;
        if (url.searchParams.get('first') === '1' && !link.confirmed && !link.spent) {
            /* Re-validate at confirm time: another link may have booked
               this slot (or closed the day) while this one was pending. */
            var canConfirm;
            try {
                var curState = await loadBookedState();
                if (isWeekendDate(link.date)) {
                    canConfirm = await isWeekendTimeBookable(curState, link.date, link.time);
                } else {
                    canConfirm = await isDayBookable(curState, link.date);
                }
            } catch (err) {
                console.error('[link] store error:', err.message);
                return sendJSON(res, 503, { error: 'Store unavailable' });
            }
            link.spent = true; // the one-time ?first=1 confirmation can only fire once
            if (canConfirm) {
                var won = await confirmBooking(link.date, isWeekendDate(link.date) ? link.time : '');
                if (won) {
                    link.confirmed = true;
                    justConfirmed = true;
                }
            }
            await store.setEx(key, PENDING_LINK_TTL_SECONDS, JSON.stringify(link));
        }
        var dayBookedNow = justConfirmed || link.confirmed;
        try {
            /* Truthful answer, straight from the store. */
            dayBookedNow = (await loadBookedState()).bookedDays.has(link.date);
        } catch (e) { /* keep the computed fallback above */ }
        return sendJSON(res, 200, {
            status: link.confirmed ? 'confirmed' : (link.spent ? 'unavailable' : 'pending'),
            just: justConfirmed,
            date: link.date,
            time: link.time,
            dayBooked: dayBookedNow
        });
    }

    /* ---- Customer reviews: public feed (approved only) ---- */
    if (req.method === 'GET' && p === '/api/reviews') {
        try {
            var feed = await publicReviews();
            return sendJSON(res, 200, { reviews: feed });
        } catch (err) {
            console.error('[reviews] store error:', err.message);
            return sendJSON(res, 503, { error: 'Store unavailable' });
        }
    }

    /* ---- Customer reviews: public submission (goes to pending queue) ---- */
    if (req.method === 'POST' && p === '/api/reviews') {
        if (!(await rateLimit('rr:rl:' + clientIp(req), REVIEWS_SUBMIT_PER_WINDOW, REVIEW_RATE_WINDOW_SECONDS))) {
            return sendJSON(res, 429, { error: 'Too many reviews submitted — please try again later.' });
        }
        var rBody;
        try { rBody = JSON.parse(await readBody(req) || '{}'); } catch (e) { rBody = {}; }
        var rErr = validateReviewInput(rBody);
        if (rErr) return sendJSON(res, 400, { error: rErr });
        var review = makeReview(rBody);
        try {
            await store.hset('rr:reviews', review.id, JSON.stringify(review));
        } catch (err) {
            console.error('[reviews] store error:', err.message);
            return sendJSON(res, 503, { error: 'Store unavailable' });
        }
        return sendJSON(res, 200, { ok: true, status: 'pending' });
    }

    /* ---- Reviews admin: password -> one-time token (10 min) ----
       The page never stores the password itself; it keeps only this
       short-lived token in tab memory and uses it for actions. */
    if (req.method === 'POST' && p === '/api/admin/reviews/login') {
        var aBody;
        try { aBody = JSON.parse(await readBody(req) || '{}'); } catch (e) { aBody = {}; }
        var key = reviewsAdminKey();
        if (!key) {
            console.error('[reviews-admin] REVIEWS_ADMIN_KEY is not set — admin login disabled.');
            return sendJSON(res, 503, { error: 'Admin access is not configured.' });
        }
        if (!timingSafeEqualStr(String(aBody.key || ''), key)) {
            await new Promise(function (r2) { setTimeout(r2, 600); }); // slow brute force
            return sendJSON(res, 401, { error: 'Wrong key.' });
        }
        var at = makeToken();
        await store.setEx('rr:ral:' + at, 600, '1');
        return sendJSON(res, 200, { token: at });
    }

    /* ---- Reviews admin: all moderation actions ----
       POST /api/admin/reviews  { token, action, id }
         action: 'list' | 'approve' | 'unapprove' | 'delete' */
    if (req.method === 'POST' && p === '/api/admin/reviews') {
        var mBody;
        try { mBody = JSON.parse(await readBody(req) || '{}'); } catch (e) { mBody = {}; }
        var tok = typeof mBody.token === 'string' ? mBody.token : '';
        var tokOk = false;
        if (/^[a-f0-9]{24}$/.test(tok)) {
            try { tokOk = (await store.get('rr:ral:' + tok)) === '1'; } catch (e2) { tokOk = false; }
        }
        if (!tokOk) return sendJSON(res, 401, { error: 'Session expired — log in again.' });
        var action = mBody.action;
        try {
            if (action === 'list') {
                var all = await readAllReviews();
                all.sort(function (a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });
                return sendJSON(res, 200, { reviews: all, pending: all.filter(function (r) { return r.status === 'pending'; }).length });
            }
            var id = cleanReviewId(mBody.id);
            if (!id) return sendJSON(res, 400, { error: 'Invalid review id.' });
            if (action === 'delete') {
                await store.hdel('rr:reviews', id);
            } else if (action === 'approve' || action === 'unapprove') {
                var curHash = await store.hgetall('rr:reviews');
                var curRaw = curHash[id] || null;
                if (!curRaw) return sendJSON(res, 404, { error: 'Review not found.' });
                var cur;
                try { cur = JSON.parse(curRaw); } catch (e3) { return sendJSON(res, 404, { error: 'Review not found.' }); }
                if (action === 'approve') {
                    cur.status = 'approved';
                    cur.approvedAt = new Date().toISOString();
                } else {
                    cur.status = 'pending';
                    cur.approvedAt = null;
                }
                await store.hset('rr:reviews', id, JSON.stringify(cur));
            } else {
                return sendJSON(res, 400, { error: 'Unknown action.' });
            }
            var all2 = await readAllReviews();
            all2.sort(function (a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });
            return sendJSON(res, 200, { reviews: all2, pending: all2.filter(function (r) { return r.status === 'pending'; }).length });
        } catch (err) {
            console.error('[reviews-admin] store error:', err.message);
            return sendJSON(res, 503, { error: 'Store unavailable' });
        }
    }

    /* ---- Reviews admin page (secret; nothing links to it) ---- */
    if (req.method === 'GET' && (p === '/reviews-admin' || p === '/reviews-admin/')) {
        return send(res, 200, adminPageHTML(), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    }

    serveStatic(res, p);
}

const server = http.createServer(function (req, res) {
    handle(req, res).catch(function (err) {
        console.error('[handler] unexpected error on', req.method, req.url, '-', err && err.stack || err);
        try { sendJSON(res, 503, { error: 'Temporary server error' }); } catch (e) { /* already sent */ }
    });
});

/* ============================================================
   SELF-TEST — verifies the fixes against the configured store.
   Safe to run against production data: every date used is in the
   far future (2049) and every test key is deleted afterwards.
   Run: node server.js --self-test
   ============================================================ */
async function selfTest() {
    var failures = 0;
    function check(name, cond) {
        if (cond) { console.log('  PASS  ' + name); }
        else { failures++; console.log('  FAIL  ' + name); }
    }

    console.log('Store backend: ' + store.id + (store.isMemory ? '  (IN-MEMORY — dev only)' : ''));
    console.log('Using future dates (2049) and cleaning up after — production data is untouched.\n');

    var SAT = '2049-01-02';  // a Saturday
    var TUE = '2049-01-05';  // a Tuesday
    var keys = ['rr:days', 'rr:slots'];

    // Snapshot production data (if any) and clear only what we touch.
    var prodDays = await store.hgetall('rr:days');
    var prodSlots = await store.hgetall('rr:slots');
    await store.del('rr:days');
    await store.del('rr:slots');

    try {
        /* ---- ISSUE 1: cross-visibility ---- */
        var won = await confirmBooking(TUE, '');
        check('weekday booking confirms', won === true);
        var state = await loadBookedState();
        check('weekday booking visible to a fresh read (another visitor/instance)',
            state.bookedDays.has(TUE));

        /* ---- ISSUE 2: persistence ---- */
        state = await loadBookedState();
        check('weekday booking still there on later reads (no reversion)',
            state.bookedDays.has(TUE));

        /* ---- ISSUE 3: weekend slot independence ---- */
        // Morning slot first
        check('weekend 8:30 AM confirms', (await confirmBooking(SAT, '8:30 AM')) === true);
        state = await loadBookedState();
        check('slot 1 used -> 8:45 AM blocked', (await isWeekendTimeBookable(state, SAT, '8:45 AM')) === false);
        check('slot 1 used -> 9:30 AM blocked', (await isWeekendTimeBookable(state, SAT, '9:30 AM')) === false);
        check('slot 1 used -> other slot untouched (1:00 PM open)', (await isWeekendTimeBookable(state, SAT, '1:00 PM')) === true);
        check('day not fully booked after 1 of 2 slots', !state.bookedDays.has(SAT));
        // Early afternoon slot second
        check('weekend 1:30 PM confirms', (await confirmBooking(SAT, '1:30 PM')) === true);
        state = await loadBookedState();
        check('slot 2 used -> 1:00 PM blocked', (await isWeekendTimeBookable(state, SAT, '1:00 PM')) === false);
        check('slots 1+2 used -> day fully booked (crossed off for everyone)', state.bookedDays.has(SAT));
        check('fully-booked day: no time bookable', (await isWeekendTimeBookable(state, SAT, '8:30 AM')) === false);

        /* ---- Double-book race ---- */
        var WED = '2049-01-06';
        var racers = [confirmBooking(WED, ''), confirmBooking(WED, ''), confirmBooking(WED, '')];
        var outcomes = await Promise.all(racers);
        var wins = outcomes.filter(Boolean).length;
        check('three simultaneous bookings -> exactly one wins (no double-booking)', wins === 1);

        /* ---- Pending link TTL ---- */
        await store.setEx('rr:link:selftest', 1, JSON.stringify({ date: TUE, time: '', confirmed: false, spent: false }));
        await new Promise(function (r) { setTimeout(r, 1500); });
        var expired = await store.get('rr:link:selftest');
        check('pending link expires automatically (confirmed bookings never expire)', expired === null);

        /* ---- Customer reviews: approve-first moderation ---- */
        var prodReviews = await store.hgetall('rr:reviews');
        await store.del('rr:reviews');
        try {
            check('banned-word filter catches profanity', hasBannedWord('this place is shit') === true);
            check('banned-word filter does not flag normal words', hasBannedWord('They detail every class of car with care') === false);

            var bad = validateReviewInput({ name: 'X'.repeat(60), rating: 5, text: 'Great job, very shiny!' });
            check('over-long name rejected', bad !== null);
            var bad2 = validateReviewInput({ name: 'Sam', rating: 9, text: 'Great job, very shiny!' });
            check('rating out of range rejected', bad2 !== null);

            var rev = makeReview({ name: 'Self Test', rating: 5, text: 'Fantastic work — the car looks brand new!', vehicle: '2049 Test Car' });
            await store.hset('rr:reviews', rev.id, JSON.stringify(rev));
            check('new review starts pending (not in public feed)', (await publicReviews()).length === 0);

            rev.status = 'approved';
            rev.approvedAt = new Date().toISOString();
            await store.hset('rr:reviews', rev.id, JSON.stringify(rev));
            var feedAfter = await publicReviews();
            check('approved review appears in public feed', feedAfter.length === 1 && feedAfter[0].id === rev.id && feedAfter[0].rating === 5);

            rev.status = 'pending';
            await store.hset('rr:reviews', rev.id, JSON.stringify(rev));
            check('unapproved review disappears from public feed', (await publicReviews()).length === 0);

            await store.hdel('rr:reviews', rev.id);
            check('deleted review is gone from the store', Object.keys(await store.hgetall('rr:reviews')).length === 0);
        } finally {
            /* Restore whatever reviews existed before the test. */
            await store.del('rr:reviews');
            for (var rk in prodReviews) await store.hset('rr:reviews', rk, prodReviews[rk]);
        }
    } finally {
        /* Restore: wipe every 2049-* test date, then rebuild both hashes
           from the pre-test snapshot PLUS any real (non-test) fields that
           appeared while the test was running — a booking made during the
           test is never lost. */
        var dNow = await store.hgetall('rr:days');
        var sNow = await store.hgetall('rr:slots');
        await store.del('rr:days');
        await store.del('rr:slots');
        var restored = {};
        Object.keys(prodDays).forEach(function (k) { restored[k] = prodDays[k]; });
        Object.keys(dNow).forEach(function (k) {
            if (k.indexOf('2049-') !== 0 && !restored[k]) restored[k] = dNow[k];
        });
        for (var k in restored) await store.hset('rr:days', k, restored[k]);
        restored = {};
        Object.keys(prodSlots).forEach(function (k) { restored[k] = prodSlots[k]; });
        Object.keys(sNow).forEach(function (k) {
            if (k.indexOf('2049-') !== 0 && !restored[k]) restored[k] = sNow[k];
        });
        for (var k2 in restored) await store.hset('rr:slots', k2, restored[k2]);
        await store.del('rr:link:selftest');
    }

    console.log('');
    if (failures === 0) { console.log('ALL SELF-TESTS PASSED'); process.exit(0); }
    console.log(failures + ' SELF-TEST(S) FAILED');
    process.exit(1);
}

if (process.argv.indexOf('--self-test') !== -1) {
    selfTest().catch(function (err) {
        console.error('self-test crashed:', err);
        process.exit(1);
    });
} else {
    server.listen(PORT, function () {
        console.log('Revive Rides booking server running at http://localhost:' + PORT);
        console.log('Booking store: ' + store.id + (store.isMemory ? '  (IN-MEMORY — dev only; bookings vanish on restart)' : ''));
    });
}
