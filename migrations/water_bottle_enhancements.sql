-- Water Management Enhancements Migration
-- Add bottle_price and bottle_health fields

-- Add status field to water_additions for tracking filled/empty bottles
ALTER TABLE water_additions 
ADD COLUMN IF NOT EXISTS status ENUM('filled', 'empty') DEFAULT 'filled';

-- Add bottle_price field to water_additions (price of bottle without water)
ALTER TABLE water_additions 
ADD COLUMN IF NOT EXISTS bottle_price DECIMAL(10, 2) DEFAULT 0;

-- Add bottle_health field to water_jerrycans for tracking bottle condition
ALTER TABLE water_jerrycans 
ADD COLUMN IF NOT EXISTS bottle_health ENUM('good', 'damaged', 'needs_repair') DEFAULT 'good';

-- Add bottle_price field to water_jerrycans (price of bottle for selling)
ALTER TABLE water_jerrycans 
ADD COLUMN IF NOT EXISTS bottle_price DECIMAL(10, 2) DEFAULT 0;

-- Add sale_type to water_sales to track what was sold
ALTER TABLE water_sales 
ADD COLUMN IF NOT EXISTS sale_type ENUM('water_and_bottle', 'water_only', 'empty_bottle') DEFAULT 'water_and_bottle';

-- Add bottle_price to water_sales
ALTER TABLE water_sales 
ADD COLUMN IF NOT EXISTS bottle_price DECIMAL(10, 2) DEFAULT 0;

-- Add water_price to water_sales (price of water alone)
ALTER TABLE water_sales 
ADD COLUMN IF NOT EXISTS water_price DECIMAL(10, 2) DEFAULT 0;
