const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { logActivity } = require('../utils/activityLogger');
const { createAndSendNotification } = require('./notifications');

// Auto-migrate: Add previous_stock column to items table if it doesn't exist
(async () => {
  try {
    await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS previous_stock DECIMAL(15,3) DEFAULT 0`);
    // Initialize previous_stock with current stock for items that have 0
    await pool.query(`UPDATE items SET previous_stock = stock WHERE previous_stock = 0 OR previous_stock IS NULL`);
    console.log('✅ Items previous_stock column ready');
  } catch (err) {
    console.log('Items migration:', err.message);
  }
})();

// Helper function to save current stock to previous_stock BEFORE updating
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

// GET all sales
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 40;
    const offset = (page - 1) * limit;
    const dateFilter = req.query.dateFilter || 'today';
    
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
    
    // Get total count
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) as total FROM sales WHERE ${dateCondition}`);
    const totalPages = Math.ceil(total / limit);
    
    const [sales] = await pool.query(`SELECT * FROM sales WHERE ${dateCondition} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [limit, offset]);

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

      // Fetch client phone if client_id exists
      let client_phone = '';
      if (sale.client_id) {
        const [clients] = await pool.query('SELECT phone FROM clients WHERE id = ?', [sale.client_id]);
        if (clients.length > 0) {
          client_phone = clients[0].phone || '';
        }
      }

      const saleFinalAmount = Number(sale.final_amount) || 0;
      let paid_so_far = sale.status === 'Paid' ? saleFinalAmount : 0;
      let balance = Math.max(0, saleFinalAmount - paid_so_far);

      const [linkedDebts] = await pool.query(
        "SELECT id, amount FROM debts WHERE type = 'debtor' AND description = ? LIMIT 1",
        [`Sale #${sale.id}`]
      );

      if (linkedDebts.length > 0) {
        const debt = linkedDebts[0];
        const [[{ total_paid }]] = await pool.query(
          'SELECT COALESCE(SUM(amount), 0) as total_paid FROM debt_installments WHERE debt_id = ?',
          [debt.id]
        );
        const debtAmount = Number(debt.amount) || 0;
        paid_so_far = Number(total_paid) || 0;
        balance = Math.max(0, debtAmount - paid_so_far);
      }

      salesWithItems.push({
        ...sale,
        client_phone,
        items,
        paid_so_far,
        balance
      });
    }

    // Calculate total stats for the filtered period
    console.log('📊 Sales - Date filter:', dateFilter);
    console.log('📊 Sales - Calculating stats with condition:', dateCondition);
    
    // Build date condition for joined queries (replace 'date' with 's.date')
    const joinedDateCondition = dateCondition.replace(/DATE\(date\)/g, 'DATE(s.date)').replace(/MONTH\(date\)/g, 'MONTH(s.date)').replace(/YEAR\(date\)/g, 'YEAR(s.date)');
    console.log('📊 Sales - Joined date condition:', joinedDateCondition);
    
    // Get total sales and total value
    const [statsRows] = await pool.query(`
      SELECT 
        COUNT(*) as totalOrders,
        COALESCE(SUM(final_amount), 0) as totalValue
      FROM sales 
      WHERE ${dateCondition}
    `);
    
    // Get total items quantity
    const [itemsRows] = await pool.query(`
      SELECT COALESCE(SUM(si.quantity), 0) as totalItems
      FROM sale_items si 
      INNER JOIN sales s ON si.sale_id = s.id
      WHERE ${joinedDateCondition}
    `);
    
    // Get total cost (sum of item_cost * quantity for all items in the period)
    const [costRows] = await pool.query(`
      SELECT COALESCE(SUM(si.quantity * COALESCE(i.cost, 0)), 0) as totalCost
      FROM sale_items si
      INNER JOIN sales s ON si.sale_id = s.id
      LEFT JOIN items i ON si.item_id = i.id
      WHERE ${joinedDateCondition}
    `);
    
    const totalStats = {
      totalOrders: statsRows[0].totalOrders,
      totalValue: statsRows[0].totalValue,
      totalItems: itemsRows[0].totalItems,
      totalCost: costRows[0].totalCost
    };
    console.log('📈 Sales - Total stats result:', totalStats);
    console.log('📈 Sales - Calculated profit (totalValue - totalCost):', parseFloat(totalStats.totalValue) - parseFloat(totalStats.totalCost));

    res.json({
      data: salesWithItems,
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
          totalItems: parseInt(totalStats.totalItems) || 0,
          totalCost: parseFloat(totalStats.totalCost) || 0
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE sale
router.post('/', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const userId = req.headers['x-user-id'];
    const { client_id, payment_method, status = 'Paid', total_amount, discount = 0, final_amount, items, paid_amount, sale_type = 'retail' } = req.body;
    if (!payment_method) return res.status(400).json({ error: 'Payment method is required' });
    if (total_amount === undefined) return res.status(400).json({ error: 'Total amount is required' });
    if (final_amount === undefined) return res.status(400).json({ error: 'Final amount is required' });
    if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'Items are required' });

    // Get client name
    let client_name = 'Walk-in Customer';
    let client_phone = '';
    let client_email = '';
    if (client_id) {
      const [clients] = await connection.query('SELECT name, phone, email FROM clients WHERE id = ?', [client_id]);
      if (clients.length > 0) {
        client_name = clients[0].name;
        client_phone = clients[0].phone || '';
        client_email = clients[0].email || '';
      }
    }

    const normalizedFinalAmount = Number(final_amount) || 0;
    const rawPaidAmount = paid_amount === undefined || paid_amount === null
      ? (status === 'Paid' ? normalizedFinalAmount : 0)
      : Number(paid_amount);
    const normalizedPaidAmount = Math.max(0, Math.min(normalizedFinalAmount, Number.isFinite(rawPaidAmount) ? rawPaidAmount : 0));
    const normalizedStatus = normalizedPaidAmount >= normalizedFinalAmount ? 'Paid' : 'Partial';
    const remainingAmount = Math.max(0, normalizedFinalAmount - normalizedPaidAmount);

    // Create sale record
    const [result] = await connection.query(
      'INSERT INTO sales (date, client_id, client_name, items_count, payment_method, total_amount, discount, final_amount, status, sale_type) VALUES (CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [client_id || null, client_name, items.length, payment_method, total_amount, discount, normalizedFinalAmount, normalizedStatus, sale_type || 'retail']
    );

    const saleId = result.insertId;

    // ⚡ OPTIMIZED: Fetch all item details FIRST (1 query instead of N queries)
    const itemIds = items.map(i => i.item_id);
    const [allItemDetails] = await connection.query(
      `SELECT id, name, stock, price FROM items WHERE id IN (${itemIds.map(() => '?').join(',')})`,
      itemIds
    );
    
    // Create a map for quick lookup
    const itemDetailsMap = new Map(allItemDetails.map(item => [item.id, item]));

    // Insert sale items and update stock
    let priceUpdates = [];
    let stockUpdates = [];
    let priceUpdatesData = [];
    
    for (const item of items) {
      const itemDetail = itemDetailsMap.get(item.item_id);
      if (!itemDetail) continue;

      const itemName = itemDetail.name;
      const currentStock = itemDetail.stock;
      const currentPrice = itemDetail.price;
      const newStock = Math.max(0, currentStock - item.quantity);
      const totalPrice = item.quantity * item.unit_price;

      // Insert sale item
      await connection.query(
        'INSERT INTO sale_items (sale_id, item_id, item_name, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?, ?)',
        [saleId, item.item_id, itemName, item.quantity, item.unit_price, totalPrice]
      );

      // Collect all stock updates to batch execute
      stockUpdates.push({
        itemId: item.item_id,
        newStock: newStock,
        previousStock: currentStock
      });

      // Collect price updates if changed
      if (item.unit_price !== currentPrice) {
        priceUpdates.push({ itemName, oldPrice: currentPrice, newPrice: item.unit_price });
        priceUpdatesData.push({
          itemId: item.item_id,
          newPrice: item.unit_price
        });
      }
    }

    // ⚡ BATCH UPDATE ALL STOCK AT ONCE (instead of per-item)
    for (const update of stockUpdates) {
      await connection.query(
        'UPDATE items SET stock = ?, previous_stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [update.newStock, update.previousStock, update.itemId]
      );
      await connection.query(
        'UPDATE stock SET current_stock = ?, updated_at = CURRENT_TIMESTAMP WHERE item_id = ?',
        [update.newStock, update.itemId]
      );
    }

    // ⚡ BATCH UPDATE ALL PRICES AT ONCE (instead of per-item)
    for (const priceUpdate of priceUpdatesData) {
      console.log(`🔄 Batch updating price for item ${priceUpdate.itemId}: ${priceUpdate.newPrice}`);
      await connection.query(
        'UPDATE items SET price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [priceUpdate.newPrice, priceUpdate.itemId]
      );
    }

    // Create debtor record + initial installment (payment history) for partial/loan sales
    let debtId = null;
    if (remainingAmount > 0 && client_id) {
      const due = new Date();
      due.setDate(due.getDate() + 30);
      const dueDate = due.toISOString().split('T')[0];

      const debtDescription = `Sale #${saleId}`;
      const [debtResult] = await connection.query(
        'INSERT INTO debts (type, person, amount, date, due_date, description, status, phone, email) VALUES (?, ?, ?, CURDATE(), ?, ?, ?, ?, ?)',
        ['debtor', client_name, normalizedFinalAmount, dueDate, debtDescription, 'pending', client_phone, client_email]
      );
      debtId = debtResult.insertId;

      if (normalizedPaidAmount > 0) {
        await connection.query(
          'INSERT INTO debt_installments (debt_id, amount, payment_date, notes) VALUES (?, ?, CURDATE(), ?)',
          [debtId, normalizedPaidAmount, `Initial payment for Sale #${saleId}`]
        );
      }
    }

    await connection.commit();

    // ⚡ FIRE-AND-FORGET: Log activity async without blocking API response
    // This was causing 5-minute delays by querying ALL superadmins and their settings
    if (userId) {
      console.log(`📝 Queuing sale activity for async logging (user ${userId})`);
      
      // Main sale activity - fire and forget
      logActivity({
        userId: parseInt(userId),
        actionType: 'create',
        entityType: 'sale',
        entityId: saleId,
        entityName: `Sale #${saleId}`,
        description: `yagurishije FRW ${normalizedFinalAmount.toLocaleString()} kuri ${client_name}`,
        metadata: { final_amount: normalizedFinalAmount, status: normalizedStatus, items_count: items.length, payment_method, client_name }
      }).catch(err => console.error('Activity logging error:', err));

      // Log price updates if any - fire and forget
      if (priceUpdates.length > 0) {
        for (const update of priceUpdates) {
          // Find the item ID for this update
          const soldItem = items.find(item => item.unit_price === update.newPrice);
          const itemId = soldItem ? soldItem.item_id : null;
          
          logActivity({
            userId: parseInt(userId),
            actionType: 'update',
            entityType: 'item',
            entityId: itemId,
            entityName: update.itemName,
            description: `yahinduriye ibiciro bya "${update.itemName}" kuri FRW ${update.newPrice.toLocaleString()}`,
            metadata: { 
              oldPrice: update.oldPrice, 
              newPrice: update.newPrice, 
              saleId: saleId,
              updatedDuringSale: true
            }
          }).catch(err => console.error('Activity logging error:', err));
        }
      }
    } else {
      console.log('⚠️ No userId provided for sale activity logging');
    }

    // ⚡ FIRE-AND-FORGET: Create notification async without blocking API response
    if (userId) {
      createAndSendNotification({
        type: 'sale',
        title: 'Ibyagurishijwe',
        message: `${client_name} yagurishijwe ibicuruzwa bya FRW ${final_amount.toLocaleString()}`,
        userId: parseInt(userId),
        targetRole: 'superadmin',
        entityId: saleId,
        entityType: 'sale'
      }).catch(err => console.error('Notification error:', err));
    }

    // Build sale items response from data we already have in memory (no extra query needed!)
    const saleItems = items.map((item, index) => ({
      id: index + 1, // Temporary ID for response
      sale_id: saleId,
      item_id: item.item_id,
      item_name: item.item_name || '',
      quantity: item.quantity,
      unit_price: item.unit_price,
      total_price: item.quantity * item.unit_price
    }));

    res.json({
      id: saleId,
      client_name,
      client_id,
      payment_method,
      status: normalizedStatus,
      total_amount,
      discount,
      final_amount: normalizedFinalAmount,
      date: new Date().toISOString().split('T')[0],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      items_count: items.length,
      paid_amount: normalizedPaidAmount,
      remaining_amount: remainingAmount,
      debt_id: debtId,
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
    await connection.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    connection.release();
  }
});

// UPDATE sale status
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || (status !== 'Paid' && status !== 'Partial')) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    await pool.query('UPDATE sales SET status = ? WHERE id = ?', [status, id]);

    // Sync linked debt(s) created from this sale
    const saleId = parseInt(id);
    if (!Number.isNaN(saleId)) {
      const [linkedDebts] = await pool.query(
        "SELECT id, amount FROM debts WHERE type = 'debtor' AND description = ?",
        [`Sale #${saleId}`]
      );

      for (const debt of linkedDebts) {
        const [[{ total_paid }]] = await pool.query(
          'SELECT COALESCE(SUM(amount), 0) as total_paid FROM debt_installments WHERE debt_id = ?',
          [debt.id]
        );
        const debtAmount = Number(debt.amount) || 0;
        const paid = Number(total_paid) || 0;
        const balance = Math.max(0, debtAmount - paid);

        if (status === 'Paid') {
          if (balance > 0) {
            await pool.query(
              'INSERT INTO debt_installments (debt_id, amount, payment_date, notes) VALUES (?, ?, CURDATE(), ?)',
              [debt.id, balance, `Auto close from Sale #${saleId} marked Paid`]
            );
          }
          await pool.query(
            "UPDATE debts SET status = 'paid', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [debt.id]
          );
        } else {
          const computedStatus = paid >= debtAmount ? 'paid' : 'pending';
          await pool.query(
            'UPDATE debts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [computedStatus, debt.id]
          );
        }
      }
    }

    res.json({ success: true, id, status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/sales/:id/items — fetch itemized sale details
router.get('/:id/items', async (req, res) => {
  try {
    const saleId = parseInt(req.params.id);
    if (isNaN(saleId)) return res.status(400).json({ error: 'Invalid sale ID' });

    const [items] = await pool.query(
      `SELECT
        si.id,
        si.item_id,
        i.name AS item_name,
        si.quantity,
        si.unit_price,
        (si.quantity * si.unit_price) AS subtotal
       FROM sale_items si
       JOIN items i ON i.id = si.item_id
       WHERE si.sale_id = ?
       ORDER BY si.id ASC`,
      [saleId]
    );

    res.json({ saleId, items });
  } catch (err) {
    console.error('Error fetching sale items:', err);
    res.status(500).json({ error: 'Failed to fetch sale items' });
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
        description: `yasibye sale record #${id} ya FRW ${saleInfo[0].final_amount?.toLocaleString() || 0}`,
        metadata: { final_amount: saleInfo[0].final_amount, client_name: saleInfo[0].client_name }
      });
    }

    res.json({ success: true, id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
