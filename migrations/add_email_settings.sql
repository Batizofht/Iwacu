-- Create email settings table
CREATE TABLE IF NOT EXISTS email_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  smtp_host VARCHAR(255) NOT NULL,
  smtp_port INT NOT NULL DEFAULT 587,
  smtp_secure BOOLEAN NOT NULL DEFAULT FALSE,
  smtp_user VARCHAR(255) NOT NULL,
  smtp_password TEXT NOT NULL,
  notification_email VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Add notification_email to users table for personal email preferences
ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_email VARCHAR(255) NULL;

-- Add notification_email to notification_settings table
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS notification_email VARCHAR(255) NULL;
