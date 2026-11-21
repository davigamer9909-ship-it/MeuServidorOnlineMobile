
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
			username: "Jogador",
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
// ENVIAR MENSAGENS
// =====================================

function sendToRoom(room, message) {
	if (!room) return;

	const packet = JSON.stringify(message);

	for (const id in room.players) {
		const client = room.players[id];

		if (client && client.readyState === WebSocket.OPEN) {
			client.send(packet);
		}
	}
}

function sendToRoomExcept(room, excludedSocket, message) {
	if (!room) return;

	const packet = JSON.stringify(message);

	for (const id in room.players) {
		const client = room.players[id];

		if (
			client &&
			client !== excludedSocket &&
			client.readyState === WebSocket.OPEN
		) {
			client.send(packet);
		}
	}
}

function sendToPlayer(room, id, message) {
	if (!room) return;

	const client = room.players[id];

	if (client && client.readyState === WebSocket.OPEN) {
		client.send(JSON.stringify(message));
	}
}

// =====================================
// LISTA DE PARTICIPANTES
// =====================================

function obterParticipantes(room) {
	const participantes = [];

	for (const id in room.players) {
		const player = playerlist.get(id);

		participantes.push({
			uuid: id,
			username: player ? player.username : "Jogador",
			alive: room.alive[id] === true,
			is_bot: false
		});
	}

	for (const id in room.bots) {
		participantes.push({
			uuid: id,
			username: room.bots[id].username || "Bot",
			alive: room.alive[id] === true,
			is_bot: true
		});
	}

	return participantes;
}

// =====================================
// CRIAR CORPO
// =====================================

function criarCorpo(room, target, x, y) {
	if (!room || room.bodies[target]) return null;

	const body = {
		uuid: target,
		x,
		y
	};

	room.bodies[target] = body;

	sendToRoom(room, {
		cmd: "body_spawned",
		content: {
			body
		}
	});

	console.log("CORPO CRIADO:", target, x, y);

	return body;
}

// =====================================
// CONTROLADOR DOS BOTS
// =====================================

function escolherControlador(room) {
	const jogadores = Object.keys(room.players);

	const conectados = jogadores.filter(id => {
		const client = room.players[id];

		return client &&
			client.readyState === WebSocket.OPEN;
	});

	if (conectados.length === 0) {
		room.botController = null;
		return;
	}

	room.botController =
		conectados.find(id => id !== room.host) || conectados[0];

	console.log("NOVO CONTROLADOR DOS BOTS:", room.botController);

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
// REUNIÃO
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

	if (bodyUUID) {
		delete room.bodies[bodyUUID];
	}

	console.log("REUNIÃO INICIADA:", reason, reporter);

	sendToRoom(room, {
		cmd: "meeting_started",
		content: {
			reason,
			reporter,
			reporter_name: playerlist.get(reporter)?.username || "Jogador",
			body_uuid: bodyUUID,
			duration: 60,
			players: obterParticipantes(room)
		}
	});

	return true;
}

// =====================================
// FINALIZAR PARTIDA
// =====================================

function finalizarPartida(room, winner) {
	if (!room || room.finished) return;

	room.finished = true;
	room.meeting.active = false;

	sendToRoom(room, {
		cmd: "game_over",
		content: { winner }
	});

	console.log("PARTIDA FINALIZADA:", winner);
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

	if (impostores.length === 0) {
		finalizarPartida(room, "crewmates");
		return;
	}

	if (impostores.length >= crewmates.length) {
		finalizarPartida(room, "impostor");
	}
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
	let ejectedBot = false;
	let ejectedName = "";

	if (winners.length === 1 && winners[0] !== "skip") {
		const target = winners[0];

		if (room.alive[target] === true) {
			ejected = target;
			room.alive[target] = false;

			if (room.ventStates[target] !== undefined) {
				room.ventStates[target] = null;
			}

			if (room.bots[target]) {
				ejectedBot = true;
				ejectedName = room.bots[target].username || "Bot";
				room.botAlive[target] = false;
			} else {
				const player = playerlist.get(target);
				ejectedName = player ? player.username : "Jogador";
			}
		}
	} else if (winners.length > 1) {
		tie = true;
	}

	const voteDetails = {};

	for (const target in counts) {
		let name = target;

		if (target === "skip") {
			name = "SKIP";
		} else if (room.bots[target]) {
			name = room.bots[target].username || "Bot";
		} else {
			const player = playerlist.get(target);
			name = player ? player.username : "Jogador";
		}

		voteDetails[target] = {
			count: counts[target],
			username: name
		};
	}

	room.meeting.active = false;

	sendToRoom(room, {
		cmd: "meeting_result",
		content: {
			ejected,
			ejected_name: ejectedName,
			tie,
			votes: counts,
			vote_details: voteDetails
		}
	});

	if (ejectedBot) {
		sendToRoom(room, {
			cmd: "remove_network_bot",
			content: {
				bot_id: ejected
			}
		});

		delete room.bots[ejected];
	}

	resetMeeting(room);
	verificarVitoria(room);
}

