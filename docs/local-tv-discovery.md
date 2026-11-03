# Local station and live-event discovery

**Release status:** 0.1.25 / build 1025 has been withdrawn because of phone/handheld layout and Football/NFL search issues. Public downloads provide [0.1.27 / build 1027](https://github.com/DougTrier/GenX-Streamer/releases/tag/v0.1.27). See the [candidate status](../README.md#release-status) and [physical device audit](device-playability-audit.md) for the current development build. Results in this document apply to the builds named alongside them.

Status: discovery design and source research, November 1, 2026. Web TV,
My Local and nearest-affiliate discovery remain design work. Sport/league
filters and cached metadata/team-aware search are implemented in 0.1.25;
candidate-specific evidence and limits are summarised in the README and
native player documentation. The discovery design applies to each user's
saved Settings location. Illinois research examples do not become
station-specific rules in the application.

## Search the index, refresh sources separately

Opening Live TV, searching a network, or opening the Guide must not wait for a
web crawl, station scan, or trial playback. Return the existing local SQLite
snapshot immediately, with its last successful update time. Refresh relevant
metadata in owned background work and publish a new snapshot without moving
the current channel row, scroll position or remote focus.

The pipeline is:

1. Read the saved country and postal location from Settings. Resolve an
   approximate place and available broadcast-market/service-area metadata.
2. Select relevant station and publisher directory records for that area.
   Area codes are an approximate alternative, not a precise residence/market.
3. Refresh only new, changed or due publisher metadata. Do not play every feed.
4. Store normalized stations, distinct programme feeds, and scheduled events.
5. Search indexed names, network aliases, teams, schools, sports, places,
   descriptions and event metadata, with stable paginated results.
6. Recheck the selected event/feed when the viewer chooses Watch, then start
   its correct direct-player or website route.

Warm search latency should be measured independently of network freshness.
Use a 100 ms local-query performance target, not an unmeasured speed claim.
Large fixtures should demonstrate that reading one channel's programmes does
not repeatedly group or scan the entire station catalog.

## Identities and programme feeds

Do not identify a station from a channel number or a display name alone.
Different regions can have stations called FOX 43, and affiliations change.
Preserve reviewed publisher identifiers, call signs, station/facility identity,
network affiliation with provenance, and the source's own feed identity.

Keep these records separate:

- **Station:** stable identity, call sign, names/aliases, network affiliations,
  licensed place and documented coverage/service areas with provenance.
- **Feed:** station/publisher identity, direct-media or website route, access
  requirements and programme type: full station, local news, community channel,
  event, audio-only or unknown.
- **Event:** publisher event ID, teams/schools/sport/venue, advertised start in
  UTC when known, current state, observation time, and the actual watch routes.

A full affiliate schedule, a station's news channel, a national fallback, a
recorded clip and a local game's audio commentary are different programming.
Do not collapse them into one channel or automatically switch among them as
equivalent sources. Merge duplicate event listings only with sufficient
identity evidence; retain distinct legitimate delivery routes for the same
programme and their independent health history.

The existing canonical Channel stores direct HTTP(S) media URLs. Adding a
homepage URL to that array would send it to the media decoder and reconnect
logic. Web TV needs a typed page route or a separate typed directory presented
alongside Live TV, using the existing owned Web page player and remote controls.
Import/export, native query DTOs and persistence must preserve that distinction.

## Ordering local network searches

For NBC, ABC, CBS or FOX searches:

1. Prefer a confirmed affiliate serving the saved location/market.
2. Within comparable coverage, order known nearby stations by documented
   location/distance, then feed suitability and observed source quality.
3. Put other markets and unknown geographic matches after known local matches.

Do not rank an unrelated network-branded news feed above the actual local
affiliate just because both include FOX in their names. Do not infer a precise
station location from CDN hosts, channel numbers or a country tag. A station
can serve multiple postal areas and cross a state border. Postal centroids and
studio distance are approximations, not proof of reception or streaming access.

Keep user country/state filters as explicit constraints. A separately offered
nearby-market view may include cross-border coverage, with its meaning visible.
Missing location stays Unknown. Coverage and language support must be recorded
per country/provider, rather than claiming universal station coverage.

## My Local filter

Offer **My Local** as a location scope independent of content categories, so
the viewer can combine My Local with Sports or News. Selecting My Local alone
must not admit PPV into ordinary results. A specific sport/league scope or
unambiguous league/full-team search can include matching PPV as described below.
The Guide and event search must carry the same local scope as the channel list.

Use the location already saved in Settings. When it is missing, selecting
My Local opens the existing location flow, requesting country and a suitable
postal/ZIP code. Offer an area code only in countries for which the adapter
supports that approximate lookup. Do not assume that every country has US-style
ZIP or telephone area codes. Do not request a full address or device-location
permission merely to use this filter.

Apply the scope only after the location is successfully saved and resolved.
Cancelling or failing that step leaves the prior filters, playing stream,
scroll anchor and remote focus usable. A later Settings location change
invalidates the old geographic query scope without discarding the cached index
or interrupting unrelated playback.

Return verified local matches from the cached index first, with clear feed
types and event states. No verified matches is a bounded empty state with
last-update/retry information; it must not trigger a blocking full channel scan
or imply that no local stations exist. A national feed merely available in the
country is not automatically a local station, and being in the same state is
not sufficient locality evidence.

## Discover current and scheduled events

Use publisher event schedules and their official online watch destinations,
not only M3U list discovery. Suitable adapters include station directories and
schedules, community TV platforms, official school/league/creator channels,
published event feeds, and supported streaming-platform metadata.

YouTube's public Data API `search.list` supports channel-scoped `eventType=live`
and `eventType=upcoming` with `type=video`. `videos.list` can add actual/scheduled
start/end times, privacy and embedding details. Public metadata access uses a
configured project credential; it does not require the creator's account.
The separate `liveBroadcasts` management API is not a general unauthenticated
way to enumerate other creators' broadcasts.

Discover the creator's actual channel identity from its official website.
Then retain video/event IDs and refresh known events in batches. A generic
location search alone misses videos whose publisher did not geotag them.
An uploads/RSS feed alone is not a reliable complete upcoming-broadcast list.

Display Scheduled, Live now, Ended/replay, Cancelled or Availability unknown
according to fresh evidence. A scheduled start passing is not proof of a live
broadcast. A page headline saying LIVE can remain online after the event.
Keep audio-only commentary distinct from video. A television-only event can
appear as a listing, but must not get an online Watch action without a confirmed
online route. A broadcaster's general news stream does not establish that it
will carry a sports event aired on another station or subchannel.

For direct HLS, follow the master to a media playlist before interpreting it.
Advancing media sequence/timestamps across appropriate samples can confirm an
active linear delivery candidate. Absence of ENDLIST alone, a GO LIVE button,
an advancing playhead or a reachable website does not prove live local
programming. Continuous feeds can carry recorded programmes or national
fallbacks. Persist transport availability separately from programme state.

## Sports subfilters and team-aware search

This subsection describes the bounded 0.1.25 implementation; the station,
My Local and nearest-affiliate collectors elsewhere in this document remain
design work. The 0.1.25 candidate has its own development/package evidence;
the older internal 0.1.24 PPV result is not substituted for it.
Selecting Sports exposes a Sport control with All Sports, American Football,
Baseball, Basketball, Soccer and Hockey. A League control narrows American
Football to NFL or college football,
for example. A channel or event can have several sports; preserve those facts
instead of replacing the provider's category with one guessed sport.

Combine sport and league with country, text search, PPV controls and the future
My Local scope. A specific sport/league or unambiguous league/full-franchise
search includes matching PPV by default with a visible badge/status; a PPV
label is not evidence that the feed is inactive. Ordinary browsing and All
Sports without specific intent retain the decluttered PPV exclusion. The
separate PPV-only filter remains available. Bare football/nicknames/cities do
not supply automatic PPV inclusion or evidence about a programme's league.
Free TV and Paid TV keep separate browsing selections, including sport/league,
category, search and chosen geography. Returning to a tab restores its selections;
the Guide uses the active tab's scope. The saved Settings home location remains
a global preference for the future My Local feature.
Use programme evidence so a general affiliate or ESPN can qualify
when carrying the requested sport. Define a visible current/upcoming schedule
window over already cached schedules, retain explicit dedicated-channel sport facts, and provide a labelled
Unknown sport/insufficient listings state. Missing EPG is not proof that a
channel cannot carry football.

The pre-implementation source investigation found three matching limitations:

- Paid Guide search omits already stored programme categories; Free Guide
  searches title, description and category text.
- Replacing a provider category such as US/NFL with a user category Sports
  drops the original NFL term from general channel search.
- There is no shared sport/league/team vocabulary. A title containing only
  full NFL team names does not automatically match NFL or American Football.

Version 0.1.25 addresses these metadata differences with one reviewed, versioned
vocabulary and query plan shared by native and browser paths. Full unambiguous franchise
names and explicit league/sport metadata can provide evidence. Bare Bears,
Cardinals, Giants, cities, generic NCAA or college mascots alone cannot prove
NFL or football: teams and nicknames can belong to several sports. A user's
search word is query intent, not evidence about the programme. Preserve literal
matches and raw metadata; identify why an inferred result matched.

The bounded semantic predicate applies before native counts, membership,
pagination and highlights, with vocabulary and saved Guide revisions in the
relevant cache/paging identities. Existing indexed literal lookup and cached
programme membership avoid a full guide scan per channel or warm page. This
phase queries cached metadata; persistent nationwide indexing/backfill remains
design work. No stream rescan or network request per keystroke is added.
Sport/League dropdowns keep remote navigation compact. A semantic match changes
neither Guide mapping nor stream equivalence, and does not establish current-live status.

The initial shared registry is `config/sports-vocabulary.json`: five sports,
ten explicit league vocabularies and current full names for 32 NFL franchises.
Other franchises are not automatically inferred without reviewed evidence.
Shared evidence and query cases are in `tests/fixtures/sports-classifier-cases.json`
and `tests/fixtures/sports-query-cases.json`. Complete cached matchup text stays
visible with its provider label; display-only NFL expansion requires two actual
recognized title spans, a matchup separator and independently established league
evidence. Unknown abbreviations remain raw. Programme inheritance stays scoped
to the selected geo-authorized canonical channel; league evidence found only on
another alias does not resolve an otherwise unknown mascot-only title.
Membership uses a captured, validated window of at most seven days of cached
programmes; normal Guide display queries retain their own visible time window.
Metadata coverage and live/ended labels must not be confused with this snapshot.

## Keep discovery bounded

- Reuse cached station directories and event metadata across searches. For
  broad deployment, a shared metadata index can avoid repeating discovery on
  every device; a local cache must remain useful when that service is unavailable.
- Honor each provider's API quota and cache policy. Nationwide discovery cannot
  assume unlimited channel-by-channel YouTube searches from one embedded key.
  Budget discovery separately from batch refresh of already-known events.
- Refresh general metadata about every three hours when idle; use bounded,
  quota-aware checks near the start of known relevant events and on selection.
  Stale or budget-exhausted results stay visibly stale/unknown rather than
  being labelled live. Do not promise a polling cadence before budgeting it.
- Use bounded response sizes, timeouts, redirects and concurrency. Retry per
  publisher with backoff. An inaccessible source does not block other results.
- Reuse playback-intent, foreground, cancellation and cleanup ownership. Join
  conflicting maintenance before starting media; do not repeat the Guide/scan
  interference fixed in the playback work.
- Do not open many hidden WebViews, start paid streams, bypass sign-ins or
  cache expiring playback URLs as permanent catalog identities. Check reviewed
  publisher routes and reacquire session-specific destinations when needed.
- An event being off air is expected. It is not a dead-channel cleanup signal
  and must not cause repeated playback recovery attempts.

## Sources checked

- [YouTube public live/upcoming search](https://developers.google.com/youtube/v3/docs/search/list)
  and [video/live metadata](https://developers.google.com/youtube/v3/docs/videos).
- [iptv-org metadata](https://github.com/iptv-org/api): channel country is origin;
  feed broadcast_area describes coverage. Its metadata can aid identity matching
  without treating an M3U file as the only discovery mechanism.
- [HLS playlist specification](https://datatracker.ietf.org/doc/html/rfc8216/).
- [Census ZIP/ZCTA explanation](https://www.census.gov/programs-surveys/geography/guidance/geo-areas/zctas.html).
- [Clutch Sports Media](https://www.clutchsportsil.com/): an official creator
  source; current homepage items illustrate dated audio-event headlines.
- [WHOI/MyTeam announcement](https://www.25newsnow.com/2025/09/19/week-tv-announces-new-channel-more-options-sports-entertainment-local-news/):
  confirms the local sports station/subchannel identity, not an Internet simulcast.
- [Fubo's local-channel carriage](https://support.fubo.tv/hc/en-us/articles/115005151127-What-Local-Channels-does-Fubo-Carry)
  lists WYZZ in Peoria/Bloomington. This is a licensed-service availability
  reference, not a free feed or proof of playback inside GenX.
- [HDHomeRun's published HTTP API](https://info.hdhomerun.com/info/http_api)
  is another source type: an owner's network OTA tuner can expose channel
  metadata and direct MPEG-TS. No tuner adapter is implemented by this design.

Illinois publisher research and the bounded NCTV17 HLS observations are in
ignored local artifacts. They are examples, not an exhaustive catalog or an
assertion that all pages or events play inside GenX. No new Web TV stations
were automatically imported during this research.
