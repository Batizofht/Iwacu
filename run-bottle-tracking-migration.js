const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function runMigrations() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'mugeni_shop',
    multipleStatements: true
  });

  try {
    console.log('Running water management bottle tracking migrations...');

    // Run water_jerrycans_water_name migration
    const jerrycanMigration = fs.readFileSync(
      path.join(__dirname, 'migrations/water_jerrycans_water_name.sql'),
      'utf8'
    );
    await connection.execute(jerrycanMigration);
    console.log('✓ Water jerrycans water_name field added');

    // Run water_sales_bottle_tracking migration
    const salesMigration = fs.readFileSync(
      path.join(__dirname, 'migrations/water_sales_bottle_tracking.sql'),
      'utf8'
    );
    await connection.execute(salesMigration);
    console.log('✓ Water sales bottle tracking fields added');

    console.log('All migrations completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    await connection.end();
  }
}

if (require.main === module) {
  runMigrations().catch(console.error);
}

module.exports = { runMigrations };
