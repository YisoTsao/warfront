import {
  GRAYBOX_MAP_ID,
  grayboxCollision,
  grayboxManifest,
  parseMapCollision,
  parseMapManifest,
  type MapCollision,
  type MapManifest,
} from '@frontline/map-schema';

export interface LoadedMapData {
  manifest: MapManifest;
  collision: MapCollision;
  /** manifest 所在的網址或目錄，用來解析分塊路徑 */
  baseUrl: string;
}

/**
 * 依地圖 id 取得 manifest 與碰撞資料。灰盒是內建地圖；其他地圖從
 * `${mapsRoot}/${id}/map-manifest.json` 讀取。fetchJson 由呼叫端提供（瀏覽器用 fetch、伺服器讀檔）。
 */
export async function loadMapData(
  mapId: string,
  mapsRoot: string,
  fetchJson: (url: string) => Promise<unknown>,
): Promise<LoadedMapData> {
  if (mapId === GRAYBOX_MAP_ID) {
    return { manifest: grayboxManifest(), collision: grayboxCollision(), baseUrl: '' };
  }
  const baseUrl = `${mapsRoot.replace(/\/$/, '')}/${mapId}/`;
  const manifest = parseMapManifest(await fetchJson(`${baseUrl}map-manifest.json`));
  const collision = parseMapCollision(await fetchJson(`${baseUrl}${manifest.collision}`));
  return { manifest, collision, baseUrl };
}
