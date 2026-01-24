const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// GET all debts
router.get('/', async (req, res) => {
  try {
    const [debts] = await pool.query(`
      SELECT 
        d.*,
        COALESCE(SUM(i.amount), 0) as total_paid,
        (d.amount - COALESCE(SUM(i.amount), 0)) as balance
      FROM debts d
      LEFT JOIN debt_installments i ON d.id = i.debt_id
      GROUP BY d.id
      ORDER BY d.created_at DESC
    `);
    res.json({ success: true, data: debts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET debt by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [debts] = await pool.query('SELECT * FROM debts WHERE id = ?', [id]);
    if (debts.length === 0) {
      return res.status(404).json({ error: 'Debt not found' });
    }
    res.json({ success: true, data: debts[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET debt stats
router.get('/stats/summary', async (req, res) => {
  try {
    const [[{ total_debtors }]] = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) as total_debtors FROM debts WHERE type = 'debtor'"
    );
    const [[{ total_creditors }]] = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) as total_creditors FROM debts WHERE type = 'creditor'"
    );
    const [[{ pending_count }]] = await pool.query(
      "SELECT COUNT(*) as pending_count FROM debts WHERE status = 'pending'"
    );
    const [[{ overdue_count }]] = await pool.query(
      "SELECT COUNT(*) as overdue_count FROM debts WHERE status = 'overdue'"
    );
    const [[{ total_records }]] = await pool.query(
      "SELECT COUNT(*) as total_records FROM debts"
    );

    res.json({
      success: true,
      data: {
        totalDebtors: total_debtors,
        totalCreditors: total_creditors,
        pendingCount: pending_count,
        overdueCount: overdue_count,
        totalRecords: total_records,
        netBalance: total_debtors - total_creditors
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE debt
router.post('/', async (req, res) => {
  try {
    const { type, person, amount, date, due_date, description, status = 'pending', phone, email } = req.body;
    if (!type) return res.status(400).json({ error: 'Type is required' });
    if (!person) return res.status(400).json({ error: 'Person is required' });
    if (amount === undefined) return res.status(400).json({ error: 'Amount is required' });
    if (!date) return res.status(400).json({ error: 'Date is required' });

    const [result] = await pool.query(
      'INSERT INTO debts (type, person, amount, date, due_date, description, status, phone, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [type, person, amount, date, due_date || null, description || '', status, phone || '', email || '']
    );

    res.json({
      success: true,
      data: {
        id: result.insertId,
        type,
        person,
        amount,
        date,
        due_date,
        description,
        status,
        phone,
        email
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPDATE debt
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { type, person, amount, date, due_date, description, status = 'pending', phone, email } = req.body;
    if (!type) return res.status(400).json({ error: 'Type is required' });
    if (!person) return res.status(400).json({ error: 'Person is required' });
    if (amount === undefined) return res.status(400).json({ error: 'Amount is required' });
    if (!date) return res.status(400).json({ error: 'Date is required' });

    await pool.query(
      'UPDATE debts SET type = ?, person = ?, amount = ?, date = ?, due_date = ?, description = ?, status = ?, phone = ?, email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [type, person, amount, date, due_date || null, description || '', status, phone || '', email || '', id]
    );

    res.json({
      success: true,
      data: {
        id,
        type,
        person,
        amount,
        date,
        due_date,
        description,
        status,
        phone,
        email
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE debt
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM debt_installments WHERE debt_id = ?', [id]);
    await pool.query('DELETE FROM debts WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
