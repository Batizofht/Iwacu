const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// Search products for reports
router.get('/search-products', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.json({ data: [] });
    }

    const [rows] = await pool.query(`
      SELECT 
        i.id,
        i.name,
        i.sku,
        i.price,
        i.stock,
        c.name as category
      FROM items i
      LEFT JOIN categories c ON i.category_id = c.id
      WHERE i.status = 'active'
      AND (
        i.name LIKE ? OR
        i.sku LIKE ?
      )
      ORDER BY i.name
      LIMIT 20
    `, [`%${q}%`, `%${q}%`]);

    res.json({ data: rows });
  } catch (error) {
    console.error('Search products error:', error);
    res.status(500).json({ error: 'Failed to search products' });
  }
});

// Get product report (sales and purchases) with date filtering
router.get('/product/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { startDate, endDate } = req.query;
    
    // Get product info
    const [productRows] = await pool.query(`
      SELECT 
        i.id,
        i.name,
        i.sku,
        i.price,
        i.stock,
        c.name as category
      FROM items i
      LEFT JOIN categories c ON i.category_id = c.id
      WHERE i.id = ?
    `, [id]);

    if (productRows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = productRows[0];

    // Build date filter
    let dateFilter = '';
    if (startDate && endDate) {
      dateFilter = `AND (s.date BETWEEN '${startDate}' AND '${endDate}')`;
    }

    // Get sales data for this product
    const [salesRows] = await pool.query(`
      SELECT 
        COUNT(*) as total_sold,
        COALESCE(SUM(si.quantity), 0) as total_quantity,
        COALESCE(SUM(si.quantity * si.unit_price), 0) as total_revenue
      FROM sales s
      JOIN sale_items si ON s.id = si.sale_id
      WHERE si.item_id = ?
      AND s.status = 'Paid'
      ${dateFilter}
    `, [id]);

    // Get purchase data for this product
    const [purchaseRows] = await pool.query(`
      SELECT 
        COUNT(*) as purchase_count,
        COALESCE(SUM(pi.quantity), 0) as total_purchased,
        COALESCE(SUM(pi.quantity * pi.unit_price), 0) as total_cost
      FROM purchase_orders po
      JOIN purchase_order_items pi ON po.id = pi.purchase_order_id
      WHERE pi.item_id = ?
      AND (po.status = 'received' OR po.status = 'completed')
      ${dateFilter ? dateFilter.replace('s.date', 'po.date') : ''}
    `, [id]);

    // Get current stock and previous_stock from items table
    const [stockRows] = await pool.query(`
      SELECT stock, COALESCE(previous_stock, stock) as previous_stock FROM items WHERE id = ?
    `, [id]);
    
    const previousStock = stockRows[0]?.previous_stock || 0;

    // Get recent sales
    const [recentSales] = await pool.query(`
      SELECT 
        s.date,
        s.created_at,
        si.quantity,
        si.quantity * si.unit_price as revenue
      FROM sales s
      JOIN sale_items si ON s.id = si.sale_id
      WHERE si.item_id = ?
      AND s.status = 'Paid'
      ${dateFilter}
      ORDER BY s.date DESC
      LIMIT 10
    `, [id]);

    // Get recent purchases
    const [recentPurchases] = await pool.query(`
      SELECT 
        po.date,
        po.created_at,
        pi.quantity,
        pi.quantity * pi.unit_price as cost
      FROM purchase_orders po
      JOIN purchase_order_items pi ON po.id = pi.purchase_order_id
      WHERE pi.item_id = ?
      AND (po.status = 'received' OR po.status = 'completed')
      ${dateFilter ? dateFilter.replace('s.date', 'po.date') : ''}
      ORDER BY po.date DESC
      LIMIT 10
    `, [id]);

    const salesData = salesRows[0] || {};
    const purchaseData = purchaseRows[0] || {};
    const stockData = stockRows[0] || {};

    // Get cost from items table for profit calculation
    const [itemCostRows] = await pool.query(`
      SELECT cost FROM items WHERE id = ?
    `, [id]);

    const itemCost = itemCostRows[0]?.cost || 0;
    const totalCost = salesData.total_quantity * itemCost;

    const report = {
      item_id: product.id,
      item_name: product.name,
      sku: product.sku,
      category: product.category,
      current_stock: stockRows[0]?.stock || 0,
      previous_stock: previousStock,
      total_sold: salesData.total_quantity || 0,
      sales_revenue: salesData.total_revenue || 0,
      total_purchased: purchaseData.total_purchased || 0,
      purchase_cost: purchaseData.total_cost || 0,
      profit: (salesData.total_revenue || 0) - totalCost,
      sales_data: recentSales,
      purchases_data: recentPurchases
    };

    res.json({ data: report });
  } catch (error) {
    console.error('Product report error:', error);
    res.status(500).json({ error: 'Failed to get product report' });
  }
});

module.exports = router;
