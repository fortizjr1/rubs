-- Owner discount on a billing batch: taken off the split utility bill before RUBS.
ALTER TABLE billing_runs ADD COLUMN discount_type TEXT;      -- 'pct' | 'amount' | NULL
ALTER TABLE billing_runs ADD COLUMN discount_value INTEGER;  -- percent in hundredths (12.5% = 1250) or cents
ALTER TABLE billing_runs ADD COLUMN discount_note TEXT;      -- reason, staff only (never shown to residents)
