
// ========================
// Servidor Multiplayer Simples para Godot
// Baseado no servidor original do Zee GameDev
// ========================

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
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';

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
        const playersInRoom = this.getByRoom(roomCode);
        const isFirstPlayer = playersInRoom.length === 0;

        let player = {
            uuid,
            room: roomCode,
            x: isFirstPlayer ? 550 : 700,
            y: 300,
        };

        this.players.push(player);
        return player;
    },

    update: function(uuid, newX, newY) {
        const player = this.get(uuid);

        if (player) {
            player.x = newX;
            player.y = newY;
        }
    },

    remove: function(uuid) {
        this.players = this.players.filter(player => player.uuid !== uuid);
    },

    getByRoom: function(roomCode) {
        return this.players.filter(player => player.room === roomCode);
    }
};

// ========================
// ENVIAR MENSAGEM
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
// CONEXÃO DOS CLIENTES
// ========================

wss.on("connection", (socket) => {

    const uuid = uuidv4();
    socket.uuid = uuid;

    console.log(`Cliente conectado: ${uuid}`);

    socket.send(JSON.stringify({
        cmd: "joined_server",
        content: { uuid: uuid }
    }));

    // ========================
    // RECEBER MENSAGENS
    // ========================

    socket.on("message", (message) => {

        let data;

        try {
            data = JSON.parse(message.toString());
        } catch (err) {
            console.error("Erro ao parsear mensagem:", err);
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

                console.log(`Sala ${newRoomId} criada pelo jogador ${uuid}`);

                socket.send(JSON.stringify({
                    cmd: "room_created",
                    content: {
                        code: newRoomId,
                        is_host: true
                    }
                }));

                socket.send(JSON.stringify({
                    cmd: "spawn_local_player",
                    content: { player: newPlayer }
                }));

                break;
            }

            // ========================
            // ENTRAR NA SALA
            // ========================

            case "join_room": {

                const roomCode = String(content.code || "").trim().toUpperCase();
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

                console.log(`Jogador ${uuid} entrou na sala ${roomCode}`);

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

                // Avisa os jogadores antigos
                for (const clientUuid in roomToJoin.players) {

                    const client = roomToJoin.players[clientUuid];

                    if (
                        client !== socket &&
                        client.readyState === WebSocket.OPEN
                    ) {
                        client.send(JSON.stringify({
                            cmd: "spawn_new_player",
                            content: { player: newPlayer }
                        }));
                    }
                }

                break;
            }

            // ========================
            // INICIAR PARTIDA
            // ========================

            case "start_game": {

                const room = rooms.get(socket.roomId);

                if (!room) {
                    console.log("Sala não encontrada para iniciar.");
                    return;
                }

                // Somente o host pode iniciar
                if (uuid !== room.host) {
                    console.log("Jogador sem permissão tentou iniciar.");
                    return;
                }

                if (room.started) {
                    return;
                }

                room.started = true;

                console.log(`Partida iniciada na sala ${socket.roomId}`);

                // Envia para TODOS os jogadores
                sendToRoom(room, {
                    cmd: "start_game",
                    content: {}
                });

                break;
            }

            // ========================
            // ATUALIZAR POSIÇÃO
            // ========================

            case "position": {

                playerlist.update(
                    uuid,
                    content.x,
                    content.y
                );

                const room = rooms.get(socket.roomId);

                if (room) {

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
                                    y: content.y
                                }
                            }));
                        }
                    }
                }

                break;
            }

            // ========================
            // CHAT
            // ========================

            case "chat": {

                const room = rooms.get(socket.roomId);

                if (room) {
                    sendToRoom(room, {
                        cmd: "new_chat_message",
                        content: {
                            uuid: uuid,
                            msg: content.msg
                        }
                    });
                }

                break;
            }
        }
    });

    // ========================
    // DESCONECTAR JOGADOR
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
                        content: { uuid: uuid }
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
