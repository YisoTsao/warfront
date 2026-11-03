import { z } from 'zod';

/** 所有客戶端訊息的結構驗證；不合法的訊息直接丟棄並計數。 */
const finite = z.number().finite();

export const InputFrameSchema = z.object({
  s: z.number().int().nonnegative(),
  f: finite,
  r: finite,
  b: z.number().int().nonnegative(),
  st: z.number().int(),
  y: finite,
  p: finite,
  w: z.number().int(),
  vt: z.number().int(),
});

export const InputMessageSchema = z.object({ frames: z.array(InputFrameSchema).min(1).max(4) });

export const LoadoutSchema = z.object({
  classId: z.string().max(32),
  primaryId: z.string().max(32).optional(),
  secondaryId: z.string().max(32).optional(),
  attachments: z.record(z.string().max(32), z.array(z.string().max(32)).max(3)).optional(),
});

export const TeamSchema = z.object({ team: z.enum(['alpha', 'bravo']) });
export const DeploySchema = z.object({ spawn: z.string().max(16) });
export const PingSchema = z.object({ t: finite, rtt: finite.optional() });

export const JoinOptionsSchema = z.object({
  guestId: z.string().regex(/^[a-zA-Z0-9_-]{6,64}$/),
  name: z.string().max(32),
  mode: z.enum(['tdm', 'conquest']).optional(),
  mapId: z.string().regex(/^[a-z0-9-]{1,48}$/).optional(),
  bots: z.number().int().min(0).max(16).optional(),
  /** 自訂對戰規則（建立房間時有效） */
  scoreLimit: z.number().int().min(1).max(500).optional(),
  timeLimit: z.number().int().min(30).max(3600).optional(),
  loadout: LoadoutSchema.optional(),
});

export const DebugSchema = z.discriminatedUnion('cmd', [
  z.object({ cmd: z.literal('teleport'), x: finite, y: finite, z: finite }),
  z.object({ cmd: z.literal('skipWarmup') }),
]);
