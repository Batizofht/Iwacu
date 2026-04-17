const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// GET all stock with details
router.get('/', async (req, res) => {
  try {
    // First, get the overall profit from sales (to match Daily.tsx calculation)
    // Get total revenue from sales
    const [[revenueStats]] = await pool.query(`
      SELECT COALESCE(SUM(final_amount), 0) as totalRevenue
      FROM sales
    `);
    
    // Get total cost from sale items
    const [[costStats]] = await pool.query(`
      SELECT COALESCE(SUM(si.quantity * COALESCE(i.cost, 0)), 0) as totalCost
      FROM sale_items si
      LEFT JOIN items i ON si.item_id = i.id
    `);
    
    const overallProfit = (revenueStats.totalRevenue || 0) - (costStats.totalCost || 0);
    
    const [stock] = await pool.query(`
      SELECT
        i.id,
        i.name AS item,
        i.sku,
        i.cost,
        i.price,
        COALESCE(c.name, '') AS category,
        COALESCE(s.current_stock, i.stock, 0) AS current_stock,
        COALESCE(i.min_stock, 0) AS min_stock,
        CASE
            WHEN COALESCE(s.current_stock, i.stock, 0) <= 0
            THEN 'Out of Stock'
            WHEN COALESCE(s.current_stock, i.stock, 0) <= COALESCE(i.min_stock, 0)
            THEN 'Low Stock'
            ELSE 'In Stock'
        END AS stock_status,
        COALESCE((
            SELECT SUM(si.quantity)
            FROM sale_items si
            JOIN sales sa ON si.sale_id = sa.id
            WHERE si.item_id = i.id
            AND DATE_FORMAT(sa.date, '%Y-%m') = DATE_FORMAT(NOW(), '%Y-%m')
        ), 0) AS sold_this_month,
        COALESCE((
          SELECT SUM(si.quantity * si.unit_price)
          FROM sale_items si
          JOIN sales sa ON si.sale_id = sa.id
          WHERE si.item_id = i.id
        ), 0) AS total_money_sold,
        COALESCE((
          SELECT SUM(si.quantity * si.unit_price)
          FROM sale_items si
          WHERE si.item_id = i.id
        ), 0)
        -
        (COALESCE((
          SELECT SUM(si.quantity) 
          FROM sale_items si
          WHERE si.item_id = i.id
        ), 0) * COALESCE(i.cost, 0))
        AS revenue,
        COALESCE((
            SELECT SUM(poi.quantity)
            FROM purchase_order_items poi
            JOIN purchase_orders po ON poi.purchase_order_id = po.id
            WHERE poi.item_id = i.id AND po.status = 'pending'
        ), 0) AS incoming_stock,
        COALESCE(s.current_stock, i.stock, 0) * COALESCE(i.cost, 0) AS stock_value,
        i.status
      FROM items i
      LEFT JOIN categories c ON i.category_id = c.id
      LEFT JOIN stock s ON s.item_id = i.id
      WHERE i.status = 'active'
      ORDER BY i.name
    `);
    
    // Add the overall profit to the response
    res.json({
      items: stock,
      overallProfit: overallProfit
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
