// RUBS (Ratio Utility Billing System) calculation engine.
// Pure functions, no database access, so it can be unit tested.
//
// How it works
// 1. billable = bill total x recovery %            (the rest is common area / owner)
// 2. The billable amount is split into pools by the allocation weights,
//    e.g. 50% square footage + 50% occupants.
// 3. Inside each pool, every resident gets:   factor x days occupied
//    (factor = unit sqft, unit bedrooms, # occupants, or 1 for "equal").
//    Dividing by the sum of all weights gives the resident's share.
// 4. Vacancy mode:
//      "owner"    - vacant unit-days are part of the denominator, so the owner
//                   absorbs the vacant share (most common / most defensible).
//      "occupied" - only occupied unit-days count; residents split 100% of billable.
// 5. Proration: days occupied = overlap of the tenancy with the bill period.
//    Day count modes:
//      "meter"    - like a utility meter read: days = end date - start date
//                   (Oct 6 to Nov 3 = 28 days). The move-out day is not billed,
//                   so a move-out and move-in on the same day never overlap.
//      "calendar" - both the first and last day count (Oct 6 to Nov 3 = 29 days).
// 5b. Tax: tax_pct is added on top of each resident's share of that utility.
// 6. Rounding uses the largest-remainder method so the cents always add up
//    exactly to the billable amount (residents + vacancy).

const DAY_MS = 86400000;
export const BASES = ['sqft', 'bedrooms', 'occupants', 'equal'];

export function parseDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`Invalid date "${s}" (expected YYYY-MM-DD)`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

export function daysInclusive(startMs, endMs) {
  return Math.round((endMs - startMs) / DAY_MS) + 1;
}

export function periodLength(periodStart, periodEnd, dayCount = 'calendar') {
  const ps = parseDate(periodStart), pe = parseDate(periodEnd);
  return dayCount === 'meter' ? Math.round((pe - ps) / DAY_MS) : daysInclusive(ps, pe);
}

export function occupiedDays(periodStart, periodEnd, moveIn, moveOut, dayCount = 'calendar') {
  const ps = parseDate(periodStart), pe = parseDate(periodEnd);
  const mi = parseDate(moveIn), mo = parseDate(moveOut);
  const start = Math.max(ps, mi ?? -Infinity);
  const end = Math.min(pe, mo ?? Infinity);
  if (dayCount === 'meter') return end <= start ? 0 : Math.round((end - start) / DAY_MS);
  return end < start ? 0 : daysInclusive(start, end);
}

function factorFor(basis, unit, tenant, config) {
  switch (basis) {
    case 'sqft': return Math.max(0, Number(unit.sqft) || 0);
    case 'bedrooms': return Math.max(0, Number(unit.bedrooms) || 0);
    case 'occupants':
      return tenant
        ? Math.max(0, Number(tenant.occupants) || 0)
        : Math.max(0, Number(config.vacant_occupants) || 0);
    case 'equal': return 1;
    default: return 0;
  }
}

/**
 * @param {object} p
 * @param {number} p.totalCents   utility bill total, in cents
 * @param {string} p.periodStart  YYYY-MM-DD
 * @param {string} p.periodEnd    YYYY-MM-DD
 * @param {object} p.config       property_utilities row
 * @param {Array}  p.units        [{id, sqft, bedrooms, unit_number}]
 * @param {Array}  p.tenants      [{id, unit_id, move_in, move_out, occupants}]
 */
