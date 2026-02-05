const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

const requireReportsPermission = async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return null;
  }

  const [users] = await pool.query('SELECT role, permissions, status FROM users WHERE id = ?', [userId]);
  if (users.length === 0) {
    res.status(401).json({ success: false, error: 'User not found' });
    return null;
  }

  const user = users[0];
  if (user.status !== 'active') {
    res.status(403).json({ success: false, error: 'User is not active' });
    return null;
  }

  if (user.role === 'superadmin') return user;

  try {
    const perms = typeof user.permissions === 'string' ? JSON.parse(user.permissions) : user.permissions;
    if (!perms?.reports) {
      res.status(403).json({ success: false, error: 'Access denied' });
      return null;
    }
    return user;
  } catch {
    res.status(403).json({ success: false, error: 'Access denied' });
    return null;
  }
};

const parseDate = (value) => {
  if (!value) return null;
  const s = String(value);
  // Expect YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
};

// Sales report (summary + top items)
router.get('/sales', async (req, res) => {
  try {
    const user = await requireReportsPermission(req, res);
    if (!user) return;

    const startDate = parseDate(req.query.startDate);
    const endDate = parseDate(req.query.endDate);
    const status = req.query.status ? String(req.query.status) : null;

    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10) || 20, 1), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);

    const where = [];
    const params = [];

    if (startDate) {
      where.push('DATE(s.date) >= ?');
      params.push(startDate);
    }
    if (endDate) {
      where.push('DATE(s.date) <= ?');
      params.push(endDate);
    }
    if (status && status !== 'all') {
      where.push('s.status = ?');
      params.push(status);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[summary]] = await pool.query(
      `SELECT
        COUNT(DISTINCT s.id) AS sales_count,
        COALESCE(SUM(s.total_amount), 0) AS total_amount,
        COALESCE(SUM(s.discount), 0) AS total_discount,
        COALESCE(SUM(s.final_amount), 0) AS final_amount
      FROM sales s
      ${whereSql}`,
      params
    );

    const [[itemsAgg]] = await pool.query(
      `SELECT
        COALESCE(SUM(si.quantity), 0) AS items_sold,
        COALESCE(SUM(si.quantity * COALESCE(i.cost, 0)), 0) AS total_cost
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      LEFT JOIN items i ON si.item_id = i.id
      ${whereSql}`,
      params
    );

    const topItemsParams = [...params, limit, offset];
    const [topItems] = await pool.query(
      `SELECT
        si.item_id,
        COALESCE(i.name, si.item_name) AS item_name,
        COALESCE(i.sku, '') AS sku,
        COALESCE(c.name, '') AS category,
        COALESCE(SUM(si.quantity), 0) AS qty,
        COALESCE(SUM(si.total_price), 0) AS revenue
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      LEFT JOIN items i ON si.item_id = i.id
      LEFT JOIN categories c ON i.category_id = c.id
      ${whereSql}
      GROUP BY si.item_id, item_name, sku, category
      ORDER BY qty DESC
      LIMIT ? OFFSET ?`,
      topItemsParams
    );

    const revenue = Number(summary?.final_amount || 0);
    const cost = Number(itemsAgg?.total_cost || 0);

    res.json({
      success: true,
      summary: {
        sales_count: Number(summary?.sales_count || 0),
        total_amount: Number(summary?.total_amount || 0),
        total_discount: Number(summary?.total_discount || 0),
        final_amount: revenue,
        items_sold: Number(itemsAgg?.items_sold || 0),
        total_cost: cost,
        profit: revenue - cost
      },
      topItems,
      page: { limit, offset }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Purchase report (summary + top items)
router.get('/purchases', async (req, res) => {
  try {
    const user = await requireReportsPermission(req, res);
    if (!user) return;

    const startDate = parseDate(req.query.startDate);
    const endDate = parseDate(req.query.endDate);
    const status = req.query.status ? String(req.query.status) : null;

    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10) || 20, 1), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);

    const where = [];
    const params = [];

    if (startDate) {
      where.push('DATE(po.date) >= ?');
      params.push(startDate);
    }
    if (endDate) {
      where.push('DATE(po.date) <= ?');
      params.push(endDate);
    }
    if (status && status !== 'all') {
      where.push('po.status = ?');
      params.push(status);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[summary]] = await pool.query(
      `SELECT
        COUNT(DISTINCT po.id) AS orders_count,
        COALESCE(SUM(po.total_amount), 0) AS total_amount,
        COALESCE(SUM(po.discount), 0) AS total_discount,
        COALESCE(SUM(po.final_amount), 0) AS final_amount
      FROM purchase_orders po
      ${whereSql}`,
      params
    );

    const [[itemsAgg]] = await pool.query(
      `SELECT
        COALESCE(SUM(poi.quantity), 0) AS items_purchased
      FROM purchase_order_items poi
      JOIN purchase_orders po ON poi.purchase_order_id = po.id
      ${whereSql}`,
      params
    );

    const topItemsParams = [...params, limit, offset];
    const [topItems] = await pool.query(
      `SELECT
        poi.item_id,
        COALESCE(i.name, 'Unknown Item') AS item_name,
        COALESCE(i.sku, '') AS sku,
        COALESCE(c.name, '') AS category,
        COALESCE(SUM(poi.quantity), 0) AS qty,
        COALESCE(SUM(poi.total_price), 0) AS spent
      FROM purchase_order_items poi
      JOIN purchase_orders po ON poi.purchase_order_id = po.id
      LEFT JOIN items i ON poi.item_id = i.id
      LEFT JOIN categories c ON i.category_id = c.id
      ${whereSql}
      GROUP BY poi.item_id, item_name, sku, category
      ORDER BY qty DESC
      LIMIT ? OFFSET ?`,
      topItemsParams
    );

    res.json({
      success: true,
      summary: {
        orders_count: Number(summary?.orders_count || 0),
        total_amount: Number(summary?.total_amount || 0),
        total_discount: Number(summary?.total_discount || 0),
        final_amount: Number(summary?.final_amount || 0),
        items_purchased: Number(itemsAgg?.items_purchased || 0)
      },
      topItems,
      page: { limit, offset }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
