const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8080;

// === Serveur HTTP avec Express ===
app.use(express.static(path.join(__dirname, 'public')));

// Créer le serveur HTTP pour WebSocket
const server = http.createServer(app);

// Stocker les positions des badges
let badges = [];

// Créer le serveur WebSocket
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  console.log('✅ Client connecté depuis:', clientIP);

  let clientType = 'unknown';

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // === Identification ESP32 ===
      if (data.type === 'hello') {
        clientType = `Ancre ${data.anchorId}`;
        console.log(`🎯 ${clientType} identifiée`);
        ws.send(JSON.stringify({ type: 'welcome', message: 'Connexion établie' }));
        return;
      }

      // === Données d'ancre (ESP32) ===
      if (data.type === 'anchor_data') {
        clientType = `Ancre ${data.anchorId}`;
        console.log(`📡 ${clientType}: ${data.distances.length} badge(s) détecté(s)`);

        data.distances.forEach(d => {
          console.log(`   - ${d.ssid}: ${d.rssi} dBm → ${d.distance.toFixed(2)}m`);
        });

        updatePositions(data);

        // Diffuser les nouvelles positions aux clients web
        broadcastToWeb({
          type: 'positions',
          badges: badges
        });
      }

      // === Identification Client Web ===
      if (data.type === 'web_client') {
        clientType = 'Web Browser';
        ws.isWebClient = true;
        console.log('🌐 Client web connecté');

        // Envoyer les positions actuelles
        ws.send(JSON.stringify({
          type: 'positions',
          badges: badges
        }));
      }

    } catch (e) {
      console.error('❌ Erreur parsing message:', e.message);
    }
  });

  ws.on('close', () => {
    console.log(`❌ ${clientType} déconnecté`);
  });

  ws.on('error', (error) => {
    console.error(`⚠️ Erreur WebSocket (${clientType}):`, error.message);
  });
});

// === Diffusion uniquement vers les clients web ===
function broadcastToWeb(message) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.isWebClient) {
      client.send(JSON.stringify(message));
    }
  });
}

// === Mise à jour des positions via trilatération ===
function updatePositions(anchorData) {
  const { anchorId, distances } = anchorData;

  const anchors = [
    { id: 1, x: 0, y: 0 },
    { id: 2, x: 5, y: 0 },
    { id: 3, x: 2.5, y: 4 }
  ];

  distances.forEach(dist => {
    let badge = badges.find(b => b.ssid === dist.ssid);

    if (!badge) {
      badge = {
        ssid: dist.ssid,
        distances: { 1: null, 2: null, 3: null },
        x: 0,
        y: 0,
        lastUpdate: Date.now()
      };
      badges.push(badge);
    }

    badge.distances[anchorId] = dist.distance;
    badge.lastUpdate = Date.now();

    if (badge.distances[1] && badge.distances[2] && badge.distances[3]) {
      const pos = trilaterate(
        anchors[0], badge.distances[1],
        anchors[1], badge.distances[2],
        anchors[2], badge.distances[3]
      );

      if (pos) {
        badge.x = pos.x;
        badge.y = pos.y;
      }
    }
  });

  // Supprimer les badges inactifs (>10s)
  badges = badges.filter(b => Date.now() - b.lastUpdate < 10000);
}

// === Calcul trilatération 2D ===
function trilaterate(p1, r1, p2, r2, p3, r3) {
  const A = 2 * (p2.x - p1.x);
  const B = 2 * (p2.y - p1.y);
  const C = r1 * r1 - r2 * r2 - p1.x * p1.x + p2.x * p2.x - p1.y * p1.y + p2.y * p2.y;
  const D = 2 * (p3.x - p2.x);
  const E = 2 * (p3.y - p2.y);
  const F = r2 * r2 - r3 * r3 - p2.x * p2.x + p3.x * p3.x - p2.y * p2.y + p3.y * p3.y;

  const denom = E * A - B * D;
  if (Math.abs(denom) < 0.0001) return null;

  const x = (C * E - F * B) / denom;
  const y = (C * D - A * F) / denom;

  return { x, y };
}

// === Démarrer le serveur ===
server.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
});
