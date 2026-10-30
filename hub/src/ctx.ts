import type { DB } from './db.js';
import type { HubConfig } from './config.js';

export interface RouteCtx {
  db: DB;
  config: HubConfig;
}
