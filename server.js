const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// File Upload Configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Database Fallback State (in case MongoDB isn't running)
let useMemoryDb = true; 
const memoryDb = { items: [] };

// MongoDB Connection
mongoose.connect('mongodb://127.0.0.1:27017/campus_lost_found', { 
    useNewUrlParser: true, 
    useUnifiedTopology: true 
}).then(() => {
    console.log("Connected to MongoDB successfully.");
    useMemoryDb = false;
}).catch(err => {
    console.log("MongoDB connection failed. Using in-memory database for demo purposes.");
});

// SQLite Database Setup (for Users)
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error('Error opening SQLite database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            role TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS admin (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT
        )`, async (err) => {
            if (err) {
                console.error('Error creating admin table:', err.message);
            } else {
                // Robust seed: Ensure default admin exists in the admin table
                const hashedPass = await bcrypt.hash('admin123', 10);
                // We use INSERT OR REPLACE to ensure the password is what we expect
                db.run(`INSERT OR REPLACE INTO admin (username, password) VALUES (?, ?)`, 
                    ['admin', hashedPass], (err) => {
                        if (!err) console.log('Admin account "admin" initialized/updated.');
                    });
            }
        });
    }
});

// Mongoose Schema
const itemSchema = new mongoose.Schema({
    type: { type: String, enum: ['lost', 'found'], required: true },
    name: { type: String, required: true },
    category: { type: String },
    description: { type: String },
    location: { type: String },
    date: { type: String },
    imageUrl: { type: String },
    username: { type: String },
    contactEmail: { type: String },
    contactPhone: { type: String },
    matchedItemId: { type: String }, // To link lost and found items
    status: { type: String, default: 'active' }, // active, matched, solved, claimed, verified
    createdAt: { type: Date, default: Date.now }
});
const Item = mongoose.model('Item', itemSchema);

// RESTful API Routes

// GET items (with optional username filter)
app.get('/api/items', async (req, res) => {
    try {
        const { username } = req.query;
        let query = {};
        
        if (username) {
            query = { username: username }; // Filter by reporter username
        }

        if (useMemoryDb) {
            let filteredItems = memoryDb.items;
            if (username) {
                filteredItems = memoryDb.items.filter(i => i.username === username);
            }
            return res.json(filteredItems);
        }

        const items = await Item.find(query).sort({ createdAt: -1 });
        res.json(items);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST new item
app.post('/api/items', upload.single('image'), async (req, res) => {
    try {
        const itemData = {
            type: req.body.type,
            name: req.body.name,
            category: req.body.category,
            description: req.body.description,
            location: req.body.location,
            date: req.body.date,
            imageUrl: req.file ? `/uploads/${req.file.filename}` : null,
            username: req.body.username,
            contactEmail: req.body.contactEmail,
            contactPhone: req.body.contactPhone
        };

        if (useMemoryDb) {
            const newItem = { _id: Date.now().toString(), ...itemData, status: 'active', createdAt: new Date() };
            memoryDb.items.push(newItem);
            return res.status(201).json(newItem);
        }

        const newItem = new Item(itemData);
        await newItem.save();
        res.status(201).json(newItem);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET Matches
app.get('/api/matches', async (req, res) => {
    try {
        let items = [];
        if (useMemoryDb) {
            // ONLY use active items for matching!
            items = memoryDb.items.filter(i => i.status === 'active');
        } else {
            items = await Item.find({ status: 'active' });
        }

        const lostItems = items.filter(i => i.type === 'lost');
        const foundItems = items.filter(i => i.type === 'found');
        const matches = [];

        lostItems.forEach(lost => {
            foundItems.forEach(found => {
                // Simple Match Logic: Same Category AND (overlapping keywords in name or description)
                if (lost.category && found.category && lost.category === found.category) {
                    const lostWords = (lost.name + " " + lost.description).toLowerCase().split(" ");
                    const foundWords = (found.name + " " + found.description).toLowerCase().split(" ");
                    
                    const intersection = lostWords.filter(word => word.length > 3 && foundWords.includes(word));
                    
                    if (intersection.length > 0) {
                        matches.push({
                            lostItem: lost,
                            foundItem: found,
                            score: intersection.length,
                            keywords: intersection
                        });
                    }
                }
            });
        });

        // Sort by match score
        matches.sort((a, b) => b.score - a.score);
        res.json(matches);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin verify claim/match
app.put('/api/items/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        
        if (useMemoryDb) {
            const item = memoryDb.items.find(i => i._id === req.params.id);
            if (item) item.status = status;
            return res.json({ message: "Status updated", item });
        }

        const item = await Item.findByIdAndUpdate(req.params.id, { status }, { new: true });
        res.json({ message: "Status updated", item });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- Auth Endpoints (SQL) ---

// Register
app.post('/api/register', async (req, res) => {
    const { username, password, role } = req.body;
    
    if (!username || !password || !role) {
        return res.status(400).json({ error: "All fields are required" });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        // FORCE role to student for registration as requested
        const forcedRole = 'student';
        const query = `INSERT INTO users (username, password, role) VALUES (?, ?, ?)`;
        
        db.run(query, [username, hashedPassword, forcedRole], function(err) {
            if (err) {
                if (err.message.includes("UNIQUE constraint failed")) {
                    return res.status(400).json({ error: "Username already exists" });
                }
                return res.status(500).json({ error: err.message });
            }
            res.status(201).json({ message: "User registered successfully", userId: this.lastID });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Login (Users/Students only)
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: "Username and password are required" });
    }

    const query = `SELECT * FROM users WHERE username = ?`;
    db.get(query, [username], async (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) {
            return res.status(401).json({ error: "Invalid username or password" });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: "Invalid username or password" });
        }

        res.json({ message: "Login successful", name: user.username, role: user.role });
    });
});

// Admin Login
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: "Username and password are required" });
    }

    const query = `SELECT * FROM admin WHERE username = ?`;
    db.get(query, [username], async (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) {
            return res.status(401).json({ error: "Invalid admin credentials" });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: "Invalid admin credentials" });
        }

        res.json({ 
            message: "Admin login successful", 
            name: user.username, 
            role: 'admin' 
        });
    });
});

// Admin officially matches two items
app.post('/api/admin/match', async (req, res) => {
    try {
        const { lostId, foundId } = req.body;
        
        if (useMemoryDb) {
            const lostItem = memoryDb.items.find(i => i._id === lostId);
            const foundItem = memoryDb.items.find(i => i._id === foundId);
            if (lostItem && foundItem) {
                lostItem.status = 'matched';
                lostItem.matchedItemId = foundId;
                foundItem.status = 'matched';
                foundItem.matchedItemId = lostId;
            }
            return res.json({ message: "Items matched successfully" });
        }

        await Item.findByIdAndUpdate(lostId, { status: 'matched', matchedItemId: foundId });
        await Item.findByIdAndUpdate(foundId, { status: 'matched', matchedItemId: lostId });
        res.json({ message: "Items matched successfully" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET matches for a specific user
app.get('/api/user-matches/:username', async (req, res) => {
    try {
        const username = req.params.username;
        let myItems = [];
        let allItems = [];

        if (useMemoryDb) {
            allItems = memoryDb.items;
        } else {
            allItems = await Item.find();
        }

        // Find my items that are matched
        myItems = allItems.filter(i => i.username === username && i.status === 'matched');
        
        // Populate counterpart details
        const results = myItems.map(myItem => {
            const counterpart = allItems.find(i => i._id.toString() === myItem.matchedItemId);
            return {
                myItem,
                counterpart: counterpart || null
            };
        });

        res.json(results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Mark items as solved
app.put('/api/items/:id/solve', async (req, res) => {
    try {
        const itemId = req.params.id;
        
        if (useMemoryDb) {
            const item = memoryDb.items.find(i => i._id === itemId);
            if (item) {
                item.status = 'solved';
                // Update counterpart if exists
                if (item.matchedItemId) {
                    const counterpart = memoryDb.items.find(i => i._id === item.matchedItemId);
                    if (counterpart) counterpart.status = 'solved';
                }
            }
            return res.json({ message: "Complaint solved!" });
        }

        const item = await Item.findByIdAndUpdate(itemId, { status: 'solved' }, { new: true });
        if (item && item.matchedItemId) {
            await Item.findByIdAndUpdate(item.matchedItemId, { status: 'solved' });
        }
        res.json({ message: "Complaint solved!" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Fallback Route for Single Page App
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
