-- Date the utility bill was received from the city (staff reference only, not on statements).
ALTER TABLE billing_runs ADD COLUMN bill_date TEXT;
-- The Rent Manager charge date is always the statement date now.
UPDATE billing_runs SET charge_date = statement_date;
