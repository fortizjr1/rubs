import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateRubs, calculateFlat, occupiedDays, periodLength } from '../lib/rubs.js';

const units = [
  { id: 1, unit_number: '101', sqft: 1000, bedrooms: 2 },
  { id: 2, unit_number: '102', sqft: 500, bedrooms: 1 },
  { id: 3, unit_number: '103', sqft: 500, bedrooms: 1 },
];
const base = { recovery_pct: 100, w_sqft: 0, w_bedrooms: 0, w_occupants: 0, w_equal: 0, vacancy_mode: 'owner', vacant_occupants: 1, admin_fee_cents: 0 };
const fullYear = { move_in: '2020-01-01', move_out: null };

test('occupied days are inclusive and prorated', () => {
  assert.equal(occupiedDays('2026-06-01', '2026-06-30', '2020-01-01', null), 30);
  assert.equal(occupiedDays('2026-06-01', '2026-06-30', '2026-06-16', null), 15);
  assert.equal(occupiedDays('2026-06-01', '2026-06-30', '2020-01-01', '2026-06-10'), 10);
  assert.equal(occupiedDays('2026-06-01', '2026-06-30', '2026-07-01', null), 0);
  assert.equal(occupiedDays('2026-06-01', '2026-06-30', '2026-06-05', '2026-06-05'), 1);
});

test('square footage split, all occupied', () => {
  const tenants = units.map((u, i) => ({ id: 10 + i, unit_id: u.id, occupants: 1, ...fullYear }));
  const r = calculateRubs({ totalCents: 100000, periodStart: '2026-06-01', periodEnd: '2026-06-30', config: { ...base, w_sqft: 100 }, units, tenants });
  assert.deepEqual(r.lines.map((l) => l.amount_cents), [50000, 25000, 25000]);
  assert.equal(r.summary.vacancy_cents, 0);
});

test('recovery % deducts common area, admin fee added', () => {
  const tenants = units.map((u, i) => ({ id: 10 + i, unit_id: u.id, occupants: 1, ...fullYear }));
  const r = calculateRubs({ totalCents: 100000, periodStart: '2026-06-01', periodEnd: '2026-06-30', config: { ...base, w_equal: 1, recovery_pct: 90, admin_fee_cents: 350 }, units, tenants });
  assert.equal(r.summary.billable_cents, 90000);
  assert.equal(r.summary.common_area_cents, 10000);
  assert.deepEqual(r.lines.map((l) => l.share_cents), [30000, 30000, 30000]);
  assert.deepEqual(r.lines.map((l) => l.amount_cents), [30350, 30350, 30350]);
});

test('vacant unit: owner absorbs vs occupied-only', () => {
  const tenants = [{ id: 10, unit_id: 1, occupants: 2, ...fullYear }, { id: 11, unit_id: 2, occupants: 1, ...fullYear }];
  const args = { totalCents: 100000, periodStart: '2026-06-01', periodEnd: '2026-06-30', units, tenants };
  const owner = calculateRubs({ ...args, config: { ...base, w_sqft: 100 } });
  assert.deepEqual(owner.lines.map((l) => l.share_cents), [50000, 25000]);
  assert.equal(owner.summary.vacancy_cents, 25000);
  const occ = calculateRubs({ ...args, config: { ...base, w_sqft: 100, vacancy_mode: 'occupied' } });
  assert.deepEqual(occ.lines.map((l) => l.share_cents), [66667, 33333]);
  assert.equal(occ.summary.vacancy_cents, 0);
});

test('mid-period move-out and move-in in the same unit are prorated', () => {
  const tenants = [
    { id: 10, unit_id: 1, occupants: 1, move_in: '2020-01-01', move_out: '2026-06-10' },
    { id: 11, unit_id: 1, occupants: 1, move_in: '2026-06-11', move_out: null },
  ];
  const r = calculateRubs({ totalCents: 30000, periodStart: '2026-06-01', periodEnd: '2026-06-30', config: { ...base, w_equal: 1 }, units: [units[0]], tenants });
  assert.deepEqual(r.lines.map((l) => [l.days, l.share_cents]), [[10, 10000], [20, 20000]]);
});

