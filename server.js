
const express = require("express");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 9090;

const server = app.listen(PORT, () => {
    console.log("Servidor iniciado na porta:", PORT);
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();

// =====================================
// CÓDIGO DA SALA
// =====================================

function generateRoomCode(length = 5) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";

    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    return result;
}

// =====================================
// JOGADORES
// =====================================

const playerlist = {
    players: [],

    get(uuid) {
        return this.players.find(p => p.uuid === uuid);
    },

    add(uuid, roomCode) {
        const jogadores = this.getByRoom(roomCode);

        const positions = [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 0, y: 100 },
            { x: 100, y: 100 }
        ];

        const spawn = positions[jogadores.length % positions.length];

        const player = {
            uuid,
            room: roomCode,
            x: spawn.x,
            y: spawn.y,
            z: 0,
            r_y: 0
        };

        this.players.push(player);
        return player;
    },

    update(uuid, content) {
        const player = this.get(uuid);
        if (!player) return;

        if (Number.isFinite(content.x)) player.x = content.x;
        if (Number.isFinite(content.y)) player.y = content.y;
        if (Number.isFinite(content.z)) player.z = content.z;
        if (Number.isFinite(content.r_y)) player.r_y = content.r_y;
    },

    remove(uuid) {
        this.players = this.players.filter(p => p.uuid !== uuid);
    },

    getByRoom(roomCode) {
        return this.players.filter(p => p.room === roomCode);
    }
};

// =====================================
// ENVIAR PARA A SALA
// =====================================

function sendToRoom(room, message) {
    if (!room) return;

    const packet = JSON.stringify(message);

    for (const id in room.players) {
        const client = room.players[id];

        if (client.readyState === WebSocket.OPEN) {
            client.send(packet);
        }
    }
}

// =====================================
// FINALIZAR PARTIDA
// =====================================

function finalizarPartida(room, winner) {
    if (!room || room.finished) return;

    room.finished = true;

    console.log("================================");
    console.log("PARTIDA FINALIZADA!");
    console.log("VENCEDORES:", winner);
    console.log("================================");

    sendToRoom(room, {
        cmd: "game_over",
        content: {
            winner: winner
        }
    });
}

// =====================================
// VERIFICAR VITÓRIA
// =====================================

function verificarVitoria(room) {
    if (!room || room.finished || !room.started) return;

    const vivos = Object.keys(room.players).filter(
        id => room.alive[id] === true
    );

    const impostores = vivos.filter(
        id => room.roles[id] === "impostor"
    );

    const crewmates = vivos.filter(
        id => room.roles[id] === "crewmate"
    );

    if (impostores.length === 0) {
        finalizarPartida(room, "crewmates");
        return;
    }

    if (
        crewmates.length === 0 ||
        impostores.length >= crewmates.length
    ) {
        finalizarPartida(room, "impostor");
    }
}

// =====================================
// CONEXÃO
// =====================================

