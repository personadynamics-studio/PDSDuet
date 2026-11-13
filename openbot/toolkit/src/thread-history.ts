
export function isMissingThread(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "PlatformRequestError" &&
    (error as { status?: unknown }).status === 404
  );
}


export async function historyOrEmpty<T>(
  read: () => Promise<T>,
  whenMissing: T,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isMissingThread(error)) return whenMissing;
    throw error;
  }
}
