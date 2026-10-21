// Where Deck Apps live: installed copies, each app's own data, content packs.
import path from 'node:path';
import { dataPath } from '../core/paths.mjs';

export const appsDir = () => dataPath('apps');
export const appDir = id => path.join(appsDir(), id);
export const appDataDir = id => dataPath('app-data', id);
export const packsDir = appId => dataPath('packs', appId);
export const packsRoot = () => dataPath('packs');
export const packDir = (appId, packId) => path.join(packsDir(appId), packId);
