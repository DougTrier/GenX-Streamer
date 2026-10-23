// Keep the actual UI and attachment owner in one module graph so their private
// WeakMap is shared, exactly as in the application bundle.
export { installAudioTracks } from '../../../src/ui/audio-tracks';
export { createBrowserAudioTracks } from '../../../src/platform/browser-audio-tracks';
export { createResourceOwners } from '../../../src/playback/resource-owners';
