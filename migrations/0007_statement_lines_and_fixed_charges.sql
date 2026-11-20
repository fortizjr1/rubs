-- statement_label: utilities with the same label are combined into one statement line
--   (e.g. Water + Sewer -> "Water & Sewer"; Internet + Pest Control + Trash -> "Amenity Fee").
-- charge_method: 'rubs' = split a utility bill; 'flat' = fixed amount per resident (no bill).
ALTER TABLE property_utilities ADD COLUMN statement_label TEXT;
ALTER TABLE property_utilities ADD COLUMN charge_method TEXT NOT NULL DEFAULT 'rubs';
ALTER TABLE property_utilities ADD COLUMN flat_amount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE property_utilities ADD COLUMN flat_prorate INTEGER NOT NULL DEFAULT 1;