export function calculateRubs({ totalCents, periodStart, periodEnd, config, units, tenants }) {
  const ps = parseDate(periodStart), pe = parseDate(periodEnd);
  if (ps == null || pe == null) throw new Error('Bill period start and end are required');
  const dayCount = config.day_count === 'meter' ? 'meter' : 'calendar';
  if (pe < ps || (dayCount === 'meter' && pe === ps)) throw new Error('Bill period end must be after the start');
  if (!Number.isInteger(totalCents) || totalCents < 0) throw new Error('Bill total must be a positive amount');

  const periodDays = periodLength(periodStart, periodEnd, dayCount);
  const recoveryPct = Math.min(100, Math.max(0, Number(config.recovery_pct ?? 100)));
  const billableCents = Math.round((totalCents * recoveryPct) / 100);

  const weights = BASES
    .map((b) => [b, Math.max(0, Number(config['w_' + b]) || 0)])
    .filter(([, w]) => w > 0);
  const weightTotal = weights.reduce((s, [, w]) => s + w, 0);
  if (weightTotal <= 0) {
    throw new Error('This utility has no allocation method set. Edit the utility and set a weight (e.g. 100% square footage).');
  }

  const unitById = new Map(units.map((u) => [u.id, u]));
  const occ = [];
  for (const t of tenants) {
    const unit = unitById.get(t.unit_id);
    if (!unit) continue;
    const days = occupiedDays(periodStart, periodEnd, t.move_in, t.move_out, dayCount);
    if (days > 0) occ.push({ tenant: t, unit, days });
  }

  const occupiedByUnit = new Map();
  for (const o of occ) occupiedByUnit.set(o.unit.id, (occupiedByUnit.get(o.unit.id) || 0) + o.days);

  const exact = occ.map(() => 0);
  const breakdown = occ.map(() => []);
  let vacancyExact = 0;

  for (const [basis, w] of weights) {
    const pool = (billableCents * w) / weightTotal;
    const tw = occ.map((o) => factorFor(basis, o.unit, o.tenant, config) * o.days);
    let denom = tw.reduce((s, v) => s + v, 0);

    let vacantWeight = 0;
    if (config.vacancy_mode !== 'occupied') {
      for (const u of units) {
        const vacantDays = Math.max(0, periodDays - (occupiedByUnit.get(u.id) || 0));
        vacantWeight += factorFor(basis, u, null, config) * vacantDays;
      }
    }
    denom += vacantWeight;

    if (denom <= 0) { vacancyExact += pool; continue; }

    occ.forEach((o, i) => {
      const share = (pool * tw[i]) / denom;
      exact[i] += share;
      breakdown[i].push({
        basis,
        weight_pct: round2((w / weightTotal) * 100),
        factor: factorFor(basis, o.unit, o.tenant, config),
        days: o.days,
        pool_cents: round2(pool),
        ratio_pct: round4((tw[i] / denom) * 100),
        share_cents: round2(share),
      });
    });
    vacancyExact += (pool * vacantWeight) / denom;
  }

  // Largest remainder rounding across residents + vacancy bucket.
  const buckets = [...exact, vacancyExact];
  const floors = buckets.map((v) => Math.floor(v + 1e-9));
  let remainder = billableCents - floors.reduce((s, v) => s + v, 0);
  const order = buckets
    .map((v, i) => ({ i, frac: v - Math.floor(v + 1e-9) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) floors[order[k].i] += 1;

  const adminFee = Math.max(0, Math.round(Number(config.admin_fee_cents) || 0));
  const taxPct = Math.max(0, Number(config.tax_pct) || 0);
  const lines = occ.map((o, i) => {
    const share = floors[i];
    const tax = Math.round((share * taxPct) / 100);
    return {
      tenant_id: o.tenant.id,
      unit_id: o.unit.id,
      days: o.days,
      period_days: periodDays,
      share_cents: share,
      admin_fee_cents: adminFee,
      tax_cents: tax,
      amount_cents: share + adminFee + tax,
      detail: { bases: breakdown[i], recovery_pct: recoveryPct, vacancy_mode: config.vacancy_mode || 'owner', day_count: dayCount, tax_pct: taxPct },
    };
  });

  const vacancyCents = floors[floors.length - 1];
  const residentShareCents = lines.reduce((s, l) => s + l.share_cents, 0);
  return {
    lines,
    summary: {
      period_days: periodDays,
      total_cents: totalCents,
      recovery_pct: recoveryPct,
      billable_cents: billableCents,
      common_area_cents: totalCents - billableCents,
      vacancy_cents: vacancyCents,
      resident_share_cents: residentShareCents,
      admin_fees_cents: adminFee * lines.length,
      tax_cents: lines.reduce((s, l) => s + l.tax_cents, 0),
      tax_pct: taxPct,
      day_count: dayCount,
      billed_to_residents_cents: lines.reduce((s, l) => s + l.amount_cents, 0),
      owner_cost_cents: totalCents - residentShareCents,
      resident_count: lines.length,
      weights: Object.fromEntries(weights),
    },
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;
