import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  createHealthInspector,
  inspectHealthSource,
  type HealthCheckBudgetMs,
  type HealthInspection,
} from './health-inspection';
import {
  recordValidatedMediaPreflightReceipt,
  mediaPreflightHeaderRetry,
} from './media-preflight-diagnostics';
export { mediaPreflightDiagnosticsSnapshot } from './media-preflight-diagnostics';

// Match the inspector's fixed failure taxonomy, never forward arbitrary native text.
const safeNativeFailures = new Set([
  'timeout',
  'dns-failure',
  'tls-failure',
  'connectivity-failure',
  'network-failure',
  'redirect-refused',
  'url-policy-refused',
  'playlist-too-large',
  'playlist-invalid-utf8',
]);

/** Resource availability is not a decoder claim; development browsers retain their own profile. */
export async function inspectCheckedMediaSource(
  url: string,
  allowHttp: boolean,
  signal: AbortSignal,
  budgetMs: HealthCheckBudgetMs = 20000,
): Promise<HealthInspection> {
  if (!isTauri()) return inspectHealthSource(url, allowHttp, signal, budgetMs);
  let nativeCanceled = false;
  return createHealthInspector({
    native: {
      inspect: async (input) => {
        const raw = await invoke<unknown>('inspect_media_resources', input);
        if (!raw || typeof raw !== 'object') throw new Error('Stream check receipt is invalid.');
        const result = raw as Record<string, unknown>;
        const headerRetryCount = mediaPreflightHeaderRetry(result);
        if (
          result.requestId !== input.requestId ||
          headerRetryCount === null ||
          (headerRetryCount === 1 && Number(result.checkedResources) < 2) ||
          !['resources-responded', 'unverified', 'unavailable'].includes(String(result.status)) ||
          typeof result.reasonCode !== 'string' ||
          !/^[a-z0-9-]{1,128}$/.test(result.reasonCode) ||
          !Number.isSafeInteger(result.checkedResources) ||
          Number(result.checkedResources) < 0 ||
          Number(result.checkedResources) > 8 ||
          (result.status === 'resources-responded' &&
            (Number(result.checkedResources) === 0 ||
              (result.httpStatus !== undefined &&
                (Number(result.httpStatus) < 200 || Number(result.httpStatus) >= 300)))) ||
          (result.httpStatus !== undefined &&
            (!Number.isInteger(result.httpStatus) ||
              Number(result.httpStatus) < 100 ||
              Number(result.httpStatus) > 599)) ||
          (result.retryAfter !== undefined &&
            (typeof result.retryAfter !== 'string' ||
              result.retryAfter.length > 128 ||
              [...result.retryAfter].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)))
        )
          throw new Error('Stream check receipt is invalid.');
        const httpStatus = result.httpStatus as number | undefined;
        recordValidatedMediaPreflightReceipt(
          {
            status: result.status as 'resources-responded' | 'unavailable' | 'unverified',
            reasonCode: result.reasonCode,
            checkedResources: Number(result.checkedResources),
            ...(httpStatus === undefined ? {} : { httpStatus }),
            ...(headerRetryCount === 1
              ? ({ headerRetryCount: 1, headerRetryReason: 'network-failure' } as const)
              : {}),
          },
          signal.aborted || nativeCanceled,
        );
        if (
          result.status === 'unavailable' &&
          (httpStatus === undefined || (httpStatus >= 200 && httpStatus < 300))
        ) {
          // Root headers are not evidence that a later resource/body responded.
          // Keep transport failures distinct from actual failing HTTP responses.
          throw safeNativeFailures.has(result.reasonCode) ? result.reasonCode : 'network-failure';
        }
        const status = result.status === 'resources-responded' ? 200 : Number(httpStatus ?? 200);
        return {
          status,
          ...(status >= 200 && status < 300
            ? { kind: result.status === 'resources-responded' ? 'media' : 'unsupported' }
            : {}),
          ...(result.retryAfter !== undefined ? { retryAfter: result.retryAfter } : {}),
        };
      },
      cancel: (requestId) => {
        nativeCanceled = true;
        return invoke('cancel_playlist', { requestId });
      },
    },
  })(url, allowHttp, signal, budgetMs);
}
