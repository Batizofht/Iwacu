const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// GET store settings
router.get('/', async (req, res) => {
  try {
    const [settings] = await pool.query('SELECT * FROM store_settings LIMIT 1');
    
    if (settings.length === 0) {
      // Return default settings
      return res.json({
        success: true,
        data: {
          shop_name: 'My Shop',
          phone: '',
          email: '',
          country: '',
          major_city: '',
          city_two: '',
          address: '',
          logo_url: '',
          currency: 'FRW'
        }
      });
    }
    
    res.json({ success: true, data: settings[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// UPDATE store settings
router.put('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    
    // Verify user is superadmin
    const [users] = await pool.query('SELECT role FROM users WHERE id = ?', [userId]);
    if (users.length === 0 || users[0].role !== 'superadmin') {
      return res.status(403).json({ success: false, error: 'Only superadmin can update store settings' });
    }
    
    const {
      shop_name,
      phone,
      email,
      country,
      major_city,
      city_two,
      address,
      logo_url,
      currency
    } = req.body;
    
    if (!shop_name) {
      return res.status(400).json({ success: false, error: 'Shop name is required' });
    }
    
    // Check if settings exist
    const [existing] = await pool.query('SELECT id FROM store_settings LIMIT 1');
    
    if (existing.length === 0) {
      // Insert new settings
      await pool.query(
        `INSERT INTO store_settings 
         (shop_name, phone, email, country, major_city, city_two, address, logo_url, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [shop_name, phone || '', email || '', country || '', major_city || '', city_two || '', address || '', logo_url || '', currency || 'FRW']
      );
    } else {
      // Update existing settings
      await pool.query(
        `UPDATE store_settings SET
         shop_name = ?, phone = ?, email = ?, country = ?, major_city = ?, 
         city_two = ?, address = ?, logo_url = ?, currency = ?,
         updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [shop_name, phone || '', email || '', country || '', major_city || '', city_two || '', address || '', logo_url || '', currency || 'FRW', existing[0].id]
      );
    }
    
    // Get updated settings
    const [updated] = await pool.query('SELECT * FROM store_settings LIMIT 1');
    
    res.json({ success: true, data: updated[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
