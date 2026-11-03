// Which of a provider's locations is closest to the person, from their time zone alone (no
// location lookup): the one whose standard UTC offset is nearest, on the same continent when
// there is one.

/** Standard UTC offset (hours) of the cities providers run in, then of whole countries. */
const CITY = {
  "New York": -5, "New Jersey": -5, Atlanta: -5, Ashburn: -5, "Ashburn, VA": -5, Miami: -5, Toronto: -5, Chicago: -6, Dallas: -6, "Mexico City": -6,
  Seattle: -8, "Los Angeles": -8, "San Francisco": -8, "Silicon Valley": -8, Hillsboro: -8, "Hillsboro, OR": -8, "Santa Clara": -8,
  "São Paulo": -3, "Sao Paulo": -3, Santiago: -4,
};
const COUNTRY = {
  US: -6, CA: -5, MX: -6, BR: -3, CL: -4, GB: 0, IE: 0, PT: 0, ES: 1, FR: 1, NL: 1, BE: 1, DE: 1, CH: 1, AT: 1, IT: 1, PL: 1, SE: 1, NO: 1, DK: 1, FI: 2, IL: 2, ZA: 2,
  IN: 5.5, SG: 8, HK: 8, TW: 8, JP: 9, KR: 9, AU: 10, NZ: 12,
};
const CONTINENT = { US: "America", CA: "America", MX: "America", BR: "America", CL: "America", IL: "Asia", ZA: "Africa", IN: "Asia", SG: "Asia", HK: "Asia", TW: "Asia", JP: "Asia", KR: "Asia", AU: "Australia", NZ: "Pacific" };

function offsetOf(loc) {
  return CITY[loc.city] ?? COUNTRY[loc.country] ?? null;
}

/** The person's standard offset (January and July, whichever is smaller) and continent. */
function here(timeZone) {
  const offset = (month) => {
    const d = new Date(Date.UTC(2026, month, 15, 12));
    const local = new Date(d.toLocaleString("en-US", { timeZone }));
    const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
    return (local - utc) / 3_600_000;
  };
  let hours = 0;
  try { hours = Math.min(offset(0), offset(6)); } catch {}
  return { hours, continent: String(timeZone || "").split("/")[0] };
}

function continentOf(loc) {
  return CONTINENT[loc.country] ?? "Europe";
}

/** The closest location's name, or the first one's when none can be placed. */
function nearestLocation(locations, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const me = here(timeZone);
  let best = null;
  let bestScore = Infinity;
  for (const loc of locations) {
    const off = offsetOf(loc);
    if (off == null) continue;
    const score = Math.abs(off - me.hours) + (continentOf(loc) === me.continent ? 0 : 6);
    if (score < bestScore) [best, bestScore] = [loc, score];
  }
  return (best ?? locations[0])?.name ?? "";
}

module.exports = { nearestLocation };
