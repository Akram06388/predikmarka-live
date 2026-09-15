const leagueMap = {
    bl1: 'bl1',
    pl: 'eng1',
    laliga: 'es1',
    seriea: 'it1'
};

function seasonForNow() {
    const now = new Date();
    return now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

function response(body, statusCode = 200) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify(body)
    };
}

function toMatchPayload(match) {
    const result = match.MatchResults?.[match.MatchResults.length - 1];
    const start = Date.parse(match.MatchDateTime || '');
    const minute = Number.isFinite(start)
        ? Math.max(0, Math.min(90, Math.floor((Date.now() - start) / 60000)))
        : 0;

    return {
        matchId: match.MatchID,
        homeTeam: match.Team1?.TeamName || 'HOME',
        awayTeam: match.Team2?.TeamName || 'AWAY',
        minute,
        scoreHome: Number(result?.PointsTeam1 || 0),
        scoreAway: Number(result?.PointsTeam2 || 0),
        redHome: 0,
        redAway: 0,
        updatedAt: new Date().toISOString()
    };
}

function toLivePayload(matches, league) {
    if (!matches.length) {
        return {
            isLive: false,
            source: 'OpenLigaDB free football data',
            league,
            matches: [],
            message: 'No live match found for this competition.'
        };
    }

    return {
        isLive: true,
        source: 'OpenLigaDB free football data',
        league,
        matches: matches.map(toMatchPayload),
        updatedAt: new Date().toISOString(),
        note: 'Free provider coverage for minute and cards may be limited.'
    };
}

exports.handler = async function handler(event) {
    const league = event.queryStringParameters?.league || 'bl1';
    const providerLeague = leagueMap[league] || leagueMap.bl1;
    const endpoint = `https://www.openligadb.de/api/getmatchdata/${providerLeague}/${seasonForNow()}`;

    try {
        const providerResponse = await fetch(endpoint, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(8000)
        });
        if (!providerResponse.ok) {
            return response({ isLive: false, source: 'OpenLigaDB unavailable', league }, 502);
        }

        const matches = await providerResponse.json();
        const now = Date.now();
        const liveMatches = matches
            .filter(match => !match.MatchIsFinished)
            .filter(match => {
                const start = Date.parse(match.MatchDateTime || '');
                return Number.isFinite(start) && start <= now && now - start <= 100 * 60000;
            })
            .sort((a, b) => Date.parse(a.MatchDateTime) - Date.parse(b.MatchDateTime))
            .slice(0, 10);

        return response(toLivePayload(liveMatches, league));
    } catch (error) {
        return response({
            isLive: false,
            source: 'OpenLigaDB unavailable',
            league,
            error: error.message
        }, 502);
    }
};
