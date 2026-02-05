-- Create previous_stock table to track stock history per item
CREATE TABLE IF NOT EXISTS previous_stock (
  id INT AUTO_INCREMENT PRIMARY KEY,
  item_id INT NOT NULL,
  stock_quantity DECIMAL(15,3) NOT NULL DEFAULT 0,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
  UNIQUE KEY unique_item (item_id)
);

-- Insert initial records for all existing items
INSERT IGNORE INTO previous_stock (item_id, stock_quantity)
SELECT id, stock FROM items WHERE status = 'active';
