
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
const MEETING_DURATION = 60;

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
// NOME DO PARTICIPANTE
// =====================================

function obterNome(room, id) {
	if (room.bots[id]) {
		return room.bots[id].username || "Bot";
	}

	const player = playerlist.get(id);
	return player ? player.username : "Jogador";
}

// =====================================
// CRIAR CORPO
// =====================================

function criarCorpo(room, target, x, y, killerId = null) {
	if (!room || room.bodies[target]) return null;

	const body = {
		uuid: target,
		x: Number(x),
		y: Number(y),
		killer_id: killerId
	};

	room.bodies[target] = body;

	sendToRoom(room, {
		cmd: "body_spawned",
		content: { body }
	});

	console.log("CORPO CRIADO:", target, body.x, body.y);
	console.log("ELIMINADO POR:", killerId || "Desconhecido");

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

function limparTimersDosBots(meeting) {
	if (!meeting || !meeting.botTimers) return;

	for (const timer of meeting.botTimers) {
		clearTimeout(timer);
	}

	meeting.botTimers = [];
}

function resetMeeting(room) {
	if (room.meeting) {
		if (room.meeting.timer) {
			clearTimeout(room.meeting.timer);
		}

		limparTimersDosBots(room.meeting);
	}

	room.meeting = {
		active: false,
		reporter: null,
		reason: null,
		votes: {},
		startedAt: null,
		timer: null,
		botTimers: []
	};
}

// =====================================
// PARTICIPANTES VIVOS
// =====================================

function obterParticipantesVivos(room) {
	return Object.keys(room.alive).filter(id =>
		room.alive[id] === true &&
		(!!room.players[id] || !!room.bots[id])
	);
}

// =====================================
// VOTO AUTOMÁTICO DOS BOTS
// =====================================

function votarBot(room, botId, meetingAtual) {
	// Impede votos de reuniões antigas.
	if (!room || room.meeting !== meetingAtual) return;
	if (!meetingAtual.active || room.finished) return;

	if (!room.bots[botId]) return;
	if (room.alive[botId] !== true) return;

	// Impede o mesmo bot de votar duas vezes.
	if (
		Object.prototype.hasOwnProperty.call(
			meetingAtual.votes,
			botId
		)
	) return;

	const participantes = obterParticipantesVivos(room).filter(
		id => id !== botId
	);

	let target = "skip";

	// 15% de chance de pular.
	if (participantes.length > 0 && Math.random() >= 0.15) {
		target = participantes[
			Math.floor(Math.random() * participantes.length)
		];
	}

	meetingAtual.votes[botId] = target;

	const totalVotos = Object.keys(meetingAtual.votes).length;
	const totalVivos = obterParticipantesVivos(room).length;

	sendToRoom(room, {
		cmd: "vote_received",
		content: {
			uuid: botId,
			total_votes: totalVotos,
			total_alive: totalVivos
		}
	});

	console.log(
		"VOTO DO BOT:",
		obterNome(room, botId),
		"->",
		target === "skip" ? "SKIP" : obterNome(room, target)
	);

	verificarVotos(room);
}

function agendarVotosDosBots(room, meetingAtual) {
	for (const botId of Object.keys(room.bots)) {
		if (room.alive[botId] !== true) continue;

		// Entre 1,5 e 10 segundos.
		const delay = 1500 + Math.random() * 8500;

		const timer = setTimeout(() => {
			votarBot(room, botId, meetingAtual);
		}, delay);

		meetingAtual.botTimers.push(timer);
	}
}

// =====================================
// INICIAR REUNIÃO
// =====================================

function iniciarReuniao(room, reporter, reason, bodyUUID = null) {
	if (!room || !room.started || room.finished) return false;
	if (room.meeting.active) return false;
	if (room.alive[reporter] !== true) return false;

	if (bodyUUID && !room.bodies[bodyUUID]) {
		return false;
	}

	if (bodyUUID) {
		delete room.bodies[bodyUUID];
	}

	room.meeting = {
		active: true,
		reporter,
		reason,
		votes: {},
		startedAt: Date.now(),
		timer: null,
		botTimers: []
	};

	const meetingAtual = room.meeting;

	console.log("REUNIÃO INICIADA:", reason, reporter);

	sendToRoom(room, {
		cmd: "meeting_started",
		content: {
			reason,
			reporter,
			reporter_name: obterNome(room, reporter),
			body_uuid: bodyUUID,
			duration: MEETING_DURATION,
			players: obterParticipantes(room)
		}
	});

	// Agenda os votos dos bots.
	agendarVotosDosBots(room, meetingAtual);

	// Tempo máximo da reunião.
	meetingAtual.timer = setTimeout(() => {
		if (room.meeting === meetingAtual && meetingAtual.active) {
			console.log("TEMPO DA REUNIÃO ESGOTADO!");
			finalizarReuniao(room);
		}
	}, MEETING_DURATION * 1000);

	return true;
}

// =====================================
// FINALIZAR PARTIDA
// =====================================

function finalizarPartida(room, winner) {
	if (!room || room.finished) return;

	room.finished = true;

	if (room.meeting && room.meeting.timer) {
		clearTimeout(room.meeting.timer);
	}

	if (room.meeting) {
		limparTimersDosBots(room.meeting);
		room.meeting.active = false;
	}

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
	if (!room || !room.meeting || !room.meeting.active) return;

	const meetingAtual = room.meeting;

	if (meetingAtual.timer) {
		clearTimeout(meetingAtual.timer);
	}

	limparTimersDosBots(meetingAtual);

	const votes = meetingAtual.votes;
	const counts = {};

	for (const vote of Object.values(votes)) {
		counts[vote] = (counts[vote] || 0) + 1;
	}

	const values = Object.values(counts);
	const highest = values.length > 0 ? Math.max(...values) : 0;

	const winners = Object.keys(counts).filter(
		id => counts[id] === highest
	);

	let ejected = null;
	let ejectedName = "";
	let ejectedBot = false;
	let ejectedRole = "";
	let tie = false;

	// Elimina somente se houver um vencedor único
	// que não seja Skip.
	if (winners.length === 1 && winners[0] !== "skip") {
		const target = winners[0];

		if (
			room.alive[target] === true &&
			(room.players[target] || room.bots[target])
		) {
			ejected = target;
			ejectedName = obterNome(room, target);
			ejectedBot = !!room.bots[target];
			ejectedRole = room.roles[target] || "";

			room.alive[target] = false;

			if (room.ventStates[target] !== undefined) {
				room.ventStates[target] = null;
			}

			if (ejectedBot) {
				room.botAlive[target] = false;
			}
		}
	} else if (winners.length > 1) {
		tie = true;
	}

	const voteDetails = {};

	for (const target in counts) {
		voteDetails[target] = {
			count: counts[target],
			username: target === "skip"
				? "SKIP"
				: obterNome(room, target)
		};
	}

	const votesCast = Object.keys(votes).length;

	const totalVoters = obterParticipantesVivos(room).length +
		(ejected !== null ? 1 : 0);

	meetingAtual.active = false;

	sendToRoom(room, {
		cmd: "meeting_result",
		content: {
			ejected,
			ejected_name: ejectedName,
			ejected_is_bot: ejectedBot,
			ejected_role: ejectedRole,
			tie,
			skip: winners.length === 1 && winners[0] === "skip",
			votes: counts,
			vote_details: voteDetails,
			votes_cast: votesCast,
			total_voters: totalVoters
		}
	});

	console.log("================================");
	console.log("REUNIÃO FINALIZADA");
	console.log("VOTOS:", counts);
	console.log("VOTOS COMPUTADOS:", votesCast);
	console.log("ELIMINADO:", ejectedName || "Ninguém");
	console.log("É BOT:", ejectedBot);
	console.log("EMPATE:", tie);
	console.log("================================");

	// Remove o bot eliminado dos clientes.
	if (ejected && ejectedBot) {
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
// VERIFICAR SE TODOS VOTARAM
// =====================================

function verificarVotos(room) {
	if (!room || !room.meeting || !room.meeting.active) return;

	const participantesVivos = obterParticipantesVivos(room);

	if (participantesVivos.length === 0) {
		finalizarReuniao(room);
		return;
	}

	const todosVotaram = participantesVivos.every(id =>
		Object.prototype.hasOwnProperty.call(
			room.meeting.votes,
			id
		)
	);

	if (todosVotaram) {
		console.log("TODOS OS PARTICIPANTES VOTARAM!");
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

		if (room.meeting && room.meeting.active) {
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

				sendToRoom(room, {
					cmd: "host_changed",
					content: {
						uuid: room.host
					}
				});
			}
		}

		atualizarControladorSeNecessario(room, uuid);

		if (Object.keys(room.players).length === 0) {
			if (room.meeting && room.meeting.timer) {
				clearTimeout(room.meeting.timer);
			}

			if (room.meeting) {
				limparTimersDosBots(room.meeting);
			}

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
// BOT REPORTAR CORPO
// =====================================

case "bot_report_body": {
	const room = rooms.get(socket.roomId);

	if (!room || !room.started || room.finished) return;
	if (room.meeting.active) return;

	// Somente o controlador dos bots pode solicitar.
	if (uuid !== room.botController) return;

	const botId = String(content.bot_id || "");
	const bodyUUID = String(content.body_uuid || "");

	const bot = room.bots[botId];
	const body = room.bodies[bodyUUID];

	if (!bot || !body) return;
	if (room.alive[botId] !== true) return;

	// O bot não pode reportar automaticamente
	// o corpo que ele mesmo criou.
	// O self-report é decidido no bot_kill.
	if (body.killer_id === botId) return;

	const distancia = Math.hypot(
	bot.x - body.x,
	bot.y - body.y
	);

	if (distancia > REPORT_DISTANCE) return;

	console.log(
		"BOT REPORTOU CORPO:",
		obterNome(room, botId),
		"CORPO:",
		bodyUUID
	);

	iniciarReuniao(
		room,
		botId,
		"body_report",
		bodyUUID
	);

	break;
}	

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
						startedAt: null,
						timer: null,
						botTimers: []
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

				verificarVotos(room);
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

				criarCorpo(room, botId, bot.x, bot.y, uuid);

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

				const body = criarCorpo(
					room,
					target,
					victim.x,
					victim.y,
					uuid
				);
				sendToRoom(room, {
					cmd: "player_killed",
					content: {
						uuid: target,
						killer_id: uuid,
						body
					}
				});

				verificarVitoria(room);

				// Se a partida acabou, não existe self-report.
				if (room.finished) break;

				// 20% de chance de self-report.
				if (room.bodies[target] && Math.random() < 0.20) {
					console.log(
					"[SELF REPORT] ",
					obterNome(room, botId),
					" reportou o próprio assassinato!"
				);

				iniciarReuniao(
					room,
					botId,
					"body_report",
					target
				);
}

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
				if (!room.players[uuid]) return;

				const target = String(content.target || "");

				if (!target) return;

				// Só aceita Skip ou participante vivo.
				if (target !== "skip") {
					if (room.alive[target] !== true) return;
					if (!room.players[target] && !room.bots[target]) return;
				}

				// Não permite votar duas vezes.
				if (
					Object.prototype.hasOwnProperty.call(
						room.meeting.votes,
						uuid
					)
				) return;

				room.meeting.votes[uuid] = target;

				const totalVivos = obterParticipantesVivos(room).length;
				const votesCast = Object.keys(room.meeting.votes).length;

				sendToRoom(room, {
					cmd: "vote_received",
					content: {
						uuid,
						total_votes: votesCast,
						total_alive: totalVivos
					}
				});

				console.log(
					"VOTO RECEBIDO:",
					obterNome(room, uuid),
					"->",
					target === "skip" ? "SKIP" : obterNome(room, target)
				);

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
