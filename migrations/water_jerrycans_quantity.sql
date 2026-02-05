-- Migration: Change water_jerrycans from individual rows to quantity-based
-- This reduces database size significantly

-- Add quantity column if it doesn't exist
ALTER TABLE water_jerrycans 
ADD COLUMN IF NOT EXISTS quantity INT DEFAULT 1;

-- Create a new consolidated table structure
-- First, consolidate existing rows into quantity-based records
-- This query groups existing bottles and sums them

-- Step 1: Create temp table with consolidated data
CREATE TEMPORARY TABLE temp_consolidated AS
SELECT 
  water_name,
  capacity,
  status,
  MAX(selling_price) as selling_price,
  MAX(bottle_price) as bottle_price,
  MAX(bottle_health) as bottle_health,
  COUNT(*) as quantity,
  MAX(created_at) as created_at
FROM water_jerrycans
GROUP BY water_name, capacity, status;

-- Step 2: Delete all existing rows
DELETE FROM water_jerrycans;

-- Step 3: Insert consolidated rows
INSERT INTO water_jerrycans (water_name, capacity, status, selling_price, bottle_price, bottle_health, quantity, serial_number, created_at)
SELECT 
  water_name,
  capacity,
  status,
  selling_price,
  bottle_price,
  bottle_health,
  quantity,
  CONCAT('STOCK-', water_name, '-', capacity, 'L-', status),
  created_at
FROM temp_consolidated;

-- Step 4: Drop temp table
DROP TEMPORARY TABLE temp_consolidated;
