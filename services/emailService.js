const nodemailer = require('nodemailer');
const { pool } = require('../config/database');

class EmailService {
  constructor() {
    this.transporter = null;
    this.init();
  }

  async init() {
    try {
      // Get email settings from database
      const [settings] = await pool.query(
        'SELECT * FROM email_settings WHERE is_active = TRUE LIMIT 1'
      );

      if (settings.length > 0) {
        const config = settings[0];
        this.transporter = nodemailer.createTransport({
          host: config.smtp_host,
          port: config.smtp_port,
          secure: config.smtp_secure, // true for 465, false for other ports
          auth: {
            user: config.smtp_user,
            pass: config.smtp_password
          }
        });

        // Verify connection
        await this.transporter.verify();
        console.log('✅ Email service initialized successfully');
      } else {
        console.log('⚠️ No email configuration found');
      }
    } catch (error) {
      console.error('❌ Failed to initialize email service:', error.message);
    }
  }

  async sendNotification(notification, userEmail) {
    if (!this.transporter || !userEmail) {
      console.log('Skipping email: no transporter or email address');
      return false;
    }

    try {
      // Check if within quiet hours
      const quietHoursCheck = await this.checkQuietHours(notification.user_id);
      if (!quietHoursCheck.canSend) {
        console.log(`Email skipped due to quiet hours: ${quietHoursCheck.reason}`);
        return false;
      }

      const mailOptions = {
        from: `"Iwacu Shop" <${this.transporter.options.auth.user}>`,
        to: userEmail,
        subject: this.getSubject(notification),
        html: this.getHtmlContent(notification)
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log(`✅ Email sent successfully: ${result.messageId}`);
      return true;
    } catch (error) {
      console.error('❌ Failed to send email:', error.message);
      return false;
    }
  }

  async checkQuietHours(userId) {
    try {
      const [settings] = await pool.query(
        'SELECT quiet_hours_start, quiet_hours_end FROM notification_settings WHERE user_id = ?',
        [userId]
      );

      if (settings.length === 0 || !settings[0].quiet_hours_start || !settings[0].quiet_hours_end) {
        return { canSend: true };
      }

      const { quiet_hours_start, quiet_hours_end } = settings[0];
      const now = new Date();
      const currentTime = now.getHours() * 60 + now.getMinutes(); // Total minutes since midnight
      
      const [startHour, startMin] = quiet_hours_start.split(':').map(Number);
      const [endHour, endMin] = quiet_hours_end.split(':').map(Number);
      const startTime = startHour * 60 + startMin;
      const endTime = endHour * 60 + endMin;

      // Handle overnight quiet hours (e.g., 22:00 to 06:00)
      let inQuietHours = false;
      if (startTime > endTime) {
        // Overnight period
        inQuietHours = currentTime >= startTime || currentTime <= endTime;
      } else {
        // Same day period
        inQuietHours = currentTime >= startTime && currentTime <= endTime;
      }

      if (inQuietHours) {
        return { 
          canSend: false, 
          reason: `Currently within quiet hours (${quiet_hours_start} - ${quiet_hours_end})` 
        };
      }

      return { canSend: true };
    } catch (error) {
      console.error('Error checking quiet hours:', error);
      return { canSend: true }; // Allow sending if check fails
    }
  }

  getSubject(notification) {
    const typeSubjects = {
      'sale': '🛒 New Sale Recorded',
      'purchase': '📦 New Purchase Order',
      'expense': '💸 New Expense Recorded',
      'debt': '💰 New Debt Added',
      'stock': '⚠️ Low Stock Alert',
      'user': '👤 User Activity',
      'large_transaction': '💵 Large Transaction Alert'
    };

    return typeSubjects[notification.type] || '🔔 Iwacu Shop Notification';
  }

  getHtmlContent(notification) {
    const typeColors = {
      'sale': '#10b981',
      'purchase': '#3b82f6', 
      'expense': '#f97316',
      'debt': '#8b5cf6',
      'stock': '#f59e0b',
      'user': '#06b6d4',
      'large_transaction': '#ef4444'
    };

    const color = typeColors[notification.type] || '#6b7280';

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Iwacu Shop Notification</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background-color: #f8fafc; }
          .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 24px; text-align: center; }
          .content { padding: 24px; }
          .notification-card { border-left: 4px solid ${color}; background: #f8fafc; padding: 16px; border-radius: 8px; margin: 16px 0; }
          .title { font-weight: 600; color: #1f2937; margin-bottom: 8px; }
          .message { color: #6b7280; font-size: 14px; line-height: 1.5; }
          .meta { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; padding-top: 12px; border-top: 1px solid #e5e7eb; }
          .time { font-size: 12px; color: #9ca3af; }
          .actor { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #6b7280; }
          .actor-avatar { width: 20px; height: 20px; border-radius: 50%; color: white; font-weight: bold; display: flex; align-items: center; justify-center; font-size: 10px; }
          .footer { background: #f8fafc; padding: 16px 24px; text-align: center; color: #6b7280; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0; font-size: 24px;">🔔 Iwacu Shop</h1>
            <p style="margin: 8px 0 0 0; opacity: 0.9;">Real-time Business Updates</p>
          </div>
          
          <div class="content">
            <div class="notification-card">
              <div class="title">${notification.title}</div>
              <div class="message">${notification.message}</div>
              
              ${notification.actor_name ? `
                <div class="meta">
                  <div class="display-flex align-items-center gap-8">
                
                    <span>${notification.actor_name}</span>
                  </div>
                  <div class="time">${this.formatTime(notification.created_at)}</div>
                </div>
              ` : `
                <div class="meta">
                  <div></div>
                  <div class="time">${this.formatTime(notification.created_at)}</div>
                </div>
              `}
            </div>
            
            <p style="color: #6b7280; font-size: 14px; text-align: center; margin: 24px 0;">
              This notification was sent from your Stokify | Iwacu Shop system.
            </p>
          </div>
          
          <div class="footer">
            <p>© 2024 Iwacu Shop. All rights reserved.</p>
            <p style="margin-top: 4px;">This is an automated message. Please do not reply.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  formatTime(dateString) {
    const date = new Date(dateString);
    return date.toLocaleString('en-RW', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  }
}

module.exports = new EmailService();
