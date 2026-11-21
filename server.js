
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

const REPORT_DISTANCE = 70;
const KILL_DISTANCE = 70;

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
// ENVIAR PARA TODOS MENOS UM
// =====================================

function sendToRoomExcept(room, excludedSocket, message) {
    if (!room) return;

    const packet = JSON.stringify(message);

    for (const id in room.players) {
        const client = room.players[id];

        if (
            client !== excludedSocket &&
            client.readyState === WebSocket.OPEN
        ) {
            client.send(packet);
        }
    }
}

// =====================================
// CONTROLADOR DOS BOTS
// =====================================

function escolherControlador(room) {
    const jogadores = Object.keys(room.players);

    const conectados = jogadores.filter(id => {
        const client = room.players[id];
        return client && client.readyState === WebSocket.OPEN;
    });

    if (conectados.length === 0) {
        room.botController = null;
        return;
    }

    // Prioriza alguém que não seja o host.
    room.botController =
        conectados.find(id => id !== room.host) || conectados[0];

    console.log("================================");
    console.log("CONTROLADOR DOS BOTS:", room.botController);
    console.log("================================");

    sendToRoom(room, {
        cmd: "bot_controller_changed",
        content: {
            uuid: room.botController
        }
    });
}

function atualizarControladorSeNecessario(room, saiuUUID) {
    if (!room) return;

    if (
        room.botController === saiuUUID ||
        !room.botController ||
        !room.players[room.botController]
    ) {
        escolherControlador(room);
    }
}

// =====================================
// ESTADO INICIAL DA REUNIÃO
// =====================================

function resetMeeting(room) {
    room.meeting = {
        active: false,
        reporter: null,
        reason: null,
        votes: {},
        startedAt: null
    };
}

// =====================================
// FINALIZAR PARTIDA
// =====================================

function finalizarPartida(room, winner) {
    if (!room || room.finished) return;

    room.finished = true;
    room.meeting.active = false;

    console.log("================================");
    console.log("PARTIDA FINALIZADA!");
    console.log("VENCEDORES:", winner);
    console.log("================================");

    sendToRoom(room, {
        cmd: "game_over",
        content: { winner }
    });
}

// =====================================
// VERIFICAR VITÓRIA
// =====================================

