const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// Search categories for reports
router.get('/search-categories', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.json({ data: [] });
    }

    const [rows] = await pool.query(`
      SELECT 
        c.id,
        c.name,
        c.description,
        c.items_count
      FROM categories c
      WHERE c.status = 'active'
      AND (
        c.name LIKE ? OR
        c.description LIKE ?
      )
      ORDER BY c.name
      LIMIT 20
    `, [`%${q}%`, `%${q}%`]);

    res.json({ data: rows });
  } catch (error) {
    console.error('Search categories error:', error);
    res.status(500).json({ error: 'Failed to search categories' });
  }
});

// Get category report with date filtering
router.get('/category/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { startDate, endDate } = req.query;
    
    // Get category info
    const [categoryRows] = await pool.query(`
      SELECT 
        c.id,
        c.name,
        c.description,
        c.items_count
      FROM categories c
      WHERE c.id = ?
    `, [id]);

    if (categoryRows.length === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const category = categoryRows[0];

    // Build date filter
    let dateFilter = '';
    if (startDate && endDate) {
      dateFilter = `AND (s.date BETWEEN '${startDate}' AND '${endDate}')`;
    }

    // Get sales data for this category
    const [salesRows] = await pool.query(`
      SELECT 
        COUNT(DISTINCT s.id) as total_sales,
        COALESCE(SUM(si.quantity), 0) as total_quantity,
        COALESCE(SUM(si.quantity * si.unit_price), 0) as total_revenue
      FROM sales s
      JOIN sale_items si ON s.id = si.sale_id
      JOIN items i ON si.item_id = i.id
      WHERE i.category_id = ?
      AND s.status = 'Paid'
      ${dateFilter}
    `, [id]);

    // Get purchase data for this category
    const [purchaseRows] = await pool.query(`
      SELECT 
        COUNT(DISTINCT po.id) as purchase_count,
        COALESCE(SUM(pi.quantity), 0) as total_purchased,
        COALESCE(SUM(pi.quantity * pi.unit_price), 0) as total_cost
      FROM purchase_orders po
      JOIN purchase_order_items pi ON po.id = pi.purchase_order_id
      JOIN items i ON pi.item_id = i.id
      WHERE i.category_id = ?
      AND (po.status = 'received' OR po.status = 'completed')
      ${dateFilter ? dateFilter.replace('s.date', 'po.date') : ''}
    `, [id]);

    // Get current stock for this category
    const [stockRows] = await pool.query(`
      SELECT COALESCE(SUM(i.stock), 0) as total_stock
      FROM items i
      WHERE i.category_id = ?
      AND i.status = 'active'
    `, [id]);

    // Get items in this category with their data
    const [itemsRows] = await pool.query(`
      SELECT 
        i.id,
        i.name,
        i.sku,
        i.stock as current_stock,
        COALESCE(sales_data.total_sold, 0) as total_sold,
        COALESCE(sales_data.sales_revenue, 0) as sales_revenue,
        COALESCE(purchases_data.total_purchased, 0) as total_purchased,
        COALESCE(purchases_data.purchase_cost, 0) as purchase_cost
      FROM items i
      LEFT JOIN (
        SELECT 
          si.item_id,
          COALESCE(SUM(si.quantity), 0) as total_sold,
          COALESCE(SUM(si.quantity * si.unit_price), 0) as sales_revenue
        FROM sales s
        JOIN sale_items si ON s.id = si.sale_id
        WHERE s.status = 'Paid'
        ${dateFilter}
        GROUP BY si.item_id
      ) sales_data ON i.id = sales_data.item_id
      LEFT JOIN (
        SELECT 
          pi.item_id,
          COALESCE(SUM(pi.quantity), 0) as total_purchased,
          COALESCE(SUM(pi.quantity * pi.unit_price), 0) as purchase_cost
        FROM purchase_orders po
        JOIN purchase_order_items pi ON po.id = pi.purchase_order_id
        WHERE (po.status = 'received' OR po.status = 'completed')
        ${dateFilter ? dateFilter.replace('s.date', 'po.date') : ''}
        GROUP BY pi.item_id
      ) purchases_data ON i.id = purchases_data.item_id
      WHERE i.category_id = ?
      AND i.status = 'active'
      ORDER BY i.name
    `, [id]);

    // Get daily breakdown
    let dailyQuery = `
      SELECT 
        DATE(s.date) as date,
        COALESCE(SUM(si.quantity), 0) as sales,
        COALESCE(SUM(si.quantity * si.unit_price), 0) as revenue,
        0 as purchases,
        0 as cost
      FROM sales s
      JOIN sale_items si ON s.id = si.sale_id
      JOIN items i ON si.item_id = i.id
      WHERE i.category_id = ?
      AND s.status = 'Paid'
      ${dateFilter}
      GROUP BY DATE(s.date)
    `;
    
    let dailyData = await pool.query(dailyQuery, [id]);

    // Get purchase daily data
    let purchaseDailyQuery = `
      SELECT 
        DATE(po.date) as date,
        0 as sales,
        0 as revenue,
        COALESCE(SUM(pi.quantity), 0) as purchases,
        COALESCE(SUM(pi.quantity * pi.unit_price), 0) as cost
      FROM purchase_orders po
      JOIN purchase_order_items pi ON po.id = pi.purchase_order_id
      JOIN items i ON pi.item_id = i.id
      WHERE i.category_id = ?
      AND (po.status = 'received' OR po.status = 'completed')
      ${dateFilter ? dateFilter.replace('s.date', 'po.date') : ''}
      GROUP BY DATE(po.date)
    `;
    
    let purchaseDailyData = await pool.query(purchaseDailyQuery, [id]);

    // Combine daily data
    const dailyMap = new Map();
    
    [...dailyData[0], ...purchaseDailyData[0]].forEach(row => {
      const date = row.date.toISOString().split('T')[0];
      if (dailyMap.has(date)) {
        const existing = dailyMap.get(date);
        dailyMap.set(date, {
          date,
          sales: existing.sales + row.sales,
          purchases: existing.purchases + row.purchases,
          revenue: existing.revenue + row.revenue,
          cost: existing.cost + row.cost
        });
      } else {
        dailyMap.set(date, row);
      }
    });

    const dailyDataArray = Array.from(dailyMap.values()).sort((a, b) => 
      new Date(b.date) - new Date(a.date)
    );

    const salesData = salesRows[0] || {};
    const purchaseData = purchaseRows[0] || {};
    const stockData = stockRows[0] || {};

    // Calculate profit
    const totalCost = itemsRows.reduce((sum, item) => {
      return sum + (item.total_sold * (item.sales_revenue / Math.max(1, item.total_sold) - item.purchase_cost / Math.max(1, item.total_purchased)));
    }, 0);

    const report = {
      category_id: category.id,
      category_name: category.name,
      total_sold: salesData.total_quantity || 0,
      total_purchased: purchaseData.total_purchased || 0,
      sales_revenue: salesData.total_revenue || 0,
      purchase_cost: purchaseData.total_cost || 0,
      current_stock: stockData.total_stock || 0,
      profit: (salesData.total_revenue || 0) - totalCost,
      items: itemsRows.map(item => ({
        ...item,
        profit: (item.sales_revenue || 0) - (item.total_sold * (item.purchase_cost / Math.max(1, item.total_purchased)))
      })),
      daily_data: dailyDataArray
    };

    res.json({ data: report });
  } catch (error) {
    console.error('Category report error:', error);
    res.status(500).json({ error: 'Failed to get category report' });
  }
});

module.exports = router;
