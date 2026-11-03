# Independent search and Guide verification

This QA record covers private 0.1.26 / Android build 1026 candidates. See the [current source candidate](../README.md#release-status) and [physical device audit](device-playability-audit.md) for subsequent build and device evidence. Version 0.1.3 remains the available public release after the withdrawal of 0.1.25.

C3 was rejected for native keyboard/focus behavior. Later C4/C5 checks verified targeted corrections, but C5 exposed blank handheld Watch controls and repeated application-amplified buffering. Reviewed C6 emulator checks cover native IME, controlled search and Back; the closed Thor packet verifies readable Watch/Expanded controls, remote routes and retained PBS recall. Its bounded 90-second playback observation improved, with brief interruptions still present.

Use exactly these five cases, preserving query and scope. Record the installed APK identity and test time. A station-name lookup cannot replace a failed programme query.

## The five cases

| Case | Exact query and scope | Public identity and independent reference | Candidate evidence and limits |
| --- | --- | --- | --- |
| News station | `CBS News Miami`; All; no sport/league | Observed CBS NEWS MIAMI branding; [official news service](https://www.cbsnews.com/miami/live/). | C1: correct main and Guide station; episode/timing unproved. Carried evidence, not a fresh C3/C5/C6 content run. |
| American football | `football`; Sports → American Football → All leagues | `ACCDigitalNetwork.us@SD`; C1 observed football gameplay. [Duke's game report](https://goduke.com/news/2019/11/30/football-duke-tops-miami-27-17-on-senior-day) corroborates the historical replay, not a current airing. | C1 recall failure. C3 collected all 21 main/17 Guide IDs, with exact ACC in both. Its earlier football listing ended at 04:29Z on November 2; the C3 current page then had no ACC listing. No all-result specificity or current-title pass; carried, not freshly repeated in C5/C6. |
| Children's programme | `Xavier Riddle`; All; no sport/league | `PBSKids.us@SD`; C1 characters corroborated against the [official series](https://pbskids.org/xavier/). The [official national live service](https://pbskids.org/videos/watch/live) supplies the bounded schedule adapter. | C1: zero main/Guide, a real coverage failure. C5 normal preview/save supplied 380 programmes and one exact national connection; the original query returned one main/one settled Guide row. C6 retained cached main 1/Guide 1 with five visible programme cells, without resaving or rescanning. Its displayed listings were Arthur/Odd Squad and others; no fresh Xavier airing, exact episode or PBS playback proof. |
| Music station | `1HD Music Television`; All; no sport/league | C1 and C5 observed the station watermark/music video; [official service description](https://1hd.ru/about/). | C1 later playback failed; C3 produced zero frames. C5 decoded 1080p pictures, then suffered five approximately 12.23–12.27-second buffering holds before the operator paused. Application hold amplification is evidenced; the underlying media-gap cause is unproved. C6's reviewed 90.2497-second window had no repeated twelve-second hold: 15 controller transitions lasted 262–298 ms and one lasted 2.167 seconds, with an approximately 1.735-second DOM pause. Playback advanced, but was not stall-free. No verified connected music Guide. |
| Scripted programme | `X-Files`; All; no sport/league | `Comet.us@SD`, main feed in `America/New_York`; [official dated schedule](https://comettv.com/schedule/). | C1: zero main/Guide. C3 normal preview/save supplied 124 programmes and one connection without a rescan; query returned one main/one Guide. COMET-branded drama was observed; Dreamland II remained dated-schedule inference. Carried evidence, not a fresh C5/C6 programme run. |

Public provider/feed IDs use the [IPTV-org feed catalogue](https://iptv-org.github.io/api/feeds.json); they must match the saved channel's exact identity. National PBS evidence does not authorize Samsung, regional or similarly named channel merges.

The C1 baseline and separate C3/C5 supplements retain their original failures. C5 restored the specific national PBS coverage/recall gap; it did not produce five fresh passes. Controlled C6 emulator NFL results do not replace the original public `football` case. No all-five-pass conclusion is established.

## Establish truth before judging results

1. Record UTC/device clocks and timezone, distinguishing unsynchronized samples from a measured clock offset; record tab, geography, category, sport/league, adult visibility and PPV policy.
2. Observe changing decoded pictures from the intended public Free source. Retain identity, timestamp and pictures; loading art or a `Playing` label is insufficient.
3. Label proof as **station**, **series**, **episode**, or **schedule inference**. A watermark identifies a station; an advertisement may not identify the surrounding programme.
4. Cite primary broadcaster references. Dated schedules must match feed/timezone; catalogues and undated promotions are not airing proof.
5. Write expected provider/channel IDs before judging results. App labels, cached titles and classifier output are not independent truth.

## Compare main results and Guide

1. Enter the exact query through Search & Filters, return to channels and confirm retained scope before counting.
2. Record every returned app/provider/feed ID. Check the expected positive and inspect unrelated or ambiguous rows for false positives.
3. Open Guide with the same active-tab query, geography and facets. Record mappings, titles and start/stop instants; explain each difference from main results.
4. Missing Guide data is a coverage failure even when station-name search works. Empty metadata does not establish programme absence.
5. Matches can come from future cached listings in the rolling seven-day membership window. Identify the qualifying programme/time before calling an unrelated **current** title a false positive.
6. Separate that membership window from the shorter displayed page and actual source coverage. Do not invent ends or promise seven continuous days.
7. Unestablished identity/listing means **unexplained/incomplete**. Do not guess regional aliases, substring sport evidence or missing titles.
8. Clear only the active tab. Preserve Free/Paid isolation, account authority, geography, adult/removal and PPV rules. These public Free cases authorize no Paid-provider session.

COMET and national PBS KIDS use registered official adapters through the existing acquisition, preview, cache and connection owners. C3 verified COMET targeted preview/save and C5 verified PBS targeted preview/save without rescanning channels or injecting mappings. These checks did not verify refreshing every configured source. Saved metadata is searched locally; no network request is made for each query or row.

## Report outcomes without hiding gaps

Keep a five-row expected/actual table with separate station/programme proof, main-search, Guide-coverage and playback outcomes. Use **Pass**, **Fail** or **Incomplete**, with timestamps and evidence references.

- Preserve query, scope and old failures. Append later candidate results; do not relabel old captures or substitute another query to obtain five passes.
- Recheck dynamic programme expectations at each run. Record the qualifying current/future listing and its clock/window limits.
- Record initial decode and continued playback separately. C5's 1HD picture did not excuse its repeated holds; no verified music Guide source was established.
- The C5 full trace supports app hold amplification, not a universal provider, decoder, channel-missing or operator-pause explanation for the original gaps.
- Keep UI, remote and playback claims separate. C6 emulator IME, Clear, Back and controlled search checks passed; Thor's normal/Expanded Watch labels and physical Back routes passed. These scopes do not establish physical S25/Fire/Flip, audibility, authenticated Paid or every-surface acceptance.
- C6's full 411-record capture and closure were reviewed separately from the isolated 90 seconds. Auto briefly changed 3 → 5 → 3 seconds; the C5 repeated twelve-second holds did not recur. Short gap transitions and 25 retained playback-gap warnings remain; no universal stream recovery, clean-log or stall-free claim.
- Keep the candidate private while required outcomes remain failed or incomplete. Do not report five fresh runs or five passes from carried and provisional evidence.

## Local QA examples

These repository-relative paths point to **ignored local evidence**, not files shipped in the public repository or new release certificates:

- [Original five-case comparison](../artifacts/independent-programming-testing/five-search-final-comparison-candidate1.json): independent observations and retained failures for the same five queries.
- [C3 supplement](../artifacts/independent-programming-testing/five-search-comparison-candidate3-supplement.json): complete AF IDs, normal COMET setup, music failure and carried CBS/PBS evidence.
- [C5 supplement](../artifacts/independent-programming-testing/five-search-comparison-candidate5-supplement.json) and [full-trace addendum](../artifacts/independent-programming-testing/five-search-comparison-candidate5-full-trace-addendum.json): national PBS recall restored; music decode followed by repeated holds; blank Watch controls retained as a failure.
- [Official PBS source proof](../artifacts/independent-programming-testing/pbs-official-adapter/source-freeze.json): fixed national identity, publisher time policy, bounded acquisition and actual SQLite query/connection tests.
- [C6 comparison supplement](../artifacts/independent-programming-testing/five-search-comparison-candidate6-supplement.json): fresh cached PBS/music observations, carried cases, remaining Guide/playback limits and closed Thor evidence.
- [C6 emulator review](../artifacts/phone-portrait-testing/candidate-0.1.26-06/native-emulator-independent-review-by-audit.json): completed targeted UI/remote checks, three preserved incomplete runtime attempts and ordinary Exit limits.

Keep provider credentials, private stream URLs and account identities out of public QA notes. Record only the public identities needed to explain each outcome.
