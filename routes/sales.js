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

    res.json(salesWithItems);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE sale
router.post('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { client_id, payment_method, status = 'Paid', total_amount, discount = 0, final_amount, items, paid_amount } = req.body;
    if (!payment_method) return res.status(400).json({ error: 'Payment method is required' });
    if (total_amount === undefined) return res.status(400).json({ error: 'Total amount is required' });
    if (final_amount === undefined) return res.status(400).json({ error: 'Final amount is required' });
    if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'Items are required' });

    // Get client name
    let client_name = 'Walk-in Customer';
    let client_phone = '';
    let client_email = '';
    if (client_id) {
      const [clients] = await pool.query('SELECT name, phone, email FROM clients WHERE id = ?', [client_id]);
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
    const [result] = await pool.query(
      'INSERT INTO sales (date, client_id, client_name, items_count, payment_method, total_amount, discount, final_amount, status) VALUES (CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?)',
      [client_id || null, client_name, items.length, payment_method, total_amount, discount, normalizedFinalAmount, normalizedStatus]
    );

    const saleId = result.insertId;

    // Insert sale items and update stock
    let priceUpdates = [];
    for (const item of items) {
      // Get item details
      const [itemDetails] = await pool.query('SELECT name, stock, price FROM items WHERE id = ?', [item.item_id]);
      if (itemDetails.length === 0) continue;

      const itemName = itemDetails[0].name;
      const currentStock = itemDetails[0].stock;
      const currentPrice = itemDetails[0].price;
      const newStock = Math.max(0, currentStock - item.quantity);
      const totalPrice = item.quantity * item.unit_price;

      // Insert sale item
      await pool.query(
        'INSERT INTO sale_items (sale_id, item_id, item_name, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?, ?)',
        [saleId, item.item_id, itemName, item.quantity, item.unit_price, totalPrice]
      );

      // Save current stock to previous_stock BEFORE updating
      await savePreviousStock(item.item_id, currentStock);

      // Update stock
      await pool.query(
        'UPDATE items SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [newStock, item.item_id]
      );

      // Update item price if it has changed (automatic price update feature)
      if (item.unit_price !== currentPrice) {
        console.log(`🔄 Updating price for item ${itemName} (ID: ${item.item_id}): ${currentPrice} -> ${item.unit_price}`);
        await pool.query(
          'UPDATE items SET price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [item.unit_price, item.item_id]
        );
        priceUpdates.push({ itemName, oldPrice: currentPrice, newPrice: item.unit_price });
      }
    }

    // Create debtor record + initial installment (payment history) for partial/loan sales
    let debtId = null;
    if (remainingAmount > 0 && client_id) {
      const due = new Date();
      due.setDate(due.getDate() + 30);
      const dueDate = due.toISOString().split('T')[0];

      const debtDescription = `Sale #${saleId}`;
      const [debtResult] = await pool.query(
        'INSERT INTO debts (type, person, amount, date, due_date, description, status, phone, email) VALUES (?, ?, ?, CURDATE(), ?, ?, ?, ?, ?)',
        ['debtor', client_name, normalizedFinalAmount, dueDate, debtDescription, 'pending', client_phone, client_email]
      );
      debtId = debtResult.insertId;

      if (normalizedPaidAmount > 0) {
        await pool.query(
          'INSERT INTO debt_installments (debt_id, amount, payment_date, notes) VALUES (?, ?, CURDATE(), ?)',
          [debtId, normalizedPaidAmount, `Initial payment for Sale #${saleId}`]
        );
      }
    }

    // Log activity
    if (userId) {
      console.log(`📝 Logging sale activity for user ${userId}`);
      
      // Main sale activity
      await logActivity({
        userId: parseInt(userId),
        actionType: 'create',
        entityType: 'sale',
        entityId: saleId,
        entityName: `Sale #${saleId}`,
        description: `yagurishije FRW ${normalizedFinalAmount.toLocaleString()} kuri ${client_name}`,
        metadata: { final_amount: normalizedFinalAmount, status: normalizedStatus, items_count: items.length, payment_method, client_name }
      });

      // Log price updates if any
      if (priceUpdates.length > 0) {
        for (const update of priceUpdates) {
          // Find the item ID for this update
          const soldItem = items.find(item => item.unit_price === update.newPrice);
          const itemId = soldItem ? soldItem.item_id : null;
          
          await logActivity({
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
          });
        }
      }
    } else {
      console.log('⚠️ No userId provided for sale activity logging');
    }

    // Create notification for sale (async, don't wait)
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
    res.status(500).json({ error: error.message });
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
