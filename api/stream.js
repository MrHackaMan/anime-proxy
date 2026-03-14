const https = require('https');

function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; AnimeArchive/1.0)',
                'Accept': 'application/rss+xml, text/xml, */*'
            }
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchUrl(res.headers.location).then(resolve).catch(reject);
            }
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function parseRSS(xml) {
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
        const block = match[1];
        const title    = (block.match(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/) || block.match(/<title>([^<]+)<\/title>/))?.[1]?.trim() || '';
        const magnetEl = block.match(/<torrent:magnetURI><!\[CDATA\[(magnet:[^\]]+)\]\]>/);
        const magnetRaw = block.match(/(magnet:\?[^\s<"']+)/);
        const magnet   = magnetEl?.[1] || magnetRaw?.[1] || '';
        const seeders  = parseInt(block.match(/<nyaa:seeders>(\d+)<\/nyaa:seeders>/)?.[1] || '0');
        const size     = block.match(/<nyaa:size>([^<]+)<\/nyaa:size>/)?.[1] || '';
        if (title && magnet) items.push({ title, magnet, seeders, size });
    }
    return items;
}

async function search(q) {
    const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(q)}&c=1_2&f=0`;
    const res = await fetchUrl(url);
    if (res.status !== 200) return [];
    return parseRSS(res.body);
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    const { q, title, ep } = req.query;

    // If raw query provided, just search it
    if (q) {
        try {
            let results = await search(q);
            // fallback: broaden to all anime category
            if (!results.length) {
                const url2 = `https://nyaa.si/?page=rss&q=${encodeURIComponent(q)}&c=1_0&f=0`;
                const res2 = await fetchUrl(url2);
                results = parseRSS(res2.body);
            }
            results.sort((a,b) => b.seeders - a.seeders);
            return res.json({ success: true, query: q, results: results.slice(0, 10) });
        } catch(e) {
            return res.status(500).json({ success: false, error: e.message });
        }
    }

    // If title + ep provided, try multiple query formats automatically
    if (title && ep) {
        const epPadded = String(ep).padStart(2, '0');
        const queries = [
            `${title} - ${epPadded}`,           // "Steins;Gate - 01"
            `${title} ${epPadded}`,             // "Steins;Gate 01"
            `SubsPlease ${title} ${epPadded}`,  // "SubsPlease Steins;Gate 01"
            `${title} Episode ${ep}`,            // "Steins;Gate Episode 1"
        ];

        try {
            for (const query of queries) {
                let results = await search(query);
                if (!results.length) {
                    // Try broad category too
                    const url2 = `https://nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=1_0&f=0`;
                    const r2 = await fetchUrl(url2);
                    results = parseRSS(r2.body);
                }
                if (results.length) {
                    results.sort((a,b) => b.seeders - a.seeders);
                    return res.json({ success: true, query, results: results.slice(0, 10) });
                }
            }
            return res.json({ success: false, error: 'No results found for any query format', tried: queries });
        } catch(e) {
            return res.status(500).json({ success: false, error: e.message });
        }
    }

    return res.status(400).json({ error: 'Provide either ?q=search+term or ?title=Anime+Title&ep=1' });
};
