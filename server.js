const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;
const DB_FILE = path.join(__dirname, 'database.json');

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve static files from the root directory (so crm.html and client assets are accessible)
app.use(express.static(path.join(__dirname, '../')));

// Helper to load database
function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    const initialDb = { users: [], products: {}, invoices: {}, profiles: {}, softwareSales: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialDb, null, 2));
    return initialDb;
  }
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(data);
    if (!parsed.softwareSales) parsed.softwareSales = [];
    return parsed;
  } catch (err) {
    console.error("Error reading database file, resetting:", err);
    return { users: [], products: {}, invoices: {}, profiles: {}, softwareSales: [] };
  }
}

// Helper to save database
function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Helper to hash password
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// --- API ROUTES ---

// 1. Signup Route
app.post('/api/auth/signup', (req, res) => {
  const { username, password, shopName, shopType, address, phone } = req.body;

  if (!username || !password || !shopName || !shopType) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const db = loadDb();
  const userExists = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());

  if (userExists) {
    return res.status(400).json({ error: "Username already taken" });
  }

  const passwordHash = hashPassword(password);
  const newUser = { username, passwordHash, shopName, shopType };
  db.users.push(newUser);

  // Initialize data stores
  db.products[username] = [];
  db.invoices[username] = [];
  db.profiles[username] = { shopName, shopType, address: address || "", phone: phone || "" };

  saveDb(db);
  res.status(201).json({ message: "User registered successfully", user: { username, shopName, shopType } });
});

// 2. Login Route
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Missing username or password" });
  }

  const db = loadDb();
  const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());

  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  if (user.active === false) {
    return res.status(403).json({ error: "Your license is inactive. Please contact the administrator to activate it." });
  }

  const profile = db.profiles[username] || { shopName: user.shopName, shopType: user.shopType, address: "", phone: "" };
  res.json({
    message: "Login successful",
    user: {
      username: user.username,
      shopName: profile.shopName,
      shopType: profile.shopType,
      address: profile.address,
      phone: profile.phone
    }
  });
});

// 3. Sync Push Route (Upload local changes to Cloud)
app.post('/api/sync/push', (req, res) => {
  const { username, products, invoices, profile } = req.body;

  if (!username) {
    return res.status(400).json({ error: "Username is required" });
  }

  const db = loadDb();
  
  // Merge or overwrite products
  if (products) {
    db.products[username] = products;
  }
  
  // Merge or overwrite invoices
  if (invoices) {
    db.invoices[username] = invoices;
  }

  // Save profile settings
  if (profile) {
    db.profiles[username] = profile;
    const userIndex = db.users.findIndex(u => u.username === username);
    if (userIndex !== -1) {
      db.users[userIndex].shopName = profile.shopName;
      db.users[userIndex].shopType = profile.shopType;
    }
  }

  saveDb(db);
  res.json({ message: "Sync push completed successfully" });
});

// 4. Sync Pull Route (Download Cloud data to local app)
app.get('/api/sync/pull', (req, res) => {
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ error: "Username is required" });
  }

  const db = loadDb();
  
  res.json({
    products: db.products[username] || [],
    invoices: db.invoices[username] || [],
    profile: db.profiles[username] || { shopName: "My Shop", shopType: "general", address: "", phone: "" }
  });
});

// --- CRM API ROUTES ---

// 1. Get System Stats
app.get('/api/crm/stats', (req, res) => {
  const db = loadDb();
  const totalUsers = db.users.length;
  let totalProducts = 0;
  let totalInvoices = 0;
  let totalRevenue = 0;
  let totalProfit = 0;

  db.users.forEach(u => {
    const uProds = db.products[u.username] || [];
    const uInvs = db.invoices[u.username] || [];
    totalProducts += uProds.length;
    totalInvoices += uInvs.length;

    totalRevenue += uInvs.reduce((sum, inv) => sum + (inv.grandTotal || 0), 0);
    totalProfit += uInvs.reduce((sum, inv) => sum + (inv.profit || 0), 0);
  });

  // Software sales metrics (for the admin)
  const totalSoftwareSalesRevenue = (db.softwareSales || []).reduce((sum, s) => sum + (s.salePrice || 0), 0);
  const totalSoftwareSalesCost = (db.softwareSales || []).reduce((sum, s) => sum + (s.costPrice || 0), 0);
  const totalSoftwareSalesProfit = (db.softwareSales || []).reduce((sum, s) => sum + (s.profit || 0), 0);

  res.json({
    totalUsers,
    totalProducts,
    totalInvoices,
    totalRevenue,
    totalProfit,
    softwareSales: {
      revenue: totalSoftwareSalesRevenue,
      cost: totalSoftwareSalesCost,
      profit: totalSoftwareSalesProfit
    }
  });
});

// 2. Get All Client Users (with counts and totals)
app.get('/api/crm/users', (req, res) => {
  const db = loadDb();
  const usersList = db.users.map(u => {
    const profile = db.profiles[u.username] || {};
    const productCount = (db.products[u.username] || []).length;
    const invoiceCount = (db.invoices[u.username] || []).length;
    
    const userInvoices = db.invoices[u.username] || [];
    const totalSales = userInvoices.reduce((sum, inv) => sum + (inv.grandTotal || 0), 0);
    const totalProfit = userInvoices.reduce((sum, inv) => sum + (inv.profit || 0), 0);

    return {
      username: u.username,
      shopName: u.shopName || profile.shopName || "Unnamed Shop",
      shopType: u.shopType || profile.shopType || "general",
      address: profile.address || "",
      phone: profile.phone || "",
      active: u.active !== false, // default to active (true)
      productCount,
      invoiceCount,
      totalSales,
      totalProfit
    };
  });
  res.json({ users: usersList });
});

