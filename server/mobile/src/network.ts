import { z } from 'zod';
import { MobileReplySchema } from './generated/mobile-protocol';
import { RemoteError, safeBase, type Transport } from './controller';
const ErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});
export const createTransport = (allowDevWeb: boolean, fetcher: typeof fetch = fetch): Transport => async (session, path, body, signal) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort);
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 35000);
  try {
    const cookie = 'kind' in session && session.kind === 'cookie';
    const response = await fetcher(
      cookie ? path : `${safeBase(session.url, allowDevWeb)}${path}`,
      {
        redirect: "error",
        method: body === undefined ? "GET" : "POST",
        body,
        signal: controller.signal,
        ...(cookie ? { credentials: 'same-origin' } : {}),
        headers: {
          ...('token' in session ? { Authorization: `Bearer ${session.token}` } : { 'X-Mino-Web': '1' }),
          "X-Mino-Space": session.spaceId,
          "Content-Type": "application/json",
        },
      },
    );
    const data: unknown = await response.json();
    if (!response.ok) {
      if (path === '/m/commands' && [400,403,409,413,415,422].includes(response.status)) {
        const refusal = MobileReplySchema.safeParse(data);
        if (refusal.success && !refusal.data.ok && !['space_mismatch','device_unauthorized','pairing_pending'].includes(refusal.data.code ?? '')) return refusal.data;
      }
      const error = ErrorSchema.safeParse(data);
      throw new RemoteError(
        response.status,
        error.success ? (error.data.code ?? "http_error") : "http_error",
        error.success ? (error.data.message ?? "Erreur PC") : "Erreur PC",
      );
    }
    return data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
};
