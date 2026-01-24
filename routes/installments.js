const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// GET installments by debt ID
router.get('/debt/:debtId', async (req, res) => {
  try {
    const { debtId } = req.params;
    const [installments] = await pool.query(
      'SELECT * FROM debt_installments WHERE debt_id = ? ORDER BY payment_date DESC',
      [debtId]
    );
    res.json({ success: true, data: installments });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE installment
router.post('/', async (req, res) => {
  try {
    const { debtId, amount, paymentDate, notes = '' } = req.body;
    if (!debtId) return res.status(400).json({ error: 'Debt ID is required' });
    if (amount === undefined) return res.status(400).json({ error: 'Amount is required' });
    if (!paymentDate) return res.status(400).json({ error: 'Payment date is required' });

    // Add installment
    const [result] = await pool.query(
      'INSERT INTO debt_installments (debt_id, amount, payment_date, notes) VALUES (?, ?, ?, ?)',
      [debtId, amount, paymentDate, notes]
    );

    // Calculate total paid
    const [[{ total_paid }]] = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) as total_paid FROM debt_installments WHERE debt_id = ?',
      [debtId]
    );

    // Get debt amount
    const [[{ amount: debt_amount }]] = await pool.query(
      'SELECT amount FROM debts WHERE id = ?',
      [debtId]
    );

    // Update debt status if fully paid
    if (total_paid >= debt_amount) {
      await pool.query(
        "UPDATE debts SET status = 'paid', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [debtId]
      );
    }

    res.json({
      success: true,
      data: {
        id: result.insertId,
        debtId,
        amount,
        paymentDate,
        notes,
        totalPaid: total_paid,
        isFullyPaid: total_paid >= debt_amount
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE installment
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get installment to know debt_id
    const [installments] = await pool.query(
      'SELECT debt_id FROM debt_installments WHERE id = ?',
      [id]
    );
    if (installments.length === 0) {
      return res.status(404).json({ error: 'Installment not found' });
    }
    const debtId = installments[0].debt_id;

    // Delete installment
    await pool.query('DELETE FROM debt_installments WHERE id = ?', [id]);

    // Recalculate total paid
    const [[{ total_paid }]] = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) as total_paid FROM debt_installments WHERE debt_id = ?',
      [debtId]
    );

    // Get debt amount
    const [[{ amount: debt_amount }]] = await pool.query(
      'SELECT amount FROM debts WHERE id = ?',
      [debtId]
    );

    // Update debt status
    const newStatus = total_paid >= debt_amount ? 'paid' : 'pending';
    await pool.query(
      'UPDATE debts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newStatus, debtId]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
