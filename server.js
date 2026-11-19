
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

    get(uuid) {
        return this.players.find(player => player.uuid === uuid);
    },

    add(uuid, roomCode) {
        const jogadoresNaSala = this.getByRoom(roomCode);

        const spawnPositions = [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 0, y: 100 },
            { x: 100, y: 100 }
        ];

        const spawn = spawnPositions[
            jogadoresNaSala.length % spawnPositions.length
        ];

        const player = {
            uuid,
            room: roomCode,
            x: spawn.x,
            y: spawn.y,
            z: 0,
            r_y: 0
        };

        this.players.push(player);

        console.log(`Jogador ${uuid} criado.`);

        return player;
    },

    update(uuid, content) {
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

    remove(uuid) {
        this.players = this.players.filter(
            player => player.uuid !== uuid
        );
    },

    getByRoom(roomCode) {
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
// VERIFICAR VITÓRIA
// ========================

function verificarVitoria(room) {
    const vivos = Object.keys(room.players).filter(
        id => room.alive[id]
    );

    const impostores = vivos.filter(
        id => room.roles[id] === "impostor"
    );

    const crewmates = vivos.filter(
        id => room.roles[id] === "crewmate"
    );

    if (impostores.length === 0) {
        room.finished = true;

        sendToRoom(room, {
            cmd: "game_over",
            content: {
                winner: "crewmates"
            }
        });

        console.log("Crewmates venceram!");

        return;
    }

    if (crewmates.length === 0 || impostores.length >= crewmates.length) {
        room.finished = true;

        sendToRoom(room, {
            cmd: "game_over",
            content: {
                winner: "impostor"
            }
        });

        console.log("Impostor venceu!");
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
            uuid
        }
    }));

    // ========================
    // RECEBER MENSAGENS
    // ========================

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

                if (socket.roomId) return;

                let newRoomId;

                do {
                    newRoomId = generateRoomCode();
                } while (rooms.has(newRoomId));

                socket.roomId = newRoomId;

                const room = {
                    players: {},
                    host: uuid,
                    started: false,
                    finished: false,
                    roles: {},
                    alive: {}
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

                if (socket.roomId) return;

                const roomCode = String(content.code || "")
                    .trim()
                    .toUpperCase();

                const roomToJoin = rooms.get(roomCode);

                if (!roomToJoin) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: {
                            msg: "Sala não encontrada."
                        }
                    }));

                    return;
                }

                if (roomToJoin.started) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: {
                            msg: "A partida já começou."
                        }
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
                    content: {
                        player: newPlayer
                    }
                }));

                const roomPlayers = playerlist
                    .getByRoom(roomCode)
                    .filter(player => player.uuid !== uuid);

                socket.send(JSON.stringify({
                    cmd: "spawn_network_players",
                    content: {
                        players: roomPlayers
                    }
                }));

                for (const clientUuid in roomToJoin.players) {

                    const client = roomToJoin.players[clientUuid];

                    if (
                        client !== socket &&
                        client.readyState === WebSocket.OPEN
                    ) {
                        client.send(JSON.stringify({
                            cmd: "spawn_new_player",
                            content: {
                                player: newPlayer
                            }
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

                if (!room) return;
                if (uuid !== room.host) return;
                if (room.started) return;

                const jogadores = Object.keys(room.players);

                if (jogadores.length < 2) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: {
                            msg: "É necessário pelo menos 2 jogadores."
                        }
                    }));

                    return;
                }

                // Escolher impostor
                const indice = Math.floor(
                    Math.random() * jogadores.length
                );

                const impostor = jogadores[indice];

                room.started = true;

                for (const id of jogadores) {
                    room.roles[id] =
                        id === impostor ? "impostor" : "crewmate";

                    room.alive[id] = true;
                }

                console.log("Partida iniciada:", socket.roomId);
                console.log("Impostor:", impostor);

                // Enviar função individualmente
                for (const id of jogadores) {

                    const client = room.players[id];

                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            cmd: "start_game",
                            content: {
                                scene: "test_world",
                                role: room.roles[id],
                                alive: true
                            }
                        }));
                    }
                }

                break;
            }

            // ========================
            // ATUALIZAR POSIÇÃO
            // ========================

            case "position": {

                const room = rooms.get(socket.roomId);

                if (!room || !room.started || room.finished) return;
                if (!room.alive[uuid]) return;

                playerlist.update(uuid, content);

                const player = playerlist.get(uuid);

                if (!player) return;

                for (const clientUuid in room.players) {

                    const client = room.players[clientUuid];

                    if (
                        client !== socket &&
                        client.readyState === WebSocket.OPEN
                    ) {
                        client.send(JSON.stringify({
                            cmd: "update_position",
                            content: {
                                uuid,
                                x: player.x,
                                y: player.y,
                                z: player.z,
                                r_y: player.r_y
                            }
                        }));
                    }
                }

                break;
            }

            // ========================
            // ELIMINAR JOGADOR
            // ========================

            case "kill": {

                const room = rooms.get(socket.roomId);

                if (!room || !room.started || room.finished) return;

                const targetUuid = String(content.uuid || "");

                if (room.roles[uuid] !== "impostor") return;
                if (!room.alive[uuid]) return;
                if (targetUuid === uuid) return;

                if (!room.players[targetUuid]) return;
                if (room.roles[targetUuid] !== "crewmate") return;
                if (!room.alive[targetUuid]) return;

                room.alive[targetUuid] = false;

                console.log(`${uuid} eliminou ${targetUuid}`);

                sendToRoom(room, {
                    cmd: "player_killed",
                    content: {
                        uuid: targetUuid
                    }
                });

                verificarVitoria(room);

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
                        uuid,
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

            if (room.started && !room.finished) {
                delete room.alive[uuid];
                delete room.roles[uuid];
            }

            for (const clientUuid in room.players) {

                const client = room.players[clientUuid];

                if (client.readyState === WebSocket.OPEN) {

                    client.send(JSON.stringify({
                        cmd: "player_disconnected",
                        content: {
                            uuid
                        }
                    }));
                }
            }

            if (Object.keys(room.players).length === 0) {

                rooms.delete(socket.roomId);

                console.log(`Sala ${socket.roomId} removida.`);

            } else if (room.started && !room.finished) {

                verificarVitoria(room);
            }
        }
    });
});