// 3. Create a Client User
app.post('/api/crm/users', (req, res) => {
  const { username, password, shopName, shopType, address, phone } = req.body;

  if (!username || !password || !shopName || !shopType) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const db = loadDb();
  const userExists = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());

  if (userExists) {
    return res.status(400).json({ error: "Username already taken" });
  }

  const passwordHash = hashPassword(password);
  const newUser = { username, passwordHash, shopName, shopType, active: true };
  db.users.push(newUser);

  // Initialize data stores
  db.products[username] = [];
  db.invoices[username] = [];
  db.profiles[username] = { shopName, shopType, address: address || "", phone: phone || "" };

  saveDb(db);
  res.status(201).json({ message: "Client account created successfully" });
});

// 4. Update a Client User
app.put('/api/crm/users/:username', (req, res) => {
  const targetUsername = req.params.username;
  const { password, shopName, shopType, address, phone } = req.body;

  const db = loadDb();
  const userIndex = db.users.findIndex(u => u.username.toLowerCase() === targetUsername.toLowerCase());

  if (userIndex === -1) {
    return res.status(404).json({ error: "User not found" });
  }

  if (password && password.trim().length > 0) {
    db.users[userIndex].passwordHash = hashPassword(password);
  }
  if (shopName) db.users[userIndex].shopName = shopName;
  if (shopType) db.users[userIndex].shopType = shopType;

  if (!db.profiles[targetUsername]) {
    db.profiles[targetUsername] = {};
  }
  if (shopName) db.profiles[targetUsername].shopName = shopName;
  if (shopType) db.profiles[targetUsername].shopType = shopType;
  if (address !== undefined) db.profiles[targetUsername].address = address;
  if (phone !== undefined) db.profiles[targetUsername].phone = phone;

  saveDb(db);
  res.json({ message: "Client account updated successfully" });
});

// 5. Delete a Client User and all associated data
app.delete('/api/crm/users/:username', (req, res) => {
  const targetUsername = req.params.username;
  const db = loadDb();

  const userIndex = db.users.findIndex(u => u.username.toLowerCase() === targetUsername.toLowerCase());
  if (userIndex === -1) {
    return res.status(404).json({ error: "User not found" });
  }

  db.users.splice(userIndex, 1);
  delete db.products[targetUsername];
  delete db.invoices[targetUsername];
  delete db.profiles[targetUsername];

  saveDb(db);
  res.json({ message: "Client account and all associated data deleted" });
});

// 6. Get Specific Client Database Info
app.get('/api/crm/users/:username/data', (req, res) => {
  const targetUsername = req.params.username;
  const db = loadDb();

  const userExists = db.users.find(u => u.username.toLowerCase() === targetUsername.toLowerCase());
  if (!userExists) {
    return res.status(404).json({ error: "User not found" });
  }

  res.json({
    products: db.products[targetUsername] || [],
    invoices: db.invoices[targetUsername] || [],
    profile: db.profiles[targetUsername] || {}
  });
});

// 7. Toggle Client Active Status
app.post('/api/crm/users/:username/toggle-active', (req, res) => {
  const { username } = req.params;
  const db = loadDb();
  const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  user.active = user.active !== false ? false : true;
  saveDb(db);
  res.json({ message: `Client is now ${user.active ? 'active' : 'inactive'}`, active: user.active });
});

// 8. Get Software Sales Records
app.get('/api/crm/software-sales', (req, res) => {
  const db = loadDb();
  res.json({ sales: db.softwareSales || [] });
});

// 9. Log a Software Sale
app.post('/api/crm/software-sales', (req, res) => {
  const { clientUsername, clientShopName, salePrice, costPrice, date } = req.body;

  if (!clientShopName || !salePrice) {
    return res.status(400).json({ error: "Client Shop Name and Sale Price are required" });
  }

  const db = loadDb();
  const newSale = {
    id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 9),
    clientUsername: clientUsername || "",
    clientShopName,
    salePrice: parseFloat(salePrice),
    costPrice: parseFloat(costPrice || 0),
    profit: parseFloat(salePrice) - parseFloat(costPrice || 0),
    date: date || new Date().toISOString().substring(0, 10)
  };

  db.softwareSales.push(newSale);
  saveDb(db);
  res.status(201).json({ message: "Software sale logged successfully", sale: newSale });
});

// 10. Delete a Software Sale Record
app.delete('/api/crm/software-sales/:id', (req, res) => {
  const { id } = req.params;
  const db = loadDb();
  
  db.softwareSales = (db.softwareSales || []).filter(s => s.id !== id);
  saveDb(db);
  res.json({ message: "Software sale record deleted successfully" });
});

// 11. Backup Master Database File
app.get('/api/crm/backup', (req, res) => {
  if (fs.existsSync(DB_FILE)) {
    res.download(DB_FILE, 'master_database.json');
  } else {
    res.status(404).json({ error: "Database file not found" });
  }
});

// 12. Wipe and Reset Database
app.post('/api/crm/reset', (req, res) => {
  const resetDb = { users: [], products: {}, invoices: {}, profiles: {}, softwareSales: [] };
  saveDb(resetDb);
  res.json({ message: "Cloud database wiped and reset successfully" });
});

app.listen(PORT, () => {
  console.log(`ShopSync cloud server running on http://localhost:${PORT}`);
});
