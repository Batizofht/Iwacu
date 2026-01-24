const { pool } = require('../config/database');

/**
 * Log an activity and create notification for superadmin
 * @param {Object} params
 * @param {number} params.userId - ID of user performing action
 * @param {string} params.actionType - 'create', 'update', 'delete', 'login', 'logout', 'view'
 * @param {string} params.entityType - 'sale', 'purchase', 'expense', 'debt', 'item', 'category', 'user', etc.
 * @param {number} params.entityId - ID of the entity
 * @param {string} params.entityName - Name/description of entity
 * @param {string} params.description - Human readable description
 * @param {Object} params.metadata - Additional data (JSON)
 * @param {string} params.ipAddress - IP address of request
 */
const logActivity = async ({
  userId,
  actionType,
  entityType,
  entityId = null,
  entityName = null,
  description,
  metadata = null,
  ipAddress = null
}) => {
  try {
    // Insert activity log
    await pool.query(
      `INSERT INTO activity_logs (user_id, action_type, entity_type, entity_id, entity_name, description, metadata, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, actionType, entityType, entityId, entityName, description, metadata ? JSON.stringify(metadata) : null, ipAddress]
    );

    // Get user info for notification
    const [users] = await pool.query('SELECT full_name, role FROM users WHERE id = ?', [userId]);
    const user = users[0];

    // Don't create notifications for superadmin's own actions (they don't need to notify themselves)
    if (user && user.role !== 'superadmin') {
      // Create notification for superadmin
      await createNotification({
        userId,
        type: getNotificationType(entityType),
        title: getNotificationTitle(actionType, entityType, entityName),
        message: `${user.full_name} ${description}`,
        entityType,
        entityId,
        priority: getPriority(actionType, entityType, metadata)
      });
    }

    return true;
  } catch (error) {
    console.error('Activity logging error:', error);
    return false;
  }
};

/**
 * Create a notification
 */
const createNotification = async ({
  userId = null,
  targetRole = 'superadmin',
  type,
  title,
  message,
  entityType = null,
  entityId = null,
  priority = 'medium'
}) => {
  try {
    // Check notification settings for superadmins
    const [admins] = await pool.query("SELECT id FROM users WHERE role = 'superadmin' AND status = 'active'");
    
    for (const admin of admins) {
      // Check if this admin has notifications enabled for this type
      const [settings] = await pool.query('SELECT * FROM notification_settings WHERE user_id = ?', [admin.id]);
      
      let shouldNotify = true;
      if (settings.length > 0) {
        const s = settings[0];
        switch (type) {
          case 'sale': shouldNotify = s.notify_on_sale; break;
          case 'purchase': shouldNotify = s.notify_on_purchase; break;
          case 'expense': shouldNotify = s.notify_on_expense; break;
          case 'debt': shouldNotify = s.notify_on_debt; break;
          case 'stock': shouldNotify = s.notify_on_low_stock; break;
          case 'user': shouldNotify = s.notify_on_user_login; break;
          default: shouldNotify = true;
        }

        // Check quiet hours
        if (s.quiet_hours_start && s.quiet_hours_end) {
          const now = new Date();
          const currentTime = now.getHours() * 60 + now.getMinutes();
          const [startH, startM] = s.quiet_hours_start.split(':').map(Number);
          const [endH, endM] = s.quiet_hours_end.split(':').map(Number);
          const startMinutes = startH * 60 + startM;
          const endMinutes = endH * 60 + endM;
          
          if (startMinutes <= currentTime && currentTime <= endMinutes) {
            shouldNotify = false;
          }
        }
      }

      if (shouldNotify) {
        console.log(`📢 Creating notification for admin ${admin.id}: ${title}`);
        await pool.query(
          `INSERT INTO notifications (user_id, target_role, type, title, message, entity_type, entity_id, priority)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [userId, targetRole, type, title, message, entityType, entityId, priority]
        );
      }
    }

    return true;
  } catch (error) {
    console.error('Create notification error:', error);
    return false;
  }
};

/**
 * Get notification type from entity type
 */
const getNotificationType = (entityType) => {
  const typeMap = {
    'sale': 'sale',
    'purchase': 'purchase',
    'purchase_order': 'purchase',
    'expense': 'expense',
    'debt': 'debt',
    'item': 'stock',
    'category': 'stock',
    'user': 'user',
    'stock': 'stock'
  };
  return typeMap[entityType] || 'system';
};

/**
 * Get notification title
 */
const getNotificationTitle = (actionType, entityType, entityName) => {
  const actionLabels = {
    'create': 'Yongeye',
    'update': 'Yahinduye',
    'delete': 'Yasivye',
    'login': 'Yinjiye',
    'logout': 'Yasohotse'
  };

  const entityLabels = {
    'sale': 'Kugurisha',
    'purchase': 'Kurangura',
    'purchase_order': 'Purchase Order',
    'expense': 'Depanse',
    'debt': 'Ideni',
    'item': 'Igicuruzwa',
    'category': 'Kategori',
    'user': 'Umukoresha',
    'client': 'Umukiriya',
    'supplier': 'Supplier'
  };

  const action = actionLabels[actionType] || actionType;
  const entity = entityLabels[entityType] || entityType;
  
  return `${action} ${entity}${entityName ? `: ${entityName}` : ''}`;
};

/**
 * Determine priority based on action and metadata
 */
const getPriority = (actionType, entityType, metadata) => {
  // High priority for large transactions
  if (metadata && metadata.amount && metadata.amount >= 100000) {
    return 'high';
  }
  
  // High priority for deletions
  if (actionType === 'delete') {
    return 'high';
  }

  // Medium priority for sales and purchases
  if (['sale', 'purchase', 'expense', 'debt'].includes(entityType)) {
    return 'medium';
  }

  return 'low';
};

/**
 * Send push notification to subscribed users
 */
const sendPushNotification = async (userId, title, message) => {
  try {
    const [subscriptions] = await pool.query(
      'SELECT * FROM push_subscriptions WHERE user_id = ?',
      [userId]
    );

    // Note: For actual push notifications, you'd need web-push library
    // This is a placeholder for the push notification logic
    for (const sub of subscriptions) {
      console.log(`Push notification to user ${userId}: ${title} - ${message}`);
      // In production, use web-push to send actual notifications
    }

    return true;
  } catch (error) {
    console.error('Push notification error:', error);
    return false;
  }
};

module.exports = {
  logActivity,
  createNotification,
  sendPushNotification
};
