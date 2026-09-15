const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const PROVIDER = 'OpenLigaDB free football data';
const leagueMap = {
    bl1: 'bl1',
    pl: 'eng1',
    laliga: 'es1',
    seriea: 'it1'
};
const clients = new Set();
const cache = new Map();

function seasonForNow() {
    const now = new Date();
    return now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

function json(response, status, body) {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
    });
    response.end(payload);
}

function scoreFromMatch(match) {
    const result = match?.MatchResults?.[match.MatchResults.length - 1];
    return {
        home: Number(result?.PointsTeam1 || 0),
        away: Number(result?.PointsTeam2 || 0)
    };
}

function minuteFromMatch(match) {
    const start = Date.parse(match?.MatchDateTime || '');
    if (!Number.isFinite(start)) return 0;
    const elapsed = Math.floor((Date.now() - start) / 60000);
    return Math.max(0, Math.min(90, elapsed));
}

function toLivePayload(match, league) {
    if (!match) {
        return {
            isLive: false,
            source: PROVIDER,
            league,
            message: 'No live match found for this competition.'
        };
    }

    const score = scoreFromMatch(match);
    const minute = minuteFromMatch(match);
    return {
        isLive: minute >= 0 && minute <= 95 && !match.MatchIsFinished,
        source: PROVIDER,
        league,
        matchId: match.MatchID,
        homeTeam: match.Team1?.TeamName || 'HOME',
        awayTeam: match.Team2?.TeamName || 'AWAY',
        minute,
        scoreHome: score.home,
        scoreAway: score.away,
        redHome: 0,
        redAway: 0,
        updatedAt: new Date().toISOString(),
        note: 'OpenLigaDB provides free match and score data; minute and cards depend on provider coverage.'
    };
}

async function fetchProvider(league) {
    const providerLeague = leagueMap[league] || leagueMap.bl1;
    const season = seasonForNow();
    const endpoint = `https://www.openligadb.de/api/getmatchdata/${providerLeague}/${season}`;
    const response = await fetch(endpoint, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);

    const matches = await response.json();
    const now = Date.now();
    const liveMatch = matches
        .filter(match => !match.MatchIsFinished)
        .filter(match => {
            const start = Date.parse(match.MatchDateTime || '');
            return Number.isFinite(start) && start <= now && now - start <= 100 * 60000;
        })
        .sort((a, b) => Date.parse(a.MatchDateTime) - Date.parse(b.MatchDateTime))[0];

    const payload = toLivePayload(liveMatch, league);
    cache.set(league, payload);
    return payload;
}

async function getLive(league) {
    try {
        return await fetchProvider(league);
    } catch (error) {
        const fallback = cache.get(league);
        if (fallback) return { ...fallback, source: `${fallback.source} (cached)` };
        return {
            isLive: false,
            source: `${PROVIDER} unavailable`,
            league,
            error: error.message
        };
    }
}

async function broadcast(league) {
    const payload = await getLive(league);
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN && client.league === league) {
            client.send(JSON.stringify(payload));
        }
    }
}

const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);

    if (requestUrl.pathname === '/api/live') {
        const league = requestUrl.searchParams.get('league') || 'bl1';
        json(response, 200, await getLive(league));
        return;
    }

    if (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html') {
        fs.createReadStream(path.join(ROOT, 'index.html')).on('error', () => {
            json(response, 404, { error: 'index.html not found' });
        }).pipe(response);
        return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
});

const socketServer = new WebSocket.Server({ server, path: '/ws' });
socketServer.on('connection', async (socket, request) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    socket.league = requestUrl.searchParams.get('league') || 'bl1';
    clients.add(socket);
    socket.send(JSON.stringify(await getLive(socket.league)));
    socket.on('close', () => clients.delete(socket));
});

setInterval(() => {
    for (const league of Object.keys(leagueMap)) broadcast(league);
}, 15000);

server.listen(PORT, () => {
    console.log(`PredikMarka running at http://localhost:${PORT}`);
    console.log(`Live API: http://localhost:${PORT}/api/live?league=bl1`);
    console.log('WebSocket: ws://localhost:' + PORT + '/ws?league=bl1');
});
