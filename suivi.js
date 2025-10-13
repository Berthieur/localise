const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

// ================= CONFIGURATION =================
const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: false,
  clientTracking: true
});

// ================= MIDDLEWARES =================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Dossier public
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);
app.use(express.static(publicDir));

// ================= BASE DE DONNÉES =================
const DB_PATH = path.join(__dirname, 'tracking.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('❌ Erreur DB:', err);
  else {
    console.log('✅ DB:', DB_PATH);
    initDatabase();
  }
});

// ================= INIT DB =================
function initDatabase() {
  db.serialize(() => {
    // Table employees
    db.run(`CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      nom TEXT NOT NULL,
      prenom TEXT NOT NULL,
      type TEXT,
      is_active INTEGER DEFAULT 0,
      last_position_x REAL,
      last_position_y REAL,
      last_seen INTEGER,
      created_at INTEGER,
      email TEXT,
      telephone TEXT,
      taux_horaire REAL,
      frais_ecolage REAL,
      profession TEXT,
      date_naissance TEXT,
      lieu_naissance TEXT
    )`);

    // Table rssi_measurements
    db.run(`CREATE TABLE IF NOT EXISTS rssi_measurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id TEXT,
      anchor_id INTEGER,
      anchor_x REAL,
      anchor_y REAL,
      rssi INTEGER,
      mac TEXT,
      timestamp INTEGER,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )`);

    // Index pour performances
    db.run(`CREATE INDEX IF NOT EXISTS idx_rssi_employee 
            ON rssi_measurements(employee_id, timestamp DESC)`);

    // Tables annexes
    db.run(`CREATE TABLE IF NOT EXISTS pointages (
      id TEXT PRIMARY KEY,
      employee_id TEXT,
      employee_name TEXT,
      type TEXT,
      timestamp INTEGER,
      date TEXT,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS salaries (
      id TEXT PRIMARY KEY,
      employee_id TEXT,
      employee_name TEXT,
      amount REAL,
      hours_worked REAL,
      type TEXT,
      period TEXT,
      date INTEGER,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )`);

    // Données de test
    db.get("SELECT COUNT(*) as count FROM employees", [], (err, row) => {
      if (!err && row.count === 0) {
        console.log('📝 Ajout données test...');
        const testData = [
          ['emp-1', 'fun', 'tero', 'employé', 1, Date.now()],
          ['emp-2', 'Rakoto', 'Jean', 'employé', 0, Date.now()],
          ['emp-3', 'Rasoa', 'Marie', 'manager', 0, Date.now()],
          ['emp-4', 'info', 'Spray', 'employé', 0, Date.now()]
        ];
        testData.forEach(emp => {
          db.run(`INSERT INTO employees (id, nom, prenom, type, is_active, created_at) 
                  VALUES (?, ?, ?, ?, ?, ?)`, emp);
        });
      }
    });
  });
  console.log('✅ Tables initialisées');
}

// ================= WEBSOCKET CLIENTS =================
const clients = { web: new Set(), esp32: new Set(), mobile: new Set() };

// ================= CONNEXIONS WEBSOCKET =================
wss.on('connection', (ws, req) => {
  console.log(`🔌 New connection from ${req.socket.remoteAddress}`);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const clientType = url.searchParams.get('type') || 'web';
  console.log(`Client type: ${clientType}`);
  console.log(`🔌 ${clientType} connecté (Total: ${wss.clients.size})`);
  
  ws.clientType = clientType;
  ws.isAlive = true;

  if (clientType === 'esp32') clients.esp32.add(ws);
  else if (clientType === 'mobile') clients.mobile.add(ws);
  else clients.web.add(ws);

  // Message de bienvenue
  ws.send(JSON.stringify({
    type: 'connected',
    message: `Serveur OK - ${clientType}`,
    timestamp: Date.now(),
    clientType
  }));

  // Envoyer employés actifs aux clients web/mobile
  if (clientType === 'web' || clientType === 'mobile') {
    setTimeout(() => sendActiveEmployees(ws), 500);
  }

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleWebSocketMessage(ws, data);
    } catch (error) {
      console.error('❌ Parse error:', error.message);
    }
  });

  ws.on('close', () => {
    console.log(`🔌 ${clientType} déconnecté (Restant: ${wss.clients.size - 1})`);
    clients.esp32.delete(ws);
    clients.web.delete(ws);
    clients.mobile.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('❌ WS error:', error.message);
  });
});

