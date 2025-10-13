const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { Pool } = require('pg');
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

// Configuration PostgreSQL
const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_H2kziBw3QLma@ep-royal-base-a2sf764o-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
});

// Test connexion PostgreSQL
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Erreur connexion PostgreSQL:', err.message);
    return;
  }
  console.log('✅ Connecté à PostgreSQL');
  release();
  initDatabase();
});

// ================= MIDDLEWARES =================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Dossier public
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);
app.use(express.static(publicDir));

// ================= INIT DB =================
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY,
        nom TEXT NOT NULL,
        prenom TEXT NOT NULL,
        type TEXT,
        is_active INTEGER DEFAULT 0,
        last_position_x REAL,
        last_position_y REAL,
        last_seen BIGINT,
        created_at BIGINT,
        email TEXT,
        telephone TEXT,
        taux_horaire REAL,
        frais_ecolage REAL,
        profession TEXT,
        date_naissance TEXT,
        lieu_naissance TEXT
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS rssi_measurements (
        id SERIAL PRIMARY KEY,
        employee_id TEXT,
        anchor_id INTEGER,
        anchor_x REAL,
        anchor_y REAL,
        rssi INTEGER,
        mac TEXT,
        timestamp BIGINT,
        FOREIGN KEY (employee_id) REFERENCES employees(id)
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_rssi_employee 
      ON rssi_measurements(employee_id, timestamp DESC)
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pointages (
        id TEXT PRIMARY KEY,
        employee_id TEXT,
        employee_name TEXT,
        type TEXT,
        timestamp BIGINT,
        date TEXT,
        FOREIGN KEY (employee_id) REFERENCES employees(id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS salaries (
        id TEXT PRIMARY KEY,
        employee_id TEXT,
        employee_name TEXT,
        amount REAL,
        hours_worked REAL,
        type TEXT,
        period TEXT,
        date BIGINT,
        FOREIGN KEY (employee_id) REFERENCES employees(id)
      )
    `);

    // Vérifier si les données de test existent
    const { rows } = await pool.query('SELECT COUNT(*) as count FROM employees');
    if (rows[0].count == 0) {
      console.log('📝 Ajout données test...');
      const testData = [
        ['emp-1', 'fun', 'tero', 'employe', 1, Date.now()],
        ['emp-2', 'Rakoto', 'Jean', 'employe', 0, Date.now()],
        ['emp-3', 'Rasoa', 'Marie', 'manager', 0, Date.now()],
        ['emp-4', 'info', 'Spray', 'employe', 0, Date.now()]
      ];
      for (const emp of testData) {
        await pool.query(
          `INSERT INTO employees (id, nom, prenom, type, is_active, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6)`,
          emp
        );
      }
    }
    console.log('✅ Tables initialisées');
  } catch (err) {
    console.error('❌ Erreur initialisation DB:', err.message);
  }
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

  ws.send(JSON.stringify({
    type: 'connected',
    message: `Serveur OK - ${clientType}`,
    timestamp: Date.now(),
    clientType
  }));

  if (clientType === 'web' || clientType === 'mobile') {
    setTimeout(() => sendActiveEmployees(ws), 500);
  }

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      await handleWebSocketMessage(ws, data);
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

// Heartbeat
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

// ================= GESTION MESSAGES =================
async function handleWebSocketMessage(ws, data) {
  console.log(`📥 ${ws.clientType}: ${data.type}`);
  
  switch (data.type) {
    case 'rssi_data': 
      await handleRSSIData(data); 
      break;
    case 'scan_qr': 
      await handleQRScan(data); 
      break;
    case 'pointage': 
      await handlePointage(data); 
      break;
    case 'get_active_employees': 
      await sendActiveEmployees(ws); 
      break;
    case 'ping': 
    case 'pong': 
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() })); 
      break;
    default: 
      console.log('⚠️ Type inconnu:', data.type);
  }
}

// ================= TRAITEMENT RSSI =================
async function handleRSSIData(data) {
  const { anchor_id, anchor_x, anchor_y, badges, timestamp } = data;
  
  console.log(`📡 Ancre #${anchor_id} (${anchor_x}, ${anchor_y}): ${badges?.length || 0} badges`);
  
  if (!badges || badges.length === 0) return;

  for (const badge of badges) {
    const { ssid, mac, rssi } = badge;
    
    if (!ssid || ssid === 'None' || !ssid.trim()) continue;

    const employeeName = ssid.trim();
    
    console.log(`🔎 Recherche: "${employeeName}"`);
    
    try {
      const { rows } = await pool.query(
        `SELECT id, nom, prenom FROM employees 
         WHERE LOWER(TRIM(nom || ' ' || prenom)) = LOWER($1) 
            OR LOWER(TRIM(prenom || ' ' || nom)) = LOWER($1)
            OR LOWER(TRIM(nom)) = LOWER($1) 
            OR LOWER(TRIM(prenom)) = LOWER($1)
         LIMIT 1`,
        [employeeName]
      );

      if (rows.length === 0) {
        console.log(`⚠️ Non trouvé: "${employeeName}"`);
        continue;
      }

      const employee = rows[0];
      console.log(`✅ ${employee.prenom} ${employee.nom} (${employee.id})`);
      
      await pool.query(
        `INSERT INTO rssi_measurements (employee_id, anchor_id, anchor_x, anchor_y, rssi, mac, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [employee.id, anchor_id, anchor_x, anchor_y, rssi, mac, Date.now()]
      );
      
      console.log(`📝 RSSI: ${employee.prenom} ${employee.nom} = ${rssi} dBm`);
      await calculatePosition(employee.id);
    } catch (err) {
      console.error('❌ DB error:', err.message);
    }
  }
}

// ================= CALCUL POSITION =================
async function calculatePosition(employeeId) {
  const threshold = Date.now() - 5000;
  
  try {
    const { rows: measurements } = await pool.query(
      `SELECT anchor_id, anchor_x, anchor_y, rssi
       FROM rssi_measurements
       WHERE employee_id = $1 AND timestamp > $2
       ORDER BY timestamp DESC LIMIT 10`,
      [employeeId, threshold]
    );

    if (measurements.length === 0) {
      console.log(`⚠️ Aucune mesure récente pour ${employeeId}`);
      return;
    }
    
    if (measurements.length < 3) {
      console.log(`⚠️ Pas assez de mesures: ${measurements.length}/3`);
      const anchor = measurements[0];
      const position = { x: anchor.anchor_x, y: anchor.anchor_y };
      await updatePosition(employeeId, position);
      return;
    }

    console.log(`📊 ${measurements.length} mesures pour triangulation:`);
    
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
      await updatePosition(employeeId, position);
    } else {
      console.log(`⚠️ Pas assez d'ancres: ${anchors.length}/3`);
      const anchor = anchors[0];
      const position = { x: anchor.x, y: anchor.y };
      await updatePosition(employeeId, position);
    }
  } catch (err) {
    console.error('❌ Calc error:', err.message);
  }
}

// Mise à jour de la position
async function updatePosition(employeeId, position) {
  try {
    await pool.query(
      `UPDATE employees 
       SET last_position_x = $1, last_position_y = $2, last_seen = $3
       WHERE id = $4`,
      [position.x, position.y, Date.now(), employeeId]
    );
    console.log(`✅ Position enregistrée pour ${employeeId}`);
    await broadcastPosition(employeeId, position);
  } catch (err) {
    console.error('❌ Update position error:', err.message);
  }
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
async function broadcastPosition(employeeId, position) {
  try {
    const { rows } = await pool.query(`SELECT * FROM employees WHERE id = $1`, [employeeId]);
    if (rows.length === 0) {
      console.error('❌ Broadcast error: Employé non trouvé');
      return;
    }
    
    const employee = rows[0];
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
  } catch (err) {
    console.error('❌ Broadcast error:', err.message);
  }
}

// ================= QR & POINTAGE =================
async function handleQRScan(data) {
  const { qr_code } = data;
  
  try {
    const { rows } = await pool.query('SELECT id, nom, prenom, is_active FROM employees WHERE id = $1', [qr_code]);
    if (rows.length === 0) {
      return broadcast('scan_result', { success: false, message: 'Employé non trouvé' });
    }

    const employee = rows[0];
    const now = Date.now();
    const newStatus = employee.is_active === 0 ? 1 : 0;
    const pointageType = newStatus === 1 ? 'ENTREE' : 'SORTIE';
    
    await pool.query('UPDATE employees SET is_active=$1, last_seen=$2 WHERE id=$3', 
      [newStatus, now, employee.id]
    );
    
    const pointageId = uuidv4();
    await pool.query(
      `INSERT INTO pointages (id, employee_id, employee_name, type, timestamp, date)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [pointageId, employee.id, `${employee.prenom} ${employee.nom}`, pointageType, now, new Date().toISOString().split('T')[0]]
    );
    
    broadcast('scan_result', {
      success: true,
      action: pointageType,
      message: `${employee.prenom} ${employee.nom} est ${pointageType === 'ENTREE' ? 'entré' : 'sorti'}`,
      employeeId: employee.id
    });
  } catch (err) {
    console.error('❌ QR scan error:', err.message);
  }
}

async function handlePointage(data) {
  const { employeeId, employeeName, type, timestamp, date } = data;
  const pointageId = uuidv4();
  
  try {
    await pool.query(
      `INSERT INTO pointages (id, employee_id, employee_name, type, timestamp, date) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [pointageId, employeeId, employeeName, type, timestamp, date]
    );
    broadcast('pointage_recorded', { pointageId, employeeId, type, timestamp });
  } catch (err) {
    console.error('❌ Pointage error:', err.message);
  }
}

async function sendActiveEmployees(ws) {
  try {
    const { rows } = await pool.query('SELECT * FROM employees WHERE is_active=1 ORDER BY nom, prenom');
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ 
        type: 'active_employees', 
        employees: rows, 
        timestamp: Date.now() 
      }));
      console.log(`📢 Employés actifs envoyés à ${ws.clientType}`);
    }
  } catch (err) {
    console.error('❌ Active employees error:', err.message);
  }
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

app.get('/api/employees', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM employees ORDER BY nom, prenom');
    res.json({ success: true, employees: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/employees/active', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM employees WHERE is_active=1');
    res.json({ success: true, employees: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/employees', async (req, res) => {
  const { nom, prenom, type, email, telephone } = req.body;
  const id = uuidv4();
  
  try {
    await pool.query(
      `INSERT INTO employees (id, nom, prenom, type, is_active, created_at, email, telephone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, nom, prenom, type || 'employe', 0, Date.now(), email, telephone]
    );
    res.json({ success: true, id, message: 'Employé ajouté' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/rssi-data', async (req, res) => { 
  await handleRSSIData(req.body); 
  res.json({ success: true, message: 'Données RSSI traitées' }); 
});

app.post('/api/scan', async (req, res) => { 
  await handleQRScan(req.body); 
  res.json({ success: true, message: 'Scan traité' }); 
});

app.post('/api/pointages', async (req, res) => { 
  await handlePointage(req.body); 
  res.json({ success: true, message: 'Pointage enregistré' }); 
});

app.get('/api/pointages/history', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pointages ORDER BY timestamp DESC LIMIT 100');
    res.json({ success: true, pointages: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ================= DÉMARRAGE =================
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔════════════════════════════════════╗');
  console.log('║   Serveur Suivi Temps Réel       ║');
  console.log('╚════════════════════════════════════╝');
  console.log(`📡 Port: ${PORT}`);
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`🗄️ DB: PostgreSQL Neon`);
  console.log('═══════════════════════════════════════\n');
});

// Arrêt propre
process.on('SIGTERM', async () => { 
  console.log('⏹️ Arrêt...');
  server.close(async () => { 
    await pool.end(); 
    process.exit(0); 
  });
});
