const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'mugeni_shop',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Initialize database tables
const initDatabase = async () => {
  const connection = await pool.getConnection();
  try {
    // Categories table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        status ENUM('active', 'inactive') DEFAULT 'active',
        items_count INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Items table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS items (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(255) NOT NULL,
        sku VARCHAR(100),
        category_id INT,
        price DECIMAL(10,2) NOT NULL,
        cost DECIMAL(10,2) NOT NULL,
        stock DECIMAL(10,3) DEFAULT 0,
        min_stock DECIMAL(10,3) DEFAULT 5,
        status ENUM('active', 'inactive') DEFAULT 'active',
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
      )
    `);

    // Clients table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(50),
        contact VARCHAR(255),
        email VARCHAR(255),
        address TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Debts table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS debts (
        id INT PRIMARY KEY AUTO_INCREMENT,
        type ENUM('debtor', 'creditor') NOT NULL,
        person VARCHAR(255) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        date DATE NOT NULL,
        due_date DATE,
        description TEXT,
        status ENUM('pending', 'paid', 'overdue') DEFAULT 'pending',
        phone VARCHAR(50),
        email VARCHAR(255),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Debt installments table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS debt_installments (
        id INT PRIMARY KEY AUTO_INCREMENT,
        debt_id INT NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        payment_date DATE NOT NULL,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (debt_id) REFERENCES debts(id) ON DELETE CASCADE
      )
    `);

    // Stock table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stock (
        id INT PRIMARY KEY AUTO_INCREMENT,
        item_id INT NOT NULL,
        sku VARCHAR(100) NOT NULL UNIQUE,
        current_stock DECIMAL(10,3) NOT NULL DEFAULT 0,
        min_stock DECIMAL(10,3) NOT NULL DEFAULT 0,
        sold_this_month DECIMAL(10,3) NOT NULL DEFAULT 0,
        incoming_stock DECIMAL(10,3) NOT NULL DEFAULT 0,
        cost_price DECIMAL(10,2) NOT NULL,
        selling_price DECIMAL(10,2) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
      )
    `);

    // Sales table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS sales (
        id INT PRIMARY KEY AUTO_INCREMENT,
        date DATE NOT NULL,
        client_id INT,
        client_name VARCHAR(255),
        items_count DECIMAL(10,3) NOT NULL,
        payment_method ENUM('Cash', 'Momo', 'Loan'),
        total_amount DECIMAL(10,2) NOT NULL,
        discount DECIMAL(5,2) NOT NULL DEFAULT 0,
        final_amount DECIMAL(10,2) NOT NULL,
        status ENUM('Paid', 'Partial') DEFAULT 'Paid',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
      )
    `);

    // Sale items table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS sale_items (
        id INT PRIMARY KEY AUTO_INCREMENT,
        sale_id INT NOT NULL,
        item_id INT NOT NULL,
        item_name VARCHAR(255) NOT NULL,
        quantity DECIMAL(10,3) NOT NULL,
        unit_price DECIMAL(10,2) NOT NULL,
        total_price DECIMAL(10,2) NOT NULL,
        FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
      )
    `);

    // Stock history table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stock_history (
        id INT PRIMARY KEY AUTO_INCREMENT,
        item_id INT NOT NULL,
        change_type ENUM('purchase', 'sale', 'adjustment', 'return'),
        quantity_change DECIMAL(10,2) NOT NULL,
        previous_stock INT NOT NULL,
        new_stock INT NOT NULL,
        reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
      )
    `);

    // Suppliers table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS suppliers (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(255) NOT NULL,
        contact VARCHAR(255) NOT NULL,
        phone VARCHAR(50),
        address TEXT,
        email VARCHAR(255),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Purchase orders table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id INT PRIMARY KEY AUTO_INCREMENT,
        po_number VARCHAR(50) UNIQUE NOT NULL,
        date DATE NOT NULL,
        supplier_id INT NOT NULL,
        total_amount DECIMAL(10,2) NOT NULL,
        discount DECIMAL(5,2) NOT NULL DEFAULT 0,
        final_amount DECIMAL(10,2) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
      )
    `);

    // Purchase order items table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS purchase_order_items (
        id INT PRIMARY KEY AUTO_INCREMENT,
        purchase_order_id INT NOT NULL,
        item_id INT NOT NULL,
        quantity DECIMAL(10,3) NOT NULL,
        unit_price DECIMAL(10,3) NOT NULL,
        total_price DECIMAL(10,3) NOT NULL,
        FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
        FOREIGN KEY (item_id) REFERENCES items(id)
      )
    `);

    // Expenses table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id INT PRIMARY KEY AUTO_INCREMENT,
        person VARCHAR(255) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        description TEXT NOT NULL,
        category VARCHAR(255) NOT NULL,
        date DATE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Users table for authentication
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT PRIMARY KEY AUTO_INCREMENT,
        username VARCHAR(100) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        role ENUM('superadmin', 'staff') DEFAULT 'staff',
        permissions JSON,
        avatar_color VARCHAR(20) DEFAULT '#10b981',
        status ENUM('active', 'inactive') DEFAULT 'active',
        last_login DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await connection.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_email VARCHAR(255) NULL`).catch(() => {});

    // Activity logs table - tracks all user actions
    await connection.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        action_type ENUM('create', 'update', 'delete', 'login', 'logout', 'view') NOT NULL,
        entity_type VARCHAR(50) NOT NULL,
        entity_id INT,
        entity_name VARCHAR(255),
        description TEXT,
        metadata JSON,
        ip_address VARCHAR(50),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Notifications table - alerts for superadmin
    await connection.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT,
        target_role ENUM('superadmin', 'staff', 'all') DEFAULT 'superadmin',
        type ENUM('sale', 'purchase', 'expense', 'debt', 'stock', 'user', 'system') NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        entity_type VARCHAR(50),
        entity_id INT,
        is_read BOOLEAN DEFAULT FALSE,
        priority ENUM('low', 'medium', 'high', 'urgent') DEFAULT 'medium',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        read_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    // Notification settings table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS notification_settings (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL UNIQUE,
        email_notifications BOOLEAN DEFAULT TRUE,
        push_notifications BOOLEAN DEFAULT TRUE,
        notify_on_sale BOOLEAN DEFAULT TRUE,
        notify_on_purchase BOOLEAN DEFAULT TRUE,
        notify_on_expense BOOLEAN DEFAULT TRUE,
        notify_on_debt BOOLEAN DEFAULT TRUE,
        notify_on_low_stock BOOLEAN DEFAULT TRUE,
        notify_on_user_login BOOLEAN DEFAULT FALSE,
        notify_on_large_transaction BOOLEAN DEFAULT TRUE,
        large_transaction_threshold DECIMAL(10,2) DEFAULT 100000,
        quiet_hours_start TIME,
        quiet_hours_end TIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    await connection.query(`ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS notification_email VARCHAR(255) NULL`).catch(() => {});

    await connection.query(`
      CREATE TABLE IF NOT EXISTS email_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        smtp_host VARCHAR(255) NOT NULL DEFAULT '',
        smtp_port INT NOT NULL DEFAULT 587,
        smtp_secure BOOLEAN NOT NULL DEFAULT FALSE,
        smtp_user VARCHAR(255) NOT NULL DEFAULT '',
        smtp_password TEXT NOT NULL DEFAULT '',
        notification_email VARCHAR(255) NOT NULL DEFAULT '',
        is_active BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Push subscription table for browser notifications
    await connection.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        endpoint TEXT NOT NULL,
        p256dh VARCHAR(255),
        auth VARCHAR(255),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Store/Company settings table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS store_settings (
        id INT PRIMARY KEY AUTO_INCREMENT,
        shop_name VARCHAR(255) NOT NULL DEFAULT 'My Shop',
        phone VARCHAR(50),
        email VARCHAR(255),
        country VARCHAR(100),
        major_city VARCHAR(100),
        city_two VARCHAR(100),
        address TEXT,
        logo_url VARCHAR(500),
        currency VARCHAR(10) DEFAULT 'FRW',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Kitchen items table for food/kitchen stock management
    await connection.query(`
      CREATE TABLE IF NOT EXISTS kitchen_items (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(100) NOT NULL,
        unit VARCHAR(50) NOT NULL DEFAULT 'kg',
        current_stock DECIMAL(10,3) DEFAULT 0,
        min_stock DECIMAL(10,3) DEFAULT 5,
        unit_cost DECIMAL(10,2) DEFAULT 0,
        description TEXT,
        supplier_name VARCHAR(255),
        status ENUM('active', 'inactive', 'deleted') DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log('Kitchen items migration: ✅');

    // Kitchen stock movements table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS kitchen_movements (
        id INT PRIMARY KEY AUTO_INCREMENT,
        kitchen_item_id INT NOT NULL,
        movement_type ENUM('stock_in', 'stock_out', 'adjustment') NOT NULL,
        quantity_change DECIMAL(10,3) NOT NULL,
        unit_cost DECIMAL(10,2) DEFAULT 0,
        notes TEXT,
        used_for VARCHAR(255),
        created_by INT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (kitchen_item_id) REFERENCES kitchen_items(id) ON DELETE CASCADE
      )
    `);
    console.log('Kitchen movements migration: ✅');

    // Seed default kitchen categories if table is empty
    const [existingKitchenItems] = await connection.query('SELECT COUNT(*) as count FROM kitchen_items');
    if (existingKitchenItems[0].count === 0) {
      const defaultKitchenItems = [
        { name: 'Rice', category: 'Grains', unit: 'kg', min_stock: 10, unit_cost: 1500 },
        { name: 'Beans', category: 'Grains', unit: 'kg', min_stock: 10, unit_cost: 1200 },
        { name: 'Maize Flour', category: 'Grains', unit: 'kg', min_stock: 10, unit_cost: 800 },
        { name: 'Cooking Oil', category: 'Cooking Oil', unit: 'L', min_stock: 5, unit_cost: 3500 },
        { name: 'Sugar', category: 'Spices', unit: 'kg', min_stock: 5, unit_cost: 1800 },
        { name: 'Salt', category: 'Spices', unit: 'kg', min_stock: 3, unit_cost: 500 },
        { name: 'Tomatoes', category: 'Vegetables', unit: 'kg', min_stock: 5, unit_cost: 1000 },
        { name: 'Onions', category: 'Vegetables', unit: 'kg', min_stock: 5, unit_cost: 800 },
        { name: 'Potatoes', category: 'Vegetables', unit: 'kg', min_stock: 10, unit_cost: 600 },
        { name: 'Cabbage', category: 'Vegetables', unit: 'pcs', min_stock: 5, unit_cost: 500 },
        { name: 'Meat (Beef)', category: 'Meat', unit: 'kg', min_stock: 5, unit_cost: 5000 },
        { name: 'Chicken', category: 'Meat', unit: 'kg', min_stock: 5, unit_cost: 4500 },
        { name: 'Fish', category: 'Meat', unit: 'kg', min_stock: 3, unit_cost: 4000 },
        { name: 'Eggs', category: 'Dairy', unit: 'pcs', min_stock: 30, unit_cost: 200 },
        { name: 'Milk', category: 'Dairy', unit: 'L', min_stock: 5, unit_cost: 1000 },
        { name: 'Bread', category: 'Bakery', unit: 'pcs', min_stock: 10, unit_cost: 500 },
        { name: 'Tea Leaves', category: 'Beverages', unit: 'kg', min_stock: 2, unit_cost: 2500 },
        { name: 'Coffee', category: 'Beverages', unit: 'kg', min_stock: 1, unit_cost: 5000 }
      ];
      
      for (const item of defaultKitchenItems) {
        await connection.query(
          `INSERT INTO kitchen_items (name, category, unit, current_stock, min_stock, unit_cost, status) VALUES (?, ?, ?, 0, ?, ?, 'active')`,
          [item.name, item.category, item.unit, item.min_stock, item.unit_cost]
        );
      }
      console.log('✅ Default kitchen items seeded');
    }

    // Seed default store settings if not exists
    const [existingSettings] = await connection.query('SELECT id FROM store_settings LIMIT 1');
    if (existingSettings.length === 0) {
      await connection.query(
        `INSERT INTO store_settings (shop_name, currency) VALUES (?, ?)`,
        ['My Shop', 'FRW']
      );
      console.log('✅ Default store settings created');
    }

    // Add user_id columns to existing tables (for tracking who did what)
    await connection.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS created_by INT`).catch(() => {});
    await connection.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS created_by INT`).catch(() => {});
    await connection.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS created_by INT`).catch(() => {});
    await connection.query(`ALTER TABLE debts ADD COLUMN IF NOT EXISTS created_by INT`).catch(() => {});
    await connection.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS created_by INT`).catch(() => {});
    await connection.query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_by INT`).catch(() => {});

    // Seed superadmin if not exists
    const [existingAdmin] = await connection.query(
      "SELECT id FROM users WHERE username = 'admin'"
    );
    if (existingAdmin.length === 0) {
      const bcrypt = require('bcryptjs');
      const hashedPassword = await bcrypt.hash('admin123', 10);
      await connection.query(
        `INSERT INTO users (username, password, full_name, role, permissions) VALUES (?, ?, ?, ?, ?)`,
        ['admin', hashedPassword, 'Super Admin', 'superadmin', JSON.stringify({
          dashboard: true,
          quickSell: true,
          stock: true,
          sales: true,
          purchases: true,
          items: true,
          categories: true,
          debts: true,
          expenses: true,
          reports: true,
          aiSummary: true,
          userManagement: true,
          help: true
        })]
      );
      console.log('✅ Superadmin seeded: username=admin, password=admin123');
    }

    // Create indexes
    await connection.query(`CREATE INDEX IF NOT EXISTS idx_items_category ON items(category_id)`).catch(() => {});
    await connection.query(`CREATE INDEX IF NOT EXISTS idx_items_sku ON items(sku)`).catch(() => {});
    await connection.query(`CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date)`).catch(() => {});
    await connection.query(`CREATE INDEX IF NOT EXISTS idx_sales_client ON sales(client_id)`).catch(() => {});
    await connection.query(`CREATE INDEX IF NOT EXISTS idx_debts_type ON debts(type)`).catch(() => {});
    await connection.query(`CREATE INDEX IF NOT EXISTS idx_debts_status ON debts(status)`).catch(() => {});
    await connection.query(`CREATE INDEX IF NOT EXISTS idx_stock_history_item ON stock_history(item_id)`).catch(() => {});
    await connection.query(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`).catch(() => {});

    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('Database initialization error:', error);
  } finally {
    connection.release();
  }
};

module.exports = { pool, initDatabase };