wss.on('error', (error) => {
  console.error('❌ WebSocket server error:', error);
});

// Heartbeat (30 secondes)
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

// ================= GESTION MESSAGES =================
function handleWebSocketMessage(ws, data) {
  console.log(`📥 ${ws.clientType}: ${data.type}`);
  
  switch (data.type) {
    case 'rssi_data': 
      handleRSSIData(data); 
      break;
    case 'scan_qr': 
      handleQRScan(data); 
      break;
    case 'pointage': 
      handlePointage(data); 
      break;
    case 'get_active_employees': 
      sendActiveEmployees(ws); 
      break;
    case 'ping': 
    case 'pong': 
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() })); 
      break;
    default: 
      console.log('⚠️  Type inconnu:', data.type);
  }
}

// ================= TRAITEMENT RSSI =================
function handleRSSIData(data) {
  const { anchor_id, anchor_x, anchor_y, badges, timestamp } = data;
  
  console.log(`📡 Ancre #${anchor_id} (${anchor_x}, ${anchor_y}): ${badges?.length || 0} badges`);
  
  if (!badges || badges.length === 0) return;

  badges.forEach(badge => {
    const { ssid, mac, rssi } = badge;
    
    if (!ssid || ssid === 'None' || !ssid.trim()) return;

    const employeeName = ssid.trim();
    
    console.log(`  🔎 Recherche: "${employeeName}"`);
    
    // Recherche flexible (insensible à la casse, ordre prénom/nom)
    db.get(
      `SELECT id, nom, prenom FROM employees 
       WHERE LOWER(TRIM(nom || ' ' || prenom)) = LOWER(?) 
          OR LOWER(TRIM(prenom || ' ' || nom)) = LOWER(?)
          OR LOWER(TRIM(nom)) = LOWER(?) 
          OR LOWER(TRIM(prenom)) = LOWER(?)
       LIMIT 1`,
      [employeeName, employeeName, employeeName, employeeName],
      (err, employee) => {
        if (err) {
          console.error('❌ DB error:', err.message);
          return;
        }
        
        if (!employee) {
          console.log(`⚠️  Non trouvé: "${employeeName}"`);
          return;
        }
        
        console.log(`✅ ${employee.prenom} ${employee.nom} (${employee.id})`);
        
        // Enregistrer RSSI
        db.run(
          `INSERT INTO rssi_measurements (employee_id, anchor_id, anchor_x, anchor_y, rssi, mac, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [employee.id, anchor_id, anchor_x, anchor_y, rssi, mac, Date.now()],
          (err) => { 
            if (err) {
              console.error('❌ Insert error:', err.message);
            } else {
              console.log(`📝 RSSI: ${employee.prenom} ${employee.nom} = ${rssi} dBm`);
              calculatePosition(employee.id); 
            }
          }
        );
      }
    );
  });
}

// ================= CALCUL POSITION =================
function calculatePosition(employeeId) {
  const threshold = Date.now() - 5000; // 5 secondes
  
  db.all(
    `SELECT anchor_id, anchor_x, anchor_y, rssi
     FROM rssi_measurements
     WHERE employee_id = ? AND timestamp > ?
     ORDER BY timestamp DESC LIMIT 10`,
    [employeeId, threshold],
    (err, measurements) => {
      if (err) {
        console.error('❌ Calc error:', err.message);
        return;
      }
      
      if (!measurements || measurements.length === 0) {
        console.log(`⚠️  Aucune mesure récente pour ${employeeId}`);
        return;
      }
      
      if (measurements.length < 3) {
        console.log(`⚠️  Pas assez de mesures: ${measurements.length}/3`);
        const anchor = measurements[0];
        const position = { x: anchor.anchor_x, y: anchor.anchor_y };
        updatePosition(employeeId, position);
        return;
      }

      console.log(`📊 ${measurements.length} mesures pour triangulation:`);
      
      // Grouper par ancre
      const anchorData = {};
      measurements.forEach(m => {
        const distance = rssiToDistance(m.rssi);
        console.log(`   Ancre #${m.anchor_id}: ${m.rssi} dBm → ${distance.toFixed(2)}m`);
        
        if (!anchorData[m.anchor_id] || distance < anchorData[m.anchor_id].distance) {
          anchorData[m.anchor_id] = { 
            x: m.anchor_x, 
            y: m.anchor_y, 
            distance 
          };
        }
      });

      const anchors = Object.values(anchorData);
      
      if (anchors.length >= 3) {
        const position = trilateration(anchors);
        console.log(`📍 Position: (${position.x.toFixed(2)}, ${position.y.toFixed(2)})`);
        updatePosition(employeeId, position);
      } else {
        console.log(`⚠️  Pas assez d'ancres: ${anchors.length}/3`);
        const anchor = anchors[0];
        const position = { x: anchor.x, y: anchor.y };
        updatePosition(employeeId, position);
      }
    }
  );
}

// Mise à jour de la position
function updatePosition(employeeId, position) {
  db.run(
    `UPDATE employees 
     SET last_position_x = ?, last_position_y = ?, last_seen = ?
     WHERE id = ?`,
    [position.x, position.y, Date.now(), employeeId],
    (err) => {
      if (!err) {
        console.log(`✅ Position enregistrée pour ${employeeId}`);
        broadcastPosition(employeeId, position);
      } else {
        console.error('❌ Update position error:', err.message);
      }
    }
  );
}

// Conversion RSSI → Distance
function rssiToDistance(rssi, txPower = -59, n = 2.0) {
  if (rssi === 0) return -1.0;
  return Math.pow(10, (txPower - rssi) / (10 * n));
}

// Trilatération
function trilateration(anchors) {
  anchors.sort((a, b) => a.distance - b.distance);
  const [a1, a2, a3] = anchors.slice(0, 3);
  
  const A = 2 * a2.x - 2 * a1.x;
  const B = 2 * a2.y - 2 * a1.y;
  const C = a1.distance**2 - a2.distance**2 - a1.x**2 + a2.x**2 - a1.y**2 + a2.y**2;
  const D = 2 * a3.x - 2 * a2.x;
  const E = 2 * a3.y - 2 * a2.y;
  const F = a2.distance**2 - a3.distance**2 - a2.x**2 + a3.x**2 - a2.y**2 + a3.y**2;
  
  const denom1 = E*A - B*D;
  const denom2 = B*D - A*E;

  if (Math.abs(denom1) < 0.0001 || Math.abs(denom2) < 0.0001) {
    // Centroïde pondéré
    const totalWeight = anchors.reduce((sum, a) => sum + 1 / Math.max(a.distance, 0.1), 0);
    const x = anchors.reduce((sum, a) => sum + a.x / Math.max(a.distance, 0.1), 0) / totalWeight;
    const y = anchors.reduce((sum, a) => sum + a.y / Math.max(a.distance, 0.1), 0) / totalWeight;
    return { x, y };
  }
  
  return { 
    x: (C*E - F*B) / denom1, 
    y: (C*D - A*F) / denom2 
  };
}

// Diffuser position
function broadcastPosition(employeeId, position) {
  db.get(`SELECT * FROM employees WHERE id = ?`, [employeeId], (err, employee) => {
    if (err || !employee) {
      console.error('❌ Broadcast error:', err ? err.message : 'Employé non trouvé');
      return;
    }
    
    const message = JSON.stringify({ 
      type: 'position_update', 
      employee, 
      timestamp: Date.now() 
    });
    
    [...clients.web, ...clients.mobile].forEach(c => {
      if (c.readyState === WebSocket.OPEN) {
        c.send(message);
        console.log(`📢 Position diffusée à ${c.clientType}: ${employee.prenom} ${employee.nom}`);
      }
    });
  });
}

// ================= QR & POINTAGE =================
function handleQRScan(data) {
  const { qr_code } = data;
  
  db.get('SELECT id, nom, prenom, is_active FROM employees WHERE id = ?', [qr_code], (err, employee) => {
    if (err || !employee) {
      return broadcast('scan_result', { success: false, message: 'Employé non trouvé' });
    }

    const now = Date.now();
    const newStatus = employee.is_active === 0 ? 1 : 0;
    const pointageType = newStatus === 1 ? 'ENTREE' : 'SORTIE';
    
    db.run('UPDATE employees SET is_active=?, last_seen=? WHERE id=?', 
      [newStatus, now, employee.id], 
      (err) => {
        if (err) {
          console.error('❌ QR scan update error:', err.message);
          return;
        }
        const pointageId = uuidv4();
        db.run(
          `INSERT INTO pointages (id, employee_id, employee_name, type, timestamp, date)
           VALUES (?,?,?,?,?,?)`,
          [pointageId, employee.id, `${employee.prenom} ${employee.nom}`, pointageType, now, new Date().toISOString().split('T')[0]],
          (err) => {
            if (err) {
              console.error('❌ Pointage insert error:', err.message);
              return;
            }
            broadcast('scan_result', {
              success: true,
              action: pointageType,
              message: `${employee.prenom} ${employee.nom} est ${pointageType === 'ENTREE' ? 'entré' : 'sorti'}`,
              employeeId: employee.id
            });
          }
        );
      }
    );
  });
}

function handlePointage(data) {
  const { employeeId, employeeName, type, timestamp, date } = data;
  const pointageId = uuidv4();
  
  db.run(
    `INSERT INTO pointages (id, employee_id, employee_name, type, timestamp, date) 
     VALUES (?,?,?,?,?,?)`,
    [pointageId, employeeId, employeeName, type, timestamp, date],
    (err) => {
      if (err) {
        console.error('❌ Pointage error:', err.message);
        return;
      }
      broadcast('pointage_recorded', { pointageId, employeeId, type, timestamp });
    }
  );
}

function sendActiveEmployees(ws) {
  db.all('SELECT * FROM employees WHERE is_active=1 ORDER BY nom, prenom', [], (err, employees) => {
    if (err) {
      console.error('❌ Active employees error:', err.message);
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ 
        type: 'active_employees', 
        employees, 
        timestamp: Date.now() 
      }));
      console.log(`📢 Employés actifs envoyés à ${ws.clientType}`);
    }
  });
}

