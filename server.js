#!/usr/bin/env node
'use strict';

/* ============================================================
   Revive Rides — tiny booking server (no dependencies)

   Holds the shared booking state in memory ONLY:
   - CONFIRMED_BOOKED_DAYS: days that are booked for everyone
   - PENDING_LINKS: one-time confirmation links keyed by token

   Nothing about customers is stored — no names, addresses, or
   phone numbers ever reach this server. No database, no files
   written, no cookies. State resets when the server restarts.

   Run:  node server.js   (then open http://localhost:3000)
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const PUBLIC_DIR = __dirname;
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

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
    '2026-10-02',
    '2026-10-03',
    '2026-10-04'
]);

const PARTIAL_DAY_OPEN_SLOTS = {
    '2026-10-17': ['1:00 PM', '1:15 PM', '1:30 PM'] // early-afternoon slot only
};

/* ---- Shared state (in memory only) ---- */
const CONFIRMED_BOOKED_DAYS = new Set();  // days FULLY booked (no bookable slot left)
const CONFIRMED_BOOKED_SLOTS = new Map(); // weekend date -> Set of confirmed times (one per slot)
const PENDING_LINKS = new Map();          // token -> { date, time, confirmed, spent }

/* ---- Helpers ---- */
function makeToken() {
    // 24 hex chars = 96 bits of randomness — non-guessable
    return crypto.randomBytes(12).toString('hex');
}

function validateDateKey(date) {
    return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function validateTimeLabel(time) {
    // Only labels produced by the site's slot picker are accepted
    if (typeof time !== 'string') return false;
    return /^(0?[1-9]|1[0-2]):[0-5]\d (AM|PM)$/.test(time);
}

/* ---- Weekend slot schedule ----
   Non-weekday days (Saturday/Sunday) run three independent slots:
   Morning (5 times), Early afternoon (3) and Late afternoon (2).
   All slots are open simultaneously — a customer may book any of
   the ten times in any order. Confirming any one time in a slot
   closes that whole slot (its other times become unavailable) and
   leaves the other slots untouched. The day is only fully booked
   once every slot has been used — three bookings total, in any
   order. Mon–Thu keeps a single four-time slot and Friday a single
   two-time slot: one booking per day, same rule as before. */
const WEEKEND_SLOT_GROUPS = [
    { name: 'Morning',         times: ['8:30 AM', '8:45 AM', '9:00 AM', '9:15 AM', '9:30 AM'] },
    { name: 'Early afternoon', times: ['1:00 PM', '1:15 PM', '1:30 PM'] },
    { name: 'Late afternoon',  times: ['4:45 PM', '5:00 PM'] }
];

function isWeekendDate(date) {
    var parts = date.split('-');
    var dow = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])).getDay();
    return dow === 0 || dow === 6;
}

/* A slot is "used" once any of its times is confirmed, or when the
   owner has every time in it blocked (partial-day lists like
   2026-10-17 restrict which times are open). Used slots are closed;
   the other slots stay independently open. */
function isSlotUsed(date, slotIdx) {
    var booked = CONFIRMED_BOOKED_SLOTS.get(date) || new Set();
    var openSlots = PARTIAL_DAY_OPEN_SLOTS[date] || null;
    var g = WEEKEND_SLOT_GROUPS[slotIdx];
    var ownerOpen = false;
    for (var j = 0; j < g.times.length; j++) {
        if (booked.has(g.times[j])) return true;
        if (!openSlots || openSlots.indexOf(g.times[j]) !== -1) ownerOpen = true;
    }
    return !ownerOpen;
}

function isWeekendTimeBookable(date, time) {
    if (CONFIRMED_BOOKED_DAYS.has(date) || OWNER_BOOKED.has(date) || FULLY_BLOCKED_DATES.has(date)) return false;
    for (var i = 0; i < WEEKEND_SLOT_GROUPS.length; i++) {
        if (WEEKEND_SLOT_GROUPS[i].times.indexOf(time) === -1) continue;
        if (isSlotUsed(date, i)) return false;      // its slot already used
        var openSlots = PARTIAL_DAY_OPEN_SLOTS[date];
        if (openSlots && openSlots.indexOf(time) === -1) return false; // owner-blocked
        return true;
    }
    return false; // not one of the weekend times
}

function hasBookableSlot(date) {
    for (var i = 0; i < WEEKEND_SLOT_GROUPS.length; i++) {
        if (!isSlotUsed(date, i)) return true;
    }
    return false;
}

