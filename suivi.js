const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8080;

// === Serveur HTTP pour les fichiers statiques ===
app.use(express.static(path.join(__dirname, 'public')));

// Créer le serveur HTTP pour WebSocket
const server = http.createServer(app);

// Stocker les badges détectés
let badges = [];

// === Serveur WebSocket ===
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
                broadcastToWeb({
                    type: 'positions',
                    badges: badges.map(b => ({
                        ssid: b.ssid,
                        x: b.smoothedX,
                        y: b.smoothedY
                    }))
                });
            }

            // === Identification Client Web ===
            if (data.type === 'web_client') {
                clientType = 'Web Browser';
                ws.isWebClient = true;
                console.log('🌐 Client web connecté');

                // Envoyer les positions actuelles immédiatement
                ws.send(JSON.stringify({
                    type: 'positions',
                    badges: badges.map(b => ({
                        ssid: b.ssid,
                        x: b.smoothedX,
                        y: b.smoothedY
                    }))
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

// === Diffusion uniquement aux clients web ===
function broadcastToWeb(message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.isWebClient) {
            client.send(JSON.stringify(message));
        }
    });
}

// === Mise à jour des positions via trilatération avec filtrage ===
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
                smoothedX: 0,
                smoothedY: 0,
                lastUpdate: Date.now()
            };
            badges.push(badge);
        }

        badge.distances[anchorId] = dist.distance;
        badge.lastUpdate = Date.now();

        // Si toutes les distances sont disponibles, calculer trilatération
        if (badge.distances[1] && badge.distances[2] && badge.distances[3]) {
            const pos = trilaterate(
                anchors[0], badge.distances[1],
                anchors[1], badge.distances[2],
                anchors[2], badge.distances[3]
            );

            if (pos) {
                badge.x = pos.x;
                badge.y = pos.y;

                // 🔹 Filtrage position (moyenne mobile simple)
                const alpha = 0.6;
                badge.smoothedX = alpha * badge.smoothedX + (1 - alpha) * badge.x;
                badge.smoothedY = alpha * badge.smoothedY + (1 - alpha) * badge.y;
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

// === Démarrage du serveur ===
server.listen(PORT, () => {
    console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
});
