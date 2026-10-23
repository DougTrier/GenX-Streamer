/** One wake adapter receives the union of foreground activity reasons. */
export function createActivityWakePolicy(send: (active: boolean) => Promise<void>) {
  let playback = false;
  let scan = false;
  let television = false;
  let closed = false;
  const apply = () => send(!closed && (playback || (television && scan)));
  return {
    setPlayback(active: boolean) {
      playback = active;
      return apply();
    },
    setScan(active: boolean) {
      scan = active;
      return apply();
    },
    setTelevision(active: boolean) {
      television = active;
      return apply();
    },
    close() {
      closed = true;
      playback = scan = false;
      return apply();
    },
  };
}