function verificarVitoria(room) {
    if (!room || room.finished || !room.started) return;

    const vivos = Object.keys(room.alive).filter(
        id => room.alive[id] === true
    );

    const impostores = vivos.filter(
        id => room.roles[id] === "impostor"
    );

    const crewmates = vivos.filter(
        id => room.roles[id] === "crewmate"
    );

    console.log("Participantes vivos:", vivos.length);
    console.log("Impostores vivos:", impostores.length);
    console.log("Crewmates vivos:", crewmates.length);

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
// INICIAR REUNIÃO
// =====================================

function iniciarReuniao(room, reporter, reason, bodyUUID = null) {
    if (!room || !room.started || room.finished) return false;
    if (room.meeting.active) return false;
    if (room.alive[reporter] !== true) return false;

    room.meeting = {
        active: true,
        reporter,
        reason,
        votes: {},
        startedAt: Date.now()
    };

    console.log("================================");
    console.log("REUNIÃO INICIADA");
    console.log("Motivo:", reason);
    console.log("Responsável:", reporter);
    console.log("================================");

    sendToRoom(room, {
        cmd: "meeting_started",
        content: {
            reason,
            reporter,
            body_uuid: bodyUUID,
            duration: 60
        }
    });

    return true;
}

// =====================================
// FINALIZAR REUNIÃO
// =====================================

function finalizarReuniao(room) {
    if (!room || !room.meeting.active) return;

    const counts = {};

    for (const vote of Object.values(room.meeting.votes)) {
        counts[vote] = (counts[vote] || 0) + 1;
    }

    const values = Object.values(counts);
    const highest = values.length > 0 ? Math.max(...values) : 0;

    const winners = Object.keys(counts).filter(
        id => counts[id] === highest
    );

    let ejected = null;
    let tie = false;

    if (winners.length === 1 && winners[0] !== "skip") {
        ejected = winners[0];

        if (room.alive[ejected] === true) {
            room.alive[ejected] = false;
            room.ventStates[ejected] = null;
        } else {
            ejected = null;
        }
    } else if (winners.length > 1) {
        tie = true;
    }

    console.log("================================");
    console.log("RESULTADO DA VOTAÇÃO");
    console.log("VOTOS:", counts);
    console.log("EXPULSO:", ejected);
    console.log("EMPATE:", tie);
    console.log("================================");

    room.meeting.active = false;

    sendToRoom(room, {
        cmd: "meeting_result",
        content: {
            ejected,
            tie,
            votes: counts
        }
    });

    room.bodies = {};

    resetMeeting(room);
    verificarVitoria(room);
}

// =====================================
// VERIFICAR VOTOS
// =====================================

function verificarVotos(room) {
    if (!room || !room.meeting.active) return;

    const vivos = Object.keys(room.players).filter(
        id => room.alive[id] === true
    );

    if (vivos.length === 0) return;

    const todosVotaram = vivos.every(id =>
        Object.prototype.hasOwnProperty.call(room.meeting.votes, id)
    );

    if (todosVotaram) {
        finalizarReuniao(room);
    }
}

// =====================================
// CONEXÃO
// =====================================

wss.on("connection", socket => {
    const uuid = uuidv4();

    socket.uuid = uuid;
    socket.roomId = null;

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
            // SAIR DA SALA
            // =====================================

            case "leave_room": {
                const code = socket.roomId;
                if (!code) return;

                const room = rooms.get(code);

                if (room) {
                    delete room.players[uuid];
                    delete room.alive[uuid];
                    delete room.roles[uuid];
                    delete room.ventStates[uuid];
                    delete room.bodies[uuid];

                    if (room.meeting.active) {
                        delete room.meeting.votes[uuid];
                    }

                    playerlist.remove(uuid);

                    sendToRoom(room, {
                        cmd: "player_disconnected",
                        content: { uuid }
                    });

                    if (room.host === uuid) {
                        const remaining = Object.keys(room.players);

                        if (remaining.length > 0) {
                            room.host = remaining[0];

                            const newHost = room.players[room.host];

                            if (newHost.readyState === WebSocket.OPEN) {
                                newHost.send(JSON.stringify({
                                    cmd: "host_changed",
                                    content: {
                                        uuid: room.host
                                    }
                                }));
                            }
                        }
                    }

                    atualizarControladorSeNecessario(room, uuid);

                    if (Object.keys(room.players).length === 0) {
                        rooms.delete(code);
                        console.log("Sala removida:", code);
                    } else {
                        verificarVotos(room);
                        verificarVitoria(room);
                    }
                }

                socket.roomId = null;

                socket.send(JSON.stringify({
                    cmd: "left_room",
                    content: {}
                }));

                console.log("Jogador saiu:", uuid, code);
                break;
            }

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
                    botController: null,

                    started: false,
                    starting: false,
                    finished: false,

                    roles: {},
                    alive: {},

                    taskProgress: 0,
                    completedTasks: new Set(),

                    ventStates: {},
                    bodies: {},

                    meeting: {
                        active: false,
                        reporter: null,
                        reason: null,
                        votes: {},
                        startedAt: null
                    },

                    bots: {},
                    botRoles: {},
                    botAlive: {}
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
                        content: { msg: "Sala não encontrada." }
                    }));
                    return;
                }

                if (room.started || room.starting) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "A partida já começou." }
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

                const others = playerlist.getByRoom(code).filter(
                    p => p.uuid !== uuid
                );

                socket.send(JSON.stringify({
                    cmd: "spawn_network_players",
                    content: { players: others }
                }));

                socket.send(JSON.stringify({
                    cmd: "spawn_network_bots",
                    content: { bots: room.bots }
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
            // INICIAR PARTIDA
            // =====================================

            case "start_game": {
                const room = rooms.get(socket.roomId);

                if (!room) return;
                if (uuid !== room.host) return;
                if (room.started || room.starting) return;

                const players = Object.keys(room.players);

                if (players.length < 1) return;

                const names = Array.isArray(content.bot_names)
                    ? content.bot_names.slice(0, 10)
                    : [];

                room.bots = {};
                room.botRoles = {};
                room.botAlive = {};

                for (let i = 0; i < names.length; i++) {
                    const botId = "bot_" + String(i + 1).padStart(2, "0");

                    room.bots[botId] = {
                        bot_id: botId,
                        username: String(names[i]).slice(0, 24),
                        x: 0,
                        y: 0
                    };
                }

                const bots = Object.keys(room.bots);

                if (players.length + bots.length < 2) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: {
                            msg: "É necessário pelo menos 2 participantes."
                        }
                    }));
                    return;
                }

                room.starting = true;

                socket.send(JSON.stringify({
                    cmd: "choose_roles",
                    content: {
                        players,
                        bots
                    }
                }));

                console.log("Sorteio solicitado!");
                console.log("Jogadores:", players.length);
                console.log("Bots:", bots.length);
                break;
            }

            // =====================================
            // RECEBER FUNÇÕES
            // =====================================

            case "assign_roles": {
                const room = rooms.get(socket.roomId);

                if (!room) return;
                if (uuid !== room.host) return;
                if (!room.starting || room.started) return;

                const roles = content.roles;

                if (!roles || typeof roles !== "object") {
                    room.starting = false;
                    return;
                }

                const players = Object.keys(room.players);
                const bots = Object.keys(room.bots);
                const participants = [...players, ...bots];

                const roleIds = Object.keys(roles);

                if (roleIds.length !== participants.length) {
                    room.starting = false;
                    return;
                }

                for (const id of participants) {
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

                const impostors = participants.filter(
                    id => roles[id] === "impostor"
                );

                if (impostors.length !== 1) {
                    room.starting = false;

                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: {
                            msg: "Precisa ter exatamente um impostor."
                        }
                    }));
                    return;
                }

                room.roles = {};
                room.alive = {};
                room.ventStates = {};
                room.bodies = {};

                room.botRoles = {};
                room.botAlive = {};

                room.taskProgress = 0;
                room.completedTasks = new Set();
                room.finished = false;

                resetMeeting(room);

                for (const id of participants) {
                    room.roles[id] = roles[id];
                    room.alive[id] = true;
                }

                for (const id of players) {
                    room.ventStates[id] = null;
                }

                for (const id of bots) {
                    room.botRoles[id] = roles[id];
                    room.botAlive[id] = true;
                }

                // Escolher controlador independente do host.
                escolherControlador(room);

                room.started = true;
                room.starting = false;

                console.log("================================");
                console.log("PARTIDA INICIADA");
                console.log("IMPOSTOR:", impostors[0]);
                console.log("CONTROLADOR:", room.botController);
                console.log("================================");

                for (const id of players) {
                    const client = room.players[id];

                    if (client.readyState !== WebSocket.OPEN) continue;

                    client.send(JSON.stringify({
                        cmd: "start_game",
                        content: {
                            scene: "test_world",
                            role: room.roles[id],
                            alive: true,
                            roles: room.roles,
                            bot_roles: room.botRoles,
                            bot_controller: room.botController
                        }
                    }));

                    client.send(JSON.stringify({
                        cmd: "spawn_network_bots",
                        content: {
                            bots: room.bots
                        }
                    }));
                }

                break;
            }

            // =====================================
            // POSIÇÃO DOS JOGADORES
            // =====================================

            case "position": {
                const room = rooms.get(socket.roomId);

                if (!room || !room.started || room.finished) return;
                if (room.alive[uuid] !== true) return;
                if (room.meeting.active) return;
                if (room.ventStates[uuid] !== null) return;

                playerlist.update(uuid, content);

                const player = playerlist.get(uuid);
                if (!player) return;

                sendToRoomExcept(room, socket, {
                    cmd: "update_position",
                    content: {
                        uuid,
                        x: player.x,
                        y: player.y,
                        z: player.z,
                        r_y: player.r_y
                    }
                });

                break;
            }

            // =====================================
            // BOT - POSIÇÃO
            // =====================================

            case "bot_position": {
                const room = rooms.get(socket.roomId);

                if (!room || !room.started || room.finished) return;
                if (uuid !== room.botController) return;
                if (room.meeting.active) return;

                const botId = String(content.bot_id || "");

                if (!room.bots[botId]) return;
                if (room.alive[botId] !== true) return;

                const x = Number(content.x);
                const y = Number(content.y);

                if (!Number.isFinite(x) || !Number.isFinite(y)) return;

                room.bots[botId].x = x;
                room.bots[botId].y = y;

                sendToRoomExcept(room, socket, {
                    cmd: "update_bot_position",
                    content: {
                        bot_id: botId,
                        x,
                        y
                    }
                });

                break;
            }

            // =====================================
            // BOT - COMPLETAR TAREFA
            // =====================================

            case "bot_task": {
                const room = rooms.get(socket.roomId);

                if (!room || !room.started || room.finished) return;
                if (uuid !== room.botController) return;
                if (room.meeting.active) return;

                const botId = String(content.bot_id || "");
                const taskId = String(content.task_id || "");

                if (!room.bots[botId]) return;
                if (room.alive[botId] !== true) return;
                if (room.roles[botId] !== "crewmate") return;

                if (!taskId || taskId.length > 200) return;
                if (room.completedTasks.has(taskId)) return;

                room.completedTasks.add(taskId);

                room.taskProgress = Math.min(
                    room.taskProgress + 10,
                    100
                );

                console.log("Bot completou tarefa:", botId, taskId);

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

                if (room.taskProgress >= 100) {
                    finalizarPartida(room, "crewmates");
                }

                break;
            }

            // =====================================
            // BOT - ELIMINAR HUMANO OU BOT
            // =====================================

            case "bot_kill": {
                const room = rooms.get(socket.roomId);

                if (!room || !room.started || room.finished) return;
                if (uuid !== room.botController) return;
                if (room.meeting.active) return;

                const botId = String(content.bot_id || "");
                const target = String(content.target || "");

                if (!room.bots[botId]) return;
                if (room.roles[botId] !== "impostor") return;
                if (room.alive[botId] !== true) return;

                if (!target || target === botId) return;

                const isHuman = !!room.players[target];
                const isBot = !!room.bots[target];

                if (!isHuman && !isBot) return;

                if (room.roles[target] !== "crewmate") return;
                if (room.alive[target] !== true) return;

                let victimX;
                let victimY;

                if (isHuman) {
                    const victim = playerlist.get(target);
                    if (!victim) return;

                    victimX = victim.x;
                    victimY = victim.y;
                } else {
                    victimX = room.bots[target].x;
                    victimY = room.bots[target].y;
                }

                const bot = room.bots[botId];

                const distance = Math.hypot(
                    bot.x - victimX,
                    bot.y - victimY
                );

                if (distance > KILL_DISTANCE) return;

                room.alive[target] = false;

                if (isBot) {
                    room.botAlive[target] = false;
                }

                room.bodies[target] = {
                    uuid: target,
                    x: victimX,
                    y: victimY
                };

                console.log("================================");
                console.log("BOT IMPOSTOR ELIMINOU!");
                console.log("IMPOSTOR:", bot.username);
                console.log("VÍTIMA:", isHuman ? target : room.bots[target].username);
                console.log("TIPO:", isHuman ? "HUMANO" : "BOT");
                console.log("DISTÂNCIA:", distance);
                console.log("================================");

                sendToRoom(room, {
                    cmd: "player_killed",
                    content: {
                        uuid: target,
                        killer_id: botId,
                        body: room.bodies[target]
                    }
                });

                verificarVitoria(room);
                break;
            }

            // =====================================
            // REMOVER BOT
            // =====================================

            case "bot_remove": {
                const room = rooms.get(socket.roomId);

                if (!room || uuid !== room.host) return;

                const botId = String(content.bot_id || "");

                if (!room.bots[botId]) return;

                delete room.bots[botId];
                delete room.roles[botId];
                delete room.alive[botId];
                delete room.botRoles[botId];
                delete room.botAlive[botId];

                sendToRoom(room, {
                    cmd: "remove_network_bot",
                    content: { bot_id: botId }
                });

                verificarVitoria(room);
                break;
            }

            // =====================================
            // ENTRAR NO DUTO
            // =====================================

            case "vent_enter": {
                const room = rooms.get(socket.roomId);

                if (!room || !room.started || room.finished) return;
                if (room.meeting.active) return;

                if (room.roles[uuid] !== "impostor") return;
                if (room.alive[uuid] !== true) return;
                if (room.ventStates[uuid] !== null) return;

                const from = Number(content.from);
                const to = Number(content.to);

                if (
                    !Number.isInteger(from) ||
                    !Number.isInteger(to) ||
                    from < 0 ||
                    from > 3 ||
                    to < 0 ||
                    to > 3
                ) return;

                const destinoEsperado = (from + 1) % 4;
                if (to !== destinoEsperado) return;

                room.ventStates[uuid] = { from, to };

                sendToRoom(room, {
                    cmd: "vent_event",
                    content: {
                        uuid,
                        action: "enter",
                        from,
                        to,
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
                if (room.meeting.active) return;

                if (room.roles[uuid] !== "impostor") return;
                if (room.alive[uuid] !== true) return;

                const state = room.ventStates[uuid];
                if (!state) return;

                const vent = Number(content.vent);

                if (!Number.isInteger(vent)) return;
                if (vent !== state.to) return;

                room.ventStates[uuid] = null;

                sendToRoom(room, {
                    cmd: "vent_event",
                    content: {
                        uuid,
                        action: "exit",
                        vent
                    }
                });

                break;
            }

            // =====================================
            // TAREFA DO JOGADOR
            // =====================================

            case "task": {
                const room = rooms.get(socket.roomId);

                if (!room || !room.started || room.finished) return;
                if (room.meeting.active) return;
                if (room.roles[uuid] !== "crewmate") return;
                if (room.alive[uuid] !== true) return;

                const taskId = String(content.task_id || "");

                if (!taskId || taskId.length > 200) return;
                if (room.completedTasks.has(taskId)) return;

                room.completedTasks.add(taskId);

                room.taskProgress = Math.min(
                    room.taskProgress + 10,
                    100
                );

                console.log("Jogador completou tarefa:", uuid, taskId);

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

                if (room.taskProgress >= 100) {
                    finalizarPartida(room, "crewmates");
                }

                break;
            }

            // =====================================
            // ELIMINAR JOGADOR
            // =====================================

            
case "kill": {
    const room = rooms.get(socket.roomId);

    if (!room) {
        console.log("[KILL] Sala não encontrada");
        return;
    }

    if (!room.started || room.finished) {
        console.log("[KILL] Partida não está ativa");
        return;
    }

    if (room.meeting.active) {
        console.log("[KILL] Reunião ativa");
        return;
    }

    const target = String(content.uuid || "");

    console.log("================================");
    console.log("TENTATIVA DE ELIMINAÇÃO");
    console.log("IMPOSTOR:", uuid);
    console.log("ALVO:", target);
    console.log("PAPEL:", room.roles[uuid]);
    console.log("VIVO:", room.alive[uuid]);

    if (room.roles[uuid] !== "impostor") {
        console.log("[KILL] REJEITADO: jogador não é impostor");
        return;
    }

    if (room.alive[uuid] !== true) {
        console.log("[KILL] REJEITADO: impostor está morto");
        return;
    }

    if (room.ventStates[uuid] != null) {
        console.log("[KILL] REJEITADO: impostor está no duto");
        return;
    }

    if (target === uuid) {
        console.log("[KILL] REJEITADO: alvo é o próprio impostor");
        return;
    }

    if (!room.players[target]) {
        console.log("[KILL] REJEITADO: alvo não está na sala");
        return;
    }

    if (room.roles[target] !== "crewmate") {
        console.log("[KILL] REJEITADO: alvo não é crewmate");
        return;
    }

    if (room.alive[target] !== true) {
        console.log("[KILL] REJEITADO: alvo já está eliminado");
        return;
    }

    if (room.ventStates[target] != null) {
        console.log("[KILL] REJEITADO: alvo está no duto");
        return;
    }

    const killer = playerlist.get(uuid);
    const victim = playerlist.get(target);

    if (!killer || !victim) {
        console.log("[KILL] REJEITADO: posição não encontrada");
        return;
    }

    const distance = Math.hypot(
        killer.x - victim.x,
        killer.y - victim.y
    );

    console.log("POSIÇÃO IMPOSTOR:", killer.x, killer.y);
    console.log("POSIÇÃO ALVO:", victim.x, victim.y);
    console.log("DISTÂNCIA:", distance);
    console.log("DISTÂNCIA MÁXIMA:", KILL_DISTANCE);

    if (distance > KILL_DISTANCE) {
        console.log("[KILL] REJEITADO: muito longe");
        console.log("================================");
        return;
    }

    // Eliminação confirmada.
    room.alive[target] = false;

    room.bodies[target] = {
        uuid: target,
        x: victim.x,
        y: victim.y
    };

    console.log("[KILL] ELIMINAÇÃO CONFIRMADA!");
    console.log("VÍTIMA:", target);
    console.log("================================");

    sendToRoom(room, {
        cmd: "player_killed",
        content: {
            uuid: target,
            killer_id: uuid,
            body: room.bodies[target]
        }
    });

    verificarVitoria(room);

    break;
}


            // =====================================
            // REPORTAR CORPO
            // =====================================

            case "report_body": {
                const room = rooms.get(socket.roomId);

                if (!room || !room.started || room.finished) return;
                if (room.alive[uuid] !== true) return;
                if (room.meeting.active) return;
                if (room.ventStates[uuid] !== null) return;

                const target = String(content.uuid || "");

                if (!target || !room.bodies[target]) return;

                const reporter = playerlist.get(uuid);
                const body = room.bodies[target];

                if (!reporter) return;

                const distance = Math.hypot(
                    reporter.x - body.x,
                    reporter.y - body.y
                );

                if (distance > REPORT_DISTANCE) return;

                iniciarReuniao(room, uuid, "body_report", target);
                break;
            }

            // =====================================
            // REUNIÃO DE EMERGÊNCIA
            // =====================================

            case "meeting_start": {
                const room = rooms.get(socket.roomId);

                if (!room || !room.started || room.finished) return;
                if (room.alive[uuid] !== true) return;
                if (room.meeting.active) return;
                if (room.ventStates[uuid] !== null) return;

                iniciarReuniao(room, uuid, "emergency");
                break;
            }

            // =====================================
            // VOTAR
            // =====================================

            case "meeting_vote": {
                const room = rooms.get(socket.roomId);

                if (!room || !room.meeting.active) return;
                if (room.finished) return;
                if (room.alive[uuid] !== true) return;

                const target = String(content.target || "");
                if (!target) return;

                if (
                    target !== "skip" &&
                    room.alive[target] !== true
                ) return;

                if (
                    Object.prototype.hasOwnProperty.call(
                        room.meeting.votes,
                        uuid
                    )
                ) return;

                room.meeting.votes[uuid] = target;

                const vivos = Object.keys(room.players).filter(
                    id => room.alive[id] === true
                );

                const totalVotes = Object.keys(room.meeting.votes).length;

                sendToRoom(room, {
                    cmd: "vote_received",
                    content: {
                        uuid,
                        total_votes: totalVotes,
                        total_alive: vivos.length
                    }
                });

                verificarVotos(room);
                break;
            }

            // =====================================
            // CHAT
            // =====================================

            case "chat": {
                const room = rooms.get(socket.roomId);
                if (!room) return;

                const msg = String(content.msg || "").slice(0, 300);
                if (!msg.trim()) return;

                sendToRoom(room, {
                    cmd: "new_chat_message",
                    content: {
                        uuid,
                        msg
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

        const code = socket.roomId;
        const room = rooms.get(code);

        if (!room) return;

        delete room.players[uuid];
        delete room.alive[uuid];
        delete room.roles[uuid];
        delete room.ventStates[uuid];
        delete room.bodies[uuid];

        if (room.meeting.active) {
            delete room.meeting.votes[uuid];
        }

        sendToRoom(room, {
            cmd: "player_disconnected",
            content: { uuid }
        });

        if (Object.keys(room.players).length === 0) {
            rooms.delete(code);
            console.log("Sala removida:", code);
            return;
        }

        // Transferir host se necessário.
        if (room.host === uuid) {
            room.host = Object.keys(room.players)[0];

            const newHost = room.players[room.host];

            if (newHost.readyState === WebSocket.OPEN) {
                newHost.send(JSON.stringify({
                    cmd: "host_changed",
                    content: {
                        uuid: room.host
                    }
                }));
            }
        }

        // Transferir controlador dos bots se necessário.
        atualizarControladorSeNecessario(room, uuid);

        if (room.starting) {
            room.starting = false;
        }

        verificarVotos(room);

        if (room.started && !room.finished) {
            verificarVitoria(room);
        }
    });
});
