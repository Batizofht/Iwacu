/**
 * Run once to add water_name and related columns for product-based water selling.
 * From server folder: node run-water-name-migration.js
 */
const { pool } = require('./config/database');

const steps = [
  { name: 'water_jerrycans.water_name', sql: "ALTER TABLE water_jerrycans ADD COLUMN water_name VARCHAR(100) DEFAULT 'Water'" },
  { name: 'water_additions.water_name', sql: "ALTER TABLE water_additions ADD COLUMN water_name VARCHAR(100) DEFAULT 'Water'" },
  { name: 'water_additions.status', sql: "ALTER TABLE water_additions ADD COLUMN status VARCHAR(20) DEFAULT 'filled'" },
  { name: 'water_sales.water_name', sql: "ALTER TABLE water_sales ADD COLUMN water_name VARCHAR(100) DEFAULT 'Water'" },
  { name: 'water_sales.capacity', sql: 'ALTER TABLE water_sales ADD COLUMN capacity INT DEFAULT 20' },
  { name: 'backfill jerrycans', sql: "UPDATE water_jerrycans SET water_name = COALESCE(water_name, 'Water') WHERE water_name IS NULL OR water_name = ''" },
  { name: 'backfill additions', sql: "UPDATE water_additions SET water_name = COALESCE(water_name, 'Water'), status = COALESCE(status, 'filled') WHERE water_name IS NULL OR water_name = ''" },
  { name: 'backfill sales', sql: 'UPDATE water_sales SET water_name = COALESCE(water_name, \'Water\'), capacity = COALESCE(capacity, 20) WHERE water_name IS NULL OR water_name = \'\'' }
];

async function run() {
  for (const step of steps) {
    try {
      await pool.query(step.sql);
      console.log('OK:', step.name);
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME' || err.message && err.message.includes('Duplicate column')) {
        console.log('Skip (already exists):', step.name);
      } else {
        console.error('Failed:', step.name, err.message);
      }
    }
  }
  process.exit(0);
}

run();
