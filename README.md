# ShopMaster Sync Backend

This is the cloud synchronization server for ShopMaster POS.

## 🚀 How to Run the Server

1. **Open a terminal** and navigate to the backend folder:
   ```powershell
   cd backend
   ```

2. **Start the server**:
   ```powershell
   node server.js
   ```

The server will start on `http://localhost:5000`. The frontend app is pre-configured to connect to this local server.
When users sign up or sync, their data will be saved to `backend/database.json` on the server.
