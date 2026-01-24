const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { logActivity } = require('../utils/activityLogger');
const { createAndSendNotification } = require('./notifications');

// GET all purchase orders
router.get('/', async (req, res) => {
  try {
    const [orders] = await pool.query('SELECT * FROM purchase_orders ORDER BY created_at DESC');

    const ordersWithDetails = [];
    for (const order of orders) {
      // Get supplier details
      const [suppliers] = await pool.query('SELECT * FROM suppliers WHERE id = ?', [order.supplier_id]);
      const supplier = suppliers[0] || null;

      // Get purchase order items
      const [items] = await pool.query(`
        SELECT poi.*, i.name as item_name, i.sku, i.category_id, i.price, i.cost 
        FROM purchase_order_items poi 
        LEFT JOIN items i ON poi.item_id = i.id 
        WHERE poi.purchase_order_id = ?
      `, [order.id]);

      ordersWithDetails.push({
        ...order,
        supplier_name: supplier?.name || 'Unknown Supplier',
        supplier_contact: supplier?.contact || supplier?.phone || '',
        supplier_email: supplier?.email || '',
        items: items.map(item => ({
          ...item,
          item_name: item.item_name || 'Unknown Item',
          sku: item.sku || '',
          price: item.price || 0,
          cost: item.cost || 0
        }))
      });
    }

    res.json(ordersWithDetails);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE purchase order
router.post('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { supplier_id, total_amount, discount = 0, final_amount, status = 'pending', items } = req.body;
    if (!supplier_id) return res.status(400).json({ error: 'Supplier ID is required' });
    if (total_amount === undefined) return res.status(400).json({ error: 'Total amount is required' });
    if (final_amount === undefined) return res.status(400).json({ error: 'Final amount is required' });
    if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'Items are required' });

    // Generate PO number
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const time = now.toTimeString().slice(0, 8).replace(/:/g, '');
    const po_number = `PO-${date}-${time}`;

    const [result] = await pool.query(
      'INSERT INTO purchase_orders (po_number, date, supplier_id, total_amount, discount, final_amount, status) VALUES (?, CURDATE(), ?, ?, ?, ?, ?)',
      [po_number, supplier_id, total_amount, discount, final_amount, status]
    );

    const poId = result.insertId;

    // Add purchase order items
    for (const item of items) {
      const totalPrice = item.quantity * item.unit_price;
      await pool.query(
        'INSERT INTO purchase_order_items (purchase_order_id, item_id, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?)',
        [poId, item.item_id, item.quantity, item.unit_price, totalPrice]
      );
    }

    // Get supplier name for logging
    const [suppliers] = await pool.query('SELECT name FROM suppliers WHERE id = ?', [supplier_id]);
    const supplierName = suppliers[0]?.name || 'Unknown';

    // Log activity
    if (userId) {
      logActivity({
        userId: parseInt(userId),
        actionType: 'create',
        entityType: 'purchase',
        entityId: poId,
        entityName: po_number,
        description: `yakoze purchase order ${po_number} ya FRW ${final_amount.toLocaleString()} kuri ${supplierName}`,
        metadata: { final_amount, items_count: items.length, supplier_name: supplierName }
      }).catch(err => console.error('Activity logging error:', err));
    }

    // Create notification for purchase order (async, don't wait)
    if (userId) {
      createAndSendNotification({
        type: 'purchase',
        title: 'Ibyaranguwe',
        message: `Purchase order ${po_number} ya FRW ${final_amount.toLocaleString()} yashizwe kuri ${supplierName}`,
        userId: parseInt(userId),
        targetRole: 'superadmin',
        entityId: poId,
        entityType: 'purchase'
      }).catch(err => console.error('Notification error:', err));
    }

    // Get the complete purchase order data with supplier and items details
    const [supplierDetails] = await pool.query('SELECT * FROM suppliers WHERE id = ?', [supplier_id]);
    const supplier = supplierDetails[0] || null;

    // Get purchase order items with item details
    const [purchaseItems] = await pool.query(`
      SELECT poi.*, i.name as item_name, i.sku, i.category_id, i.price, i.cost 
      FROM purchase_order_items poi 
      LEFT JOIN items i ON poi.item_id = i.id 
      WHERE poi.purchase_order_id = ?
    `, [poId]);

    res.json({
      id: poId,
      po_number,
      supplier_id,
      supplier_name: supplier?.name || 'Unknown Supplier',
      supplier_contact: supplier?.contact || supplier?.phone || '',
      supplier_email: supplier?.email || '',
      total_amount,
      discount,
      final_amount,
      status,
      date: new Date().toISOString().split('T')[0],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      items: purchaseItems.map(item => ({
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

// UPDATE purchase order
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { supplier_id, total_amount, discount = 0, final_amount, status = 'pending', items } = req.body;
    if (!supplier_id) return res.status(400).json({ error: 'Supplier ID is required' });
    if (total_amount === undefined) return res.status(400).json({ error: 'Total amount is required' });
    if (final_amount === undefined) return res.status(400).json({ error: 'Final amount is required' });
    if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'Items are required' });

    await pool.query(
      'UPDATE purchase_orders SET supplier_id = ?, total_amount = ?, discount = ?, final_amount = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [supplier_id, total_amount, discount, final_amount, status, id]
    );

    // Delete existing items and add new ones
    await pool.query('DELETE FROM purchase_order_items WHERE purchase_order_id = ?', [id]);

    for (const item of items) {
      const totalPrice = item.quantity * item.unit_price;
      await pool.query(
        'INSERT INTO purchase_order_items (purchase_order_id, item_id, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?)',
        [id, item.item_id, item.quantity, item.unit_price, totalPrice]
      );
    }

    res.json({
      id,
      supplier_id,
      total_amount,
      discount,
      final_amount,
      status,
      success: true
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPDATE purchase order status
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'Status is required' });

    // If status is changing to 'completed', update stock
    if (status === 'completed') {
      const [items] = await pool.query(
        'SELECT item_id, quantity FROM purchase_order_items WHERE purchase_order_id = ?',
        [id]
      );

      for (const item of items) {
        await pool.query(
          'UPDATE items SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [item.quantity, item.item_id]
        );
      }
    }

    await pool.query(
      'UPDATE purchase_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, id]
    );

    res.json({ success: true, id, status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE purchase order
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get purchase order status first
    const [orders] = await pool.query('SELECT status FROM purchase_orders WHERE id = ?', [id]);
    if (orders.length === 0) {
      return res.status(404).json({ error: 'Purchase order not found' });
    }
    const poStatus = orders[0].status;

    // If it's cancelled, approved, or pending, just delete it directly
    if (['cancelled', 'pending', 'approved'].includes(poStatus)) {
      await pool.query('DELETE FROM purchase_order_items WHERE purchase_order_id = ?', [id]);
      await pool.query('DELETE FROM purchase_orders WHERE id = ?', [id]);
      return res.json({ success: true });
    }

    // For completed/received ones, check if linked to any sales
    const [[{ linked_count }]] = await pool.query(`
      SELECT COUNT(*) as linked_count
      FROM sale_items si
      JOIN purchase_order_items poi ON si.item_id = poi.item_id 
      WHERE poi.purchase_order_id = ?
    `, [id]);

    if (linked_count > 0) {
      return res.status(400).json({ error: 'Cannot delete purchase order because it has linked sales records' });
    }

    // Reduce stock if needed
    const [items] = await pool.query(`
      SELECT poi.item_id, poi.quantity, i.stock 
      FROM purchase_order_items poi 
      LEFT JOIN items i ON poi.item_id = i.id 
      WHERE poi.purchase_order_id = ?
    `, [id]);

    for (const item of items) {
      const newStock = item.stock - item.quantity;
      await pool.query(
        'UPDATE items SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [newStock, item.item_id]
      );
    }

    await pool.query('DELETE FROM purchase_order_items WHERE purchase_order_id = ?', [id]);
    await pool.query('DELETE FROM purchase_orders WHERE id = ?', [id]);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
