/** Keep HTML error pages from hiding the actual endpoint and HTTP status. */
export async function readNativeResponse(response: Response, endpoint: string): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const kind = /^\s*</.test(text) ? 'an HTML page instead of API data' : 'an invalid API response';
    throw new Error(`The training service returned ${kind} for ${endpoint} (HTTP ${response.status}). Please try again. If this continues, restart the training server and reopen its URL.`);
  }
}
