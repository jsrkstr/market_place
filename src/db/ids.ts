import { customAlphabet } from 'nanoid';

const gen = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 14);

/** Prefixed, human-distinguishable ids: lst_…, req_…, mat_… */
export const newId = (prefix: 'usr' | 'lst' | 'img' | 'req' | 'mat' | 'int' | 'msg' | 'inb' | 'evt' | 'cli' | 'lgc') =>
  `${prefix}_${gen()}`;
