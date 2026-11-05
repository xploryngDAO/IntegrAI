import { AppError } from '@sac/shared';

/**
 * Bound an awaited operation with a wall-clock deadline.
 *
 * Diagnostics perform live token exchanges / marketplace reads and are the only
 * HTTP handlers allowed to run for tens of seconds. The underlying promise keeps
 * running (the application service owns its own client timeouts); we only stop
 * holding the request open forever and answer 504 with a retryable error code so
 * the UI can offer "run again".
 */
export function withTimeout<T>(operation: Promise<T>, timeoutMs: number, scope: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new AppError(
          'INTERNAL_ERROR',
          `${scope} diagnostics timed out after ${timeoutMs} ms`,
          504,
          { scope, timeoutMs },
          true,
        ),
      );
    }, timeoutMs);

    // Do not keep the event loop alive because of a diagnostics deadline.
    timer.unref();

    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
