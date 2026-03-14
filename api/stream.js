const https = require('https');

function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/rss+xml, text/xml, */*'
            }
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchUrl(res.headers.location).then(resolve).catch(reject);
            }
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
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
        const title   = (block.match(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/) || block.match(/<title>([^<]+)<\/title>/))?.[1]?.trim() || '';
        const magnet  = block.match(/(magnet:\?[^\s<"']+)/)?.[1] || '';
        const seeders = parseInt(block.match(/<nyaa:seeders>(\d+)<\/nyaa:seeders>/)?.[1] || '0');
        const size    = block.match(/<nyaa:size>([^<]+)<\/nyaa:size>/)?.[1] || '';
        if (title && magnet) items.push({ title, magnet, seeders, size });
    }
    return items;
}

const MIRRORS = [
    'https://nyaa.si',
    'https://nyaa.iss.one',
];

async function searchNyaa(q, category = '1_2') {
    for (const mirror of MIRRORS) {
        try {
            const url = `${mirror}/?page=rss&q=${encodeURIComponent(q)}&c=${category}&f=0`;
            const res = await fetchUrl(url);
            if (res.status === 200 && res.body.includes('<item>')) {
                return { items: parseRSS(res.body), mirror };
            }
        } catch(e) { /* try next mirror */ }
    }
    return { items: [], mirror: null };
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    const { title, ep } = req.query;
    if (!title || !ep) return res.status(400).json({ error: 'Provide ?title=&ep=' });

    const epPadded = String(ep).padStart(2, '0');

    // Try these query formats in order, across all mirrors
    const queries = [
        { q: `${title} - ${epPadded}`,           cat: '1_2' },
        { q: `${title} ${epPadded}`,             cat: '1_2' },
        { q: `SubsPlease ${title} ${epPadded}`,  cat: '1_2' },
        { q: `${title} - ${epPadded}`,           cat: '1_0' },
        { q: `${title} ${epPadded}`,             cat: '1_0' },
    ];

    const tried = [];
    for (const { q, cat } of queries) {
        tried.push(q);
        const { items, mirror } = await searchNyaa(q, cat);
        if (items.length) {
            items.sort((a,b) => b.seeders - a.seeders);
            return res.json({ success: true, query: q, mirror, results: items.slice(0,10) });
        }
    }

    // Debug: return raw response from nyaa to see what's happening
    try {
        const debugUrl = `https://nyaa.si/?page=rss&q=${encodeURIComponent(title)}&c=1_0&f=0`;
        const raw = await fetchUrl(debugUrl);
        return res.json({
            success: false,
            error: 'No results found',
            tried,
            debugStatus: raw.status,
            debugHeaders: raw.headers,
            debugSnippet: raw.body.slice(0, 500)
        });
    } catch(e) {
        return res.json({ success: false, error: 'All mirrors failed: ' + e.message, tried });
    }
};
