import axios from 'axios';
import { pino } from 'pino';
import * as db from './database';

const logger = pino({
  transport: {
    target: 'pino-pretty',
  },
});

const BASE_URL = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

export function getTmdbApiKey(): string {
  const raw =
    process.env.TMDB_API_KEY ||
    process.env.TMDB_KEY ||
    process.env.TMDB_TOKEN ||
    process.env.TMDB_READ_ACCESS_TOKEN ||
    db.getConfig('TMDB_API_KEY') ||
    db.getConfig('TMDB_KEY') ||
    '';
  return raw.trim().replace(/^["']|["']$/g, '').trim();
}

export function getTmdbRequestConfig(params: Record<string, any> = {}) {
  const key = getTmdbApiKey();
  const config: {
    params: Record<string, any>;
    headers: Record<string, string>;
    timeout: number;
  } = {
    params: { ...params },
    headers: { Accept: 'application/json' },
    timeout: 10000,
  };

  if (!key) return config;

  if (key.startsWith('ey') || key.length > 50) {
    // TMDB v4 JWT Bearer Token
    config.headers['Authorization'] = `Bearer ${key}`;
  } else {
    // TMDB v3 API Key (pass in params and authorization header for compatibility)
    config.params.api_key = key;
    config.headers['Authorization'] = `Bearer ${key}`;
  }

  return config;
}

export async function testTmdbConnection(): Promise<{
  success: boolean;
  message: string;
  keySource?: string;
  statusCode?: number;
}> {
  const key = getTmdbApiKey();
  if (!key) {
    return {
      success: false,
      message: 'TMDB API key is not configured in environment or database.',
    };
  }

  const keySource = process.env.TMDB_API_KEY
    ? 'Environment (.env)'
    : db.getConfig('TMDB_API_KEY')
    ? 'Database (config)'
    : 'Config fallback';
  const maskedKey =
    key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : '****';

  try {
    const config = getTmdbRequestConfig();
    const res = await axios.get(`${BASE_URL}/configuration`, config);
    if (res.status === 200) {
      return {
        success: true,
        message: `✅ TMDB API connection verified! (${keySource}: <code>${maskedKey}</code>)`,
        keySource,
        statusCode: 200,
      };
    }
    return {
      success: false,
      message: `Unexpected status ${res.status} from TMDB API.`,
      statusCode: res.status,
    };
  } catch (err: any) {
    const status = err.response?.status;
    const errorMsg =
      err.response?.data?.status_message || err.message || 'Unknown network error';
    return {
      success: false,
      message: `❌ TMDB connection failed (${status || 'Network Error'}): ${errorMsg}`,
      keySource,
      statusCode: status,
    };
  }
}

export function cleanSearchQuery(raw: string): string {
  let cleaned = raw
    // Remove common video file extensions
    .replace(/\.(mkv|mp4|avi|mov|flv|wmv|webm|m4v)$/i, '')
    // Remove square brackets and their contents like [CC], [1080p], [YTS]
    .replace(/\[[^\]]*\]/g, ' ')
    // Replace dots, underscores, dashes with spaces
    .replace(/[._\-+]/g, ' ')
    // Remove resolution, audio, and encoding tags
    .replace(
      /\b(2160p|1080p|720p|480p|uhd|fhd|hd|brrip|bluray|web-dl|webdl|webrip|hevc|x265|x264|h265|h264|dvdrip|aac|ac3|ddp5\.1|atmos|repack)\b/gi,
      ' '
    )
    // Collapse extra spaces
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length < 2) {
    cleaned = raw.replace(/\.[a-zA-Z0-9]+$/, '').trim();
  }
  return cleaned;
}

export interface TMDBMeta {
  title?: string;
  year?: number;
  poster_url?: string;
  overview?: string;
  rating?: string;
  genres?: string;
  tmdb_id?: number;
}