wss.on("connection", socket => {
    const uuid = uuidv4();
    socket.uuid = uuid;

    console.log("Cliente conectado:", uuid);

    socket.send(JSON.stringify({
        cmd: "joined_server",
        content: { uuid }
    }));

    socket.on("message", message => {
        let data;

        try {
            data = JSON.parse(message.toString());
        } catch (err) {
            console.error("JSON inválido:", err);
            return;
        }

        if (!data || typeof data !== "object") return;

        const content =
            data.content && typeof data.content === "object"
                ? data.content
                : {};

        switch (data.cmd) {

            // =====================================
            // CRIAR SALA
            // =====================================

            case "create_room": {
                if (socket.roomId) return;

                let code;

                do {
                    code = generateRoomCode();
                } while (rooms.has(code));

                socket.roomId = code;

                const room = {
                    players: {},
                    host: uuid,
                    started: false,
                    starting: false,
                    finished: false,

                    roles: {},
                    alive: {},

                    taskProgress: 0,
                    completedTasks: new Set(),

                    // Estado dos dutos.
                    // null = jogador fora dos dutos.
                    // Objeto = jogador dentro de um duto.
                    ventStates: {}
                };

                rooms.set(code, room);
                room.players[uuid] = socket;

                const player = playerlist.add(uuid, code);

                socket.send(JSON.stringify({
                    cmd: "room_created",
                    content: {
                        code,
                        is_host: true
                    }
                }));

                socket.send(JSON.stringify({
                    cmd: "spawn_local_player",
                    content: { player }
                }));

                console.log("Sala criada:", code);
                break;
            }

            // =====================================
            // ENTRAR NA SALA
            // =====================================

            case "join_room": {
                if (socket.roomId) return;

                const code = String(content.code || "")
                    .trim()
                    .toUpperCase();

                const room = rooms.get(code);

                if (!room) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: {
                            msg: "Sala não encontrada."
                        }
                    }));
                    return;
                }

                if (room.started || room.starting) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: {
                            msg: "A partida já começou."
                        }
                    }));
                    return;
                }

                socket.roomId = code;
                room.players[uuid] = socket;

                const player = playerlist.add(uuid, code);

                socket.send(JSON.stringify({
                    cmd: "room_joined",
                    content: {
                        code,
                        is_host: false
                    }
                }));

                socket.send(JSON.stringify({
                    cmd: "spawn_local_player",
                    content: { player }
                }));

                const others = playerlist
                    .getByRoom(code)
                    .filter(p => p.uuid !== uuid);

                socket.send(JSON.stringify({
                    cmd: "spawn_network_players",
                    content: { players: others }
                }));

                for (const id in room.players) {
                    const client = room.players[id];

                    if (
                        client !== socket &&
                        client.readyState === WebSocket.OPEN
                    ) {
                        client.send(JSON.stringify({
                            cmd: "spawn_new_player",
                            content: { player }
                        }));
                    }
                }

                break;
            }

            // =====================================
            // PEDIR SORTEIO AO GODOT
            // =====================================

            case "start_game": {
                const room = rooms.get(socket.roomId);

                if (!room) return;
                if (uuid !== room.host) return;
                if (room.started || room.starting) return;

                const players = Object.keys(room.players);

                if (players.length < 2) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: {
                            msg: "É necessário pelo menos 2 jogadores."
                        }
                    }));
                    return;
                }

                room.starting = true;

                socket.send(JSON.stringify({
                    cmd: "choose_roles",
                    content: { players }
                }));

                console.log("Aguardando sorteio do Godot:", socket.roomId);
                break;
            }

            // =====================================
            // RECEBER FUNÇÕES SORTEADAS PELO GODOT
            // =====================================

            case "assign_roles": {
                const room = rooms.get(socket.roomId);

                if (!room) return;
                if (uuid !== room.host) return;
                if (!room.starting || room.started) return;

                const roles = content.roles;

                if (!roles || typeof roles !== "object") return;

                const players = Object.keys(room.players);
                const roleIds = Object.keys(roles);

                if (players.length !== roleIds.length) {
                    room.starting = false;
                    return;
                }

                for (const id of players) {
                    if (!Object.prototype.hasOwnProperty.call(roles, id)) {
                        room.starting = false;
                        return;
                    }

                    if (
                        roles[id] !== "impostor" &&
                        roles[id] !== "crewmate"
                    ) {
                        room.starting = false;
                        return;
                    }
                }

                const impostors = players.filter(
                    id => roles[id] === "impostor"
                );

                if (impostors.length !== 1) {
                    room.starting = false;

                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: {
                            msg: "O sorteio precisa ter exatamente um impostor."
                        }
                    }));

                    return;
                }

                room.roles = {};
                room.alive = {};
                room.ventStates = {};

                room.taskProgress = 0;
                room.completedTasks = new Set();
                room.finished = false;

                for (const id of players) {
                    room.roles[id] = roles[id];
                    room.alive[id] = true;
                    room.ventStates[id] = null;
                }

                room.started = true;
                room.starting = false;

                console.log("Partida iniciada:", socket.roomId);
                console.log("Impostor:", impostors[0]);

                for (const id of players) {
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

            // =====================================
            // POSIÇÃO
            // =====================================

            case "position": {
                const room = rooms.get(socket.roomId);

                if (!room || !room.started || room.finished) return;
                if (!room.alive[uuid]) return;

                // Não aceitar movimento enquanto estiver no duto.
                if (room.ventStates[uuid] !== null) return;

                playerlist.update(uuid, content);

                const player = playerlist.get(uuid);
                if (!player) return;

                for (const id in room.players) {
                    const client = room.players[id];

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

            // =====================================
            // ENTRAR NO DUTO
            // =====================================

            case "vent_enter": {
                const room = rooms.get(socket.roomId);

                if (!room || !room.started || room.finished) return;

                // Somente impostor vivo.
                if (room.roles[uuid] !== "impostor") return;
                if (room.alive[uuid] !== true) return;

                // Não pode entrar se já estiver em um duto.
                if (room.ventStates[uuid] !== null) return;

                const from = Number(content.from);
                const to = Number(content.to);

                // Validar os quatro dutos.
                if (
                    !Number.isInteger(from) ||
                    !Number.isInteger(to) ||
                    from < 0 || from > 3 ||
                    to < 0 || to > 3
                ) {
                    return;
                }

                // Sequência: 1 -> 2 -> 3 -> 4 -> 1.
                const destinoEsperado = (from + 1) % 4;

                if (to !== destinoEsperado) {
                    console.log("Destino de duto inválido:", uuid);
                    return;
                }

                // Registrar que o impostor entrou.
                room.ventStates[uuid] = {
                    from: from,
                    to: to
                };

                console.log(
                    "Impostor entrou no duto:",
                    uuid,
                    "Origem:",
                    from + 1,
                    "Destino:",
                    to + 1
                );

                // Avisar todos os jogadores.
                sendToRoom(room, {
                    cmd: "vent_event",
                    content: {
                        uuid: uuid,
                        action: "enter",
                        from: from,
                        to: to,
                        vent: from
                    }
                });

                break;
            }

            // =====================================
            // SAIR DO DUTO
            // =====================================

            case "vent_exit": {
                const room = rooms.get(socket.roomId);

                if (!room || !room.started || room.finished) return;

                if (room.roles[uuid] !== "impostor") return;
                if (room.alive[uuid] !== true) return;

                const state = room.ventStates[uuid];

                // Precisa estar dentro de um duto.
                if (!state) return;

                const vent = Number(content.vent);

                // Só pode sair no destino registrado.
                if (!Number.isInteger(vent)) return;
                if (vent !== state.to) return;

                console.log(
                    "Impostor saiu do duto:",
                    uuid,
                    "Duto:",
                    vent + 1
                );

                // Marcar como fora do duto.
                room.ventStates[uuid] = null;

                // Avisar todos os jogadores.
                sendToRoom(room, {
                    cmd: "vent_event",
                    content: {
                        uuid: uuid,
                        action: "exit",
                        vent: vent
                    }
                });

                break;
            }

            // =====================================
            // TASKS
            // =====================================

            case "task": {
                const room = rooms.get(socket.roomId);

                if (!room || !room.started || room.finished) return;
                if (room.roles[uuid] !== "crewmate") return;
                if (!room.alive[uuid]) return;

                const taskId = String(content.task_id || "");

                if (!taskId || taskId.length > 200) return;
                if (room.completedTasks.has(taskId)) return;

                room.completedTasks.add(taskId);

                room.taskProgress = Math.min(
                    room.taskProgress + 10,
                    100
                );

                sendToRoom(room, {
                    cmd: "task_progress",
                    content: {
                        value: room.taskProgress
                    }
                });

                sendToRoom(room, {
                    cmd: "task_completed",
                    content: {
                        task_id: taskId
                    }
                });

                console.log("Task concluída:", taskId);
                console.log("Progresso:", room.taskProgress + "%");

                if (room.taskProgress >= 100) {
                    finalizarPartida(room, "crewmates");
                }

                break;
            }

            // =====================================
            // ELIMINAR
            // =====================================

            case "kill": {
                const room = rooms.get(socket.roomId);

                if (!room || !room.started || room.finished) return;

                const target = String(content.uuid || "");

                if (room.roles[uuid] !== "impostor") return;
                if (!room.alive[uuid]) return;
                if (target === uuid) return;
                if (!room.players[target]) return;
                if (room.roles[target] !== "crewmate") return;
                if (!room.alive[target]) return;

                room.alive[target] = false;

                console.log("Jogador eliminado:", target);

                sendToRoom(room, {
                    cmd: "player_killed",
                    content: {
                        uuid: target
                    }
                });

                verificarVitoria(room);

                break;
            }

            // =====================================
            // CHAT
            // =====================================

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

    // =====================================
    // DESCONECTAR
    // =====================================

    socket.on("close", () => {
        console.log("Cliente desconectado:", uuid);

        playerlist.remove(uuid);

        const room = rooms.get(socket.roomId);

        if (!room) return;

        delete room.players[uuid];
        delete room.alive[uuid];
        delete room.roles[uuid];
        delete room.ventStates[uuid];

        for (const id in room.players) {
            const client = room.players[id];

            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    cmd: "player_disconnected",
                    content: { uuid }
                }));
            }
        }

        if (Object.keys(room.players).length === 0) {
            rooms.delete(socket.roomId);
            return;
        }

        if (room.starting) {
            room.starting = false;
        }

        if (room.started && !room.finished) {
            verificarVitoria(room);
        }
    });
});
