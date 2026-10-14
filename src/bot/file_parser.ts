/**
 * Parses filenames to extract title, year, quality, season, and episode.
 */
export function parseFilename(filename: string) {
  let cleanName = filename.replace(/[\._]/g, ' ');
  
  // Quality detection
  const qualityMatch = cleanName.match(/(2160p|4k|1080p|720p|480p|360p|HDR)/i);
  const quality = qualityMatch ? qualityMatch[1].toUpperCase() : 'Unknown';
  
  // Season/Episode (S01E01, 1x01, Episode 01)
  const seMatch = cleanName.match(/s(\d+)e(\d+)/i) || cleanName.match(/(\d+)x(\d+)/) || cleanName.match(/s(\d+)\s*ep?\s*(\d+)/i);
  const eOnlyMatch = cleanName.match(/\bE(P|PISODE)?\s*(\d+)\b/i);
  const sOnlyMatch = cleanName.match(/\bS(EASON)?\s*(\d+)\b/i);
  let season: number | null = null;
  let episode: number | null = null;
  
  if (seMatch) {
    season = parseInt(seMatch[1]);
    episode = parseInt(seMatch[2]);
  } else if (eOnlyMatch) {
    episode = parseInt(eOnlyMatch[2]);
    // Try to find season separately
    if (sOnlyMatch) season = parseInt(sOnlyMatch[2]);
  } else if (sOnlyMatch) {
    season = parseInt(sOnlyMatch[2]);
  }
  
  // Year - avoid matching season/episode numbers by looking for 4 digits
  const yearMatch = cleanName.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? parseInt(yearMatch[0]) : null;

  // Additional Metadata
  const codecs = cleanName.match(/\b(x264|x265|HEVC|H264|H265|AVC|10bit|10-bit)\b/i);
  const audio = cleanName.match(/\b(Dual[- ]Audio|Hindi|English|Japanese|TAMIL|TELUGU|MALAYALAM|KANNADA|MULTI|Dubbed)\b/i);
  const extra = [];
  if (codecs) extra.push(codecs[0].toUpperCase());
  if (audio) extra.push(audio[0].toUpperCase());
  
  // Extract Title (everything before the first tag or year or season/episode)
  let title = cleanName;
  
  // Explicitly remove season/episode patterns from title string before tag processing
  const patternsToRemove = [
    /s(\d+)e(\d+)/i,
    /(\d+)x(\d+)/,
    /s(\d+)\s*ep?\s*(\d+)/i,
    /\bE(P|PISODE)?\s*(\d+)\b/i,
    /\bS(EASON)?\s*(\d+)\b/i,
    /\bSeason\s*\d+\b/i,
    /\bS\d+\b/i,
    /\bE\d+\b/i
  ];

  for (const pattern of patternsToRemove) {
    const match = title.match(pattern);
    if (match && match.index !== undefined) {
      title = title.substring(0, match.index);
    }
  }

  const tags = [
    '2160p', '4k', '1080p', '720p', '480p', '360p', 'HDR',
    'BluRay', 'WEB-DL', 'WEBRip', 'DVDRip', 'x264', 'x265', 'H264', 'H265', 'HEVC',
    'dual', 'hindi', 'multi', '10bit', 'hdtv', 'web'
  ];
  
  if (year) {
    const yearIdx = title.indexOf(year.toString());
    if (yearIdx !== -1) {
      title = title.substring(0, yearIdx);
    }
  }
  
  for (const tag of tags) {
    const regex = new RegExp(`\\b${tag}\\b`, 'i');
    if (title.match(regex)) {
      title = title.split(regex)[0];
    }
  }

  // Handle case where title ended with a dash or bracket
  title = title.replace(/[-(\[]\s*$/, '');
  
  // Final cleanup
  title = title.trim().replace(/\s+/g, ' ');
  
  return {
    title,
    year,
    quality,
    season,
    episode,
    tags: [...extra, quality !== 'Unknown' ? quality : ''].filter(Boolean).join(' | ')
  };
}

export function formatRenamedFilename(
  parsed: {
    title: string;
    year?: number | null;
    quality?: string;
    season?: number | null;
    episode?: number | null;
  },
  originalName: string = ''
): string {
  const extMatch = originalName.match(/\.([a-zA-Z0-9]{2,4})$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : 'mkv';

  const cleanTitle = parsed.title.trim();
  const quality = (parsed.quality && parsed.quality !== 'Unknown') ? parsed.quality : '1080p';

  // Series / Anime Format
  if (parsed.season !== null && parsed.season !== undefined && parsed.episode !== null && parsed.episode !== undefined) {
    const sStr = `S${parsed.season.toString().padStart(2, '0')}`;
    const eStr = `E${parsed.episode.toString().padStart(2, '0')}`;
    const yearStr = parsed.year ? ` (${parsed.year})` : '';
    return `${cleanTitle} ${sStr}${eStr}${yearStr} [${quality}] @VinehillMain .${ext}`;
  }

  // Movie Format: Title (Year) [1080p] @VinehillMain .mkv
  const yearStr = parsed.year ? ` (${parsed.year})` : '';
  return `${cleanTitle}${yearStr} [${quality}] @VinehillMain .${ext}`.trim();
}
