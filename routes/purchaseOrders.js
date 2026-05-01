const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { logActivity } = require('../utils/activityLogger');
const { createAndSendNotification } = require('./notifications');

// Helper function to save current stock to previous_stock in items table
async function savePreviousStock(itemId, currentStock) {
  try {
    await pool.query(
      'UPDATE items SET previous_stock = ? WHERE id = ?',
      [currentStock, itemId]
    );
  } catch (error) {
    console.error('Error saving previous_stock:', error);
  }
}

// GET all purchase orders
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 40;
    const offset = (page - 1) * limit;
    const dateFilter = req.query.dateFilter || 'today';
    
    console.log('📅 Purchase orders - dateFilter:', dateFilter);
    
    // Build date filter - default to today
    let dateCondition = 'DATE(date) = CURDATE()';
    switch (dateFilter) {
      case 'today':
        dateCondition = 'DATE(date) = CURDATE()';
        break;
      case 'yesterday':
        dateCondition = 'DATE(date) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)';
        break;
      case 'thisMonth':
        dateCondition = 'MONTH(date) = MONTH(CURDATE()) AND YEAR(date) = YEAR(CURDATE())';
        break;
      case 'lastMonth':
        dateCondition = 'MONTH(date) = MONTH(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) AND YEAR(date) = YEAR(DATE_SUB(CURDATE(), INTERVAL 1 MONTH))';
        break;
      case 'last7days':
        dateCondition = 'DATE(date) >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
        break;
      case 'all':
        dateCondition = '1=1';
        break;
      case 'custom':
        if (req.query.startDate && req.query.endDate) {
          dateCondition = `DATE(date) BETWEEN '${req.query.startDate}' AND '${req.query.endDate}'`;
        } else {
          dateCondition = '1=1';
        }
        break;
    }
    
    console.log('🔍 Purchase orders - SQL condition:', dateCondition);
    
    // Get total count with filter
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) as total FROM purchase_orders WHERE ${dateCondition}`);
    console.log('📊 Purchase orders - filtered count:', total);
    const totalPages = Math.ceil(total / limit);
    console.log('📄 Purchase orders - totalPages:', totalPages, 'limit:', limit);
    
    const [orders] = await pool.query(`SELECT * FROM purchase_orders WHERE ${dateCondition} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [limit, offset]);

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

      // Get debt balance if purchase is on credit
      let total_paid = 0;
      let balance = 0;
      let debt_status = null;
      
      if (order.payment_status === 'on_credit' && order.debt_id) {
        const [[debtInfo]] = await pool.query(`
          SELECT 
            d.status as debt_status,
            COALESCE(SUM(di.amount), 0) as total_paid,
            (d.amount - COALESCE(SUM(di.amount), 0)) as balance
          FROM debts d
          LEFT JOIN debt_installments di ON d.id = di.debt_id
          WHERE d.id = ?
          GROUP BY d.id
        `, [order.debt_id]);
        
        if (debtInfo) {
          total_paid = parseFloat(debtInfo.total_paid) || 0;
          balance = parseFloat(debtInfo.balance) || 0;
          debt_status = debtInfo.debt_status;
        }
      }

      ordersWithDetails.push({
        ...order,
        supplier_name: supplier?.name || 'Unknown Supplier',
        supplier_contact: supplier?.contact || supplier?.phone || '',
        supplier_email: supplier?.email || '',
        total_paid,
        balance,
        debt_status,
        items: items.map(item => ({
          ...item,
          item_name: item.item_name || 'Unknown Item',
          sku: item.sku || '',
          price: item.price || 0,
          cost: item.cost || 0
        }))
      });
    }

    // Calculate total stats for the filtered period
    console.log('📊 Calculating stats with condition:', dateCondition);
    
    // Get total orders and total value
    const [statsRows] = await pool.query(`
      SELECT 
        COUNT(*) as totalOrders,
        COALESCE(SUM(final_amount), 0) as totalValue
      FROM purchase_orders po 
      WHERE ${dateCondition}
    `);
    
    // Get total items quantity
    const [itemsRows] = await pool.query(`
      SELECT COALESCE(SUM(poi.quantity), 0) as totalItems
      FROM purchase_order_items poi 
      INNER JOIN purchase_orders po ON poi.purchase_order_id = po.id
      WHERE ${dateCondition}
    `);
    
    const totalStats = {
      totalOrders: statsRows[0].totalOrders,
      totalValue: statsRows[0].totalValue,
      totalItems: itemsRows[0].totalItems
    };
    console.log('📈 Total stats result:', totalStats);

    res.json({
      data: ordersWithDetails,
      pagination: { 
        page, 
        limit, 
        total, 
        totalPages, 
        hasNext: page < totalPages, 
        hasPrev: page > 1,
        stats: {
          totalOrders: parseInt(totalStats.totalOrders) || 0,
          totalValue: parseFloat(totalStats.totalValue) || 0,
          totalItems: parseInt(totalStats.totalItems) || 0
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE purchase order
router.post('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { supplier_id, total_amount, discount = 0, final_amount, status = 'pending', payment_status = 'paid_in_full', amount_paid = 0, items } = req.body;
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
      'INSERT INTO purchase_orders (po_number, date, supplier_id, total_amount, discount, final_amount, status, payment_status, amount_paid) VALUES (?, CURDATE(), ?, ?, ?, ?, ?, ?, ?)',
      [po_number, supplier_id, total_amount, discount, final_amount, status, payment_status, amount_paid]
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
    const [suppliers] = await pool.query('SELECT name, phone, email FROM suppliers WHERE id = ?', [supplier_id]);
    const supplierName = suppliers[0]?.name || 'Unknown';
    const supplierPhone = suppliers[0]?.phone || '';
    const supplierEmail = suppliers[0]?.email || '';

    // If payment is on credit, create a debt record
    let debtId = null;
    if (payment_status === 'on_credit') {
      const balance = final_amount - amount_paid;
      
      // Only create debt if there's actually a balance remaining
      if (balance > 0) {
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 30); // Default 30 days credit period
        
        const [debtResult] = await pool.query(
          `INSERT INTO debts (type, person, amount, date, due_date, description, status, phone, email) 
           VALUES ('creditor', ?, ?, CURDATE(), ?, ?, 'pending', ?, ?)`,
          [
            supplierName,
            final_amount,
            dueDate.toISOString().split('T')[0],
            `Purchase Order ${po_number}`,
            supplierPhone,
            supplierEmail
          ]
        );
        debtId = debtResult.insertId;
        
        // Link the debt to the purchase order
        await pool.query(
          'UPDATE purchase_orders SET debt_id = ? WHERE id = ?',
          [debtId, poId]
        );
        
        // If partial payment was made, create an installment record
        if (amount_paid > 0) {
          await pool.query(
            `INSERT INTO debt_installments (debt_id, amount, payment_date, notes) VALUES (?, ?, CURDATE(), ?)`,
            [debtId, amount_paid, 'Initial payment']
          );
        }
      }
    }

    // Log activity
    if (userId) {
      logActivity({
        userId: parseInt(userId),
        actionType: 'create',
        entityType: 'purchase',
        entityId: poId,
        entityName: po_number,
        description: `Yakoze purchase order ${po_number} ya FRW ${final_amount.toLocaleString()} kuri ${supplierName}`,
        metadata: { final_amount, items_count: items.length, supplier_name: supplierName }
      }).catch(err => console.error('Activity logging error:', err));
    }

    // Create notification for purchase order (async, don't wait)
    if (userId) {
      createAndSendNotification({
        type: 'purchase',
        title: 'Ibicuruzwa bishya',
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

router.patch('/:id/status', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'Status is required' });

    await connection.beginTransaction();

    const [existingOrders] = await connection.query(
      'SELECT status FROM purchase_orders WHERE id = ? LIMIT 1',
      [id]
    );

    if (!existingOrders.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Purchase order not found' });
    }

    const previousStatus = existingOrders[0].status;

    // If status is changing to 'completed', update stock
    if (status === 'completed' && previousStatus !== 'completed') {
      const [items] = await connection.query(
        'SELECT item_id, quantity FROM purchase_order_items WHERE purchase_order_id = ?',
        [id]
      );

      for (const item of items) {
        const [stockRows] = await connection.query(
          `SELECT
             i.sku,
             i.min_stock,
             i.cost,
             i.price,
             COALESCE(s.current_stock, i.stock, 0) AS current_stock
           FROM items i
           LEFT JOIN stock s ON s.item_id = i.id
           WHERE i.id = ?
           LIMIT 1`,
          [item.item_id]
        );

        if (!stockRows.length) continue;

        const currentStock = Number(stockRows[0].current_stock) || 0;
        const addedQty = Number(item.quantity) || 0;
        const nextStock = currentStock + addedQty;
        
        // Save current stock to previous_stock BEFORE updating
        await connection.query(
          'UPDATE items SET previous_stock = ? WHERE id = ?',
          [currentStock, item.item_id]
        );
        
        await connection.query(
          'UPDATE items SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [nextStock, item.item_id]
        );

        const [stockEntries] = await connection.query(
          'SELECT id FROM stock WHERE item_id = ? LIMIT 1',
          [item.item_id]
        );

        if (stockEntries.length > 0) {
          await connection.query(
            'UPDATE stock SET current_stock = ?, updated_at = CURRENT_TIMESTAMP WHERE item_id = ?',
            [nextStock, item.item_id]
          );
        } else {
          await connection.query(
            `INSERT INTO stock (item_id, sku, current_stock, min_stock, cost_price, selling_price)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              item.item_id,
              stockRows[0].sku || '',
              nextStock,
              Number(stockRows[0].min_stock) || 0,
              Number(stockRows[0].cost) || 0,
              Number(stockRows[0].price) || 0
            ]
          );
        }
      }
    }

    await connection.query(
      'UPDATE purchase_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, id]
    );

    await connection.commit();

    res.json({ success: true, id, status });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    connection.release();
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
      // Save current stock to previous_stock BEFORE updating
      await savePreviousStock(item.item_id, item.stock);
      
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

// GLOBAL SEARCH - Search across ALL purchase orders without pagination limit
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q || q.trim().length < 1) {
      return res.status(400).json({ error: 'Search query is required' });
    }
    
    const searchTerm = `%${q.trim()}%`;
    const searchTermExact = q.trim();
    
    console.log('🔍 Global purchase orders search for:', q);
    
    // Search across all purchase orders with their items and suppliers - NO LIMIT
    const [orders] = await pool.query(`
      SELECT DISTINCT po.*, s.name as supplier_name, s.phone as supplier_phone
      FROM purchase_orders po
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      LEFT JOIN purchase_order_items poi ON po.id = poi.purchase_order_id
      LEFT JOIN items i ON poi.item_id = i.id
      WHERE 
        po.po_number LIKE ?
        OR s.name LIKE ?
        OR s.phone LIKE ?
        OR i.name LIKE ?
        OR i.sku LIKE ?
        OR po.id = ?
      ORDER BY po.created_at DESC
    `, [searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, parseInt(searchTermExact) || 0]);
    
    console.log(`✅ Found ${orders.length} purchase orders matching "${q}"`);
    
    // Get items and additional details for each order
    const ordersWithDetails = [];
    for (const order of orders) {
      // Get purchase order items
      const [items] = await pool.query(`
        SELECT poi.*, i.name as item_name, i.sku, i.category_id, i.price, i.cost 
        FROM purchase_order_items poi 
        LEFT JOIN items i ON poi.item_id = i.id 
        WHERE poi.purchase_order_id = ?
      `, [order.id]);

      // Get supplier details
      let supplier = null;
      if (order.supplier_id) {
        const [suppliers] = await pool.query('SELECT * FROM suppliers WHERE id = ?', [order.supplier_id]);
        supplier = suppliers[0] || null;
      }

      // Get debt balance if purchase is on credit
      let total_paid = 0;
      let balance = 0;
      let debt_status = null;
      
      if (order.payment_status === 'on_credit' && order.debt_id) {
        const [[debtInfo]] = await pool.query(`
          SELECT 
            d.status as debt_status,
            COALESCE(SUM(di.amount), 0) as total_paid,
            (d.amount - COALESCE(SUM(di.amount), 0)) as balance
          FROM debts d
          LEFT JOIN debt_installments di ON d.id = di.debt_id
          WHERE d.id = ?
          GROUP BY d.id
        `, [order.debt_id]);
        
        if (debtInfo) {
          debt_status = debtInfo.debt_status;
          total_paid = parseFloat(debtInfo.total_paid) || 0;
          balance = parseFloat(debtInfo.balance) || 0;
        }
      }
      
      ordersWithDetails.push({
        ...order,
        supplier,
        items,
        total_paid,
        balance,
        debt_status
      });
    }
    
    res.json({
      data: ordersWithDetails,
      searchQuery: q,
      totalResults: ordersWithDetails.length,
      isSearchResult: true
    });
  } catch (error) {
    console.error('❌ Purchase orders search error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
