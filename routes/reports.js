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

// Expenses report (summary + breakdown by category)
router.get('/expenses', async (req, res) => {
  try {
    const user = await requireReportsPermission(req, res);
    if (!user) return;

    const startDate = parseDate(req.query.startDate);
    const endDate = parseDate(req.query.endDate);

    const where = [];
    const params = [];

    if (startDate) {
      where.push('DATE(e.date) >= ?');
      params.push(startDate);
    }
    if (endDate) {
      where.push('DATE(e.date) <= ?');
      params.push(endDate);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[summary]] = await pool.query(
      `SELECT
        COUNT(*) AS expenses_count,
        COALESCE(SUM(amount), 0) AS total_amount
      FROM expenses e
      ${whereSql}`,
      params
    );

    const [byCategory] = await pool.query(
      `SELECT
        category,
        COUNT(*) AS count,
        COALESCE(SUM(amount), 0) AS total
      FROM expenses e
      ${whereSql}
      GROUP BY category
      ORDER BY total DESC`,
      params
    );

    const [recentExpenses] = await pool.query(
      `SELECT id, person, amount, description, category, date
      FROM expenses e
      ${whereSql}
      ORDER BY date DESC, created_at DESC
      LIMIT 50`,
      params
    );

    res.json({
      success: true,
      summary: {
        expenses_count: Number(summary?.expenses_count || 0),
        total_amount: Number(summary?.total_amount || 0)
      },
      byCategory,
      recentExpenses
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Debts report (summary + breakdown)
router.get('/debts', async (req, res) => {
  try {
    const user = await requireReportsPermission(req, res);
    if (!user) return;

    const startDate = parseDate(req.query.startDate);
    const endDate = parseDate(req.query.endDate);
    const type = req.query.type; // 'debtor' or 'creditor'

    const where = [];
    const params = [];

    if (startDate) {
      where.push('DATE(d.date) >= ?');
      params.push(startDate);
    }
    if (endDate) {
      where.push('DATE(d.date) <= ?');
      params.push(endDate);
    }
    if (type && (type === 'debtor' || type === 'creditor')) {
      where.push('d.type = ?');
      params.push(type);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[summary]] = await pool.query(
      `SELECT
        COUNT(*) AS total_count,
        COALESCE(SUM(CASE WHEN type = 'debtor' THEN amount ELSE 0 END), 0) AS total_receivable,
        COALESCE(SUM(CASE WHEN type = 'creditor' THEN amount ELSE 0 END), 0) AS total_payable,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) AS pending_amount,
        COALESCE(SUM(CASE WHEN status = 'overdue' THEN amount ELSE 0 END), 0) AS overdue_amount,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) AS paid_amount
      FROM debts d
      ${whereSql}`,
      params
    );

    const [byStatus] = await pool.query(
      `SELECT
        status,
        type,
        COUNT(*) AS count,
        COALESCE(SUM(amount), 0) AS total
      FROM debts d
      ${whereSql}
      GROUP BY status, type
      ORDER BY type, status`,
      params
    );

    const [unpaidDebts] = await pool.query(
      `SELECT 
        d.*,
        COALESCE(SUM(i.amount), 0) as total_paid,
        (d.amount - COALESCE(SUM(i.amount), 0)) as balance
      FROM debts d
      LEFT JOIN debt_installments i ON d.id = i.debt_id
      ${whereSql ? whereSql + ' AND' : 'WHERE'} d.status != 'paid'
      GROUP BY d.id
      ORDER BY d.due_date ASC, d.amount DESC
      LIMIT 100`,
      params
    );

    res.json({
      success: true,
      summary: {
        total_count: Number(summary?.total_count || 0),
        total_receivable: Number(summary?.total_receivable || 0),
        total_payable: Number(summary?.total_payable || 0),
        pending_amount: Number(summary?.pending_amount || 0),
        overdue_amount: Number(summary?.overdue_amount || 0),
        paid_amount: Number(summary?.paid_amount || 0),
        net_balance: Number(summary?.total_receivable || 0) - Number(summary?.total_payable || 0)
      },
      byStatus,
      unpaidDebts
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// General/Quick report (combined summary)
router.get('/general', async (req, res) => {
  try {
    const user = await requireReportsPermission(req, res);
    if (!user) return;

    const startDate = parseDate(req.query.startDate);
    const endDate = parseDate(req.query.endDate);

    const dateFilter = startDate && endDate;
    
    // Sales summary
    const salesWhere = dateFilter ? 'WHERE DATE(date) >= ? AND DATE(date) <= ?' : '';
    const salesParams = dateFilter ? [startDate, endDate] : [];
    
    const [[salesSummary]] = await pool.query(
      `SELECT
        COUNT(DISTINCT id) AS count,
        COALESCE(SUM(final_amount), 0) AS revenue
      FROM sales ${salesWhere}`,
      salesParams
    );

    // Purchases summary
    const [[purchasesSummary]] = await pool.query(
      `SELECT
        COUNT(DISTINCT id) AS count,
        COALESCE(SUM(final_amount), 0) AS spent
      FROM purchase_orders ${salesWhere.replace('date', 'date')}`,
      salesParams
    );

    // Expenses summary
    const [[expensesSummary]] = await pool.query(
      `SELECT
        COUNT(*) AS count,
        COALESCE(SUM(amount), 0) AS total
      FROM expenses ${salesWhere.replace('date', 'date')}`,
      salesParams
    );

    // Debts summary (current state, not filtered by date)
    const [[debtsSummary]] = await pool.query(
      `SELECT
        COALESCE(SUM(CASE WHEN type = 'debtor' AND status != 'paid' THEN amount ELSE 0 END), 0) AS receivable,
        COALESCE(SUM(CASE WHEN type = 'creditor' AND status != 'paid' THEN amount ELSE 0 END), 0) AS payable,
        COUNT(CASE WHEN status = 'overdue' THEN 1 END) AS overdue_count
      FROM debts`
    );

    // Stock summary
    const [[stockSummary]] = await pool.query(
      `SELECT
        COUNT(*) AS total_items,
        COALESCE(SUM(stock), 0) AS total_stock,
        COALESCE(SUM(stock * cost), 0) AS stock_value,
        COUNT(CASE WHEN stock <= min_stock THEN 1 END) AS low_stock_count
      FROM items WHERE status = 'active'`
    );

    // Calculate net cash flow
    const revenue = Number(salesSummary?.revenue || 0);
    const spent = Number(purchasesSummary?.spent || 0);
    const expenses = Number(expensesSummary?.total || 0);
    const netCashFlow = revenue - spent - expenses;

    res.json({
      success: true,
      period: { startDate, endDate },
      sales: {
        count: Number(salesSummary?.count || 0),
        revenue
      },
      purchases: {
        count: Number(purchasesSummary?.count || 0),
        spent
      },
      expenses: {
        count: Number(expensesSummary?.count || 0),
        total: expenses
      },
      debts: {
        receivable: Number(debtsSummary?.receivable || 0),
        payable: Number(debtsSummary?.payable || 0),
        overdue_count: Number(debtsSummary?.overdue_count || 0)
      },
      stock: {
        total_items: Number(stockSummary?.total_items || 0),
        total_stock: Number(stockSummary?.total_stock || 0),
        stock_value: Number(stockSummary?.stock_value || 0),
        low_stock_count: Number(stockSummary?.low_stock_count || 0)
      },
      summary: {
        gross_revenue: revenue,
        total_outflow: spent + expenses,
        net_cash_flow: netCashFlow
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
