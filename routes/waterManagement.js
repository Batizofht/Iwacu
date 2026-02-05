const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { logActivity } = require('../utils/activityLogger');

// GET available water stats
router.get('/available-water', async (req, res) => {
  try {
    const [filledResult] = await pool.query(
      'SELECT COUNT(*) as count, SUM(capacity) as totalLiters FROM water_jerrycans WHERE status = "filled"'
    );
    
    const filledCount = filledResult[0].count || 0;
    const availableLiters = filledResult[0].totalLiters || 0;
    
    res.json({
      success: true,
      data: {
        totalLiters: availableLiters,
        totalJerrycans: filledCount,
        filledJerrycans: filledCount
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET available products (water_name + capacity with filled stock) for selling
router.get('/available-products', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT COALESCE(water_name, 'Water') as water_name, capacity, selling_price, COUNT(*) as available
      FROM water_jerrycans
      WHERE status = 'filled'
      GROUP BY water_name, capacity, selling_price
      HAVING available > 0
      ORDER BY water_name, capacity
    `);
    const products = rows.map((r) => ({
      water_name: r.water_name,
      capacity: r.capacity || 20,
      selling_price: parseFloat(r.selling_price) || 0,
      available: r.available,
      label: `${(r.water_name || 'Water').toUpperCase()} ${r.capacity || 20} LITRES`
    }));
    res.json({ success: true, data: products });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET water sales with filtering
router.get('/sales', async (req, res) => {
  try {
    const { period, start_date, end_date } = req.query;
    let dateFilter = '';
    
    if (period === 'today') {
      dateFilter = 'DATE(created_at) = CURDATE()';
    } else if (period === 'yesterday') {
      dateFilter = 'DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)';
    } else if (period === 'this_week') {
      dateFilter = 'DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
    } else if (period === 'this_month') {
      dateFilter = 'MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())';
    } else if (start_date && end_date) {
      dateFilter = 'DATE(created_at) BETWEEN ? AND ?';
    }
    
    let query = 'SELECT * FROM water_sales';
    let params = [];
    
    if (dateFilter) {
      query += ' WHERE ' + dateFilter;
      if (start_date && end_date) {
        params = [start_date, end_date];
      }
    }
    
    query += ' ORDER BY created_at DESC';
    
    const [sales] = await pool.query(query, params);
    
    // Calculate summary
    const totalSales = sales.reduce((sum, sale) => sum + (sale.jerrycans_sold * 20), 0);
    const totalRevenue = sales.reduce((sum, sale) => sum + parseFloat(sale.total_amount || 0), 0);
    const salesCount = sales.length;
    
    // We need to fetch total costs (investments) for the same period to calculate accurate profit
    let additionsQuery = 'SELECT SUM(total_buying_cost) as totalCost FROM water_additions';
    let additionsParams = [];
    if (dateFilter) {
      additionsQuery += ' WHERE ' + dateFilter;
      if (start_date && end_date) {
        additionsParams = [start_date, end_date];
      }
    }
    const [costResult] = await pool.query(additionsQuery, additionsParams);
    const totalCost = parseFloat(costResult[0].totalCost || 0);
    const netProfit = totalRevenue - totalCost;

    const summary = {
      totalLiters: totalSales,
      totalRevenue,
      totalProfit: netProfit, // Using Net Profit (Revenue - Investment) as requested
      salesCount,
      totalCost,
      netProfit
    };
    
    res.json({
      success: true,
      data: {
        sales,
        summary
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE water sale (with optional water_name + capacity for product-based selling)
router.post('/sales', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { jerrycans_sold, price_per_jerrycan, customer_name, payment_method, notes, water_name, capacity, customer_brings_bottle, includes_bottle } = req.body;

    if (!jerrycans_sold || !price_per_jerrycan) {
      return res.status(400).json({ error: 'Jerrycans sold and price per jerrycan are required' });
    }

    const total_amount = jerrycans_sold * price_per_jerrycan;
    const profit = 0; // Set to 0 as we calculate profit globally (Revenue - Investment)
    const custName = customer_name && String(customer_name).trim() ? String(customer_name).trim() : 'Client';
    const wName = water_name && String(water_name).trim() ? String(water_name).trim() : null;
    const cap = capacity != null ? parseInt(capacity, 10) : null;
    const customerBringsBottle = customer_brings_bottle === true;
    const includesBottle = includes_bottle === true;

    // Find filled jerrycans for this product (water_name + capacity) or any filled if not specified
    let filledJerrycans;
    if (wName && cap) {
      [filledJerrycans] = await pool.query(
        'SELECT id FROM water_jerrycans WHERE status = ? AND (water_name = ? OR (water_name IS NULL AND ? IS NULL)) AND (capacity = ? OR (capacity IS NULL AND ? IS NULL)) ORDER BY id LIMIT ?',
        ['filled', wName, wName, cap, cap, jerrycans_sold]
      );
    }
    if (!filledJerrycans || filledJerrycans.length === 0) {
      [filledJerrycans] = await pool.query(
        'SELECT id FROM water_jerrycans WHERE status = ? ORDER BY id LIMIT ?',
        ['filled', jerrycans_sold]
      );
    }

    if (filledJerrycans.length < jerrycans_sold) {
      return res.status(400).json({ error: `Only ${filledJerrycans.length} filled jerrycan(s) available for this product` });
    }

    // Create sale record with bottle tracking information
    const [result] = await pool.query(
      'INSERT INTO water_sales (water_name, capacity, jerrycans_sold, price_per_jerrycan, total_amount, profit, customer_name, payment_method, notes, customer_brings_bottle, includes_bottle) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [wName || 'Water', cap || 20, jerrycans_sold, price_per_jerrycan, total_amount, profit, custName, payment_method || 'cash', notes || '', customerBringsBottle, includesBottle]
    );

    // Handle bottle inventory based on whether customer takes bottle or brings their own
    if (includesBottle && !customerBringsBottle) {
      // Customer takes the bottle (buys it) - remove from inventory
      for (const jerrycan of filledJerrycans) {
        await pool.query(
          'DELETE FROM water_jerrycans WHERE id = ?',
          [jerrycan.id]
        );
      }
    } else {
      // Customer brings their own bottle (swaps) - we receive an empty one in exchange for the filled one we gave
      // So the filled one becomes empty in our inventory
      for (const jerrycan of filledJerrycans) {
        await pool.query(
          'UPDATE water_jerrycans SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['empty', jerrycan.id]
        );
      }
    }

    if (userId) {
      await logActivity({
        userId: parseInt(userId),
        actionType: 'create',
        entityType: 'water_sale',
        entityId: result.insertId,
        entityName: `Water Sale #${result.insertId}`,
        description: `yagurishije amazi ya ${jerrycans_sold} jerrycans ${customerBringsBottle ? "(umukiriya azanya icupa)" : "(aratwara icupa)"}`,
        metadata: { jerrycans_sold, total_amount, profit, customerBringsBottle, includesBottle }
      });
    }

    res.json({
      success: true,
      data: {
        id: result.insertId,
        water_name: wName || 'Water',
        capacity: cap || 20,
        jerrycans_sold,
        price_per_jerrycan,
        total_amount,
        profit,
        customer_name: custName,
        payment_method: payment_method || 'cash',
        notes: notes || '',
        customer_brings_bottle: customerBringsBottle,
        includes_bottle: includesBottle
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPDATE water sale
router.put('/sales/:id', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { id } = req.params;
    const { jerrycans_sold, price_per_jerrycan, customer_name, payment_method, notes } = req.body;
    if (!jerrycans_sold || !price_per_jerrycan) {
      return res.status(400).json({ error: 'Jerrycans sold and price per jerrycan are required' });
    }
    const total_amount = jerrycans_sold * price_per_jerrycan;
    const profit = 0; // We don't track per-sale profit anymore
    await pool.query(
      'UPDATE water_sales SET jerrycans_sold = ?, price_per_jerrycan = ?, total_amount = ?, profit = ?, customer_name = ?, payment_method = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [jerrycans_sold, price_per_jerrycan, total_amount, profit, customer_name || 'Walk-in Customer', payment_method || 'cash', notes || '', id]
    );
    if (userId) {
      await logActivity({
        userId: parseInt(userId),
        actionType: 'update',
        entityType: 'water_sale',
        entityId: parseInt(id),
        entityName: `Water Sale #${id}`,
        description: `yahuje igurisha amazi #${id}`,
        metadata: { jerrycans_sold, total_amount, profit }
      });
    }
    res.json({ success: true, message: 'Sale updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE water sale
router.delete('/sales/:id', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { id } = req.params;
    await pool.query('DELETE FROM water_sales WHERE id = ?', [id]);
    if (userId) {
      await logActivity({
        userId: parseInt(userId),
        actionType: 'delete',
        entityType: 'water_sale',
        entityId: parseInt(id),
        entityName: `Water Sale #${id}`,
        description: `yasibe igurisha amazi #${id}`,
        metadata: {}
      });
    }
    res.json({ success: true, message: 'Sale deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET water additions (with optional period, start_date, end_date)
router.get('/additions', async (req, res) => {
  try {
    const { period, start_date, end_date } = req.query;
    let dateFilter = '';
    let params = [];
    if (period === 'today') {
      dateFilter = 'DATE(created_at) = CURDATE()';
    } else if (period === 'yesterday') {
      dateFilter = 'DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)';
    } else if (period === 'this_week') {
      dateFilter = 'DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
    } else if (period === 'this_month') {
      dateFilter = 'MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())';
    } else if (start_date && end_date) {
      dateFilter = 'DATE(created_at) BETWEEN ? AND ?';
      params = [start_date, end_date];
    }
    let query = 'SELECT id, water_name, status, jerrycans_added, liters_per_jerrycan, total_liters, buying_price_per_jerrycan, selling_price_per_jerrycan, total_buying_cost AS total_cost, total_selling_price, expected_profit, supplier_name, notes, date, created_at, updated_at FROM water_additions';
    if (dateFilter) {
      query += ' WHERE ' + dateFilter;
    }
    query += ' ORDER BY created_at DESC';
    const [additions] = await pool.query(query, params);
    res.json({
      success: true,
      data: additions
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE water addition (water_name, status empty/filled, number, liters; optional buying/selling price)
router.post('/additions', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const {
      water_name,
      status = 'filled',
      jerrycans_added,
      liters_per_jerrycan,
      buying_price_per_jerrycan = 0,
      selling_price_per_jerrycan = 0,
      supplier_name,
      notes,
      date
    } = req.body;

    if (!jerrycans_added || !liters_per_jerrycan) {
      return res.status(400).json({ error: 'Number of jerrycans and litres per jerrycan are required' });
    }
    const wName = (water_name && String(water_name).trim()) ? String(water_name).trim() : 'Water';
    const jerrycanStatus = status === 'empty' ? 'empty' : 'filled';
    const buying = parseInt(buying_price_per_jerrycan, 10) || 0;
    const selling = parseInt(selling_price_per_jerrycan, 10) || 0;

    const total_liters = jerrycans_added * liters_per_jerrycan;
    const total_buying_cost = jerrycans_added * buying;
    const total_selling_price = jerrycans_added * selling;
    const expected_profit = total_selling_price - total_buying_cost;
    const dateVal = date || new Date().toISOString().split('T')[0];

    const [result] = await pool.query(
      'INSERT INTO water_additions (water_name, status, jerrycans_added, liters_per_jerrycan, total_liters, buying_price_per_jerrycan, selling_price_per_jerrycan, total_buying_cost, total_selling_price, expected_profit, supplier_name, notes, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [wName, jerrycanStatus, jerrycans_added, liters_per_jerrycan, total_liters, buying, selling, total_buying_cost, total_selling_price, expected_profit, supplier_name || '', notes || '', dateVal]
    );

    for (let i = 0; i < jerrycans_added; i++) {
      await pool.query(
        'INSERT INTO water_jerrycans (water_name, capacity, status, serial_number, selling_price, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
        [wName, liters_per_jerrycan, jerrycanStatus, `JRC-${Date.now()}-${i}`, selling]
      );
    }

    if (userId) {
      await logActivity({
        userId: parseInt(userId),
        actionType: 'create',
        entityType: 'water_addition',
        entityId: result.insertId,
        entityName: `Water Purchase #${result.insertId}`,
        description: `yaguze amazi ya ${jerrycans_added} jerrycans (${wName} ${liters_per_jerrycan}L)`,
        metadata: { jerrycans_added, total_liters, total_buying_cost }
      });
    }

    res.json({
      success: true,
      data: {
        id: result.insertId,
        water_name: wName,
        status: jerrycanStatus,
        jerrycans_added,
        liters_per_jerrycan,
        total_liters,
        buying_price_per_jerrycan: buying,
        selling_price_per_jerrycan: selling,
        total_buying_cost,
        total_selling_price,
        expected_profit,
        supplier_name: supplier_name || '',
        notes: notes || '',
        date: dateVal
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPDATE water addition
router.put('/additions/:id', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { id } = req.params;
    const { jerrycans_added, liters_per_jerrycan, buying_price_per_jerrycan, selling_price_per_jerrycan, supplier_name, notes, date } = req.body;
    if (!jerrycans_added || !liters_per_jerrycan || !buying_price_per_jerrycan || !selling_price_per_jerrycan) {
      return res.status(400).json({ error: 'Jerrycans, liters, buying and selling price are required' });
    }
    const total_liters = jerrycans_added * liters_per_jerrycan;
    const total_buying_cost = jerrycans_added * buying_price_per_jerrycan;
    const total_selling_price = jerrycans_added * selling_price_per_jerrycan;
    const expected_profit = total_selling_price - total_buying_cost;
    await pool.query(
      'UPDATE water_additions SET jerrycans_added = ?, liters_per_jerrycan = ?, total_liters = ?, buying_price_per_jerrycan = ?, selling_price_per_jerrycan = ?, total_buying_cost = ?, total_selling_price = ?, expected_profit = ?, supplier_name = ?, notes = ?, date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [jerrycans_added, liters_per_jerrycan, total_liters, buying_price_per_jerrycan, selling_price_per_jerrycan, total_buying_cost, total_selling_price, expected_profit, supplier_name || '', notes || '', date || new Date().toISOString().split('T')[0], id]
    );
    if (userId) {
      await logActivity({
        userId: parseInt(userId),
        actionType: 'update',
        entityType: 'water_addition',
        entityId: parseInt(id),
        entityName: `Water Purchase #${id}`,
        description: `yahuje igura amazi #${id}`,
        metadata: { jerrycans_added, total_buying_cost }
      });
    }
    res.json({ success: true, message: 'Purchase updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE water addition
router.delete('/additions/:id', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { id } = req.params;
    await pool.query('DELETE FROM water_additions WHERE id = ?', [id]);
    if (userId) {
      await logActivity({
        userId: parseInt(userId),
        actionType: 'delete',
        entityType: 'water_addition',
        entityId: parseInt(id),
        entityName: `Water Purchase #${id}`,
        description: `yasibe igura amazi #${id}`,
        metadata: {}
      });
    }
    res.json({ success: true, message: 'Purchase deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET recent additions
router.get('/recent-additions', async (req, res) => {
  try {
    const [additions] = await pool.query(
      'SELECT * FROM water_additions ORDER BY created_at DESC LIMIT 10'
    );
    
    res.json({
      success: true,
      data: additions
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET water stats
router.get('/stats', async (req, res) => {
  try {
    // Total jerrycans
    const [totalJerrycans] = await pool.query('SELECT COUNT(*) as count FROM water_jerrycans');
    
    // Total liters (Current Available Water)
    const [totalLiters] = await pool.query('SELECT SUM(capacity) as total FROM water_jerrycans WHERE status = "filled"');
    
    // Total cost
    const [totalCost] = await pool.query('SELECT SUM(total_buying_cost) as total FROM water_additions');
    
    // Today's additions
    const [todayAdditions] = await pool.query(
      'SELECT COUNT(*) as count FROM water_additions WHERE DATE(created_at) = CURDATE()'
    );
    
    res.json({
      success: true,
      data: {
        totalJerrycans: totalJerrycans[0].count || 0,
        totalLiters: totalLiters[0].total || 0,
        totalCost: parseFloat(totalCost[0].total || 0),
        todayAdditions: todayAdditions[0].count || 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET jerrycans
router.get('/jerrycans', async (req, res) => {
  try {
    const [jerrycans] = await pool.query(
      'SELECT * FROM water_jerrycans ORDER BY created_at DESC'
    );
    
    res.json({
      success: true,
      data: jerrycans
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPDATE jerrycan status
router.patch('/jerrycans/:id/status', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { id } = req.params;
    const { status } = req.body;
    
    if (!['filled', 'empty', 'maintenance'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    await pool.query(
      'UPDATE water_jerrycans SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, id]
    );
    
    // Log activity
    if (userId) {
      await logActivity({
        userId: parseInt(userId),
        actionType: 'update',
        entityType: 'water_jerrycan',
        entityId: parseInt(id),
        entityName: `Jerrycan #${id}`,
        description: `yahinduriye imiterere ya jerrycan #${id} kuri "${status}"`,
        metadata: { status }
      });
    }
    
    res.json({
      success: true,
      message: 'Jerrycan status updated successfully'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADD new jerrycans
router.post('/jerrycans', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    const { count, capacity = 20 } = req.body;
    
    if (!count || count < 1) {
      return res.status(400).json({ error: 'Valid count is required' });
    }
    
    const addedJerrycans = [];
    for (let i = 0; i < count; i++) {
      const [result] = await pool.query(
        'INSERT INTO water_jerrycans (capacity, status, serial_number, created_at) VALUES (?, "empty", ?, CURRENT_TIMESTAMP)',
        [capacity, `JRC-${Date.now()}-${i}`]
      );
      addedJerrycans.push({
        id: result.insertId,
        serial_number: `JRC-${Date.now()}-${i}`,
        capacity,
        status: 'empty'
      });
    }
    
    // Log activity
    if (userId) {
      await logActivity({
        userId: parseInt(userId),
        actionType: 'create',
        entityType: 'water_jerrycan',
        entityId: addedJerrycans[0]?.id,
        entityName: `${count} New Jerrycans`,
        description: `yongeremo jerrycans ${count} nshya`,
        metadata: { count, capacity }
      });
    }
    
    res.json({
      success: true,
      data: addedJerrycans
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET jerrycan stats
router.get('/jerrycan-stats', async (req, res) => {
  try {
    const [stats] = await pool.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'filled' THEN 1 ELSE 0 END) as filled,
        SUM(CASE WHEN status = 'empty' THEN 1 ELSE 0 END) as empty,
        SUM(CASE WHEN status = 'maintenance' THEN 1 ELSE 0 END) as maintenance
      FROM water_jerrycans
    `);
    
    res.json({
      success: true,
      data: {
        total: stats[0].total || 0,
        filled: stats[0].filled || 0,
        empty: stats[0].empty || 0,
        inMaintenance: stats[0].maintenance || 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET water reports
router.get('/reports', async (req, res) => {
  try {
    const { period, start_date, end_date } = req.query;
    let dateFilter = '';
    let params = [];
    
    if (period === 'today') {
      dateFilter = 'DATE(created_at) = CURDATE()';
    } else if (period === 'yesterday') {
      dateFilter = 'DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)';
    } else if (period === 'this_week') {
      dateFilter = 'DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)';
    } else if (period === 'this_month') {
      dateFilter = 'MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())';
    } else if (start_date && end_date) {
      dateFilter = 'DATE(created_at) BETWEEN ? AND ?';
      params = [start_date, end_date];
    }
    
    // Get sales
    let salesQuery = 'SELECT * FROM water_sales';
    if (dateFilter) {
      salesQuery += ' WHERE ' + dateFilter;
    }
    salesQuery += ' ORDER BY created_at DESC';
    
    const [sales] = await pool.query(salesQuery, params);
    
    // Get additions
    let additionsQuery = 'SELECT * FROM water_additions';
    if (dateFilter) {
      additionsQuery += ' WHERE ' + dateFilter;
    }
    additionsQuery += ' ORDER BY created_at DESC';
    
    const [additions] = await pool.query(additionsQuery, params);
    const additionsWithCost = additions.map(a => ({ ...a, total_cost: a.total_buying_cost || a.total_cost || 0 }));
    
    // Calculate summary
    const totalSales = sales.reduce((sum, sale) => sum + (sale.jerrycans_sold || 0), 0);
    const totalRevenue = sales.reduce((sum, sale) => sum + parseFloat(sale.total_amount || 0), 0);
    // Profit is calculated as Revenue - Investment (Cost)
    const totalAdditions = additions.reduce((sum, addition) => sum + (addition.jerrycans_added || 0), 0);
    const totalCost = additions.reduce((sum, addition) => sum + parseFloat(addition.total_buying_cost || addition.total_cost || 0), 0);
    const netProfit = totalRevenue - totalCost;
    
    // Set totalProfit to netProfit to align with frontend expectations or keep them separate
    // We will use netProfit as the main profit indicator
    const totalProfit = netProfit; 
    
    res.json({
      success: true,
      data: {
        sales,
        additions: additionsWithCost,
        summary: {
          totalSales,
          totalRevenue,
          totalProfit, // This is now Revenue - Cost
          totalAdditions,
          totalCost,
          netProfit // Same as totalProfit
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
