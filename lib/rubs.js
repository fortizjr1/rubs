// RUBS (Ratio Utility Billing System) calculation engine.
// Pure functions, no database access, so it can be unit tested.
//
// How it works
// 1. billable = bill total x recovery %            (the rest is common area / owner)
// 2. The billable amount is split into pools by the allocation weights,
//    e.g. 50% square footage + 50% occupants.
// 3. Inside each pool, every tenant gets:   factor x days occupied
//    (factor = unit sqft, unit bedrooms, # occupants, or 1 for "equal").
//    Dividing by the sum of all weights gives the tenant's share.
// 4. Allocation (same choices as Rent Manager's RUBS Template):
//      allocation_mode "even_all"      - divide evenly across all units (owner pays vacant units' share)
//      allocation_mode "even_occupied" - divide evenly across occupied units only
//      allocation_mode "factors"       - weighted factors: Occupancy, Square Feet, Bedrooms, Bathrooms.
//        Occupancy always counts occupied units only (a vacant unit has 0 people).
//        Square Feet / Bedrooms / Bathrooms each have a scope: "all" units (vacant unit-days stay in the
//        total, so the owner absorbs that share) or "occupied" units only.
//    Older configs without allocation_mode use vacancy_mode ("owner" = all units, "occupied") for every
//    factor and vacant_occupants for vacant units in the occupancy pool.
// 5. Proration: days occupied = overlap of the tenancy with the bill period.
//    Day count modes:
//      "meter"    - like a utility meter read: days = end date - start date
//                   (Oct 6 to Nov 3 = 28 days). The move-out day is not billed,
//                   so a move-out and move-in on the same day never overlap.
//      "calendar" - both the first and last day count (Oct 6 to Nov 3 = 29 days).
// 5b. Tax: tax_pct is added on top of each tenant's share of that utility.
// 6. Rounding: each tenant's share is rounded to the penny; the owner's share (vacancy) absorbs
//    the rounding difference, so tenants + owner always add up exactly to the billable amount.
// 7. Occupancy weighting (how people count in the occupancy factor):
//      "headcount"  - each person counts 1
//      "cap2"       - 1 person = 1, 2 or more = 2
//      "half"       - 1.0 for the first person + 0.5 for each additional
//      "conservice" - Conservice factored: 1 = 1.0, 2 = 1.6, 3 = 1.9, 4 = 2.2, +0.3 for each additional

const DAY_MS = 86400000;
export const BASES = ['sqft', 'bedrooms', 'bathrooms', 'occupants', 'equal'];
export const FACTOR_BASES = ['occupants', 'sqft', 'bedrooms', 'bathrooms'];
const MODES = ['even_all', 'even_occupied', 'factors'];

/** Weights to use: [[basis, weight], …] following the allocation mode. */
export function allocationWeights(config) {
  const mode = MODES.includes(config.allocation_mode) ? config.allocation_mode : null;
  const list = mode === 'even_all' || mode === 'even_occupied' ? [['equal', 100]]
    : mode === 'factors' ? FACTOR_BASES.map((b) => [b, Number(config['w_' + b]) || 0])
    : BASES.map((b) => [b, Number(config['w_' + b]) || 0]); // older configs
  return list.map(([b, w]) => [b, Math.max(0, w)]).filter(([, w]) => w > 0);
}

/** "all": vacant unit-days stay in the total (owner pays them); "occupied": only occupied units share it. */
export function factorScope(basis, config) {
  const mode = MODES.includes(config.allocation_mode) ? config.allocation_mode : null;
  if (!mode) return config.vacancy_mode === 'occupied' ? 'occupied' : 'all';
  if (basis === 'equal') return mode === 'even_all' ? 'all' : 'occupied';
  if (basis === 'occupants') return 'occupied';
  return config[`${basis}_scope`] === 'occupied' ? 'occupied' : 'all';
}

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

/** Occupancy factor for a household of n people, per the utility's occupancy weighting. */
export function occupancyWeight(n, weighting = 'headcount') {
  const people = Math.max(0, Math.floor(Number(n) || 0));
  if (people === 0) return 0;
  switch (weighting) {
    case 'cap2': return Math.min(people, 2);
    case 'half': return 1 + 0.5 * (people - 1);
    case 'conservice': return [0, 1.0, 1.6, 1.9, 2.2][people] ?? round2(2.2 + 0.3 * (people - 4));
    default: return people;
  }
}

