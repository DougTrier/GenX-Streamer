/** Versioned observation policies; a requested limit is not a measured duration. */
export const DECODER_HEALTH_PROFILE = 'decoder-v1/html-video-quality-presented-v1';
export function reachabilityHealthProfile(native: boolean, budgetMs = 20000): string {
  if (![20000, 45000, 60000].includes(budgetMs))
    throw new Error('Choose a supported channel check time.');
  return `reachability-v3/${native ? 'native-media-resources-v1' : 'browser-fetch-v1'}/max-${budgetMs}/sequential`;
}
