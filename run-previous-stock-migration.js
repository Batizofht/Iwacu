const { pool } = require('./config/database');

async function runPreviousStockMigration() {
  try {
    console.log('🔄 Creating previous_stock table...');
    
    // Create previous_stock table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS previous_stock (
        id INT AUTO_INCREMENT PRIMARY KEY,
        item_id INT NOT NULL,
        stock_quantity DECIMAL(15,3) NOT NULL DEFAULT 0,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
        UNIQUE KEY unique_item (item_id)
      )
    `);
    console.log('✅ previous_stock table created');
    
    // Insert initial records for all existing items
    const [result] = await pool.query(`
      INSERT IGNORE INTO previous_stock (item_id, stock_quantity)
      SELECT id, stock FROM items WHERE status = 'active'
    `);
    console.log(`✅ Inserted ${result.affectedRows} initial records`);
    
    console.log('✅ Previous stock migration completed successfully!');
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
  } finally {
    process.exit(0);
  }
}

runPreviousStockMigration();
