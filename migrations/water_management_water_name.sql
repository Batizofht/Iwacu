-- Add water name (brand) and product-based selling
-- Run this after water_management.sql (run once)

-- Jerrycans: add water name (e.g. Jibu)
ALTER TABLE water_jerrycans ADD COLUMN water_name VARCHAR(100) DEFAULT 'Water';

-- Additions: add water name and status (empty/filled) for the batch
ALTER TABLE water_additions ADD COLUMN water_name VARCHAR(100) DEFAULT 'Water';
ALTER TABLE water_additions ADD COLUMN status VARCHAR(20) DEFAULT 'filled';

-- Sales: which product was sold (for display and reporting)
ALTER TABLE water_sales ADD COLUMN water_name VARCHAR(100) DEFAULT 'Water';
ALTER TABLE water_sales ADD COLUMN capacity INT DEFAULT 20;

-- Backfill existing rows
UPDATE water_jerrycans SET water_name = COALESCE(water_name, 'Water') WHERE water_name IS NULL OR water_name = '';
UPDATE water_additions SET water_name = COALESCE(water_name, 'Water'), status = COALESCE(status, 'filled') WHERE water_name IS NULL OR water_name = '';
UPDATE water_sales SET water_name = COALESCE(water_name, 'Water'), capacity = COALESCE(capacity, 20) WHERE water_name IS NULL OR water_name = '';
