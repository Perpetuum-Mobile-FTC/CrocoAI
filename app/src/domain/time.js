// Europe/Bucharest wall-clock <-> UTC (DST-aware). Pure (no db): used by services AND migrations.
const TZ = "Europe/Bucharest";

function bucharestOffsetMin(utcMs) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs)).reduce((o, p) => { o[p.type] = Number(p.value); return o; }, {});
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return (asUtc - Math.floor(utcMs / 1000) * 1000) / 60000;
}

// Local date "YYYY-MM-DD" + time "HH:MM" -> UTC epoch ms.
function bucharestToUtcMs(date, time) {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - bucharestOffsetMin(guess) * 60000;
  return guess - bucharestOffsetMin(first) * 60000;
}

// UTC epoch ms -> { date: "YYYY-MM-DD", time: "HH:MM" } in Europe/Bucharest.
function utcToBucharest(utcMs) {
  const local = new Date(utcMs + bucharestOffsetMin(utcMs) * 60000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

// Start of the Europe/Bucharest calendar day containing `utcMs`, as ISO UTC ("...Z") - compares directly
// with created_at columns (strftime('%Y-%m-%dT%H:%M:%fZ')).
function bucharestDayStartIso(utcMs) {
  return new Date(bucharestToUtcMs(utcToBucharest(utcMs).date, "00:00")).toISOString();
}

function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

// A date-time from a form/the AI ("YYYY-MM-DDTHH:MM", no offset = Europe/Bucharest wall clock) or a full ISO
// string with Z/offset -> ISO UTC ("...Z"). null if it can't be parsed.
function toUtcIso(value) {
  const s = String(value || "").trim();
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2}(\.\d+)?)?$/.exec(s);
  if (local) {
    const [y, mo, d] = local[1].split("-").map(Number);
    const [h, mi] = local[2].split(":").map(Number);
    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate(); // day 0 of next month = last day of this one
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth || h > 23 || mi > 59) return null;
    return new Date(bucharestToUtcMs(local[1], local[2])).toISOString();
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) || !/^\d{4}-\d{2}-\d{2}T/.test(s) ? null : new Date(ms).toISOString();
}

module.exports = { TZ, bucharestOffsetMin, bucharestToUtcMs, utcToBucharest, bucharestDayStartIso, addDays, toUtcIso };