function factorFor(basis, unit, tenant, config) {
  switch (basis) {
    case 'sqft': return Math.max(0, Number(unit.sqft) || 0);
    case 'bedrooms': return Math.max(0, Number(unit.bedrooms) || 0);
    case 'bathrooms': return Math.max(0, Number(unit.bathrooms) || 0);
    case 'occupants':
      return tenant
        ? occupancyWeight(tenant.occupants, config.occupancy_weighting)
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

  const weights = allocationWeights(config);
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
    const scope = factorScope(basis, config);
    if (scope === 'all') {
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
        scope,
      });
    });
    vacancyExact += (pool * vacantWeight) / denom;
  }

  // Penny-round each tenant; the owner's share takes the rounding difference.
  const floors = [...exact.map((v) => Math.round(v + 1e-9)), 0];
  floors[floors.length - 1] = billableCents - floors.slice(0, -1).reduce((s, v) => s + v, 0);
  const roundingCents = floors[floors.length - 1] - Math.round(vacancyExact);

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
      rounding_cents: roundingCents,
      occupancy_weighting: config.occupancy_weighting || 'headcount',
      allocation_mode: config.allocation_mode || null,
    },
  };
}

/**
 * Fixed amount per tenant (e.g. Internet, Cable, Pest Control): not split from a bill.
 * Each tenant who lived there during the period is charged config.flat_amount_cents,
 * prorated by days occupied when config.flat_prorate is on. tax_pct is added on top.
 */
export function calculateFlat({ periodStart, periodEnd, config, units, tenants }) {
  const ps = parseDate(periodStart), pe = parseDate(periodEnd);
  if (ps == null || pe == null) throw new Error('Bill period start and end are required');
  const dayCount = config.day_count === 'meter' ? 'meter' : 'calendar';
  if (pe < ps || (dayCount === 'meter' && pe === ps)) throw new Error('Bill period end must be after the start');
  const amount = Math.max(0, Math.round(Number(config.flat_amount_cents) || 0));
  if (!amount) throw new Error('This charge has no fixed amount set. Edit the utility and enter the amount per tenant.');
  const prorate = config.flat_prorate === undefined || config.flat_prorate === null ? true : Boolean(Number(config.flat_prorate));
  const taxPct = Math.max(0, Number(config.tax_pct) || 0);
  const periodDays = periodLength(periodStart, periodEnd, dayCount);
  const unitIds = new Set(units.map((u) => u.id));
  const lines = [];
  for (const t of tenants) {
    if (!unitIds.has(t.unit_id)) continue;
    const days = occupiedDays(periodStart, periodEnd, t.move_in, t.move_out, dayCount);
    if (days <= 0) continue;
    const share = prorate ? Math.round((amount * Math.min(days, periodDays)) / periodDays) : amount;
    const tax = Math.round((share * taxPct) / 100);
    lines.push({
      tenant_id: t.id, unit_id: t.unit_id, days, period_days: periodDays,
      share_cents: share, admin_fee_cents: 0, tax_cents: tax, amount_cents: share + tax,
      detail: { method: 'flat', amount_cents: amount, prorate, day_count: dayCount, tax_pct: taxPct },
    });
  }
  const shares = lines.reduce((s, l) => s + l.share_cents, 0);
  return {
    lines,
    summary: {
      method: 'flat', period_days: periodDays, flat_amount_cents: amount, prorate,
      total_cents: 0, billable_cents: 0, common_area_cents: 0, vacancy_cents: 0,
      resident_share_cents: shares, admin_fees_cents: 0, tax_cents: lines.reduce((s, l) => s + l.tax_cents, 0), tax_pct: taxPct,
      billed_to_residents_cents: lines.reduce((s, l) => s + l.amount_cents, 0), owner_cost_cents: 0,
      resident_count: lines.length, day_count: dayCount,
    },
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * Splits `totalCents` across `weights` in proportion, in whole cents, so the parts add up
 * exactly to the total (leftover pennies go to the largest remainders). Used to spread an
 * owner's dollar discount over the utility lines of a billing batch.
 */
export function splitCents(totalCents, weights) {
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (!sum || !totalCents) return weights.map(() => 0);
  const exact = weights.map((w) => (Math.max(0, w) / sum) * totalCents);
  const parts = exact.map((v) => Math.floor(v));
  let left = totalCents - parts.reduce((s, v) => s + v, 0);
  const order = exact.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k][1]]++;
  return parts;
}
