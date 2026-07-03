require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/shopsync";

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve frontend if running locally
app.use(express.static(path.join(__dirname, '../')));

// --- Mongoose Setup ---
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB Database'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  shopName: String,
  shopType: String,
  active: { type: Boolean, default: true },
  assigned_device_id: { type: String, default: null }
});

const ClientDataSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  products: { type: Array, default: [] },
  invoices: { type: Array, default: [] },
  vendors: { type: Array, default: [] },
  profile: { type: Object, default: {} }
});

const SoftwareSaleSchema = new mongoose.Schema({
  id: String,
  clientUsername: String,
  clientShopName: String,
  salePrice: Number,
  costPrice: Number,
  profit: Number,
  date: String
});

const User = mongoose.model('User', UserSchema);
const ClientData = mongoose.model('ClientData', ClientDataSchema);
const SoftwareSale = mongoose.model('SoftwareSale', SoftwareSaleSchema);

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// --- API ROUTES ---

// 1. Signup Route
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, password, shopName, shopType, address, phone } = req.body;
    if (!username || !password || !shopName || !shopType) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const userExists = await User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
    if (userExists) return res.status(400).json({ error: "Username already taken" });

    const newUser = new User({
      username,
      passwordHash: hashPassword(password),
      shopName,
      shopType
    });
    await newUser.save();

    const newData = new ClientData({
      username,
      products: [],
      invoices: [],
      profile: { shopName, shopType, address: address || "", phone: phone || "" }
    });
    await newData.save();

    res.status(201).json({ message: "User registered successfully", user: { username, shopName, shopType } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Login Route
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password, deviceId } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Missing username or password" });
    if (!deviceId) return res.status(400).json({ error: "Device ID is required for login" });

    const user = await User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
    if (!user || user.passwordHash !== hashPassword(password)) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    if (user.active === false) {
      return res.status(403).json({ error: "Your license is inactive. Please contact the administrator to activate it." });
    }

    // Hardware locking logic
    if (!user.assigned_device_id) {
      user.assigned_device_id = deviceId;
      await user.save();
    } else if (user.assigned_device_id !== deviceId) {
      return res.status(403).json({ error: "This account is already registered on another device." });
    }

    const data = await ClientData.findOne({ username: user.username }) || {};
    const profile = data.profile || { shopName: user.shopName, shopType: user.shopType, address: "", phone: "" };
    
    res.json({
      message: "Login successful",
      user: {
        username: user.username,
        shopName: profile.shopName || user.shopName,
        shopType: profile.shopType || user.shopType,
        address: profile.address,
        phone: profile.phone
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Sync Push Route
app.post('/api/sync/push', async (req, res) => {
  try {
    const { username, products, invoices, vendors, profile } = req.body;
    if (!username) return res.status(400).json({ error: "Username is required" });

    let clientData = await ClientData.findOne({ username });
    if (!clientData) {
      clientData = new ClientData({ username, products: [], invoices: [], vendors: [], profile: {} });
    }

    if (products) clientData.products = products;
    if (invoices) clientData.invoices = invoices;
    if (vendors) clientData.vendors = vendors;
    if (profile) {
      clientData.profile = profile;
      await User.updateOne({ username }, { $set: { shopName: profile.shopName, shopType: profile.shopType } });
    }

    await clientData.save();
    res.json({ message: "Sync push completed successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Sync Pull Route
app.get('/api/sync/pull', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: "Username is required" });

    const data = await ClientData.findOne({ username });
    if (!data) {
      return res.json({ products: [], invoices: [], vendors: [], profile: { shopName: "My Shop", shopType: "general", address: "", phone: "" } });
    }
    res.json({ products: data.products, invoices: data.invoices, vendors: data.vendors, profile: data.profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CRM API ROUTES ---

// 1. Get System Stats
app.get('/api/crm/stats', async (req, res) => {
  try {
    const usersCount = await User.countDocuments();
    const allData = await ClientData.find({});
    
    let totalProducts = 0, totalInvoices = 0, totalRevenue = 0, totalProfit = 0;
    allData.forEach(d => {
      totalProducts += (d.products || []).length;
      totalInvoices += (d.invoices || []).length;
      totalRevenue += (d.invoices || []).reduce((sum, inv) => sum + (inv.grandTotal || 0), 0);
      totalProfit += (d.invoices || []).reduce((sum, inv) => sum + (inv.profit || 0), 0);
    });

    const sales = await SoftwareSale.find({});
    const totalSoftwareSalesRevenue = sales.reduce((sum, s) => sum + (s.salePrice || 0), 0);
    const totalSoftwareSalesCost = sales.reduce((sum, s) => sum + (s.costPrice || 0), 0);
    const totalSoftwareSalesProfit = sales.reduce((sum, s) => sum + (s.profit || 0), 0);

    res.json({
      totalUsers: usersCount, totalProducts, totalInvoices, totalRevenue, totalProfit,
      softwareSales: { revenue: totalSoftwareSalesRevenue, cost: totalSoftwareSalesCost, profit: totalSoftwareSalesProfit }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Get All Client Users
app.get('/api/crm/users', async (req, res) => {
  try {
    const users = await User.find({});
    const allData = await ClientData.find({});
    
    const usersList = users.map(u => {
      const data = allData.find(d => d.username === u.username) || { products: [], invoices: [], profile: {} };
      const productCount = data.products.length;
      const invoiceCount = data.invoices.length;
      const totalSales = data.invoices.reduce((sum, inv) => sum + (inv.grandTotal || 0), 0);
      const totalProfit = data.invoices.reduce((sum, inv) => sum + (inv.profit || 0), 0);

      return {
        username: u.username,
        shopName: u.shopName || data.profile.shopName || "Unnamed Shop",
        shopType: u.shopType || data.profile.shopType || "general",
        address: data.profile.address || "",
        phone: data.profile.phone || "",
        active: u.active !== false,
        productCount, invoiceCount, totalSales, totalProfit
      };
    });
    res.json({ users: usersList });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Create a Client User (CRM)
app.post('/api/crm/users', async (req, res) => {
  try {
    const { username, password, shopName, shopType, address, phone } = req.body;
    if (!username || !password || !shopName || !shopType) return res.status(400).json({ error: "Missing fields" });

    const userExists = await User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
    if (userExists) return res.status(400).json({ error: "Username already taken" });

    await new User({ username, passwordHash: hashPassword(password), shopName, shopType, active: true }).save();
    await new ClientData({ username, products: [], invoices: [], profile: { shopName, shopType, address, phone } }).save();
    
    res.status(201).json({ message: "Client account created successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Update Client User
app.put('/api/crm/users/:username', async (req, res) => {
  try {
    const targetUsername = req.params.username;
    const { password, shopName, shopType, address, phone } = req.body;

    const user = await User.findOne({ username: { $regex: new RegExp(`^${targetUsername}$`, 'i') } });
    if (!user) return res.status(404).json({ error: "User not found" });

    if (password && password.trim().length > 0) user.passwordHash = hashPassword(password);
    if (shopName) user.shopName = shopName;
    if (shopType) user.shopType = shopType;
    await user.save();

    let data = await ClientData.findOne({ username: user.username });
    if (!data) data = new ClientData({ username: user.username, profile: {} });
    
    if (shopName) data.profile.shopName = shopName;
    if (shopType) data.profile.shopType = shopType;
    if (address !== undefined) data.profile.address = address;
    if (phone !== undefined) data.profile.phone = phone;
    
    data.markModified('profile');
    await data.save();

    res.json({ message: "Client account updated successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Delete Client User
app.delete('/api/crm/users/:username', async (req, res) => {
  try {
    const username = req.params.username;
    const user = await User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
    if (!user) return res.status(404).json({ error: "User not found" });

    await User.deleteOne({ username: user.username });
    await ClientData.deleteOne({ username: user.username });
    res.json({ message: "Client account and data deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Get Client Data
app.get('/api/crm/users/:username/data', async (req, res) => {
  try {
    const username = req.params.username;
    const data = await ClientData.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
    if (!data) return res.status(404).json({ error: "Data not found" });
    res.json({ products: data.products, invoices: data.invoices, profile: data.profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Toggle Active Status
app.post('/api/crm/users/:username/toggle-active', async (req, res) => {
  try {
    const username = req.params.username;
    const user = await User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
    if (!user) return res.status(404).json({ error: "User not found" });

    user.active = user.active !== false ? false : true;
    await user.save();
    res.json({ message: `Client is now ${user.active ? 'active' : 'inactive'}`, active: user.active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7b. Reset Device ID
app.post('/api/crm/users/:username/reset-device', async (req, res) => {
  try {
    const username = req.params.username;
    const user = await User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
    if (!user) return res.status(404).json({ error: "User not found" });

    user.assigned_device_id = null;
    await user.save();
    res.json({ message: "Device assignment reset successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Software Sales Routes
app.get('/api/crm/software-sales', async (req, res) => {
  try {
    const sales = await SoftwareSale.find({});
    res.json({ sales });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/crm/software-sales', async (req, res) => {
  try {
    const { clientUsername, clientShopName, salePrice, costPrice, date } = req.body;
    if (!clientShopName || !salePrice) return res.status(400).json({ error: "Missing fields" });

    const newSale = new SoftwareSale({
      id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 9),
      clientUsername: clientUsername || "",
      clientShopName,
      salePrice: parseFloat(salePrice),
      costPrice: parseFloat(costPrice || 0),
      profit: parseFloat(salePrice) - parseFloat(costPrice || 0),
      date: date || new Date().toISOString().substring(0, 10)
    });

    await newSale.save();
    res.status(201).json({ message: "Sale logged", sale: newSale });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/crm/software-sales/:id', async (req, res) => {
  try {
    await SoftwareSale.deleteOne({ id: req.params.id });
    res.json({ message: "Sale deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Backup
app.get('/api/crm/backup', async (req, res) => {
  try {
    const users = await User.find({});
    const clientData = await ClientData.find({});
    const softwareSales = await SoftwareSale.find({});
    res.json({ users, clientData, softwareSales });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset
app.post('/api/crm/reset', async (req, res) => {
  try {
    await User.deleteMany({});
    await ClientData.deleteMany({});
    await SoftwareSale.deleteMany({});
    res.json({ message: "Cloud database wiped and reset successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`ShopSync Mongoose server running on http://localhost:${PORT}`);
});
