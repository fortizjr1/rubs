-- Split rules that mirror Rent Manager's RUBS Template:
--   allocation_mode: 'even_all' | 'even_occupied' | 'factors'
--   factors: occupancy (always occupied units), square feet, bedrooms, bathrooms;
--   *_scope: 'all' units or 'occupied' units only, per factor.
ALTER TABLE property_utilities ADD COLUMN allocation_mode TEXT NOT NULL DEFAULT 'factors';
ALTER TABLE property_utilities ADD COLUMN w_bathrooms REAL NOT NULL DEFAULT 0;
ALTER TABLE property_utilities ADD COLUMN sqft_scope TEXT NOT NULL DEFAULT 'all';
ALTER TABLE property_utilities ADD COLUMN bedrooms_scope TEXT NOT NULL DEFAULT 'all';
ALTER TABLE property_utilities ADD COLUMN bathrooms_scope TEXT NOT NULL DEFAULT 'all';
-- How people count in the occupancy factor: 'headcount' | 'cap2' | 'half' | 'conservice'
ALTER TABLE property_utilities ADD COLUMN occupancy_weighting TEXT NOT NULL DEFAULT 'headcount';

-- Carry existing rules over: an equal-only split becomes "divide evenly", and the old
-- per-utility vacancy setting becomes each factor's scope.
UPDATE property_utilities
  SET allocation_mode = CASE WHEN vacancy_mode = 'occupied' THEN 'even_occupied' ELSE 'even_all' END
  WHERE w_equal > 0 AND w_sqft = 0 AND w_bedrooms = 0 AND w_occupants = 0;
UPDATE property_utilities
  SET sqft_scope = CASE WHEN vacancy_mode = 'occupied' THEN 'occupied' ELSE 'all' END,
      bedrooms_scope = CASE WHEN vacancy_mode = 'occupied' THEN 'occupied' ELSE 'all' END,
      bathrooms_scope = CASE WHEN vacancy_mode = 'occupied' THEN 'occupied' ELSE 'all' END;
