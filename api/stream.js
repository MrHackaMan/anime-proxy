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

        // Title — handle CDATA and plain
        const titleMatch = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)
            || block.match(/<title>([\s\S]*?)<\/title>/);
        const title = titleMatch?.[1]?.trim() || '';

        // Magnet — nyaa puts it in <nyaa:magnetUri> or <torrent:magnetURI> or plain link
        const magnetMatch = block.match(/<(?:nyaa|torrent):magnetURI[^>]*><!\[CDATA\[(magnet:[^\]]+)\]\]>/)
            || block.match(/<(?:nyaa|torrent):magnetURI[^>]*>(magnet:[^<]+)<\//)
            || block.match(/(magnet:\?xt=[^\s<"'&]+)/);
        const magnet = magnetMatch?.[1]?.trim() || '';

        // Torrent link as fallback
        const linkMatch = block.match(/<link>(https?:\/\/nyaa\.si\/download\/[^<]+)<\/link>/)
            || block.match(/<guid[^>]*>(https?:\/\/nyaa\.si\/view\/\d+)<\/guid>/);
        const torrentLink = linkMatch?.[1] || '';

        const seeders = parseInt(block.match(/<nyaa:seeders>(\d+)<\/nyaa:seeders>/)?.[1] || '0');
        const size    = block.match(/<nyaa:size>([^<]+)<\/nyaa:size>/)?.[1] || '';
        const infoHash = block.match(/<nyaa:infoHash>([^<]+)<\/nyaa:infoHash>/)?.[1] || '';

        // Build magnet from infoHash if no magnet found directly
        let finalMagnet = magnet;
        if (!finalMagnet && infoHash) {
            finalMagnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`;
        }
        // Build magnet from torrent download link ID
        if (!finalMagnet && torrentLink) {
            const idMatch = torrentLink.match(/\/download\/(\d+)\.torrent/);
            if (idMatch) finalMagnet = torrentLink; // return download link, player can handle it
        }

        if (title) items.push({ title, magnet: finalMagnet, torrentLink, seeders, size, infoHash });
    }
    return items;
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    const { title, ep, debug } = req.query;
    if (!title || !ep) return res.status(400).json({ error: 'Provide ?title=&ep=' });

    const epPadded = String(ep).padStart(2, '0');
    const queries = [
        { q: `${title} - ${epPadded}`,          cat: '1_2' },
        { q: `${title} ${epPadded}`,            cat: '1_2' },
        { q: `SubsPlease ${title} ${epPadded}`, cat: '1_2' },
        { q: `${title} - ${epPadded}`,          cat: '1_0' },
        { q: `${title} ${epPadded}`,            cat: '1_0' },
    ];

    for (const { q, cat } of queries) {
        try {
            const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(q)}&c=${cat}&f=0`;
            const r = await fetchUrl(url);
            if (r.status === 200) {
                const items = parseRSS(r.body);
                if (debug) return res.json({ query: q, raw: r.body.slice(0, 2000), items });
                if (items.length) {
                    items.sort((a,b) => b.seeders - a.seeders);
                    return res.json({ success: true, query: q, results: items.slice(0, 10) });
                }
            }
        } catch(e) { /* try next */ }
    }

    // debug mode — return raw XML of last attempt so we can see the structure
    if (debug) {
        const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(title)}&c=1_0&f=0`;
        const r = await fetchUrl(url);
        return res.json({ raw: r.body.slice(0, 3000) });
    }

    return res.json({ success: false, error: 'No results with magnets found', tried: queries.map(q=>q.q) });
};