export async function searchTMDB(
  title: string,
  year: number | null,
  category: string
): Promise<TMDBMeta> {
  const key = getTmdbApiKey();
  if (!key) {
    logger.warn('TMDB_API_KEY is missing. Skipping metadata fetch.');
    return {};
  }

  try {
    const type = category === 'movies' ? 'movie' : 'tv';
    const params: any = { query: title };

    if (year) {
      if (type === 'movie') {
        params.primary_release_year = year;
      } else {
        params.first_air_date_year = year;
      }
    }

    let response = await axios.get(
      `${BASE_URL}/search/${type}`,
      getTmdbRequestConfig(params)
    );

    // If no results for TV show with a year, try without the year (as it might be a later season)
    if (response.data.results.length === 0 && type === 'tv' && year) {
      delete params.first_air_date_year;
      response = await axios.get(
        `${BASE_URL}/search/${type}`,
        getTmdbRequestConfig(params)
      );
    }

    // If still no results, try cleaned title
    if (response.data.results.length === 0) {
      const cleaned = cleanSearchQuery(title);
      if (cleaned && cleaned !== title) {
        params.query = cleaned;
        response = await axios.get(
          `${BASE_URL}/search/${type}`,
          getTmdbRequestConfig(params)
        );
      }
    }

    // If still no results, fallback to multi search
    if (response.data.results.length === 0) {
      delete params.primary_release_year;
      delete params.first_air_date_year;
      params.query = cleanSearchQuery(title) || title;
      response = await axios.get(
        `${BASE_URL}/search/multi`,
        getTmdbRequestConfig(params)
      );
    }

    const result = response.data?.results?.[0];
    if (!result) return {};

    // Get Genre names
    let genreNames = '';
    try {
      const targetType = result.media_type || type;
      if (targetType === 'movie' || targetType === 'tv') {
        const genresResponse = await axios.get(
          `${BASE_URL}/genre/${targetType}/list`,
          getTmdbRequestConfig()
        );
        const genreMap = new Map(
          genresResponse.data.genres.map((g: any) => [g.id, g.name])
        );
        genreNames = (result.genre_ids || [])
          .map((id: number) => genreMap.get(id))
          .filter(Boolean)
          .join(', ');
      }
    } catch {
      // Genres are non-fatal
    }

    return {
      title: result.title || result.name,
      year: result.release_date
        ? parseInt(result.release_date.split('-')[0])
        : result.first_air_date
        ? parseInt(result.first_air_date.split('-')[0])
        : year || undefined,
      poster_url: result.poster_path
        ? `${IMAGE_BASE}${result.poster_path}`
        : undefined,
      overview: result.overview,
      rating: result.vote_average?.toFixed(1),
      genres: genreNames,
      tmdb_id: result.id,
    };
  } catch (error) {
    logger.error(`TMDB search failed: ${error}`);
    return {};
  }
}

export async function getShowStatus(
  title: string,
  category: string
): Promise<string> {
  const key = getTmdbApiKey();
  if (!key) return '';

  try {
    const type = category === 'movies' ? 'movie' : 'tv';
    if (type === 'movie') return 'Ended';

    const searchResponse = await axios.get(
      `${BASE_URL}/search/tv`,
      getTmdbRequestConfig({ query: title })
    );

    const show = searchResponse.data?.results?.[0];
    if (!show) return '';

    const detailsResponse = await axios.get(
      `${BASE_URL}/tv/${show.id}`,
      getTmdbRequestConfig()
    );

    return detailsResponse.data?.status || '';
  } catch {
    return '';
  }
}

export interface TMDBCandidate {
  tmdb_id: number;
  title: string;
  year?: number;
  poster_url?: string;
  hasCover: boolean;
  overview?: string;
  rating?: string;
  category: string;
  media_type?: string;
}

export interface TMDBSearchResult {
  candidates: TMDBCandidate[];
  error?: string;
  statusCode?: number;
}

