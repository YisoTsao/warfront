import RAPIER from '@dimforge/rapier3d-compat';

let initPromise: Promise<void> | null = null;

/** Rapier 的 WASM 只需初始化一次；瀏覽器與 Node 都適用。 */
export function initPhysics(): Promise<void> {
  initPromise ??= RAPIER.init();
  return initPromise;
}

export { RAPIER };
