const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// Configuration
const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// WebSocket avec support des proxy (Render)
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: false,
  clientTracking: true
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Base de données SQLite (persiste avec Render Disk)
const DB_PATH = process.env.DATABASE_URL || './tracking.db';
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('❌ Erreur DB:', err);
  } else {
    console.log('✅ Connexion DB établie:', DB_PATH);
    initDatabase();
  }
});

// Initialisation des tables
function initDatabase() {
  db.serialize(() => {
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

    // Ajouter des données de test si vide
    db.get("SELECT COUNT(*) as count FROM employees", [], (err, row) => {
      if (!err && row.count === 0) {
        console.log('📝 Ajout de données de test...');
        const testEmployees = [
          ['emp-1', 'Rakoto', 'Jean', 'employé', 1, Date.now()],
          ['emp-2', 'Rasoa', 'Marie', 'manager', 0, Date.now()],
          ['emp-3', 'Rabe', 'Paul', 'employé', 1, Date.now()]
        ];
        
        testEmployees.forEach(emp => {
          db.run(
            `INSERT INTO employees (id, nom, prenom, type, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            emp
          );
        });
      }
    });
  });

  console.log('✅ Tables initialisées');
}

// Stockage des clients WebSocket
const clients = {
  web: new Set(),
  esp32: new Set(),
  mobile: new Set()
};

// Gestion des connexions WebSocket
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const clientType = url.searchParams.get('type') || 'web';
  
  console.log(`🔌 Nouvelle connexion WebSocket: ${clientType} (Total: ${wss.clients.size})`);

  ws.clientType = clientType;
  ws.isAlive = true;
  
  if (clientType === 'esp32') {
    clients.esp32.add(ws);
  } else if (clientType === 'mobile') {
    clients.mobile.add(ws);
  } else {
    clients.web.add(ws);
  }

  // Message de bienvenue
  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Connecté au serveur de suivi',
    timestamp: Date.now(),
    clientType: clientType
  }));

  // Envoyer l'état initial
  if (clientType === 'web' || clientType === 'mobile') {
    setTimeout(() => sendActiveEmployees(ws), 500);
  }

  // Pong pour heartbeat
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Réception des messages
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleWebSocketMessage(ws, data);
    } catch (error) {
      console.error('❌ Erreur parsing message:', error);
    }
  });

  // Déconnexion
  ws.on('close', () => {
    console.log(`🔌 Déconnexion: ${clientType} (Restant: ${wss.clients.size - 1})`);
    clients.esp32.delete(ws);
    clients.web.delete(ws);
    clients.mobile.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('❌ Erreur WebSocket:', error.message);
  });
});

// Heartbeat pour détecter les connexions mortes
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// Gestion des messages WebSocket
function handleWebSocketMessage(ws, data) {
  console.log(`📥 Message (${ws.clientType}): ${data.type}`);

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
      console.log('⚠️ Type de message inconnu:', data.type);
  }
}

// Traitement des données RSSI
function handleRSSIData(data) {
  const { anchor_id, anchor_x, anchor_y, badges } = data;
  
  console.log(`📡 RSSI Ancre #${anchor_id} (${anchor_x}, ${anchor_y}): ${badges?.length || 0} badges`);

  if (!badges || badges.length === 0) return;

  badges.forEach(badge => {
    const { ssid, mac, rssi } = badge;
    
    if (!ssid || ssid === 'None' || !ssid.trim()) return;

    const employeeName = ssid.replace('BADGE_', '').trim();
    
    db.get(
      `SELECT id FROM employees 
       WHERE nom || ' ' || prenom = ? OR nom = ? OR prenom = ? 
       LIMIT 1`,
      [employeeName, employeeName, employeeName],
      (err, employee) => {
        if (err || !employee) {
          console.log(`⚠️ Employé non trouvé: ${employeeName}`);
          return;
        }

        db.run(
          `INSERT INTO rssi_measurements 
           (employee_id, anchor_id, anchor_x, anchor_y, rssi, mac, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [employee.id, anchor_id, anchor_x, anchor_y, rssi, mac, Date.now()],
          (err) => {
            if (!err) calculatePosition(employee.id);
          }
        );
      }
    );
  });
}

// Calcul de position
function calculatePosition(employeeId) {
  const threshold = Date.now() - 5000;

  db.all(
    `SELECT anchor_id, anchor_x, anchor_y, rssi
     FROM rssi_measurements
     WHERE employee_id = ? AND timestamp > ?
     ORDER BY timestamp DESC
     LIMIT 10`,
    [employeeId, threshold],
    (err, measurements) => {
      if (err || !measurements || measurements.length < 3) return;

      const anchorData = {};
      measurements.forEach(m => {
        const distance = rssiToDistance(m.rssi);
        if (!anchorData[m.anchor_id] || distance < anchorData[m.anchor_id].distance) {
          anchorData[m.anchor_id] = {
            x: m.anchor_x,
            y: m.anchor_y,
            distance: distance
          };
        }
      });

      const anchors = Object.values(anchorData);
      
      if (anchors.length >= 3) {
        const position = trilateration(anchors);
        
        db.run(
          `UPDATE employees 
           SET last_position_x = ?, last_position_y = ?, last_seen = ?
           WHERE id = ?`,
          [position.x, position.y, Date.now(), employeeId],
          (err) => {
            if (!err) {
              console.log(`📍 Position: ${employeeId} (${position.x.toFixed(2)}, ${position.y.toFixed(2)})`);
              broadcastPosition(employeeId, position);
            }
          }
        );
      }
    }
  );
}

function rssiToDistance(rssi, txPower = -59, n = 2.0) {
  if (rssi === 0) return -1.0;
  const ratio = (txPower - rssi) / (10 * n);
  return Math.pow(10, ratio);
}

function trilateration(anchors) {
  anchors.sort((a, b) => a.distance - b.distance);
  const [a1, a2, a3] = anchors.slice(0, 3);
  
  const A = 2 * a2.x - 2 * a1.x;
  const B = 2 * a2.y - 2 * a1.y;
  const C = a1.distance ** 2 - a2.distance ** 2 - a1.x ** 2 + a2.x ** 2 - a1.y ** 2 + a2.y ** 2;
  const D = 2 * a3.x - 2 * a2.x;
  const E = 2 * a3.y - 2 * a2.y;
  const F = a2.distance ** 2 - a3.distance ** 2 - a2.x ** 2 + a3.x ** 2 - a2.y ** 2 + a3.y ** 2;

  const denom1 = E * A - B * D;
  const denom2 = B * D - A * E;

  if (Math.abs(denom1) < 0.0001 || Math.abs(denom2) < 0.0001) {
    const totalWeight = anchors.reduce((sum, a) => sum + 1 / Math.max(a.distance, 0.1), 0);
    const x = anchors.reduce((sum, a) => sum + a.x / Math.max(a.distance, 0.1), 0) / totalWeight;
    const y = anchors.reduce((sum, a) => sum + a.y / Math.max(a.distance, 0.1), 0) / totalWeight;
    return { x, y };
  }

  return { 
    x: (C * E - F * B) / denom1,
    y: (C * D - A * F) / denom2
  };
}

function broadcastPosition(employeeId, position) {
  db.get(
    `SELECT * FROM employees WHERE id = ?`,
    [employeeId],
    (err, employee) => {
      if (err || !employee) return;

      const message = JSON.stringify({
        type: 'position_update',
        employee: employee,
        timestamp: Date.now()
      });

      [...clients.web, ...clients.mobile].forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    }
  );
}

function handleQRScan(data) {
  const { qr_code } = data;
  
  db.get('SELECT id, nom, prenom, is_active FROM employees WHERE id = ?', [qr_code], (err, employee) => {
    if (err || !employee) {
      broadcast('scan_result', { success: false, message: 'Employé non trouvé' });
      return;
    }

    const now = Date.now();
    const newStatus = employee.is_active === 0 ? 1 : 0;
    const pointageType = newStatus === 1 ? 'ENTREE' : 'SORTIE';

    db.run(
      'UPDATE employees SET is_active = ?, last_seen = ? WHERE id = ?',
      [newStatus, now, employee.id],
      (err) => {
        if (err) return;

        const pointageId = uuidv4();
        db.run(
          `INSERT INTO pointages (id, employee_id, employee_name, type, timestamp, date)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [pointageId, employee.id, `${employee.prenom} ${employee.nom}`, pointageType, now, new Date().toISOString().split('T')[0]],
          () => {
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
     VALUES (?, ?, ?, ?, ?, ?)`,
    [pointageId, employeeId, employeeName, type, timestamp, date],
    (err) => {
      if (!err) {
        broadcast('pointage_recorded', { pointageId, employeeId, type, timestamp });
      }
    }
  );
}

function sendActiveEmployees(ws) {
  db.all(
    `SELECT * FROM employees WHERE is_active = 1 ORDER BY nom, prenom`,
    [],
    (err, employees) => {
      if (err) return;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'active_employees',
          employees: employees,
          timestamp: Date.now()
        }));
      }
    }
  );
}

function broadcast(type, data) {
  const message = JSON.stringify({ type, ...data, timestamp: Date.now() });
  [...clients.web, ...clients.mobile].forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// === ROUTES API REST (Compatibilité Flask) ===

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    websocket: wss.clients.size,
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
  db.all('SELECT * FROM employees WHERE is_active = 1', [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, employees: rows });
  });
});

app.post('/api/employees', (req, res) => {
  const { nom, prenom, type, email, telephone } = req.body;
  const id = uuidv4();
  
  db.run(
    `INSERT INTO employees (id, nom, prenom, type, is_active, created_at, email, telephone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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

// Démarrage du serveur
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}`);
  console.log(`🌐 Dashboard: http://localhost:${PORT}`);
  console.log(`🔍 Environnement: ${process.env.NODE_ENV || 'development'}`);
});

// Gestion de l'arrêt propre
process.on('SIGTERM', () => {
  console.log('⏹️ Arrêt du serveur...');
  server.close(() => {
    db.close();
    process.exit(0);
  });
});