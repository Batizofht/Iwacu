const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { logActivity } = require('../utils/activityLogger');
const { createAndSendNotification } = require('./notifications');

// GET all sales
router.get('/', async (req, res) => {
  try {
    const [sales] = await pool.query('SELECT * FROM sales ORDER BY created_at DESC');

    const salesWithItems = [];
    for (const sale of sales) {
      const [items] = await pool.query(`
        SELECT
          si.id,
          si.sale_id,
          si.item_id,
          si.quantity,
          si.unit_price,
          si.total_price,
          i.name AS item_name,
          i.cost AS item_cost
        FROM sale_items si
        LEFT JOIN items i ON si.item_id = i.id
        WHERE si.sale_id = ?
      `, [sale.id]);

      salesWithItems.push({
        ...sale,
        items
      });
    }

    res.json(salesWithItems);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE sale
router.post('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { client_id, payment_method, status = 'Paid', total_amount, discount = 0, final_amount, items } = req.body;
    if (!payment_method) return res.status(400).json({ error: 'Payment method is required' });
    if (total_amount === undefined) return res.status(400).json({ error: 'Total amount is required' });
    if (final_amount === undefined) return res.status(400).json({ error: 'Final amount is required' });
    if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'Items are required' });

    // Get client name
    let client_name = 'Walk-in Customer';
    if (client_id) {
      const [clients] = await pool.query('SELECT name FROM clients WHERE id = ?', [client_id]);
      if (clients.length > 0) {
        client_name = clients[0].name;
      }
    }

    // Create sale record
    const [result] = await pool.query(
      'INSERT INTO sales (date, client_id, client_name, items_count, payment_method, total_amount, discount, final_amount, status) VALUES (CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?)',
      [client_id || null, client_name, items.length, payment_method, total_amount, discount, final_amount, status]
    );

    const saleId = result.insertId;

    // Insert sale items and update stock
    for (const item of items) {
      // Get item details
      const [itemDetails] = await pool.query('SELECT name, stock FROM items WHERE id = ?', [item.item_id]);
      if (itemDetails.length === 0) continue;

      const itemName = itemDetails[0].name;
      const currentStock = itemDetails[0].stock;
      const newStock = Math.max(0, currentStock - item.quantity);
      const totalPrice = item.quantity * item.unit_price;

      // Insert sale item
      await pool.query(
        'INSERT INTO sale_items (sale_id, item_id, item_name, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?, ?)',
        [saleId, item.item_id, itemName, item.quantity, item.unit_price, totalPrice]
      );

      // Update stock
      await pool.query(
        'UPDATE items SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [newStock, item.item_id]
      );
    }

    // Log activity
    if (userId) {
      console.log(`📝 Logging sale activity for user ${userId}`);
      logActivity({
        userId: parseInt(userId),
        actionType: 'create',
        entityType: 'sale',
        entityId: saleId,
        entityName: `Sale #${saleId}`,
        description: `yagurishije FRW ${final_amount.toLocaleString()} kuri ${client_name}`,
        metadata: { final_amount, items_count: items.length, payment_method, client_name }
      }).catch(err => console.error('Activity logging error:', err));
    } else {
      console.log('⚠️ No userId provided for sale activity logging');
    }

    // Create notification for sale (async, don't wait)
    if (userId) {
      createAndSendNotification({
        type: 'sale',
        title: 'Ishuri Rishya',
        message: `${client_name} yagurishijwe ibicuruzwa bya FRW ${final_amount.toLocaleString()}`,
        userId: parseInt(userId),
        targetRole: 'superadmin',
        entityId: saleId,
        entityType: 'sale'
      }).catch(err => console.error('Notification error:', err));
    }

    // Get the complete sale data with items details
    const [saleItems] = await pool.query(`
      SELECT si.*, i.name as item_name, i.sku, i.category_id, i.price, i.cost 
      FROM sale_items si 
      LEFT JOIN items i ON si.item_id = i.id 
      WHERE si.sale_id = ?
    `, [saleId]);

    res.json({
      id: saleId,
      client_name,
      client_id,
      payment_method,
      status,
      total_amount,
      discount,
      final_amount,
      date: new Date().toISOString().split('T')[0],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      items_count: items.length,
      items: saleItems.map(item => ({
        ...item,
        item_name: item.item_name || 'Unknown Item',
        sku: item.sku || '',
        price: item.price || 0,
        cost: item.cost || 0
      })),
      success: true
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPDATE sale status
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    await pool.query('UPDATE sales SET status = ? WHERE id = ?', [status, id]);

    res.json({ success: true, id, status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE sale
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { id } = req.params;

    // Get sale info for logging
    const [saleInfo] = await pool.query('SELECT * FROM sales WHERE id = ?', [id]);

    // Get sale items to restore stock
    const [items] = await pool.query(`
      SELECT si.item_id, si.quantity, i.stock 
      FROM sale_items si 
      LEFT JOIN items i ON si.item_id = i.id 
      WHERE si.sale_id = ?
    `, [id]);

    // Restore stock for each item
    for (const item of items) {
      const newStock = Number(item.stock) + Number(item.quantity);

      await pool.query(
        'UPDATE items SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [newStock, item.item_id]
      );
    }

    // Delete sale items and sale
    await pool.query('DELETE FROM sale_items WHERE sale_id = ?', [id]);
    await pool.query('DELETE FROM sales WHERE id = ?', [id]);

    // Log activity
    if (userId && saleInfo.length > 0) {
      await logActivity({
        userId: parseInt(userId),
        actionType: 'delete',
        entityType: 'sale',
        entityId: parseInt(id),
        entityName: `Sale #${id}`,
        description: `yasivye sale #${id} ya FRW ${saleInfo[0].final_amount?.toLocaleString() || 0}`,
        metadata: { final_amount: saleInfo[0].final_amount, client_name: saleInfo[0].client_name }
      });
    }

    res.json({ success: true, id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
