-- Add water_name field to water_jerrycans table for product tracking
ALTER TABLE water_jerrycans 
ADD COLUMN IF NOT EXISTS water_name VARCHAR(255);