test('weighted 50% sqft + 50% occupants, cents always balance', () => {
  const tenants = [
    { id: 10, unit_id: 1, occupants: 3, ...fullYear },
    { id: 11, unit_id: 2, occupants: 1, move_in: '2026-06-07', move_out: null },
    { id: 12, unit_id: 3, occupants: 2, move_in: '2020-01-01', move_out: '2026-06-19' },
  ];
  const r = calculateRubs({ totalCents: 123457, periodStart: '2026-06-01', periodEnd: '2026-06-30', config: { ...base, w_sqft: 50, w_occupants: 50 }, units, tenants });
  const sum = r.lines.reduce((s, l) => s + l.share_cents, 0) + r.summary.vacancy_cents;
  assert.equal(sum, r.summary.billable_cents);
  assert.equal(r.summary.owner_cost_cents, 123457 - r.lines.reduce((s, l) => s + l.share_cents, 0));
});

test('errors on missing weights and bad periods', () => {
  assert.throws(() => calculateRubs({ totalCents: 100, periodStart: '2026-06-01', periodEnd: '2026-06-30', config: base, units, tenants: [] }), /allocation/);
  assert.throws(() => calculateRubs({ totalCents: 100, periodStart: '2026-06-30', periodEnd: '2026-06-01', config: { ...base, w_equal: 1 }, units, tenants: [] }), /must be after/);
});

test('meter-read day count matches utility bills (end - start)', () => {
  assert.equal(periodLength('2026-10-06', '2026-11-03', 'meter'), 28);
  assert.equal(periodLength('2026-10-06', '2026-11-03', 'calendar'), 29);
  // move-out and move-in on the same day: no overlap, days add up to the period
  assert.equal(occupiedDays('2026-10-06', '2026-11-03', '2020-01-01', '2026-10-25', 'meter'), 19);
  assert.equal(occupiedDays('2026-10-06', '2026-11-03', '2026-10-25', null, 'meter'), 9);
  assert.equal(occupiedDays('2026-10-06', '2026-11-03', '2026-11-03', null, 'meter'), 0);
});

test('turnover on the same day in meter mode bills the unit exactly once', () => {
  const tenants = [
    { id: 10, unit_id: 1, occupants: 1, move_in: '2020-01-01', move_out: '2026-10-25' },
    { id: 11, unit_id: 1, occupants: 1, move_in: '2026-10-25', move_out: null },
  ];
  const r = calculateRubs({ totalCents: 28000, periodStart: '2026-10-06', periodEnd: '2026-11-03', config: { ...base, w_equal: 1, day_count: 'meter' }, units: [units[0]], tenants });
  assert.deepEqual(r.lines.map((l) => [l.days, l.share_cents]), [[19, 19000], [9, 9000]]);
  assert.equal(r.summary.vacancy_cents, 0);
});

test('utility tax is added on top of the share (10% on $7.24 = $0.72)', () => {
  const tenants = [{ id: 10, unit_id: 1, occupants: 1, ...fullYear }];
  const r = calculateRubs({ totalCents: 724, periodStart: '2026-10-06', periodEnd: '2026-11-03', config: { ...base, w_equal: 1, tax_pct: 10, day_count: 'meter' }, units: [units[0]], tenants });
  assert.equal(r.lines[0].share_cents, 724);
  assert.equal(r.lines[0].tax_cents, 72);
  assert.equal(r.lines[0].amount_cents, 796);
  assert.equal(r.summary.tax_cents, 72);
});

test('fixed amount per resident, prorated by days, with tax', () => {
  const tenants = [
    { id: 10, unit_id: 1, occupants: 1, ...fullYear },
    { id: 11, unit_id: 2, occupants: 1, move_in: '2026-10-20', move_out: null },
    { id: 12, unit_id: 3, occupants: 1, move_in: '2026-12-01', move_out: null },
  ];
  const r = calculateFlat({ periodStart: '2026-10-06', periodEnd: '2026-11-03', units, tenants,
    config: { flat_amount_cents: 1500, flat_prorate: 1, tax_pct: 7, day_count: 'meter' } });
  assert.deepEqual(r.lines.map((l) => [l.tenant_id, l.days, l.share_cents, l.tax_cents]), [[10, 28, 1500, 105], [11, 14, 750, 53]]);
  const noProrate = calculateFlat({ periodStart: '2026-10-06', periodEnd: '2026-11-03', units, tenants,
    config: { flat_amount_cents: 1500, flat_prorate: 0, day_count: 'meter' } });
  assert.deepEqual(noProrate.lines.map((l) => l.share_cents), [1500, 1500]);
  assert.throws(() => calculateFlat({ periodStart: '2026-10-06', periodEnd: '2026-11-03', units, tenants, config: { flat_amount_cents: 0 } }), /fixed amount/);
});
