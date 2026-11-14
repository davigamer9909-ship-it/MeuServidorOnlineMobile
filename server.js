
const express = require("express");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 9090;

const server = app.listen(PORT, () => {
    console.log(`Servidor iniciado na porta: ${PORT}`);
});

const wss = new WebSocket.Server({ server });

const rooms = new Map();

// ========================
// GERAR CÓDIGO DA SALA
// ========================

function generateRoomCode(length = 5) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";

    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    return result;
}

// ========================
// LISTA DE JOGADORES
// ========================

const playerlist = {
    players: [],

    getAll: function() {
        return this.players;
    },

    get: function(uuid) {
        return this.players.find(player => player.uuid === uuid);
    },

    add: function(uuid, roomCode) {

        const player = {
            uuid: uuid,
            room: roomCode,

            // Coordenadas iniciais 3D
            x: 0,
            y: 2,
            z: 0,

            // Rotação
            r_y: 0
        };

        this.players.push(player);

        return player;
    },

    update: function(uuid, content) {

        const player = this.get(uuid);

        if (!player) return;

        if (Number.isFinite(content.x))
            player.x = content.x;

        if (Number.isFinite(content.y))
            player.y = content.y;

        if (Number.isFinite(content.z))
            player.z = content.z;

        if (Number.isFinite(content.r_y))
            player.r_y = content.r_y;
    },

    remove: function(uuid) {
        this.players = this.players.filter(
            player => player.uuid !== uuid
        );
    },

    getByRoom: function(roomCode) {
        return this.players.filter(
            player => player.room === roomCode
        );
    }
};

// ========================
// ENVIAR PARA A SALA
// ========================

function sendToRoom(room, message) {

    if (!room) return;

    const packet = JSON.stringify(message);

    for (const clientUuid in room.players) {

        const client = room.players[clientUuid];

        if (client.readyState === WebSocket.OPEN) {
            client.send(packet);
        }
    }
}

// ========================
// CONEXÃO
// ========================

wss.on("connection", (socket) => {

    const uuid = uuidv4();

    socket.uuid = uuid;

    console.log(`Cliente conectado: ${uuid}`);

    socket.send(JSON.stringify({
        cmd: "joined_server",
        content: {
            uuid: uuid
        }
    }));

    socket.on("message", (message) => {

        let data;

        try {
            data = JSON.parse(message.toString());
        } catch (err) {
            console.error("Erro ao interpretar mensagem:", err);
            return;
        }

        const content = data.content || {};

        switch (data.cmd) {

            // ========================
            // CRIAR SALA
            // ========================

            case "create_room": {

                const newRoomId = generateRoomCode();

                socket.roomId = newRoomId;

                const room = {
                    players: {},
                    host: uuid,
                    started: false
                };

                rooms.set(newRoomId, room);

                room.players[uuid] = socket;

                const newPlayer = playerlist.add(uuid, newRoomId);

                console.log(`Sala ${newRoomId} criada.`);

                socket.send(JSON.stringify({
                    cmd: "room_created",
                    content: {
                        code: newRoomId,
                        is_host: true
                    }
                }));

                socket.send(JSON.stringify({
                    cmd: "spawn_local_player",
                    content: {
                        player: newPlayer
                    }
                }));

                break;
            }

            // ========================
            // ENTRAR NA SALA
            // ========================

            
case "join_room": {

    const roomCode = String(content.code || "")
        .trim()
        .toUpperCase();

    const roomToJoin = rooms.get(roomCode);

    if (!roomToJoin) {
        socket.send(JSON.stringify({
            cmd: "error",
            content: { msg: "Sala não encontrada." }
        }));
        return;
    }

    if (roomToJoin.started) {
        socket.send(JSON.stringify({
            cmd: "error",
            content: { msg: "A partida já começou." }
        }));
        return;
    }

    socket.roomId = roomCode;
    roomToJoin.players[uuid] = socket;

    const newPlayer = playerlist.add(uuid, roomCode);

    console.log(`Jogador entrou na sala ${roomCode}.`);

    socket.send(JSON.stringify({
        cmd: "room_joined",
        content: {
            code: roomCode,
            is_host: false
        }
    }));

    socket.send(JSON.stringify({
        cmd: "spawn_local_player",
        content: { player: newPlayer }
    }));

    const roomPlayers = playerlist.getByRoom(roomCode)
        .filter(p => p.uuid !== uuid);

    socket.send(JSON.stringify({
        cmd: "spawn_network_players",
        content: { players: roomPlayers }
    }));

    for (const clientUuid in roomToJoin.players) {
        const client = roomToJoin.players[clientUuid];

        if (client !== socket && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                cmd: "spawn_new_player",
                content: { player: newPlayer }
            }));
        }
    }

    // IMPORTANTE:
    // Não existe start_game aqui.
    // O jogador permanece na sala de espera.

    break;
}


            // ========================
            // INICIAR PARTIDA
            // ========================

            case "start_game": {

                const room = rooms.get(socket.roomId);

                if (!room) return;

                if (uuid !== room.host) return;

                if (room.started) return;

                room.started = true;

                console.log(`Partida iniciada: ${socket.roomId}`);

                sendToRoom(room, {
                    cmd: "start_game",
                    content: {}
                });

                break;
            }

            // ========================
            // ATUALIZAR POSIÇÃO 3D
            // ========================

            case "position": {

                const room = rooms.get(socket.roomId);

                if (!room) return;

                // Atualiza os dados do jogador
                playerlist.update(uuid, content);

                // Envia posição e rotação aos outros jogadores
                for (const clientUuid in room.players) {

                    const client = room.players[clientUuid];

                    if (
                        client !== socket &&
                        client.readyState === WebSocket.OPEN
                    ) {
                        client.send(JSON.stringify({
                            cmd: "update_position",
                            content: {
                                uuid: uuid,
                                x: content.x,
                                y: content.y,
                                z: content.z,
                                r_y: content.r_y
                            }
                        }));
                    }
                }

                break;
            }

            // ========================
            // CHAT
            // ========================

            case "chat": {

                const room = rooms.get(socket.roomId);

                if (!room) return;

                sendToRoom(room, {
                    cmd: "new_chat_message",
                    content: {
                        uuid: uuid,
                        msg: content.msg
                    }
                });

                break;
            }
        }
    });

    // ========================
    // DESCONECTAR
    // ========================

    socket.on("close", () => {

        console.log(`Cliente desconectado: ${uuid}`);

        playerlist.remove(uuid);

        const room = rooms.get(socket.roomId);

        if (room) {

            delete room.players[uuid];

            for (const clientUuid in room.players) {

                const client = room.players[clientUuid];

                if (client.readyState === WebSocket.OPEN) {

                    client.send(JSON.stringify({
                        cmd: "player_disconnected",
                        content: {
                            uuid: uuid
                        }
                    }));
                }
            }

            if (Object.keys(room.players).length === 0) {

                rooms.delete(socket.roomId);

                console.log(`Sala ${socket.roomId} vazia e removida.`);
            }
        }
    });
});