export async function searchTMDBCandidatesWithDiagnostics(
  query: string,
  category: string,
  limit = 5
): Promise<TMDBSearchResult> {
  const key = getTmdbApiKey();
  if (!key) {
    logger.warn('TMDB_API_KEY is missing. Skipping candidate search.');
    return {
      candidates: [],
      error: 'TMDB_KEY_NOT_CONFIGURED',
    };
  }

  const rawQuery = query.trim();
  if (!rawQuery) {
    return { candidates: [] };
  }

  try {
    const primaryType =
      category === 'movies' ? 'movie' : category === 'series' ? 'tv' : 'multi';

    // 1. First attempt: exact query on primary endpoint
    let response = await axios.get(
      `${BASE_URL}/search/${primaryType}`,
      getTmdbRequestConfig({ query: rawQuery })
    );

    let rawResults: any[] = response.data?.results || [];

    // 2. Second attempt: cleaned query if raw yielded no results or query contained file clutter
    const cleaned = cleanSearchQuery(rawQuery);
    if (rawResults.length === 0 && cleaned && cleaned.toLowerCase() !== rawQuery.toLowerCase()) {
      response = await axios.get(
        `${BASE_URL}/search/${primaryType}`,
        getTmdbRequestConfig({ query: cleaned })
      );
      rawResults = response.data?.results || [];
    }

    // 3. Third attempt: fallback to /search/multi if category was specific but gave 0 results
    if (rawResults.length === 0 && primaryType !== 'multi') {
      const multiQuery = cleaned || rawQuery;
      response = await axios.get(
        `${BASE_URL}/search/multi`,
        getTmdbRequestConfig({ query: multiQuery })
      );
      rawResults = (response.data?.results || []).filter(
        (r: any) => r.media_type === 'movie' || r.media_type === 'tv'
      );
    }

    // 4. Map candidates and sort: prioritize items with covers and popular items
    const candidates: TMDBCandidate[] = rawResults.slice(0, limit).map((r: any) => {
      const releaseDate = r.release_date || r.first_air_date || '';
      const year = releaseDate ? parseInt(releaseDate.split('-')[0]) : undefined;
      const posterPath = r.poster_path;
      const determinedCat =
        r.media_type === 'tv' ? 'series' : r.media_type === 'movie' ? 'movies' : category;

      return {
        tmdb_id: r.id,
        title: r.title || r.name || 'Unknown',
        year,
        poster_url: posterPath ? `${IMAGE_BASE}${posterPath}` : undefined,
        hasCover: Boolean(posterPath && posterPath.trim().length > 0),
        overview: r.overview,
        rating: r.vote_average ? Number(r.vote_average).toFixed(1) : undefined,
        category: determinedCat,
        media_type: r.media_type || (category === 'movies' ? 'movie' : 'tv'),
      };
    });

    return { candidates };
  } catch (error: any) {
    const status = error.response?.status;
    const msg =
      error.response?.data?.status_message || error.message || 'API request failed';
    logger.error(`TMDB candidate search failed (${status || 'Network Error'}): ${msg}`);

    return {
      candidates: [],
      error: msg,
      statusCode: status,
    };
  }
}

export async function searchTMDBCandidates(
  query: string,
  category: string,
  limit = 5
): Promise<TMDBCandidate[]> {
  const result = await searchTMDBCandidatesWithDiagnostics(query, category, limit);
  return result.candidates;
}

export async function getTMDBDetails(
  tmdbId: number,
  category: string
): Promise<TMDBMeta | null> {
  const key = getTmdbApiKey();
  if (!key) return null;

  try {
    let type = category === 'movies' ? 'movie' : 'tv';
    let response: any;

    try {
      response = await axios.get(
        `${BASE_URL}/${type}/${tmdbId}`,
        getTmdbRequestConfig()
      );
    } catch (e: any) {
      // If failed with wrong type, try opposite type
      if (e.response?.status === 404) {
        const altType = type === 'movie' ? 'tv' : 'movie';
        response = await axios.get(
          `${BASE_URL}/${altType}/${tmdbId}`,
          getTmdbRequestConfig()
        );
      } else {
        throw e;
      }
    }

    const result = response?.data;
    if (!result) return null;

    const genreNames = (result.genres || [])
      .map((g: any) => g.name)
      .filter(Boolean)
      .join(', ');
    const releaseDate = result.release_date || result.first_air_date || '';
    const year = releaseDate ? parseInt(releaseDate.split('-')[0]) : undefined;

    return {
      title: result.title || result.name,
      year,
      poster_url: result.poster_path
        ? `${IMAGE_BASE}${result.poster_path}`
        : undefined,
      overview: result.overview,
      rating: result.vote_average ? Number(result.vote_average).toFixed(1) : undefined,
      genres: genreNames,
      tmdb_id: result.id,
    };
  } catch (error) {
    logger.error(`TMDB getDetails failed: ${error}`);
    return null;
  }
}
