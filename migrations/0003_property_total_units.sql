-- Number of units the property has (entered by staff). Used for the occupied / vacant counts.
ALTER TABLE properties ADD COLUMN total_units INTEGER;
