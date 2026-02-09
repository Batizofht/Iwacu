const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// Get all kitchen items with their stock status
router.get('/', async (req, res) => {
  try {
    const [items] = await pool.query(`
      SELECT 
        k.*,
        COALESCE(SUM(km.quantity_change), 0) as total_movements,
        CASE 
          WHEN k.current_stock <= k.min_stock THEN 'low'
          WHEN k.current_stock <= k.min_stock * 2 THEN 'medium'
          ELSE 'good'
        END as stock_status
      FROM kitchen_items k
      LEFT JOIN kitchen_movements km ON k.id = km.kitchen_item_id
      WHERE k.status = 'active'
      GROUP BY k.id
      ORDER BY k.name ASC
    `);
    res.json({ success: true, data: items });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get kitchen stock summary
router.get('/summary', async (req, res) => {
  try {
    const [[summary]] = await pool.query(`
      SELECT 
        COUNT(*) as total_items,
        COALESCE(SUM(current_stock), 0) as total_stock,
        COALESCE(SUM(current_stock * unit_cost), 0) as total_value,
        COUNT(CASE WHEN current_stock <= min_stock THEN 1 END) as low_stock_count,
        COUNT(CASE WHEN current_stock = 0 THEN 1 END) as out_of_stock_count
      FROM kitchen_items
      WHERE status = 'active'
    `);

    const [categoryBreakdown] = await pool.query(`
      SELECT 
        category,
        COUNT(*) as items_count,
        COALESCE(SUM(current_stock), 0) as total_stock,
        COALESCE(SUM(current_stock * unit_cost), 0) as total_value
      FROM kitchen_items
      WHERE status = 'active'
      GROUP BY category
      ORDER BY total_value DESC
    `);

    res.json({ 
      success: true, 
      summary: {
        total_items: Number(summary.total_items || 0),
        total_stock: Number(summary.total_stock || 0),
        total_value: Number(summary.total_value || 0),
        low_stock_count: Number(summary.low_stock_count || 0),
        out_of_stock_count: Number(summary.out_of_stock_count || 0)
      },
      categoryBreakdown 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get single kitchen item
router.get('/:id', async (req, res) => {
  try {
    const [[item]] = await pool.query(
      'SELECT * FROM kitchen_items WHERE id = ?',
      [req.params.id]
    );
    if (!item) {
      return res.status(404).json({ success: false, error: 'Item not found' });
    }
    res.json({ success: true, data: item });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create kitchen item
router.post('/', async (req, res) => {
  try {
    const { 
      name, 
      category, 
      unit, 
      current_stock, 
      min_stock, 
      unit_cost,
      description,
      supplier_name
    } = req.body;

    if (!name || !category || !unit) {
      return res.status(400).json({ success: false, error: 'Name, category, and unit are required' });
    }

    const [result] = await pool.query(
      `INSERT INTO kitchen_items 
        (name, category, unit, current_stock, min_stock, unit_cost, description, supplier_name, status, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW())`,
      [name, category, unit, current_stock || 0, min_stock || 5, unit_cost || 0, description || '', supplier_name || '']
    );

    const [[newItem]] = await pool.query('SELECT * FROM kitchen_items WHERE id = ?', [result.insertId]);

    res.json({ success: true, data: newItem });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update kitchen item
router.put('/:id', async (req, res) => {
  try {
    const { 
      name, 
      category, 
      unit, 
      current_stock, 
      min_stock, 
      unit_cost,
      description,
      supplier_name,
      status
    } = req.body;

    await pool.query(
      `UPDATE kitchen_items SET 
        name = COALESCE(?, name),
        category = COALESCE(?, category),
        unit = COALESCE(?, unit),
        current_stock = COALESCE(?, current_stock),
        min_stock = COALESCE(?, min_stock),
        unit_cost = COALESCE(?, unit_cost),
        description = COALESCE(?, description),
        supplier_name = COALESCE(?, supplier_name),
        status = COALESCE(?, status),
        updated_at = NOW()
       WHERE id = ?`,
      [name, category, unit, current_stock, min_stock, unit_cost, description, supplier_name, status, req.params.id]
    );

    const [[updatedItem]] = await pool.query('SELECT * FROM kitchen_items WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: updatedItem });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stock In - Add stock to kitchen item
router.post('/:id/stock-in', async (req, res) => {
  try {
    const { quantity, unit_cost, notes, supplier_name } = req.body;
    const itemId = req.params.id;

    if (!quantity || quantity <= 0) {
      return res.status(400).json({ success: false, error: 'Valid quantity is required' });
    }

    // Update current stock
    await pool.query(
      'UPDATE kitchen_items SET current_stock = current_stock + ?, unit_cost = COALESCE(?, unit_cost), supplier_name = COALESCE(?, supplier_name), updated_at = NOW() WHERE id = ?',
      [quantity, unit_cost, supplier_name, itemId]
    );

    // Record movement
    await pool.query(
      `INSERT INTO kitchen_movements (kitchen_item_id, movement_type, quantity_change, unit_cost, notes, created_at)
       VALUES (?, 'stock_in', ?, ?, ?, NOW())`,
      [itemId, quantity, unit_cost || 0, notes || '']
    );

    const [[updatedItem]] = await pool.query('SELECT * FROM kitchen_items WHERE id = ?', [itemId]);
    res.json({ success: true, data: updatedItem, message: 'Stock added successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stock Out - Use stock from kitchen (consumption)
router.post('/:id/stock-out', async (req, res) => {
  try {
    const { quantity, notes, used_for } = req.body;
    const itemId = req.params.id;

    if (!quantity || quantity <= 0) {
      return res.status(400).json({ success: false, error: 'Valid quantity is required' });
    }

    // Check available stock
    const [[item]] = await pool.query('SELECT current_stock FROM kitchen_items WHERE id = ?', [itemId]);
    if (!item) {
      return res.status(404).json({ success: false, error: 'Item not found' });
    }
    if (item.current_stock < quantity) {
      return res.status(400).json({ success: false, error: `Not enough stock. Available: ${item.current_stock}` });
    }

    // Update current stock
    await pool.query(
      'UPDATE kitchen_items SET current_stock = current_stock - ?, updated_at = NOW() WHERE id = ?',
      [quantity, itemId]
    );

    // Record movement
    await pool.query(
      `INSERT INTO kitchen_movements (kitchen_item_id, movement_type, quantity_change, notes, used_for, created_at)
       VALUES (?, 'stock_out', ?, ?, ?, NOW())`,
      [itemId, -quantity, notes || '', used_for || 'General consumption']
    );

    const [[updatedItem]] = await pool.query('SELECT * FROM kitchen_items WHERE id = ?', [itemId]);
    res.json({ success: true, data: updatedItem, message: 'Stock used successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get stock movements history
router.get('/:id/movements', async (req, res) => {
  try {
    const [movements] = await pool.query(
      `SELECT * FROM kitchen_movements 
       WHERE kitchen_item_id = ? 
       ORDER BY created_at DESC 
       LIMIT 100`,
      [req.params.id]
    );
    res.json({ success: true, data: movements });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all movements (for reports)
router.get('/movements/all', async (req, res) => {
  try {
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;

    let where = '';
    const params = [];

    if (startDate) {
      where += ' AND DATE(km.created_at) >= ?';
      params.push(startDate);
    }
    if (endDate) {
      where += ' AND DATE(km.created_at) <= ?';
      params.push(endDate);
    }

    const [movements] = await pool.query(
      `SELECT km.*, ki.name as item_name, ki.category, ki.unit
       FROM kitchen_movements km
       JOIN kitchen_items ki ON km.kitchen_item_id = ki.id
       WHERE 1=1 ${where}
       ORDER BY km.created_at DESC
       LIMIT 500`,
      params
    );

    // Summary
    const [[inSummary]] = await pool.query(
      `SELECT COALESCE(SUM(quantity_change), 0) as total_in, COALESCE(SUM(quantity_change * unit_cost), 0) as total_cost
       FROM kitchen_movements km
       WHERE movement_type = 'stock_in' ${where}`,
      params
    );

    const [[outSummary]] = await pool.query(
      `SELECT COALESCE(ABS(SUM(quantity_change)), 0) as total_out
       FROM kitchen_movements km
       WHERE movement_type = 'stock_out' ${where}`,
      params
    );

    res.json({ 
      success: true, 
      data: movements,
      summary: {
        total_in: Number(inSummary?.total_in || 0),
        total_cost: Number(inSummary?.total_cost || 0),
        total_out: Number(outSummary?.total_out || 0)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Kitchen Report with date filtering
router.get('/report', async (req, res) => {
  try {
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;

    let dateWhere = '';
    const dateParams = [];

    if (startDate) {
      dateWhere += ' AND DATE(km.created_at) >= ?';
      dateParams.push(startDate);
    }
    if (endDate) {
      dateWhere += ' AND DATE(km.created_at) <= ?';
      dateParams.push(endDate);
    }

    // Current stock levels
    const [items] = await pool.query(`
      SELECT 
        k.*,
        CASE 
          WHEN k.current_stock <= k.min_stock THEN 'low'
          WHEN k.current_stock <= k.min_stock * 2 THEN 'medium'
          ELSE 'good'
        END as stock_status
      FROM kitchen_items k
      WHERE k.status = 'active'
      ORDER BY k.category, k.name
    `);

    // Stock movements in date range
    const [movements] = await pool.query(
      `SELECT km.*, ki.name as item_name, ki.category, ki.unit
       FROM kitchen_movements km
       JOIN kitchen_items ki ON km.kitchen_item_id = ki.id
       WHERE 1=1 ${dateWhere}
       ORDER BY km.created_at DESC`,
      dateParams
    );

    // Summary for date range
    const [[stockInSummary]] = await pool.query(
      `SELECT 
        COUNT(*) as transactions,
        COALESCE(SUM(quantity_change), 0) as total_quantity,
        COALESCE(SUM(quantity_change * unit_cost), 0) as total_cost
       FROM kitchen_movements km
       WHERE movement_type = 'stock_in' ${dateWhere}`,
      dateParams
    );

    const [[stockOutSummary]] = await pool.query(
      `SELECT 
        COUNT(*) as transactions,
        COALESCE(ABS(SUM(quantity_change)), 0) as total_quantity
       FROM kitchen_movements km
       WHERE movement_type = 'stock_out' ${dateWhere}`,
      dateParams
    );

    // Usage breakdown by purpose
    const [usageByPurpose] = await pool.query(
      `SELECT 
        COALESCE(used_for, 'General') as purpose,
        COUNT(*) as transactions,
        COALESCE(ABS(SUM(quantity_change)), 0) as total_used
       FROM kitchen_movements km
       WHERE movement_type = 'stock_out' ${dateWhere}
       GROUP BY used_for
       ORDER BY total_used DESC`,
      dateParams
    );

    // Current totals
    const [[currentTotals]] = await pool.query(`
      SELECT 
        COUNT(*) as total_items,
        COALESCE(SUM(current_stock), 0) as total_stock,
        COALESCE(SUM(current_stock * unit_cost), 0) as total_value,
        COUNT(CASE WHEN current_stock <= min_stock THEN 1 END) as low_stock_count,
        COUNT(CASE WHEN current_stock = 0 THEN 1 END) as out_of_stock_count
      FROM kitchen_items
      WHERE status = 'active'
    `);

    res.json({
      success: true,
      items,
      movements,
      stockIn: {
        transactions: Number(stockInSummary?.transactions || 0),
        total_quantity: Number(stockInSummary?.total_quantity || 0),
        total_cost: Number(stockInSummary?.total_cost || 0)
      },
      stockOut: {
        transactions: Number(stockOutSummary?.transactions || 0),
        total_quantity: Number(stockOutSummary?.total_quantity || 0)
      },
      usageByPurpose,
      currentTotals: {
        total_items: Number(currentTotals?.total_items || 0),
        total_stock: Number(currentTotals?.total_stock || 0),
        total_value: Number(currentTotals?.total_value || 0),
        low_stock_count: Number(currentTotals?.low_stock_count || 0),
        out_of_stock_count: Number(currentTotals?.out_of_stock_count || 0)
      },
      dateRange: { startDate, endDate }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete kitchen item (soft delete)
router.delete('/:id', async (req, res) => {
  try {
    await pool.query(
      "UPDATE kitchen_items SET status = 'deleted', updated_at = NOW() WHERE id = ?",
      [req.params.id]
    );
    res.json({ success: true, message: 'Item deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Kitchen categories
router.get('/categories/list', async (req, res) => {
  try {
    const [categories] = await pool.query(
      `SELECT DISTINCT category, COUNT(*) as items_count 
       FROM kitchen_items 
       WHERE status = 'active' 
       GROUP BY category 
       ORDER BY category`
    );
    res.json({ success: true, data: categories });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
