-- Add quantity column to water_jerrycans table for quantity-based tracking
ALTER TABLE water_jerrycans ADD COLUMN IF NOT EXISTS quantity INT DEFAULT 1;

-- Update existing rows to have quantity = 1
UPDATE water_jerrycans SET quantity = 1 WHERE quantity IS NULL;