// =====================================
// VERIFICAR VOTOS
// =====================================

function verificarVotos(room) {
	if (!room || !room.meeting.active) return;

	// Somente jogadores humanos vivos precisam votar.
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
// REMOVER JOGADOR DA SALA
// =====================================

function removerJogadorDaSala(socket, uuid) {
	const code = socket.roomId;
	if (!code) return;

	const room = rooms.get(code);

	if (room) {
		delete room.players[uuid];
		delete room.alive[uuid];
		delete room.roles[uuid];
		delete room.ventStates[uuid];

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

				sendToPlayer(room, room.host, {
					cmd: "host_changed",
					content: {
						uuid: room.host
					}
				});
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
				if (!socket.roomId) return;

				const code = socket.roomId;
				removerJogadorDaSala(socket, uuid);

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
			// ESCOLHER NOME
			// =====================================

			case "set_username": {
				const room = rooms.get(socket.roomId);

				if (!room || !room.players[uuid]) return;

				const player = playerlist.get(uuid);
				if (!player) return;

				const username = String(content.username || "")
					.trim()
					.replace(/\s+/g, " ");

				if (username.length < 3 || username.length > 16) {
					sendToPlayer(room, uuid, {
						cmd: "error",
						content: {
							msg: "O nome precisa ter entre 3 e 16 caracteres."
						}
					});
					return;
				}

				player.username = username;

				sendToRoom(room, {
					cmd: "username_updated",
					content: {
						uuid,
						username
					}
				});

				sendToPlayer(room, uuid, {
					cmd: "username_confirmed",
					content: {
						uuid,
						username
					}
				});

				console.log("NOME DEFINIDO:", uuid, username);
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
						username: String(names[i]).slice(0, 16),
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

				if (Object.keys(roles).length !== participants.length) {
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

					sendToPlayer(room, uuid, {
						cmd: "error",
						content: {
							msg: "Precisa ter exatamente um impostor."
						}
					});
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

				escolherControlador(room);

				room.started = true;
				room.starting = false;

				console.log("PARTIDA INICIADA. IMPOSTOR:", impostors[0]);

				for (const id of players) {
					sendToPlayer(room, id, {
						cmd: "start_game",
						content: {
							scene: "choose_name",
							role: room.roles[id],
							alive: true,
							roles: room.roles,
							bot_roles: room.botRoles,
							bot_controller: room.botController
						}
					});

					sendToPlayer(room, id, {
						cmd: "spawn_network_bots",
						content: {
							bots: room.bots
						}
					});
				}

				break;
			}

			// =====================================
			// POSIÇÃO DO JOGADOR
			// =====================================

			case "position": {
				const room = rooms.get(socket.roomId);

				if (!room || !room.started || room.finished) return;
				if (room.alive[uuid] !== true) return;
				if (room.meeting.active) return;
				if (room.ventStates[uuid] != null) return;

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
			// POSIÇÃO DOS BOTS
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
					content: { bot_id: botId, x, y }
				});

				break;
			}

			// =====================================
			// TAREFA DO BOT
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
				room.taskProgress = Math.min(room.taskProgress + 10, 100);

				sendToRoom(room, {
					cmd: "task_progress",
					content: { value: room.taskProgress }
				});

				sendToRoom(room, {
					cmd: "task_completed",
					content: { task_id: taskId }
				});

				if (room.taskProgress >= 100) {
					finalizarPartida(room, "crewmates");
				}

				break;
			}

			// =====================================
			// BOT IMPOSTOR - MATAR
			// =====================================

			case "bot_kill": {
				const room = rooms.get(socket.roomId);

				if (!room || !room.started || room.finished) break;
				if (uuid !== room.botController) break;
				if (room.meeting.active) break;

				const botId = String(content.bot_id || "");
				const target = String(content.target || "");
				const bot = room.bots[botId];

				if (!bot || room.roles[botId] !== "impostor") break;
				if (room.alive[botId] !== true) break;
				if (!target || target === botId) break;

				const isHuman = !!room.players[target];
				const isBot = !!room.bots[target];

				if (!isHuman && !isBot) break;
				if (room.roles[target] !== "crewmate") break;
				if (room.alive[target] !== true) break;

				let victimX;
				let victimY;

				if (isHuman) {
					const victim = playerlist.get(target);
					if (!victim) break;

					victimX = victim.x;
					victimY = victim.y;
				} else {
					victimX = room.bots[target].x;
					victimY = room.bots[target].y;
				}

				if (Math.hypot(bot.x - victimX, bot.y - victimY) > KILL_DISTANCE) {
					break;
				}

				room.alive[target] = false;

				if (isBot) {
					room.botAlive[target] = false;
				}

				const body = criarCorpo(room, target, victimX, victimY);

				if (isHuman) {
					sendToRoom(room, {
						cmd: "player_killed",
						content: {
							uuid: target,
							killer_id: botId,
							body
						}
					});
				} else {
					sendToRoom(room, {
						cmd: "remove_network_bot",
						content: { bot_id: target }
					});

					delete room.bots[target];
				}

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
			// JOGADOR IMPOSTOR - MATAR BOT
			// =====================================

			case "kill_bot": {
				const room = rooms.get(socket.roomId);

				if (!room || !room.started || room.finished) break;
				if (room.meeting.active) break;
				if (room.roles[uuid] !== "impostor") break;
				if (room.alive[uuid] !== true) break;
				if (room.ventStates[uuid] != null) break;

				const botId = String(content.bot_id || "");
				const bot = room.bots[botId];

				if (!bot || room.roles[botId] !== "crewmate") break;
				if (room.alive[botId] !== true) break;

				const killer = playerlist.get(uuid);
				if (!killer) break;

				if (Math.hypot(killer.x - bot.x, killer.y - bot.y) > KILL_DISTANCE) {
					break;
				}

				room.alive[botId] = false;
				room.botAlive[botId] = false;

				criarCorpo(room, botId, bot.x, bot.y);

				sendToRoom(room, {
					cmd: "remove_network_bot",
					content: { bot_id: botId }
				});

				delete room.bots[botId];

				verificarVitoria(room);
				break;
			}

			// =====================================
			// JOGADOR IMPOSTOR - MATAR HUMANO
			// =====================================

			case "kill": {
				const room = rooms.get(socket.roomId);

				if (!room || !room.started || room.finished) return;
				if (room.meeting.active) return;
				if (room.roles[uuid] !== "impostor") return;
				if (room.alive[uuid] !== true) return;
				if (room.ventStates[uuid] != null) return;

				const target = String(content.uuid || "");

				if (!target || target === uuid) return;
				if (!room.players[target]) return;
				if (room.roles[target] !== "crewmate") return;
				if (room.alive[target] !== true) return;

				const killer = playerlist.get(uuid);
				const victim = playerlist.get(target);

				if (!killer || !victim) return;

				if (Math.hypot(killer.x - victim.x, killer.y - victim.y) > KILL_DISTANCE) {
					return;
				}

				room.alive[target] = false;

				const body = criarCorpo(room, target, victim.x, victim.y);

				sendToRoom(room, {
					cmd: "player_killed",
					content: {
						uuid: target,
						killer_id: uuid,
						body
					}
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
				if (room.ventStates[uuid] != null) return;

				const from = Number(content.from);
				const to = Number(content.to);

				if (
					!Number.isInteger(from) ||
					!Number.isInteger(to) ||
					from < 0 || from > 3 ||
					to < 0 || to > 3
				) return;

				if (to !== (from + 1) % 4) return;

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
				room.taskProgress = Math.min(room.taskProgress + 10, 100);

				sendToRoom(room, {
					cmd: "task_progress",
					content: { value: room.taskProgress }
				});

				sendToRoom(room, {
					cmd: "task_completed",
					content: { task_id: taskId }
				});

				if (room.taskProgress >= 100) {
					finalizarPartida(room, "crewmates");
				}

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
				if (room.ventStates[uuid] != null) return;

				const target = String(content.uuid || "");
				const body = room.bodies[target];

				if (!target || !body) return;

				const reporter = playerlist.get(uuid);
				if (!reporter) return;

				if (Math.hypot(reporter.x - body.x, reporter.y - body.y) > REPORT_DISTANCE) {
					return;
				}

				iniciarReuniao(room, uuid, "body_report", target);
				break;
			}

			// =====================================
			// BOTÃO DE EMERGÊNCIA
			// =====================================

			case "meeting_start": {
				const room = rooms.get(socket.roomId);

				if (!room || !room.started || room.finished) return;
				if (room.alive[uuid] !== true) return;
				if (room.meeting.active) return;
				if (room.ventStates[uuid] != null) return;

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

				if (target !== "skip" && room.alive[target] !== true) return;

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

				sendToRoom(room, {
					cmd: "vote_received",
					content: {
						uuid,
						total_votes: Object.keys(room.meeting.votes).length,
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

				if (room.started && room.alive[uuid] !== true) return;

				const msg = String(content.msg || "").slice(0, 300);
				if (!msg.trim()) return;

				sendToRoom(room, {
					cmd: "new_chat_message",
					content: { uuid, msg }
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
		removerJogadorDaSala(socket, uuid);
	});

	socket.on("error", error => {
		console.error("Erro no WebSocket:", error.message);
	});
});
