const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { logActivity } = require('../utils/activityLogger');

// GET all expenses
router.get('/', async (req, res) => {
  try {
    const [expenses] = await pool.query('SELECT * FROM expenses ORDER BY date DESC, created_at DESC');
    res.json({ success: true, data: expenses });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET expense stats
router.get('/stats', async (req, res) => {
  try {
    const [[{ total_expenses }]] = await pool.query('SELECT COALESCE(SUM(amount), 0) as total_expenses FROM expenses');
    const [[{ today_total }]] = await pool.query("SELECT COALESCE(SUM(amount), 0) as today_total FROM expenses WHERE date = CURDATE()");
    const [[{ yesterday_total }]] = await pool.query("SELECT COALESCE(SUM(amount), 0) as yesterday_total FROM expenses WHERE date = DATE_SUB(CURDATE(), INTERVAL 1 DAY)");
    const [[{ week_total }]] = await pool.query("SELECT COALESCE(SUM(amount), 0) as week_total FROM expenses WHERE date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)");
    const [[{ month_total }]] = await pool.query("SELECT COALESCE(SUM(amount), 0) as month_total FROM expenses WHERE date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)");
    const [[{ total_count }]] = await pool.query('SELECT COUNT(*) as total_count FROM expenses');

    res.json({
      success: true,
      data: {
        totalExpenses: total_expenses,
        todayTotal: today_total,
        yesterdayTotal: yesterday_total,
        weekTotal: week_total,
        monthTotal: month_total,
        totalCount: total_count
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET expenses by date range
router.get('/range', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const [expenses] = await pool.query(
      'SELECT * FROM expenses WHERE date BETWEEN ? AND ? ORDER BY date DESC, created_at DESC',
      [start_date, end_date]
    );
    res.json({ success: true, data: expenses });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET expense categories
router.get('/categories', async (req, res) => {
  try {
    const [categories] = await pool.query('SELECT DISTINCT category FROM expenses ORDER BY category');
    res.json({ success: true, data: categories.map(c => c.category) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE expense
router.post('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { person, amount, description, category, date } = req.body;
    if (!person) return res.status(400).json({ error: 'Person is required' });
    if (amount === undefined) return res.status(400).json({ error: 'Amount is required' });
    if (!description) return res.status(400).json({ error: 'Description is required' });
    if (!category) return res.status(400).json({ error: 'Category is required' });
    if (!date) return res.status(400).json({ error: 'Date is required' });

    const [result] = await pool.query(
      'INSERT INTO expenses (person, amount, description, category, date) VALUES (?, ?, ?, ?, ?)',
      [person, amount, description, category, date]
    );

    // Log activity
    if (userId) {
      await logActivity({
        userId: parseInt(userId),
        actionType: 'create',
        entityType: 'expense',
        entityId: result.insertId,
        entityName: category,
        description: `yongeye depanse ya FRW ${amount.toLocaleString()} (${category})`,
        metadata: { amount, category, person, description }
      });
    }

    res.json({
      success: true,
      data: {
        id: result.insertId,
        person,
        amount,
        description,
        category,
        date
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPDATE expense
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { person, amount, description, category, date } = req.body;
    if (!person) return res.status(400).json({ error: 'Person is required' });
    if (amount === undefined) return res.status(400).json({ error: 'Amount is required' });
    if (!description) return res.status(400).json({ error: 'Description is required' });
    if (!category) return res.status(400).json({ error: 'Category is required' });
    if (!date) return res.status(400).json({ error: 'Date is required' });

    await pool.query(
      'UPDATE expenses SET person = ?, amount = ?, description = ?, category = ?, date = ? WHERE id = ?',
      [person, amount, description, category, date, id]
    );

    res.json({
      success: true,
      data: {
        id,
        person,
        amount,
        description,
        category,
        date
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE expense
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM expenses WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
