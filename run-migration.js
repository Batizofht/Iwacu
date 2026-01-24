const { pool } = require('./config/database');
const fs = require('fs');

async function runMigration() {
  try {
    console.log('🔄 Running email settings migration...');
    
    // Create email_settings table
    await pool.query(`
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
    console.log('✅ email_settings table created');
    
    // Add notification_email to users table
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS notification_email VARCHAR(255) NULL
    `);
    console.log('✅ notification_email column added to users table');
    
    // Add notification_email to notification_settings table
    await pool.query(`
      ALTER TABLE notification_settings 
      ADD COLUMN IF NOT EXISTS notification_email VARCHAR(255) NULL
    `);
    console.log('✅ notification_email column added to notification_settings table');
    
    // Insert default email settings
    await pool.query(`
      INSERT IGNORE INTO email_settings 
      (smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password, notification_email, is_active)
      VALUES ('', 587, FALSE, '', '', '', FALSE)
    `);
    console.log('✅ Default email settings added!');
    
    console.log('✅ Migration completed successfully!');
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
  } finally {
    process.exit(0);
  }
}

runMigration();
