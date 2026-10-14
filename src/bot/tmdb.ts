import axios from 'axios';
import { pino } from 'pino';

const logger = pino({
  transport: {
    target: 'pino-pretty',
  },
});

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const BASE_URL = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

export interface TMDBMeta {
  title?: string;
  year?: number;
  poster_url?: string;
  overview?: string;
  rating?: string;
  genres?: string;
  tmdb_id?: number;
}

export async function searchTMDB(title: string, year: number | null, category: string): Promise<TMDBMeta> {
  if (!TMDB_API_KEY) {
    logger.warn('TMDB_API_KEY is missing. Skipping metadata fetch.');
    return {};
  }

  try {
    const type = category === 'movies' ? 'movie' : 'tv';
    const params: any = {
      api_key: TMDB_API_KEY,
      query: title,
    };

    if (year) {
      if (type === 'movie') {
        params.primary_release_year = year;
      } else {
        params.first_air_date_year = year;
      }
    }

    let response = await axios.get(`${BASE_URL}/search/${type}`, { params });

    // If no results for TV show with a year, try without the year (as it might be a later season)
    if (response.data.results.length === 0 && type === 'tv' && year) {
      delete params.first_air_date_year;
      response = await axios.get(`${BASE_URL}/search/${type}`, { params });
    }

    const result = response.data.results[0];
    if (!result) return {};

    // Get Genre names
    const genresResponse = await axios.get(`${BASE_URL}/genre/${type}/list`, {
      params: { api_key: TMDB_API_KEY }
    });
    const genreMap = new Map(genresResponse.data.genres.map((g: any) => [g.id, g.name]));
    const genreNames = (result.genre_ids || [])
      .map((id: number) => genreMap.get(id))
      .filter(Boolean)
      .join(', ');

    return {
      title: result.title || result.name,
      year: result.release_date ? parseInt(result.release_date.split('-')[0]) : result.first_air_date ? parseInt(result.first_air_date.split('-')[0]) : year || undefined,
      poster_url: result.poster_path ? `${IMAGE_BASE}${result.poster_path}` : undefined,
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

export async function getShowStatus(title: string, category: string): Promise<string> {
  if (!TMDB_API_KEY) return "";
  
  try {
    const type = category === 'movies' ? 'movie' : 'tv';
    if (type === 'movie') return "Ended";

    const searchResponse = await axios.get(`${BASE_URL}/search/tv`, {
      params: { api_key: TMDB_API_KEY, query: title }
    });

    const show = searchResponse.data.results[0];
    if (!show) return "";

    const detailsResponse = await axios.get(`${BASE_URL}/tv/${show.id}`, {
      params: { api_key: TMDB_API_KEY }
    });

    return detailsResponse.data.status || ""; 
  } catch {
    return "";
  }
}
