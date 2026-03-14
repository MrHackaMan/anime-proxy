// Vercel serverless proxy — searches Nyaa.si RSS and returns magnet links
// No scraping, no bot protection issues — Nyaa RSS is a public API

const https = require('https');

function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; AnimeArchive/1.0)',
                'Accept': 'application/rss+xml, application/xml, text/xml, */*'
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
        const title   = (block.match(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/) || block.match(/<title>([^<]+)<\/title>/))?.[1] || '';
        const magnet  = (block.match(/<torrent:magnetURI><!\[CDATA\[([^\]]+)\]\]>/) || block.match(/magnet:[^<"'\s]+/))?.[1] || (block.match(/(magnet:[^<\s"']+)/))?.[1] || '';
        const link    = (block.match(/<guid[^>]*>([^<]+)<\/guid>/))?.[1] || '';
        const seeders = parseInt((block.match(/<nyaa:seeders>(\d+)<\/nyaa:seeders>/))?.[1] || '0');
        const size    = (block.match(/<nyaa:size>([^<]+)<\/nyaa:size>/))?.[1] || '';
        if (title && magnet) items.push({ title, magnet, link, seeders, size });
    }
    return items;
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    const { q } = req.query;
    // q = search query e.g. "Steins Gate 01 1080p SubsPlease"
    if (!q) return res.status(400).json({ error: 'Missing ?q= search query' });

    try {
        // Search Nyaa RSS — category 1_2 = Anime English Translated
        const searchUrl = `https://nyaa.si/?page=rss&q=${encodeURIComponent(q)}&c=1_2&f=0`;
        const result = await fetchUrl(searchUrl);

        if (result.status !== 200) {
            return res.status(502).json({ error: `Nyaa returned ${result.status}` });
        }

        const items = parseRSS(result.body);

        if (!items.length) {
            // Try broader search without quality filter
            const broadUrl = `https://nyaa.si/?page=rss&q=${encodeURIComponent(q)}&c=1_0&f=0`;
            const broad = await fetchUrl(broadUrl);
            const broadItems = parseRSS(broad.body);
            return res.json({ success: true, query: q, results: broadItems.slice(0, 10), source: 'broad' });
        }

        // Sort by seeders descending
        items.sort((a, b) => b.seeders - a.seeders);

        return res.json({ success: true, query: q, results: items.slice(0, 10), source: 'nyaa' });

    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
};
