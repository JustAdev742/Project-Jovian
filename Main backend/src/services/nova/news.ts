// Backend-served news feed. Edit data/news.json to change what the launcher shows;
// falls back to these defaults if the file is missing/invalid.
import fs from 'fs';
import path from 'path';
import { Config } from '../../config';

export type NewsItem = { id: string; title: string; date: string; desc: string; img?: string; body?: string };

const NEWS_FILE = path.join(Config.DATA_DIR, 'news.json');

const DEFAULT_NEWS: NewsItem[] = [
  {
    id: 'welcome',
    title: 'Welcome to Project Nova',
    date: '2019-02-14',
    desc: 'Chapter 1 Season 7 is live. Log in, drop in, and enjoy the OG experience.',
    img: 'https://i.ibb.co/HLQqKrj4/Chapter-2-Remix-Header.webp',
  },
  {
    id: 'matchmaking',
    title: 'Matchmaking is online',
    date: '2019-02-14',
    desc: 'Press Play to matchmake straight into a game. Report issues in Discord.',
    img: 'https://i.ibb.co/yBBpHp1D/Chapter-2-Season-4-Key-Art-Fortnite.webp',
  },
  {
    id: 'locker',
    title: 'All cosmetics unlocked',
    date: '2019-02-14',
    desc: 'Every S7 skin, emote, pickaxe and glider is yours. Your locker now saves your loadout.',
    img: 'https://i.ibb.co/DDsGMMyh/hq720.jpg',
  },
];

export function getNews(): NewsItem[] {
  try {
    if (fs.existsSync(NEWS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(NEWS_FILE, 'utf-8'));
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.news)) return parsed.news;
    }
  } catch { /* fall through to defaults */ }
  return DEFAULT_NEWS;
}
