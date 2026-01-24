const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const emailService = require('../services/emailService');

// Get email settings
router.get('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    
    // Verify superadmin
    const [users] = await pool.query('SELECT role FROM users WHERE id = ?', [userId]);
    if (users.length === 0 || users[0].role !== 'superadmin') {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    const [settings] = await pool.query('SELECT * FROM email_settings WHERE is_active = TRUE LIMIT 1');
    
    if (settings.length === 0) {
      res.json({
        success: true,
        data: {
          smtp_host: 'smtp.gmail.com',
          smtp_port: 587,
          smtp_secure: false,
          smtp_user: 'vlabatizo@gmail.com',
          smtp_password: 'lrdm qifz hksu fiuk',
          notification_email: 'vlabatizo@gmail.com',
          is_active: false
        }
      });
    } else {
      // Don't send password in response
      const { smtp_password, ...safeSettings } = settings[0];
      res.json({ success: true, data: { ...safeSettings, smtp_password: '' } });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update email settings
router.put('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    
    // Verify superadmin
    const [users] = await pool.query('SELECT role FROM users WHERE id = ?', [userId]);
    if (users.length === 0 || users[0].role !== 'superadmin') {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    const {
      smtp_host,
      smtp_port,
      smtp_secure,
      smtp_user,
      smtp_password,
      notification_email,
      is_active
    } = req.body;

    // Check if settings exist
    const [existing] = await pool.query('SELECT id FROM email_settings LIMIT 1');

    if (existing.length === 0) {
      // Insert new settings
      await pool.query(
        `INSERT INTO email_settings 
         (smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password, notification_email, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password, notification_email, is_active]
      );
    } else {
      // Update existing settings
      const updateQuery = `
        UPDATE email_settings SET
        smtp_host = ?, smtp_port = ?, smtp_secure = ?, 
        ${smtp_password ? 'smtp_password = ?,' : ''}
        smtp_user = ?, notification_email = ?, is_active = ?
        WHERE id = ?
      `;
      
      const params = smtp_password 
        ? [smtp_host, smtp_port, smtp_secure, smtp_password, smtp_user, notification_email, is_active, existing[0].id]
        : [smtp_host, smtp_port, smtp_secure, smtp_user, notification_email, is_active, existing[0].id];
      
      await pool.query(updateQuery, params);
    }

    // Reinitialize email service if activated
    if (is_active) {
      await emailService.init();
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test email configuration
router.post('/test', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    
    // Verify superadmin
    const [users] = await pool.query('SELECT role FROM users WHERE id = ?', [userId]);
    if (users.length === 0 || users[0].role !== 'superadmin') {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    const { notification_email } = req.body;
    
    if (!notification_email) {
      return res.status(400).json({ success: false, error: 'Notification email is required' });
    }

    // Create test notification
    const testNotification = {
      type: 'user',
      title: 'Test Email Configuration',
      message: 'This is a test email to verify your email settings are working correctly.',
      user_id: userId,
      actor_name: 'System',
      actor_color: '#10b981',
      created_at: new Date().toISOString()
    };

    const success = await emailService.sendNotification(testNotification, notification_email);
    
    if (success) {
      res.json({ 
        success: true, 
        message: 'Test email sent successfully!' 
      });
    } else {
      res.status(400).json({ 
        success: false, 
        error: 'Failed to send test email. Please check your email configuration.' 
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
