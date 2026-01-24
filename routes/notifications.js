const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const emailService = require('../services/emailService');
const webpush = require('web-push');

// Configure VAPID
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Helper function to create notification and send email
async function createAndSendNotification({
  type,
  title,
  message,
  userId,
  targetRole = 'all',
  entityId = null,
  entityType = null
}) {
  try {
    // Create notification in database
    const [result] = await pool.query(
      `INSERT INTO notifications 
       (type, title, message, user_id, target_role, entity_id, entity_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [type, title, message, userId, targetRole, entityId, entityType]
    );

    const notificationId = result.insertId;

    // Get notification details with actor info
    const [notifications] = await pool.query(
      `SELECT n.*, u.full_name as actor_name, u.avatar_color as actor_color
       FROM notifications n
       LEFT JOIN users u ON n.user_id = u.id
       WHERE n.id = ?`,
      [notificationId]
    );

    if (notifications.length > 0) {
      const notification = notifications[0];

      // Get superadmin users to send email notification
      const [superadminUsers] = await pool.query(
        'SELECT u.notification_email as user_email, ns.notification_email as settings_email, ns.email_notifications FROM users u LEFT JOIN notification_settings ns ON u.id = ns.user_id WHERE u.role = ? AND (u.notification_email IS NOT NULL OR ns.notification_email IS NOT NULL)',
        ['superadmin']
      );

      // Send emails to superadmins with email notifications enabled
      for (const admin of superadminUsers) {
        const adminEmail = admin.user_email || admin.settings_email;
        const emailEnabled = admin.email_notifications || 1; // Default to enabled if not set
        
        if (adminEmail && emailEnabled) {
          try {
            // Send email notification
            await emailService.sendNotification(notification, adminEmail);
            console.log(`📧 Email sent to superadmin: ${adminEmail}`);
          } catch (emailError) {
            console.error(`Failed to send email to ${adminEmail}:`, emailError.message);
          }
        }
      }

      // Send PUSH notifications to all superadmins
      const [pushSubscriptions] = await pool.query(
        `SELECT ps.* FROM push_subscriptions ps
         JOIN users u ON ps.user_id = u.id
         JOIN notification_settings ns ON u.id = ns.user_id
         WHERE u.role = 'superadmin' 
         AND (ns.push_notifications IS NULL OR ns.push_notifications = 1)`,
      );

      console.log(`📱 Found ${pushSubscriptions.length} push subscriptions`);

      // Send push notification to each subscription
      for (const sub of pushSubscriptions) {
        try {
          const payload = JSON.stringify({
            title: notification.title,
            body: notification.message,
            icon: '/icons/icon.webp',
            badge: '/icons/badge.png',
            tag: `notification-${notificationId}`,
            data: {
              notificationId,
              type: notification.type,
              url: '/'
            }
          });

          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: {
                p256dh: sub.p256dh,
                auth: sub.auth
              }
            },
            payload
          );
          
          console.log(`📱 Push sent to user ${sub.user_id}`);
        } catch (pushError) {
          console.error(`Failed to send push to user ${sub.user_id}:`, pushError.message);
          
          // If subscription is gone/expired (410), remove it from database
          if (pushError.statusCode === 410) {
            await pool.query('DELETE FROM push_subscriptions WHERE id = ?', [sub.id]);
            console.log(`🗑️ Removed expired subscription for user ${sub.user_id}`);
          }
        }
      }
    }

    return notificationId;
  } catch (error) {
    console.error('Error creating notification:', error);
    throw error;
  }
}

// Get all notifications for a user (superadmin gets all)
router.get('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { unreadOnly, limit = 50, offset = 0 } = req.query;

    // Get user role
    const [users] = await pool.query('SELECT role FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    const isSuperAdmin = users[0].role === 'superadmin';

    let query = `
      SELECT n.*, u.full_name as actor_name, u.avatar_color as actor_color
      FROM notifications n
      LEFT JOIN users u ON n.user_id = u.id
      WHERE 1=1
    `;
    const params = [];

    // Superadmin sees notifications targeted to superadmin or all
    if (isSuperAdmin) {
      query += ` AND (n.target_role = 'superadmin' OR n.target_role = 'all')`;
    } else {
      query += ` AND (n.target_role = 'staff' OR n.target_role = 'all')`;
    }

    if (unreadOnly === 'true') {
      query += ` AND n.is_read = FALSE`;
    }

    query += ` ORDER BY n.created_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    const [notifications] = await pool.query(query, params);

    // Get unread count
    let countQuery = `
      SELECT COUNT(*) as count FROM notifications n WHERE is_read = FALSE
    `;
    if (isSuperAdmin) {
      countQuery += ` AND (n.target_role = 'superadmin' OR n.target_role = 'all')`;
    } else {
      countQuery += ` AND (n.target_role = 'staff' OR n.target_role = 'all')`;
    }
    const [countResult] = await pool.query(countQuery);

    res.json({
      success: true,
      data: notifications,
      unreadCount: countResult[0].count
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Mark notification as read
router.put('/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      'UPDATE notifications SET is_read = TRUE, read_at = NOW() WHERE id = ?',
      [id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Mark all notifications as read
router.put('/read-all', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const [users] = await pool.query('SELECT role FROM users WHERE id = ?', [userId]);
    
    if (users.length === 0) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    const isSuperAdmin = users[0].role === 'superadmin';
    
    let query = 'UPDATE notifications SET is_read = TRUE, read_at = NOW() WHERE is_read = FALSE';
    if (isSuperAdmin) {
      query += ` AND (target_role = 'superadmin' OR target_role = 'all')`;
    } else {
      query += ` AND (target_role = 'staff' OR target_role = 'all')`;
    }

    await pool.query(query);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete notification
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM notifications WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Clear all notifications
router.delete('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const [users] = await pool.query('SELECT role FROM users WHERE id = ?', [userId]);
    
    if (users.length === 0) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    const isSuperAdmin = users[0].role === 'superadmin';
    
    let query = 'DELETE FROM notifications WHERE 1=1';
    if (isSuperAdmin) {
      query += ` AND (target_role = 'superadmin' OR target_role = 'all')`;
    } else {
      query += ` AND (target_role = 'staff' OR target_role = 'all')`;
    }

    await pool.query(query);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get notification settings
router.get('/settings', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    
    const [settings] = await pool.query(
      'SELECT * FROM notification_settings WHERE user_id = ?',
      [userId]
    );

    if (settings.length === 0) {
      // Return default settings
      res.json({
        success: true,
        data: {
          email_notifications: true,
          push_notifications: true,
          notify_on_sale: true,
          notify_on_purchase: true,
          notify_on_expense: true,
          notify_on_debt: true,
          notify_on_low_stock: true,
          notify_on_user_login: false,
          notify_on_large_transaction: true,
          large_transaction_threshold: 100000,
          quiet_hours_start: null,
          quiet_hours_end: null,
          notification_email: null
        }
      });
    } else {
      res.json({ success: true, data: settings[0] });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update notification settings
router.put('/settings', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const {
      email_notifications,
      push_notifications,
      notify_on_sale,
      notify_on_purchase,
      notify_on_expense,
      notify_on_debt,
      notify_on_low_stock,
      notify_on_user_login,
      notify_on_large_transaction,
      large_transaction_threshold,
      quiet_hours_start,
      quiet_hours_end,
      notification_email
    } = req.body;

    // Check if settings exist
    const [existing] = await pool.query(
      'SELECT id FROM notification_settings WHERE user_id = ?',
      [userId]
    );

    if (existing.length === 0) {
      // Insert new settings
      await pool.query(
        `INSERT INTO notification_settings 
         (user_id, email_notifications, push_notifications, notify_on_sale, notify_on_purchase, 
          notify_on_expense, notify_on_debt, notify_on_low_stock, notify_on_user_login,
          notify_on_large_transaction, large_transaction_threshold, quiet_hours_start, quiet_hours_end, notification_email)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, email_notifications, push_notifications, notify_on_sale, notify_on_purchase,
         notify_on_expense, notify_on_debt, notify_on_low_stock, notify_on_user_login,
         notify_on_large_transaction, large_transaction_threshold, quiet_hours_start, quiet_hours_end, notification_email]
      );
    } else {
      // Update existing settings
      await pool.query(
        `UPDATE notification_settings SET
         email_notifications = ?, push_notifications = ?, notify_on_sale = ?, notify_on_purchase = ?,
         notify_on_expense = ?, notify_on_debt = ?, notify_on_low_stock = ?, notify_on_user_login = ?,
         notify_on_large_transaction = ?, large_transaction_threshold = ?, quiet_hours_start = ?, quiet_hours_end = ?, notification_email = ?
         WHERE user_id = ?`,
        [email_notifications, push_notifications, notify_on_sale, notify_on_purchase,
         notify_on_expense, notify_on_debt, notify_on_low_stock, notify_on_user_login,
         notify_on_large_transaction, large_transaction_threshold, quiet_hours_start, quiet_hours_end, notification_email, userId]
      );
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Subscribe to push notifications
router.post('/push-subscribe', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { endpoint, keys } = req.body;

    // Remove existing subscription for this endpoint
    await pool.query('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [userId, endpoint]);

    // Add new subscription
    await pool.query(
      'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)',
      [userId, endpoint, keys?.p256dh, keys?.auth]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Unsubscribe from push notifications
router.post('/push-unsubscribe', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { endpoint } = req.body;

    await pool.query('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [userId, endpoint]);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get activity logs (superadmin only)
router.get('/activity-logs', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { limit = 100, offset = 0, entityType, actionType, startDate, endDate } = req.query;

    // Verify superadmin
    const [users] = await pool.query('SELECT role FROM users WHERE id = ?', [userId]);
    if (users.length === 0 || users[0].role !== 'superadmin') {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    let query = `
      SELECT al.*, u.full_name, u.username, u.avatar_color
      FROM activity_logs al
      LEFT JOIN users u ON al.user_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (entityType) {
      query += ` AND al.entity_type = ?`;
      params.push(entityType);
    }

    if (actionType) {
      query += ` AND al.action_type = ?`;
      params.push(actionType);
    }

    if (startDate) {
      query += ` AND DATE(al.created_at) >= ?`;
      params.push(startDate);
    }

    if (endDate) {
      query += ` AND DATE(al.created_at) <= ?`;
      params.push(endDate);
    }

    query += ` ORDER BY al.created_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    const [logs] = await pool.query(query, params);

    // Parse metadata JSON
    const parsedLogs = logs.map(log => ({
      ...log,
      metadata: log.metadata ? JSON.parse(log.metadata) : null
    }));

    res.json({ success: true, data: parsedLogs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create notification (for internal use)
router.post('/', async (req, res) => {
  try {
    const notificationData = req.body;
    const notificationId = await createAndSendNotification(notificationData);
    res.json({ success: true, data: { id: notificationId } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
module.exports.createAndSendNotification = createAndSendNotification;
