-- Add previous_stock column to items table
ALTER TABLE items ADD COLUMN IF NOT EXISTS previous_stock DECIMAL(15,3) DEFAULT 0;

-- Initialize previous_stock with current stock for all items
UPDATE items SET previous_stock = stock WHERE previous_stock = 0 OR previous_stock IS NULL;
