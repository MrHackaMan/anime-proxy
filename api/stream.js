const https = require('https');
const http = require('http');

function fetchUrl(url, isBinary = false) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': '*/*'
            }
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchUrl(res.headers.location, isBinary).then(resolve).catch(reject);
            }
            if (isBinary) {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
            } else {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => resolve({ status: res.statusCode, body: data }));
            }
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function parseRSS(xml) {
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
        const block = match[1];

        const title    = (block.match(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/) || block.match(/<title>([^<]+)<\/title>/))?.[1]?.trim() || '';
        const infoHash = block.match(/<nyaa:infoHash>([^<]+)<\/nyaa:infoHash>/)?.[1]?.trim() || '';
        const seeders  = parseInt(block.match(/<nyaa:seeders>(\d+)<\/nyaa:seeders>/)?.[1] || '0');
        const size     = block.match(/<nyaa:size>([^<]+)<\/nyaa:size>/)?.[1] || '';

        // Nyaa torrent download URL is at /download/{id}.torrent
        // The guid/link looks like: https://nyaa.si/view/123456
        const viewUrl = block.match(/<guid[^>]*>(https?:\/\/nyaa\.si\/view\/(\d+))<\/guid>/);
        const torrentId = viewUrl?.[2] || '';
        const torrentFileUrl = torrentId ? `https://nyaa.si/download/${torrentId}.torrent` : null;

        // Build magnet from infoHash
        const magnet = infoHash
            ? 'magnet:?xt=urn:btih:' + infoHash + '&dn=' + encodeURIComponent(title) + '&tr=http://nyaa.tracker.wf:7777/announce&tr=udp://open.stealth.si:80/announce&tr=udp://tracker.opentrackr.org:1337/announce'
            : '';

        if (title && magnet) items.push({ title, magnet, torrentFileUrl, seeders, size, infoHash });
    }
    return items;
}

// Parse torrent file to extract webseed URLs
function parseTorrentWebseeds(buf) {
    // Look for url-list or url in the bencoded data
    const str = buf.toString('binary');
    const webseeds = [];
    
    // Match url-list entries: 8:url-list + bencoded string or list
    const urlListMatch = str.match(/8:url-list(?:l([\s\S]*?)e|(\d+):([^\x00-\x1f]{10,500}))/);
    if (urlListMatch) {
        // Extract URLs from bencoded list
        const urlRegex = /(\d+):(https?:\/\/[^\x00-\x20\x7f-\xff]{10,500})/g;
        const content = urlListMatch[0];
        let m;
        while ((m = urlRegex.exec(content)) !== null) {
            const len = parseInt(m[1]);
            const url = m[2].substring(0, len);
            if (url.startsWith('http')) webseeds.push(url);
        }
    }
    return webseeds;
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
    const queries = [
        { q: `${title} - ${epPadded}`,          cat: '1_2' },
        { q: `${title} ${epPadded}`,            cat: '1_2' },
        { q: `SubsPlease ${title} ${epPadded}`, cat: '1_2' },
        { q: `${title} - ${epPadded}`,          cat: '1_0' },
        { q: `${title} ${epPadded}`,            cat: '1_0' },
    ];

    let bestItems = [];
    let usedQuery = '';

    for (const { q, cat } of queries) {
        try {
            const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(q)}&c=${cat}&f=0`;
            const r = await fetchUrl(url);
            if (r.status === 200) {
                const items = parseRSS(r.body);
                const epStr = String(ep);
                const epPad = epPadded;
                const filtered = items.filter(r => {
                    const t = r.title.toLowerCase();
                    const hasEp = t.includes(` - ${epPad}`) || t.includes(` ${epPad} `) ||
                                  t.includes(`- ${epPad}[`) || t.includes(`${epPad}v`);
                    const isBatch = t.includes('batch') || t.includes('complete') ||
                                    /\d+-\d+/.test(t);
                    return hasEp && !isBatch;
                });
                if (filtered.length) {
                    filtered.sort((a,b) => b.seeders - a.seeders);
                    bestItems = filtered;
                    usedQuery = q;
                    break;
                }
            }
        } catch(e) { /* try next */ }
    }

    if (!bestItems.length) {
        return res.json({ success: false, error: 'No results found', tried: queries.map(q=>q.q) });
    }

    // Return results with torrent file URL so client can fetch directly
    // Client fetching the .torrent file gives WebTorrent access to webseed URLs
    const results = bestItems.slice(0, 5).map(item => ({
        ...item,
        torrentFileUrl: item.torrentUrl || null
    }));

    return res.json({ success: true, query: usedQuery, results });
};
