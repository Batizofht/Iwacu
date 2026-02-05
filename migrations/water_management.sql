-- Water Management Database Migration

-- Water jerrycans table
CREATE TABLE IF NOT EXISTS water_jerrycans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  serial_number VARCHAR(50) UNIQUE,
  capacity INT DEFAULT 20, -- liters
  status ENUM('filled', 'empty', 'maintenance') DEFAULT 'empty',
  selling_price DECIMAL(10, 2), -- Default selling price for this jerrycan
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Water additions table
CREATE TABLE IF NOT EXISTS water_additions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  jerrycans_added INT NOT NULL,
  liters_per_jerrycan INT NOT NULL,
  total_liters INT NOT NULL,
  buying_price_per_jerrycan DECIMAL(10, 2) NOT NULL,
  selling_price_per_jerrycan DECIMAL(10, 2) NOT NULL,
  total_buying_cost DECIMAL(10, 2) NOT NULL,
  total_selling_price DECIMAL(10, 2) NOT NULL,
  expected_profit DECIMAL(10, 2) NOT NULL,
  supplier_name VARCHAR(255),
  notes TEXT,
  date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Water sales table
CREATE TABLE IF NOT EXISTS water_sales (
  id INT AUTO_INCREMENT PRIMARY KEY,
  jerrycans_sold INT NOT NULL,
  price_per_jerrycan DECIMAL(10, 2) NOT NULL,
  total_amount DECIMAL(10, 2) NOT NULL,
  profit DECIMAL(10, 2) NOT NULL,
  customer_name VARCHAR(255),
  payment_method VARCHAR(50) DEFAULT 'cash',
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Add indexes for better performance
CREATE INDEX IF NOT EXISTS idx_water_jerrycans_status ON water_jerrycans(status);
CREATE INDEX IF NOT EXISTS idx_water_additions_date ON water_additions(date);
CREATE INDEX IF NOT EXISTS idx_water_sales_created_at ON water_sales(created_at);

-- Insert some sample data for testing
INSERT IGNORE INTO water_jerrycans (serial_number, capacity, status, selling_price) VALUES
('JRC-001', 20, 'filled', 500.00),
('JRC-002', 20, 'filled', 500.00),
('JRC-003', 20, 'empty', 500.00),
('JRC-004', 20, 'filled', 500.00),
('JRC-005', 20, 'empty', 500.00);

INSERT IGNORE INTO water_additions (jerrycans_added, liters_per_jerrycan, total_liters, buying_price_per_jerrycan, selling_price_per_jerrycan, total_buying_cost, total_selling_price, expected_profit, supplier_name, date) VALUES
(5, 20, 100, 300.00, 500.00, 1500.00, 2500.00, 1000.00, 'Water Supplier Co', CURDATE()),
(3, 20, 60, 320.00, 500.00, 960.00, 1500.00, 540.00, 'Aqua Supply', DATE_SUB(CURDATE(), INTERVAL 7 DAY));

INSERT IGNORE INTO water_sales (jerrycans_sold, price_per_jerrycan, total_amount, profit, customer_name, payment_method) VALUES
(2, 500.00, 1000.00, 400.00, 'John Doe', 'cash'),
(1, 500.00, 500.00, 200.00, 'Jane Smith', 'mobile_money');