/* Record a confirmed weekend time. The day only crosses off once
   every slot has been used — three bookings total, in any order. */
function confirmWeekendTime(date, time) {
    var booked = CONFIRMED_BOOKED_SLOTS.get(date);
    if (!booked) { booked = new Set(); CONFIRMED_BOOKED_SLOTS.set(date, booked); }
    booked.add(time);
    if (!hasBookableSlot(date)) {
        CONFIRMED_BOOKED_DAYS.add(date);
        CONFIRMED_BOOKED_SLOTS.delete(date);
    }
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
const DENY_FILES = new Set(['server.js', 'package.json', 'package-lock.json', 'confirm.html']);

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

/* ---- Request handling ---- */
const server = http.createServer(async function (req, res) {
    var url = new URL(req.url, 'http://x');
    var p = url.pathname;

    /* Public availability — every visitor polls this. Returns only
       day keys (never any customer info). */
    if (req.method === 'GET' && p === '/api/availability') {
        var bookedSlots = {};
        CONFIRMED_BOOKED_SLOTS.forEach(function (times, date) {
            bookedSlots[date] = Array.from(times);
        });
        return sendJSON(res, 200, {
            bookedDays: Array.from(CONFIRMED_BOOKED_DAYS),
            bookedSlots: bookedSlots
        });
    }

    /* Issue a one-time confirmation link for a specific date+slot.        Body: { "date": "2026-09-20", "time": "1:30 PM" } */
    if (req.method === 'POST' && p === '/api/request-link') {
        var body;
        try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { body = {}; }
        var date = body.date, time = body.time;
        if (!validateDateKey(date) || !validateTimeLabel(time)) {
            return sendJSON(res, 400, { error: 'Invalid slot.' });
        }
        var dayBooked = CONFIRMED_BOOKED_DAYS.has(date) || OWNER_BOOKED.has(date) || FULLY_BLOCKED_DATES.has(date);
        if (dayBooked) {
            return sendJSON(res, 409, { error: 'That day is already booked.' });
        }
        if (isWeekendDate(date) && !isWeekendTimeBookable(date, time)) {
            /* Weekend days: three independent slots — any time is
               bookable while its slot is unused. */
            return sendJSON(res, 409, { error: 'That time is not available.' });
        }
        var openSlots = PARTIAL_DAY_OPEN_SLOTS[date];
        if (openSlots && openSlots.indexOf(time) === -1) {
            return sendJSON(res, 409, { error: 'That time is not available.' });
        }
        var token = makeToken();
        PENDING_LINKS.set(token, { date: date, time: time, confirmed: false });
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
       devices) only reports status — the link is spent. */
    m = p.match(/^\/api\/link\/([a-f0-9]{24})$/);
    if (req.method === 'GET' && m) {
        var link = PENDING_LINKS.get(m[1]);
        if (!link) {
            // Unknown/spent token — reveals nothing about past links
            return sendJSON(res, 200, { status: 'unknown' });
        }
        var justConfirmed = false;
        if (url.searchParams.get('first') === '1' && !link.confirmed && !link.spent) {
            /* Re-validate at confirm time: another link may have booked
               this slot (or closed the day) while this one was pending. */
            var canConfirm;
            if (isWeekendDate(link.date)) {
                canConfirm = isWeekendTimeBookable(link.date, link.time);
            } else {
                canConfirm = !CONFIRMED_BOOKED_DAYS.has(link.date)
                    && !OWNER_BOOKED.has(link.date)
                    && !FULLY_BLOCKED_DATES.has(link.date);
            }
            link.spent = true; // the one-time ?first=1 confirmation can only fire once
            if (canConfirm) {
                link.confirmed = true;
                if (isWeekendDate(link.date)) {
                    confirmWeekendTime(link.date, link.time);
                } else {
                    CONFIRMED_BOOKED_DAYS.add(link.date);
                }
                justConfirmed = true;
            }
        }
        return sendJSON(res, 200, {
            status: link.confirmed ? 'confirmed' : (link.spent ? 'unavailable' : 'pending'),
            just: justConfirmed,
            date: link.date,
            time: link.time,
            dayBooked: CONFIRMED_BOOKED_DAYS.has(link.date)
        });
    }

    serveStatic(res, p);
});

server.listen(PORT, function () {
    console.log('Revive Rides booking server running at http://localhost:' + PORT);
});