function broadcast(type, data) {
  const message = JSON.stringify({ type, ...data, timestamp: Date.now() });
  [...clients.web, ...clients.mobile].forEach(c => {
    if (c.readyState === WebSocket.OPEN) {
      c.send(message);
      console.log(`📢 Broadcast ${type} à ${c.clientType}`);
    }
  });
}

// ================= ROUTES API =================
app.get('/', (req, res) => {
  const indexPath = path.join(publicDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, '<h1>🛰️ Serveur Suivi Temps Réel</h1><p>WebSocket actif</p>', 'utf-8');
  }
  res.sendFile(indexPath);
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    websocket: wss.clients.size,
    esp32: clients.esp32.size,
    web: clients.web.size,
    mobile: clients.mobile.size,
    timestamp: Date.now() 
  });
});

app.get('/api/employees', (req, res) => {
  db.all('SELECT * FROM employees ORDER BY nom, prenom', [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, employees: rows });
  });
});

app.get('/api/employees/active', (req, res) => {
  db.all('SELECT * FROM employees WHERE is_active=1', [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, employees: rows });
  });
});

app.post('/api/employees', (req, res) => {
  const { nom, prenom, type, email, telephone } = req.body;
  const id = uuidv4();
  
  db.run(
    `INSERT INTO employees (id, nom, prenom, type, is_active, created_at, email, telephone)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id, nom, prenom, type || 'employé', 0, Date.now(), email, telephone],
    (err) => {
      if (err) return res.status(500).json({ success: false, message: err.message });
      res.json({ success: true, id, message: 'Employé ajouté' });
    }
  );
});

app.post('/api/rssi-data', (req, res) => { 
  handleRSSIData(req.body); 
  res.json({ success: true, message: 'Données RSSI traitées' }); 
});

app.post('/api/scan', (req, res) => { 
  handleQRScan(req.body); 
  res.json({ success: true, message: 'Scan traité' }); 
});

app.post('/api/pointages', (req, res) => { 
  handlePointage(req.body); 
  res.json({ success: true, message: 'Pointage enregistré' }); 
});

app.get('/api/pointages/history', (req, res) => {
  db.all('SELECT * FROM pointages ORDER BY timestamp DESC LIMIT 100', [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, pointages: rows });
  });
});

// ================= DÉMARRAGE =================
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔════════════════════════════════════╗');
  console.log('║   Serveur Suivi Temps Réel       ║');
  console.log('╚════════════════════════════════════╝');
  console.log(`📡 Port: ${PORT}`);
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`🗄️  DB: ${DB_PATH}`);
  console.log('═══════════════════════════════════════\n');
});

// Arrêt propre
process.on('SIGTERM', () => { 
  console.log('⏹️  Arrêt...');
  server.close(() => { 
    db.close(); 
    process.exit(0); 
  });
});
